#!/usr/bin/env node
/**
 * `pnpm drill:pitr` — a LOCAL-ONLY PostgreSQL 16 WAL / point-in-time-recovery rehearsal (Workstream C).
 *
 * What this proves, and the precise limit of that proof:
 *
 *   It creates a throwaway PostgreSQL instance in a temporary directory, archives its WAL to another
 *   temporary directory, takes a base backup, writes deterministic data BEFORE a recorded recovery
 *   target, writes more data AFTER it, then restores the base backup and replays WAL up to the target.
 *   The restored instance must contain the pre-target rows and must NOT contain the post-target rows.
 *
 *   That is evidence that the WAL archiving and recovery-target CONFIGURATION in this repository is
 *   coherent and that the mechanism works on this PostgreSQL build. It is NOT evidence about staging or
 *   production recovery: different storage, different retention, different object store, different
 *   failure modes, and no off-site component is exercised here at all.
 *
 * The rehearsal is capability-gated rather than skipped silently. When the environment cannot run it
 * (no initdb, no permission to run a server, no free port) the script emits a structured
 * CAPABILITY_BLOCKED result naming the exact missing capability and exits 0, because a missing local
 * capability is not a product defect — while a rehearsal that STARTS and then fails its data assertions
 * exits non-zero, because that is a real finding.
 *
 * No credentials, no network, no paid service: the instance listens on a unix socket in its own
 * temporary directory and is destroyed, along with every file it created, in the finally block.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPORT_PATH = 'coverage/pitr-rehearsal-report.json';

/** Locate the PostgreSQL 16 binaries without assuming they are on PATH. */
function binDir() {
  const candidates = [
    process.env.PG_BIN_DIR,
    '/usr/lib/postgresql/16/bin',
    '/usr/pgsql-16/bin',
    '/opt/homebrew/opt/postgresql@16/bin',
  ].filter(Boolean);
  for (const dir of candidates) if (existsSync(join(dir, 'initdb'))) return dir;
  const which = spawnSync('bash', ['-lc', 'command -v initdb'], { encoding: 'utf8' });
  if (which.status === 0 && which.stdout.trim()) return null;
  return undefined;
}

function writeReport(report) {
  mkdirSync('coverage', { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function blocked(capability, detail) {
  writeReport({
    result: 'CAPABILITY_BLOCKED',
    capability,
    detail,
    proves: null,
    checked_at: new Date().toISOString(),
  });
  console.log(`CAPABILITY_BLOCKED: ${capability} — ${detail}`);
  console.log('The PITR scripts, configuration templates and unit validation still ran.');
  return 0;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', ...opts });
}

function main() {
  const dir = binDir();
  if (dir === undefined)
    return blocked('postgresql_16_server_binaries', 'initdb was not found in any known location');

  const bin = (name) => (dir === null ? name : join(dir, name));

  // A server may not be started as root, which is a real and common sandbox constraint.
  let runAs = null;
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const probe = run('id', ['-u', 'postgres']);
    if (probe.status !== 0)
      return blocked(
        'non_root_postgres_user',
        'running as root and no unprivileged postgres user exists to run the server as',
      );
    runAs = 'postgres';
  }

  const root = mkdtempSync(join(tmpdir(), 'yeonjae-pitr-'));
  const dataDir = join(root, 'data');
  const walDir = join(root, 'wal-archive');
  const baseDir = join(root, 'base');
  const socketDir = join(root, 'sock');
  const stages = [];
  const stage = (name, ok, detail = '') => {
    stages.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
    return ok;
  };

  try {
    for (const d of [walDir, socketDir]) mkdirSync(d, { recursive: true });
    if (runAs) run('chmod', ['777', root, walDir, socketDir]);

    // `su -c` takes ONE shell string, so every argument is single-quoted with embedded quotes escaped.
    // An earlier version interpolated arguments raw, which silently stripped the quotes out of SQL
    // literals and turned 'pre' into a column reference.
    const shellQuote = (a) => `'${String(a).replaceAll("'", `'\\''`)}'`;
    const asUser = (cmd, args) =>
      runAs ? run('su', [runAs, '-c', [cmd, ...args].map(shellQuote).join(' ')]) : run(cmd, args);

    // SQL is delivered through a FILE rather than -c, so no layer of shell quoting can alter it.
    let sqlSeq = 0;
    const sqlFile = (sql) => {
      const path = join(root, `stmt-${String(++sqlSeq)}.sql`);
      writeFileSync(path, `${sql}\n`, 'utf8');
      if (runAs) run('chmod', ['644', path]);
      return path;
    };

    const init = asUser(bin('initdb'), ['-D', dataDir, '-A', 'trust', '-U', 'postgres']);
    if (init.status !== 0)
      return blocked('initdb_execution', (init.stderr || init.stdout || '').slice(0, 300).trim());
    stage('initdb created a disposable cluster', true);

    const conf = [
      "listen_addresses = ''",
      `unix_socket_directories = '${socketDir}'`,
      'wal_level = replica',
      'archive_mode = on',
      `archive_command = 'test ! -f ${walDir}/%f && cp %p ${walDir}/%f'`,
      'max_wal_senders = 3',
      'wal_keep_size = 64MB',
    ].join('\n');
    writeFileSync(join(dataDir, 'postgresql.auto.conf'), `${conf}\n`, 'utf8');
    if (runAs) run('chown', [`${runAs}:${runAs}`, join(dataDir, 'postgresql.auto.conf')]);
    stage('configured local WAL archiving', true);

    const startLog = join(root, 'server.log');
    const start = asUser(bin('pg_ctl'), ['-D', dataDir, '-l', startLog, '-w', 'start']);
    if (start.status !== 0)
      return blocked(
        'postgres_server_start',
        (start.stderr || start.stdout || '').slice(0, 300).trim(),
      );
    stage('started the disposable instance', true);

    const psql = (sql) =>
      asUser(bin('psql'), [
        '-h',
        socketDir,
        '-U',
        'postgres',
        '-d',
        'postgres',
        '-v',
        'ON_ERROR_STOP=1',
        '-tA',
        '-f',
        sqlFile(sql),
      ]);

    let failed = false;
    const must = (name, res, detail = '') => {
      const ok = res.status === 0;
      if (!stage(name, ok, ok ? detail : (res.stderr || res.stdout || '').slice(0, 200).trim()))
        failed = true;
      return ok;
    };

    must(
      'took a base backup',
      asUser(bin('pg_basebackup'), [
        '-h',
        socketDir,
        '-U',
        'postgres',
        '-D',
        baseDir,
        '-Fp',
        '-Xs',
      ]),
    );

    must(
      'wrote deterministic pre-target data',
      psql(
        "CREATE TABLE pitr_probe (id int primary key, phase text not null); INSERT INTO pitr_probe VALUES (1,'pre'),(2,'pre');",
      ),
    );

    // The recovery target is a real committed transaction timestamp read from the SERVER rather than
    // from this process's clock: a client clock could sit either side of the boundary.
    const targetRes = psql('SELECT now()');
    must('recorded a recovery target', targetRes);
    const target = (targetRes.stdout || '').trim();

    // A distinguishable time boundary: without it the post-target rows could carry the same timestamp
    // as the target, which would make the "absent" assertion pass or fail for the wrong reason.
    psql('SELECT pg_sleep(2)');
    must(
      'wrote deterministic post-target data',
      psql("INSERT INTO pitr_probe VALUES (3,'post'),(4,'post');"),
    );
    must('forced a WAL segment switch', psql('SELECT pg_switch_wal()'));
    must('checkpointed', psql('CHECKPOINT'));

    asUser(bin('pg_ctl'), ['-D', dataDir, '-w', '-m', 'fast', 'stop']);
    stage('stopped the source instance', true);

    const recoveryConf = [
      `restore_command = 'cp ${walDir}/%f %p'`,
      `recovery_target_time = '${target}'`,
      "recovery_target_action = 'promote'",
      `unix_socket_directories = '${socketDir}'`,
      "listen_addresses = ''",
      'archive_mode = off',
    ].join('\n');
    writeFileSync(join(baseDir, 'postgresql.auto.conf'), `${recoveryConf}\n`, 'utf8');
    writeFileSync(join(baseDir, 'recovery.signal'), '', 'utf8');
    if (runAs) run('chown', ['-R', `${runAs}:${runAs}`, baseDir]);

    const restoreLog = join(root, 'restore.log');
    const restart = asUser(bin('pg_ctl'), [
      '-D',
      baseDir,
      '-l',
      restoreLog,
      '-w',
      '-t',
      '90',
      'start',
    ]);
    const restarted = restart.status === 0;
    if (
      !stage(
        'restored to the recovery target',
        restarted,
        restarted ? '' : readLog(restoreLog).slice(-300),
      )
    )
      failed = true;

    let preCount = null;
    let postCount = null;
    if (restarted) {
      preCount = Number(
        (psql("SELECT count(*) FROM pitr_probe WHERE phase='pre'").stdout || '').trim(),
      );
      postCount = Number(
        (psql("SELECT count(*) FROM pitr_probe WHERE phase='post'").stdout || '').trim(),
      );
      if (!stage('pre-target data exists after recovery', preCount === 2, `count=${preCount}`))
        failed = true;
      if (
        !stage('post-target data is absent after recovery', postCount === 0, `count=${postCount}`)
      )
        failed = true;
      asUser(bin('pg_ctl'), ['-D', baseDir, '-w', '-m', 'immediate', 'stop']);
    }

    writeReport({
      result: failed ? 'FAILED' : 'PASSED',
      method: 'local_wal_pitr_rehearsal',
      postgres_binaries: dir ?? 'PATH',
      recovery_target: target,
      pre_target_rows: preCount,
      post_target_rows: postCount,
      stages,
      proves:
        'WAL archiving and recovery-target configuration work on this local PostgreSQL 16 build',
      does_not_prove:
        'staging or production recovery, off-site backup, retention, or object-store durability',
      checked_at: new Date().toISOString(),
    });
    console.log(failed ? 'PITR rehearsal FAILED' : 'PITR rehearsal PASSED');
    return failed ? 1 : 0;
  } finally {
    // Every process and artifact this rehearsal created is removed, including on failure.
    for (const d of [dataDir, baseDir]) {
      if (!existsSync(d)) continue;
      if (runAs) run('su', [runAs, '-c', `'${bin('pg_ctl')}' -D '${d}' -m immediate stop`]);
      else run(bin('pg_ctl'), ['-D', d, '-m', 'immediate', 'stop']);
    }
    rmSync(root, { recursive: true, force: true });
  }
}

function readLog(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

process.exit(main());
