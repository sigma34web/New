/**
 * A child execution context for the multi-process coordination tests.
 *
 * Runs as a REAL separate process so that "the holder died" means the holder actually died, and so the
 * coordination under test is between processes rather than between promises on one event loop. It speaks
 * one JSON line per state transition on stdout; the parent synchronises on those lines instead of
 * sleeping.
 *
 * Kept as plain `.mjs` importing the built `dist/` output: a child that needed a TypeScript loader would
 * add a second way for the test to fail that has nothing to do with the property being tested.
 */
import { createPool } from './dist/client.js';
import { PgProviderAdmission } from './dist/provider-admission.js';
import { SharedBudget } from './dist/shared-budget.js';

const say = (event, extra = {}) => {
  process.stdout.write(
    `${JSON.stringify({ event, id: process.env.YEONJAE_CHILD_ID, ...extra })}\n`,
  );
};

const url = process.env.DATABASE_URL;
if (!url) {
  say('error', { message: 'DATABASE_URL not set' });
  process.exit(2);
}

const pool = createPool({ connectionString: url, max: 2 });
const role = process.env.YEONJAE_CHILD_ROLE ?? 'admission';
const holder = `child:${process.env.YEONJAE_CHILD_ID ?? String(process.pid)}`;

/** Wait for a file-free release signal: the parent writes a row the child polls for. */
async function waitForGo(token) {
  for (;;) {
    const r = await pool.query('SELECT 1 FROM mp_signals WHERE token = $1', [token]);
    if (r.rows.length > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

try {
  if (role === 'admission') {
    const admission = new PgProviderAdmission(pool, { holder, maxWaitMs: 0 });
    const grant = await admission.admit({
      workspaceId: process.env.YEONJAE_WORKSPACE_ID,
      provider: 'replay',
      modelId: 'replay-p',
      requestId: process.env.YEONJAE_REQUEST_ID ?? holder,
    });
    say('admitted', { admitted: grant.admitted, reason: grant.reason });
    if (process.env.YEONJAE_HOLD === '1') {
      // Hold the resource open until the parent says otherwise — or until it kills us, which is the
      // case that proves a dead holder strands nothing permanently.
      say('holding');
      await waitForGo(process.env.YEONJAE_RELEASE_TOKEN ?? 'release');
    }
    if (grant.admitted) await grant.release();
    say('released');
  } else if (role === 'budget') {
    const budget = new SharedBudget(pool);
    const cents = Number(process.env.YEONJAE_CENTS ?? '60');
    try {
      const reservation = await budget.reserve(
        {
          projectId: process.env.YEONJAE_PROJECT_ID,
          jobId: process.env.YEONJAE_JOB_ID ?? process.env.YEONJAE_PROJECT_ID,
          workspaceId: process.env.YEONJAE_WORKSPACE_ID,
        },
        cents,
      );
      say('reserved', { cents });
      if (process.env.YEONJAE_HOLD === '1') {
        say('holding');
        await waitForGo(process.env.YEONJAE_RELEASE_TOKEN ?? 'release');
      }
      if (process.env.YEONJAE_SETTLE === '1') {
        await reservation.release(cents);
        say('settled', { cents });
      }
    } catch (err) {
      say('refused', { code: err?.code ?? 'UNKNOWN' });
    }
  } else {
    say('error', { message: `unknown role ${role}` });
    process.exitCode = 2;
  }
} catch (err) {
  say('error', { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
} finally {
  // A child that leaked its pool would keep a connection open and make the parent's no-leak assertion
  // fail for the wrong reason.
  await pool.end().catch(() => {});
  say('exiting');
}
