# Progress — durable project state

The single place that records implementation status (ADR-0043). Update it in every checkpoint commit.
Everything else in `docs/` describes design; only this file claims what exists and what has run.

## Current state

| Item | Value |
| --- | --- |
| Project | Yeonjae Studio — English manuscripts in the Korean serialized-webnovel tradition |
| Phase | **Checkpoint 7 — complete and merged upstream** via [PR #10](https://github.com/jsisiwb/New/pull/10) at `59d62752f31261a0c86921603993f37992194dd2`. **Phase 4 — MVP hardening is ACTIVE and incomplete.** Its credential-free DETERMINISTIC portions are **MERGED UPSTREAM** via [PR #12](https://github.com/jsisiwb/New/pull/12) at `99e6bf5ccf962c2283589745ccbef7983cb682d6`, the reviewed 100-set contrast corpus via [PR #13](https://github.com/jsisiwb/New/pull/13) at `4df7d92ff3d1641da0f0f270940aa31d33c7cc89`, and **active-request cancellation (automated scope) via [PR #14](https://github.com/jsisiwb/New/pull/14) at merge commit `30cb62af6fed0ac685fe29d44cae0f471577aab1`** (parents: the previous upstream base `4df7d92ff3d1641da0f0f270940aa31d33c7cc89` and the reviewed cancellation head `b1ea8f2af7dea24868f8d32b73c8f64c841d09a2`), each verified by reading the merge commit's parents directly. Merged: the deterministic halves of B-4-1, B-4-2, B-4-3, B-4-4 and B-4-6, B-4-5's blinded reviewer tooling, **B-4-5a** (the automated corpus expansion to 100 distinct sets) and the automated cancellation scope (propagation through gateway, retry, repair, fallback, workflow/activity and durable-state paths). **Database least-privilege hardening is implemented for its automated scope in the current continuation** (see the Phase 4 section below). Still **not run** because each needs a paid provider, a deployment environment, repository administration or a human reviewer: the live 20-chapter × five-night validation, confirmed remote cancellation and post-cancellation billing reconciliation, the real-provider outage drill, staging/production restore, PITR, live credential rotation, real billing calibration, production vector retrieval and the bilingual human review. **Neither B-4-1, B-4-2, B-4-5 nor Phase 4 is complete.** Checkpoint 6 merged via upstream PR #9 at `6195700`; Checkpoint 5 via PR #8 at `c8cfb59`; Checkpoints 0–4 in PRs #1–#4 |
| Default branch | `hoplite/ainos-1ac771f8` in `jsisiwb/New` — the upstream base/default development branch, **now at the active-cancellation merge commit `30cb62af6fed0ac685fe29d44cae0f471577aab1`** (parents: the previous upstream base `4df7d92ff3d1641da0f0f270940aa31d33c7cc89` and the reviewed cancellation head `b1ea8f2af7dea24868f8d32b73c8f64c841d09a2`). Upstream [PR #14](https://github.com/jsisiwb/New/pull/14) is **merged**; the historical fork staging PR [sigma30web/New#1](https://github.com/sigma30web/New/pull/1) is **closed without being merged**. The base branch resolves to the same SHA `30cb62af…` in `jsisiwb/New` (read-only upstream) and `sigma31web/New` (the current writable fork), verified by reading each remote's ref |
| Working branch | **Active:** `hoplite/akragas-7c1f75a8` in the writable fork `sigma31web/New`, open as a **draft staging PR that must not be merged**. It was created at exactly the base SHA `30cb62af6fed0ac685fe29d44cae0f471577aab1` — a clean continuation, with nothing recovered or copied from any earlier fork. Markers on this branch: `--least-privilege-start-30cb62af` and `--least-privilege-baseline-30cb62af`, both at the base SHA, plus the final review marker recorded in the Phase 4 section below. **HISTORICAL PROVENANCE ONLY (never written to from here):** `hoplite/pistiros-8c5d93b0` @ `b1ea8f2af7dea24868f8d32b73c8f64c841d09a2` in `sigma30web/New`, whose head is the second parent of the upstream merge, whose staging PR #1 is closed unmerged, and whose merge marker `--active-cancellation-merged-30cb62af` resolves to the merge commit; earlier still, `hoplite/morgantina-64e49616` @ `bafc9cc23ce632608f38ed3984ea5c0ccc3b72df` in `sigma29web/New`, `hoplite/akraiphia-akraiphnion-258b962b` @ `fecd79ede8142a2485959e688f679c1785a88b82` in `sigma28web/New`, and the forks `sigma23web`–`sigma30web/New`. No published commit was ever rewritten across these continuations, and no unpublished branch from an earlier fork was recovered into this one. Upstream branch protection remains **unavailable/unconfigured**, so the compensating controls stay procedural: fork-only implementation, no base-branch writes, draft staging PRs, green push and PR CI, immutable markers, no force-push, and no merge without explicit authorization |
| Application code | pnpm workspace: `packages/prose`, `packages/domain`, `packages/db` (migrations 0001–0004 — 0004 adds `workflow_id`/idempotency/`pins` on `jobs`, `workflow_artifacts` content-addressed store, `dependency_edges`; `canon.commit_delta`, `canon.rollback_latest`, bitemporal helpers, `retrieval.ts` accepted-only reads, lexical search, summaries, ACS/pack persistence), `packages/canon` (deterministic verifier + acceptance), `packages/narrative` (profile store, composition, Block compiler), `packages/prompts` (25 immutable prompt families v1.0.0, registry, prompt sets), `packages/gateway` (Guard, routing, budget, repair, output-language path, audit; Mock/Replay providers — Replay gains `activity:<id>` binding), `packages/context` (Active Constraint Set compiler, 4 pack templates, query plan, structured fetch, Postgres FTS retriever + vector interface, T0–T3 assembler with ladder, provenance renderer, manifest + pack hash, validation, `buildPack`), `packages/workflows` (Postgres-checkpointed `runStep` runtime, planning/drafting/evaluation/revision/acceptance stages, `produceChapter` core loop with previous-chapter gate before spend, `workflowStatus`, `exportAccepted`; Replay fixture `examples/fixture/ch01`), `apps/cli` (incl. `chapter:produce` / `chapter:status` / `chapter:resume` / `export:accepted` operator surface over the production workflow, replay-only), `apps/api` (Checkpoint 7: Fastify `/v1` operator API — session/API-key authentication, membership-derived authorization, RLS-scoped connections, RFC 9457 problem details, `Idempotency-Key` handling, cursor pagination, security headers, health/readiness, audit log; migration 0006 adds identity, membership, row-level security on every workspace-owned table, API idempotency keys, job control columns, the append-only `job_events` log and the `exports` table; migration 0007 narrows the request-scoped role's grants to least privilege after the audit; migration 0008 adds fenced target leases; migration 0009 adds `canon.assert_lease_fence`, the in-transaction fence assertion that makes fencing atomic with the write it protects (ADR-0048); migration 0010 adds the operator-editable `/v1` write resource families; job control + SSE, accepted-only TXT/DOCX export, the canon correction/retcon/regeneration-preview/rollback HTTP surface, canon/cost/budget inspector reads, structured-log + trace-correlated observability with redaction, the per-process sliding-window rate limiter and the default-deny CORS allowlist are delivered), `apps/worker` (Checkpoint 7: Temporal worker over the proven chapter loop, ADR-0047 — deterministic workflow ids, fenced target leases, versioned prose-free activity contracts, typed retry classification, pause/resume/cancel signals, progress queries, deterministic history replay; replay-only provider routing with no live-call path), `apps/web` (Checkpoint 7: Next.js 16 / React 19 operator application covering all 11 operator work areas over the real `/v1` API, with journey, accessibility and keyboard-path tests) |
| CI | `planning-validation.yml` (validator) + `ci.yml` (Postgres 16 service; types-fresh, typecheck, lint, format, unit + integration tests, the 120-chapter replay, the chaos drills, the disposable restore drill, the defensive security suite, the deterministic cost suite, the contrast regression, CLI/API/worker/web smoke, web production build, dependency-audit gate, gitleaks) on every push/PR. Each of the five explicit hardening suites is run by its own runner AND verified again from its own durable report (`coverage/chaos-report.json`, `restore-drill-report.json`, `security-report.json`, `cost-report.json`) rather than from `coverage/junit.xml`, which every later vitest invocation overwrites — the defect D-4 repair. `pnpm check` runs the same sequence including all five suites (the defect D-7 repair); gitleaks is the one documented CI-only difference and is **unavailable locally**. **Latest upstream evidence: on the Phase 4 deterministic-integration merge commit `99e6bf5c`, [ci](https://github.com/jsisiwb/New/actions/runs/35205393002) and [planning-validation](https://github.com/jsisiwb/New/actions/runs/35205392869) both succeeded, with secret scanning green.** A PR with zero check runs is unverified, never "green" |

## Checkpoints

| # | Name | Branch | Status | PR |
| --- | --- | --- | --- | --- |
| 0 | Corrected planning baseline (audit, ADR-0037…0044, validator, schemas, fixture, policies) | `hoplite/prokonnesos-fc9b87c1` | done, awaiting review | [#1](https://github.com/jsisiwb/New/pull/1) |
| 1 | Repository foundation (pnpm workspace, TS strict, lint/format/test, schema→types lockstep, CI, mock provider, CLI skeleton, code-point/length/language primitives, StoryClock + lifecycle machines, policy loader) | `…--build-01-foundation` (stacked on 0) | done, awaiting review | [#2](https://github.com/jsisiwb/New/pull/2) |
| 2 | Domain, database and canon core (migration 0001; immutable versions; code-point evidence trigger; frame × timeline rule; `canon.commit_delta` with change classes + complete `inverse`; `canon.rollback_latest`; quarantine; bitemporal helpers; verifier; CLI DB commands) | `…--build-01-foundation--build-02-domain-canon` (stacked on 1) | done, awaiting review | [#3](https://github.com/jsisiwb/New/pull/3) |
| 3 | Narrative identity (profiles as data, composition, Block compiler with role variants, both contract hashes, shedding, overflow error), prompt registry (24 families, immutable content-hashed versions, strict variables, prompt sets), gateway (fail-closed Guard, routing, budget guard, bounded repair, truncation, output-language discard→regenerate→reroute, idempotent audit; Mock/Replay/fault providers), migration 0002 (append-only `llm_calls` with both contract hashes, immutable `prompt_versions`, `jobs`/`job_steps`) | `…--build-02-domain-canon--build-03-identity-gateway` (stacked on 2) | done, awaiting review | [#4](https://github.com/jsisiwb/New/pull/4) |
| 4 | Context and retrieval (Active Constraint Set compiler with `CONSTRAINTS_OVERFLOW`; templates `pack.scene_writer` / `pack.chapter_planner` / `pack.continuity_checker` / `pack.extractor` v1.0.0; deterministic query plan; structured canon fetch at the pinned canon version on the contract timeline — states with evidence, knower-specific knowledge with secrets and prior-loop/source-story memory labels, directional relationships + register, promises, events, world rules; previous accepted chapter L1 + verbatim tail + hook + committed deltas + elapsed time; migration 0003 `summaries` / `search_documents` (accepted-only triggers, idempotent indexing, de-acceptance cleanup) / `active_constraint_sets` / `context_packs` / `embedding_sets`; Postgres FTS retriever + `VectorRetriever` interface; T0–T3 with `PACK_T0_OVERFLOW` / `PACK_T1_OVERFLOW` and the ladder; provenance-tagged rendering; manifest with sections, sources, versions, rank scores, drop reasons, degradation flags, pack hash; pre-call validation; `pack:build` CLI; ADR-0045) | `…--build-03-identity-gateway--build-04-context-retrieval` (stacked on 3) | done, awaiting review | stacked on #4 |
| 5 | Chapter-production vertical slice (deterministic Postgres-checkpointed core loop: intake → spec → bible → arc → locked contract → scene plan → draft → checks → bounded revision → approval-lock → extraction → verification → atomic commit → L1 summary + accepted-only index + dependency edges; ch.1 → ch.2 carries summary/tail/hook/deltas; `exportAccepted`; migration 0004 `jobs.workflow_id`/idempotency/`pins` + `workflow_artifacts`; Replay `activity:<id>` binding; CLI `chapter:produce` / `chapter:status` / `chapter:resume` / `export:accepted` operator surface with replay-only routing, JSON output, nonzero exit on failure; ADR-0046) | `hoplite/kos-969b8d7e--checkpoint-05-completion` | done, merged | upstream [#8](https://github.com/jsisiwb/New/pull/8) |
| 6 | Quality and long-form validation | merged upstream at `6195700` (developed on `hoplite/megale-polis-83bf1984` in the historical fork `sigma23web/New`) | done, merged | [#9](https://github.com/jsisiwb/New/pull/9) |
| 7 | Interface and hardening (identity/RLS, complete versioned `/v1` API incl. all write families, job control + SSE, accepted-only TXT/DOCX export, durable Temporal orchestration, atomic lease fencing, canon correction/retcon/rollback + HTTP surface, inspectors, observability, rate limiting, CORS allowlist, runbooks, `apps/web` with all 11 operator work areas) | merged into `hoplite/ainos-1ac771f8` at `59d6275` (work branch `hoplite/medma-023f017e` @ `2f51c4e`, historical) | **complete and merged upstream; post-merge CI and planning validation green. See the Checkpoint 7 table for the authoritative per-item state and its open limitations** | [#10](https://github.com/jsisiwb/New/pull/10) (merged) |

PR dependency rule: each checkpoint PR is based on the previous checkpoint branch and states its parent;
merge bottom-up. No PR is merged without explicit user authorization.

## Validation commands and latest results

| Command | Purpose | Last result |
| --- | --- | --- |
| `pip install jsonschema && python3 tools/validate-planning-package.py` | schemas, examples, canon-delta union, evidence offsets against fixture manuscripts, cross-file refs, stale terms, truthfulness | **ALL OK** (33 schemas, all `$ref` resolved; 0 contradiction / stale-term hits) — re-run at Checkpoint 7 closeout |
| `DATABASE_URL=postgres://… CI=true pnpm check` | types-fresh → typecheck → lint → format:check → unit + Postgres integration tests → web build → validator → contrast | **local green at Checkpoint 7 closeout** on the merge commit `59d6275`: generated types fresh (33 schemas), typecheck / lint / format:check clean, **55 test files / 772 tests passed**, planning validation ALL OK, contrast 800 evaluations with 280/280 agreement and 0 false positives / 0 false negatives, `pnpm audit --audit-level=high` no known vulnerabilities, `git diff --check` clean; PostgreSQL 16, Node 22.23.2, pnpm 10.26.0, Python 3.12.3. Local green is not GitHub green: see the PR's Actions runs for CI evidence |
| `pnpm cli identity:compile project/…@1 writer_full 2000` | compiles the fixture identity block: both contracts first, 11 sections, 1,272 est. tokens, deterministic hash | ok |
| `pnpm cli prompts:list` | 25 immutable prompt versions + active prompt set id | ok |
| `pnpm cli verify-evidence examples/fixture/manuscripts/ch09.accepted.txt examples/fixture/canon-delta.ch09.json` | code-point evidence verification via the CLI | ok: 8 spans verified |
| `pnpm cli db:migrate … manuscript:import … manuscript:approve … canon:accept … canon:state-at` | end-to-end: import fixture ch.9, approval-lock, verified atomic commit (version 0 → 1), state query at ch.11 returns the venom injury | ok (see PR #3 body) |
| `pnpm cli db:migrate` (0003) → `project:create` → `entity:create` ×4 → `manuscript:import` ch.9 → `manuscript:approve` → `canon:accept` (fixture delta remapped) → `summary:set 9` → `search:index` → `pack:build <project> 10 scene_writer contract.json spec.json --persist --identity=project/…@1` | Checkpoint 4 smoke: chapter 10 writer pack over the real canon — 10 sections, 4,057 est. tokens of 24,000 (T0 2,751 / T1 1,083 / T2 223), previous chapter 9 pinned (v1, canon v1, 422-word tail, tail hash), 32 included / 53 excluded (`diversity_cap`), all 11 validation checks true, `degradation.vector = not_configured`, manifest persisted (`stored: true`) | ok |
| `pnpm cli constraints:compile 12 examples/fixture/story-spec.v3.json` | Active Constraint Set for ch.12 from the fixture spec (12 hard incl. one merged duplicate, 4 soft, 2 assumptions, 3 excluded by scope/retirement); cap 100 → `CONSTRAINTS_OVERFLOW` | ok |

Tests not run: none skipped locally at closeout — all 55 files / 772 tests executed with `DATABASE_URL` set,
so the Postgres integration suites ran rather than skipping. Without `DATABASE_URL` the integration suites
skip visibly. `gitleaks` is **not installed in the local sandbox and was therefore not run locally**; it runs
in CI, where the "Secret scanning (gitleaks)" check on the merge commit `59d6275` succeeded.
`pnpm audit --audit-level=high` reported no known vulnerabilities.
Live-model tests: **none executed, ever**; nothing in this repository is evidence of live-model prose quality.
Vector retrieval has no implementation (interface + `embedding_sets` registry only, ADR-0045).

Checkpoint 4 test inventory (`packages/context`): unit — constraints (6: scope selection, stable ids, dedupe,
classification, determinism, scope-driven hash change, `CONSTRAINTS_OVERFLOW`, locked facts, non-English
text without paraphrase refused, scope predicate); assembler (21: identical inputs → identical bytes/section
hashes/pack hash + schema-valid manifest; item order irrelevant; canon version / Narrative Identity /
Production Policy changes alter the hash; provenance + source version on every item and line; T0 survives
trimming; `PACK_T0_OVERFLOW`; ladder then `PACK_T1_OVERFLOW`; deterministic T2 ranking, diversity cap, T1
dedupe; T16 rejected draft excluded with reason and phrase absent, mandatory draft → `PROHIBITED_SOURCE`;
untrusted text excluded and never in the system position; other-project items excluded; contract rendered as
PLANNED; k−1 summary/tail/hook/deltas with pins; k > 1 without accepted k−1 fails validation; stale canon
version / other timeline fail the pin check; writer pack passes the gateway Guard; templates ↔ registry roles
and identity variants; checker/extractor job-scoped text; deterministic query plan). Postgres integration
(12): quarantined draft not indexed/summarizable/retrievable and indexing idempotent; k receives k−1 L1 +
tail + hook + committed deltas + pins + elapsed time + evidence-bearing states + locked facts, manifest and
ACS persisted; determinism over the DB + idempotent persistence; knower-specific knowledge, secrets, T0
guards; directional + time-correct relationships (ch.10 vs ch.4); prior-loop isolation with labeled memory;
distant ch.3 event recovered lexically with provenance, nothing ≥ k, nothing non-accepted; lexical/vector
outage degrades with flags; dead DB → `STRUCTURED_RETRIEVAL_UNAVAILABLE`; k−1 working/missing →
`PREVIOUS_CHAPTER_NOT_ACCEPTED`; rollback removes search documents + summary and unbuilds k; checker accepts
`working` job text, extractor only `approved`, quarantined ids refused. Repair regression (`packages/db`):
version numbering across quarantined versions.

## Verification of the inherited stack (this session, 2026-09-14)

- Repository `jsisiwb/New` read via the public API and `git fetch`; default branch `hoplite/ainos-1ac771f8`
  (`2823bb9`). PRs #1–#4 open, none merged, bases chain #1 → #2 → #3 → #4 as recorded; heads `ae11f05`,
  `1ee4a80`, `21e054f`, `0a01e80` match the handoff; nothing was pushed after `0a01e80`. GitHub Actions
  (`ci`, `planning-validation`, gitleaks) succeeded on every head.
- `DATABASE_URL=… CI=true pnpm check` at `0a01e80` (Node 22.23.2, pnpm 10.26.0, Postgres 16.14): 18 files,
  116 tests passed, validator ALL OK — the recorded Checkpoint 3 state is confirmed.
- Defect found and repaired on this branch (not blocking merge of #1–#4, fixed forward): manuscript version
  numbering could reuse a quarantined version's `version_no` (see decisions log).
- Merge verdict: PRs #1–#4 are internally consistent and green; merging remains a user decision (none
  authorized). Merge order #1 → #2 → #3 → #4, retargeting each next PR to the default branch after the
  previous merge.

## Known failures / gaps

- Contrast sets: 100 sets in the repo (5 genres × 8 narrative functions, two or three sets per cell),
  above the ≥ 40 pre-calibration target of B-6-3. The judge calibration run itself is still outstanding:
  the expectations in `contrast-sets.seed.json` are authored starting expectations, not measured judge
  output, and thresholds stay `uncalibrated` until B-4-5 runs them against live judges with bilingual
  reviewers.
- Fixture manuscripts: only ch.9 (accepted) and its rejected draft exist as text; ch.12/ch.14 evidence is
  described, not addressable, until Checkpoint 5 produces them.
- Thresholds in profiles and policies are `uncalibrated`.
- **B-4-5 is PARTIAL.** Its automated portion **B-4-5a is implemented**: the contrast corpus is now
  **100 accepted sets**, expanded from 40 by authoring `cs-041`–`cs-100` in validated five-set batches
  under the deterministic distinctness and coverage gate (`packages/eval/src/distinctness.ts`), which was
  not weakened and whose 0.60 near-duplicate threshold was not moved. See "B-4-5a corpus expansion" below
  for the metrics. **This is not human calibration.** Blinded reviewer tooling exists and is tested, but
  **generated packets are not human review**: no reviewer has seen one, no judgment exists, the bilingual
  reviewer round specified in `docs/07-quality/01-testing-strategy.md` §6 has not run, and calibration
  stays `uncalibrated`. B-4-5 remains incomplete until that reviewer process is executed.
- **Phase 4 external blockers, all still open.** Live 20-chapter × five-night validation (B-4-1b) and the
  real-provider outage drill (B-4-2b) need paid providers. Staging restore, production restore, PITR,
  off-site backup and RTO/RPO (B-4-3c) need a deployment environment. Live credential rotation (B-4-3d)
  needs a secret manager and real credentials. Bilingual human review (B-4-5c) needs human reviewers. Real
  billing calibration (B-4-6c) needs live providers and provider invoices. None of these has been
  simulated, approximated or claimed.
- **Restore evidence is scoped to a local disposable database.** The drill proves a logical
  `pg_dump`/`pg_restore` round trip. It is not PITR, not a staging restore, not a production restore, not
  off-site backup verification, and it measures no RTO/RPO.
- **Cost evidence is synthetic/replay.** Monetary values come from fixtures served by the replay provider.
  No live call, no price table, no invoice — `real_billing_calibrated` is `false` in the durable report.
- **Security coverage is the automated application surface only.** There is no WAF, no network-layer
  control and no external penetration test, and metrics and rate limiting remain per process.
- gitleaks is **unavailable locally** in the development sandbox; it runs in CI only.
- Upstream **branch protection is unavailable/unconfigured**; the compensating controls are procedural.

## Unresolved risks (see `03-risk-analysis.md`)

R1/R2 (translation-like vs Western-pacing drift) remain the top product risks and are not testable until
Checkpoint 3 (gateway + judges) and Checkpoint 6 (contrast-set regression on live models).

## Checkpoint 4 limitations (recorded, not hidden)

- Vector retrieval: interface + `embedding_sets` registry only; no embedder, no pgvector (ADR-0045). Packs
  report `degradation.vector = not_configured`.
- Lexical search uses the `english` FTS configuration without the per-project name thesaurus
  (`05-retrieval-and-indexing.md` §3); entity tagging covers names/short forms/aliases. Thesaurus is B-1-13
  follow-up.
- L1 summaries are stored by `summary:set` (operator/tests); the `factual_summarizer` call that produces them
  belongs to the Checkpoint 5 acceptance workflow. The same workflow will call `canon.index_accepted_version`
  inside the acceptance transaction and write dependency edges from stored packs (ADR-0032).
- Token counts use `english_estimator_v1` (words × 1.3); the manifest records the estimator id so a tokenizer
  can replace it without changing the schema.
- The three Production Policies gained `context.input_budget_tokens` and new content hashes at `version: 1`
  (no project pins them yet).

## Next exact tasks (Checkpoint 5 — chapter-production vertical slice): done in this change

1. ~~`git checkout -b …--build-04-context-retrieval--build-05-chapter-vertical-slice` from the Checkpoint 4 head.~~
   Landed as `hoplite/kos-969b8d7e--checkpoint-05-completion` (repair of
   the WIP slice merged as PR #7 at `4ea8ecd`; fork staging PR `huuuiuh/New#1`, upstream integration PR
   targeting `jsisiwb/New:hoplite/ainos-1ac771f8`).
2. `packages/workflows` (Postgres-checkpointed idempotent steps, ADR-0044/ADR-0046): intake →
   `requirement_interpreter` → Story Spec → assumptions → bible commit → arc → `chapter_planner` with
   `pack.chapter_planner` → Chapter Contract (validated, locked) → `pack.scene_writer` → `scene_planner` →
   `scene_writer` per scene through `ReplayProvider` → assembly → deterministic checks → replayed evaluators
   → targeted revision → approval-lock → `canon_extractor` with `pack.extractor` → `verifyDelta` →
   `acceptChapter` (+ `factual_summarizer` L1, `indexAcceptedVersion`, dependency edges) → Chapter 2 pack
   proving it carries Chapter 1's summary/tail/hook/deltas → export. Done; 22/22 integration tests
   (incl. T19b global-identity collision proof).
3. Replay recordings for every fixture call (no live provider). Done (`examples/fixture/ch01/replay.ch01.json`,
   prompt-hash + `activity:<id>` binding, `misses == []`).
4. CLI operator surface over the production workflow. Done in this change: `chapter:produce <project> <ch>`
   (runs/resumes `produceChapter` with replay-only routing, deterministic workflow id, JSON summary, nonzero
   exit on failure), `chapter:status <workflow-id>`, `chapter:resume <workflow-id>` (same resume entrypoint,
   explicit), `export:accepted <project>` (accepted manuscripts only; `--full` prints text, default prints
   hashes/sizes); 5 CLI chapter-surface tests (success, idempotent repeat, failure, interrupt→resume, export).
   Remaining follow-ups (not in this change): per-project name thesaurus (B-1-13); Checkpoint 6
   quality/long-form scope.

## Checkpoint 7 — interface and hardening (complete, merged upstream at `59d6275`)

Merged into the upstream base/default development branch `hoplite/ainos-1ac771f8` via
[PR #10](https://github.com/jsisiwb/New/pull/10) at merge commit
`59d62752f31261a0c86921603993f37992194dd2` (parents `6195700a068b04108e26f87affd738842f39a15a`, the
Checkpoint 6 merge, and `2f51c4ecef685a28a4ab717934510d9a20a26483`, the Checkpoint 7 head). Post-merge
workflows on the merge commit are green: [ci](https://github.com/jsisiwb/New/actions/runs/35131086126) and
[planning-validation](https://github.com/jsisiwb/New/actions/runs/35131086114), all three check runs —
typecheck/lint/format/generated-types/tests with PostgreSQL 16, planning-package validation, and gitleaks
secret scanning — succeeded.

Every item below is exercised by tests against a real PostgreSQL 16, with no live paid-provider calls. The
limitations in the final row remain open and are recorded rather than closed:

| Item | State |
| --- | --- |
| Identity and membership | **done**: `users` with a salted scrypt verifier whose parameters are stored per row; `sessions` and `api_keys` stored as SHA-256 of a high-entropy secret with expiry and revocation as columns; `workspace_members` as the single source of a principal's role. Constant-time comparisons; a missing account still spends comparable work so it is not detectable by timing. 25 tests |
| App-role least privilege (audit repair) | **done**: a forensic audit of the recovered migration 0006 found its RLS design sound but its grants too wide on the tables that deliberately have no workspace column, where a policy cannot compensate. `users`/`sessions` were fully writable by `yeonjae_app` (every password verifier and session/CSRF hash readable; a verifier overwritable); `schema_migrations` was deletable, proven by probe — all rows removed, after which `migrate()` would replay every migration; `prompt_sets` had no immutability trigger, unlike `prompt_versions`, and was writable, so a pinned role→version mapping could be repointed silently; `api_keys` was insertable and `workspace_members` updatable, letting a request-scoped connection manufacture its own credential or owner role. Migration 0007 revokes what the request path never needs (authentication runs on the unscoped pool before a workspace is proven), adds the missing `prompt_sets` append-only trigger, and narrows `ALTER DEFAULT PRIVILEGES` so a future table cannot be silently writable without a policy. 9 regression tests, each failing against 0006 alone |
| Workspace isolation (RLS) | **done**: row-level security ENABLED **and** FORCED on every workspace-owned table, including the `*_evidence` join tables isolated through their parent. Because a superuser bypasses RLS unconditionally, migration 0006 adds the non-superuser role `yeonjae_app` and `withWorkspace()` switches to it with a transaction-local `app.workspace_id` — otherwise the policies would never bite for the application's own connection. Proved by reads that deliberately omit a `workspace_id` predicate, by naming a foreign row id explicitly, by an unset context returning nothing, and by a refused cross-workspace INSERT. `prompt_sets`/`prompt_versions` are deliberately excluded as the global immutable prompt registry (ADR-0016), not tenant data |
| Versioned `/v1` API — platform foundation and read surfaces | **done**: `apps/api` (Fastify) implements authentication (session cookie + bearer API key), membership-derived authorization with the viewer/editor/owner matrix, RLS-scoped request handling, RFC 9457 problem details over the workflow layer's existing stable code vocabulary, `Idempotency-Key` bound to (workspace, method, route, request hash), cursor pagination, conservative security headers, health/readiness, an append-only audit log, and read surfaces for projects, chapters/versions, canon commits, entities, timeline, jobs, workflow status and an accepted-only export preview. 35 contract tests. (This row covers the foundation only; the write resource families, canon/inspector surfaces, SSE, export, observability, rate limiting and CORS are the separate rows below, all delivered — the API as a whole is complete for Checkpoint 7 scope) |
| Job control and SSE | **done**: migration 0006's `jobs.control` columns and `job_events` have execution semantics. Control is an intent, not an interrupt — `checkpointControl` runs BEFORE a step, so a pause or cancel stops at a checkpoint boundary, no step is torn in half, resumption replays completed steps from `job_steps` without re-spending, and a cancel that lands before acceptance leaves its artifacts noncanonical (asserted: zero `canon_commits`). Terminal jobs accept nothing, a duplicate cancel emits no second event, and a cancelling job is never downgraded to paused. `GET /v1/jobs/{id}/events` streams the append-only log: `Last-Event-ID` replay is exact (the cursor only moves forward), `seq` is allocated inside the INSERT so concurrent emitters cannot collide, heartbeats are comment frames, a terminal event closes the stream, and event payloads are refused if they carry prose, prompt text or a credential. 46 tests (16 durable control, 12 stream, 5 verb dispatch, 13 HTTP) |
| Accepted-only TXT and DOCX export | **done**: `POST /v1/projects/{id}/exports`, status read and authorized download, with artifacts materialized in `exports.content` — a download names an export id, so no filesystem path exists in the request at any point. The accepted-only rule is NOT re-implemented: rendering goes through Checkpoint 5's `exportAccepted`, whose `acceptedChapter` gate requires an accepted chapter AND an accepted manuscript row with an `accepted_commit_id`. Proved against a chapter accepted by the real replay workflow, with a working draft, a quarantined draft and a losing candidate planted alongside: none appears in the TXT, in the DOCX text, or in the raw bytes of either. DOCX is written by `docx` (OOXML) and unzipped and parsed in the test. TXT is byte-identical across runs; the DOCX *content* hash matches TXT's, since ZIP metadata makes container bytes nondeterministic. 13 tests |
| Durable orchestration (Temporal, `apps/worker`) | **done** (ADR-0047): ADR-0003/ADR-0044 placed Temporal at Checkpoint 7 "once the core loop is proven". `apps/worker` runs a Temporal worker whose workflow is deliberately small — acquire lease → observe control → produce → settle → release — and contains no planning, selection, extraction or commit logic. Checkpoint 5's `produceChapter` is wrapped as ONE durable activity and keeps its Postgres checkpoint log, so durability composes rather than duplicating: Postgres gives step-level exactly-once (a restarted run replays `job_steps` and re-spends nothing), Temporal gives run-level durable timers, typed retries, signals, history replay, cancellation scopes and worker-restart recovery. ADR-0047 records why the literal per-step decomposition of ADR-0044 §2 was NOT applied: it would fork the canon invariants into a second, weaker implementation. Activity contracts are versioned and carry no prose (the intake and bible pass as content-addressed artifact ids); an unknown version is rejected, never reinterpreted. Failures are classified by meaning — provider/network retry, validation/policy/budget refusals are non-retryable. Two independent duplicate-start defences: the deterministic workflow id with an allow-duplicate-failed-only reuse policy, and migration 0008's target leases with a TTL (a dead worker cannot block a target) and a monotone fence (a revived zombie cannot act after its lease is stolen). Proved on Temporal's locally downloaded time-skipping test server with replayed model calls — no paid infrastructure, no credentials: acceptance advancing canon exactly once, duplicate start refused with one job and one commit chain, lease contention reported with the holder, zombie fencing, worker restart resuming with model-call count equal to a clean run, cancel-before-commit leaving zero canon commits and artifacts recorded noncanonical, pause honoured before any spend, a permanent failure not retried (max step attempt 1), contract-version refusal, and deterministic workflow-history replay. 11 tests |
| Correction, retcon and rollback | **done** for the canon-service layer: `impactOf` / `regenerationPreview` / `rollbackImpact` compute a read-only impact report (a dry run cannot have a side effect), and ADR-0032's split is honoured from the recorded edge materiality rather than inferred — material dependents become **stale**, contextual dependents become **review suggestions** only. Corrections and retcons commit through `canon.commit_delta` with `source = 'user_correction'` / `'retcon'`, so they inherit every acceptance check (change class, evidence, frame, validity, atomic optimistic version) instead of getting a second, weaker path; evidence-backed canon is not relaxed for operators (a corrected fact with no span is refused as `EVIDENCE_REQUIRED`). Justification is mandatory, a retcon additionally requires explicit human confirmation and carries its exposure in the refusal, and there is no Beta-only automatic patch engine — affected chapters go stale for a human. Nothing is deleted: a correction supersedes and links the prior row, whose evidence stays readable; rollback retracts by version (row counts unchanged) and MVP latest-only is enforced, including refusing to roll back a rollback. An approved report that has gone out of date is a typed `CANON_STALE` conflict, and two concurrent corrections leave exactly one winner with the loser typed. 15 tests |
| Corrective audit of orchestration and job control | **done**: a review of the Checkpoint 7 orchestration found four real defects, each now fixed with a test that failed before the fix. (1) **Lease renewal failure was ignored** — the heartbeat discarded both a `false` result and a thrown error, so a worker could keep drafting, evaluating and committing canon after its lease expired or was stolen at a higher fence. Ownership is now a separate read (`leaseOwnership`) that distinguishes *lost* (released / expired / fenced out, with the current holder named) from *unknown* (database unreachable), because the two demand opposite responses: fail closed on the first, retry on the second. `runStep` re-verifies ownership **before every step**, so a fenced-out run stops before its next durable side effect rather than at an arbitrary point inside one. (2) **Mid-run control was not observed** — `checkpointControl` was called only before and after the whole activity, so a pause or cancel issued during drafting, evaluation or extraction was not seen until the pipeline finished. It is now called inside `runStep`, the only place that knows a unit of work has not begun; replayed steps deliberately skip the check, since replay performs no work and no spend. (3) **A late cancel relabelled accepted canon** — a cancel losing the race with the atomic commit produced a self-contradictory state (job `cancelled`, chapter `accepted`, canon advanced). A late cancel is now reported as `too_late`, the job settles `completed`, and the ignored request is recorded in the job's history. (4) **A completed run emitted no terminal job event**, so an SSE client could not distinguish "finished" from "idle"; `finishJob` now closes every completed run exactly once. Additionally, `produceChapter` no longer relabels a control stop as `failed`. Proved with the control request submitted **while the pipeline is actively running** (the test polls the persisted step and acts mid-flight), not seeded before start: 10 tests |
| Atomic lease fencing (TOCTOU closure) | **done** (ADR-0048, migration 0009): the previous corrective made lease loss *observable* at every step boundary, but a pre-step ownership read and the durable mutation it protects are separate transactions, so a lease could expire or be stolen between the check and the write and the write still landed — a genuine time-of-check/time-of-use gap that no existing test attacked, because the suite revoked leases *between* steps. `canon.assert_lease_fence` now RAISES `LEASE_LOST` and is executed as the first statement of the transaction that performs the protected write, so check and use are one atomic unit; its `FOR SHARE` lock on the lease row serializes against the `FOR UPDATE` a rival's steal takes, so a steal cannot interleave with an open fenced transaction. `withFencedTransaction` is the only sanctioned path for a lease-protected write and covers canon acceptance/commit, the approval lock and chapter status, winner enforcement (the selection decision and loser transitions), L1 summaries and accepted-only indexing, dependency-edge writes, and the job step-begin/running bookkeeping. Separately, a `false` renewal is now treated as **definitive** lease loss immediately (it is the database reporting the holder/fence pair is no longer live, not an ambiguity) while a *thrown* renewal error is still left to the ownership read, since a transport fault is not evidence about ownership. A takeover is always reported `fenced_out` rather than `released`, because telling an operator a target is free while a rival produces it is the more dangerous error. Proved by a deterministic barrier suite that reproduces the race by ordering — pre-step read, then a committed steal from a second connection, then the attempted mutation — with no timing-dependent sleeps standing in for the interleaving: stale worker refused with a typed `LEASE_LOST`/`fenced_out`, nothing written (canon does not advance, no chapter row created), expired/released/missing/stale-fence claims each refused with their own reason, renewal-`false` and the fenced write reaching the same verdict, the rightful holder completing, retries staying idempotent, and the unleased CLI path still working. Mutation-checked: with the assertion body replaced by `RETURN`, 8 of the 10 tests fail — so they detect the gap rather than passing vacuously. 10 tests |
| Canon operator HTTP surface (correction, retcon, regeneration preview, rollback) | **done**: the API plan's "Canon & inspectors" actions now have an authorized HTTP surface over the already-tested `packages/canon` services — `POST /v1/projects/{id}/canon:correct`, `:retcon`, `:rollback` and `GET /v1/projects/{id}/chapters/{n}/regeneration-preview`. The layer is deliberately thin: validation, role policy, an audit record and a safe serialization, with every canon rule (mandatory justification, evidence resolution, change classes, atomic commit against an expected version, latest-only rollback, explicit retcon confirmation, material-vs-contextual consequences) left where it already holds. Registered as ONE Fastify route dispatching through `requireVerb`, because Fastify reads `canon:retcon` as a parameter named `projectId:retcon` and separate registrations make the first handler silently answer all three — a request to `:rollback` running the correction handler would be an authorization hazard, since rollback is owner-only. Role policy: dry run = `viewer` (it is a read of consequences), correction commit = `editor`, retcon and rollback = `owner`. A dry run writes nothing at all — no canon commit, no idempotency record and no audit row claiming a change happened (`planned ≠ happened`). `expected_canon_version` is REQUIRED when committing rather than defaulted to current, because defaulting it would reduce the optimistic check to comparing a value with itself and silently absorb a commit that landed between the operator's report and their decision. A takeover of the `released`/`fenced_out` kind is not involved here; what is surfaced instead is `CANON_STALE` with both versions. 20 tests: unauthenticated refusal on every route, viewer-may-dry-run-but-not-commit, editor refused for retcon and rollback, cross-workspace project hidden behind the SAME 404 code as a nonexistent one (a distinguishable response would confirm the tenant), non-member refused with `NOT_A_MEMBER`, dry runs leaving canon/commits/audit untouched, regeneration preview marking nothing stale, missing and stale `expected_canon_version`, blank justification, unconfirmed retcon reported with `reason: CONFIRMATION_REQUIRED`, five malformed bodies, no SQL/stack/path/prose in any error, `Idempotency-Key` making a retried correction commit exactly once (and replaying rather than re-running, which a naive retry would now fail on), the same key with a changed payload refused `409 IDEMPOTENCY_KEY_REUSED`, two racing corrections yielding exactly one new canon version, a committed correction's audit row attributed to the authenticated user with no corrected value in it, a confirmed retcon recorded with `source = 'retcon'` and the superseded row still readable, and a rollback that refuses to roll back a rollback |
| Canon inspector, cost and budget reads | **done**: `GET /v1/projects/{id}/canon/facts` (entity/attribute filters, cursor pagination), `…/canon/promises` (status filter), `…/canon/facts/{factId}/evidence`, `…/canon/dependencies` (materiality filter), `…/canon/stale`, `…/costs?group_by=role|model|chapter` and `…/budgets`. All `viewer`, all read-only, all through the RLS-scoped connection. Three properties are the point and are tested, not asserted. (1) **Evidence is accepted-only.** Evidence spans quote manuscript text, so this is the one canon inspector that can surface prose; the route joins through to `manuscript_versions.status = 'accepted'`. Attempting to plant a counter-example showed the database is stronger still: `evidence_span_guard` refuses a span on a `working` version outright ("evidence may reference only immutable versions"), and `canon_write_guard` refuses ANY write to `fact_evidence` from outside `canon.commit_delta` — both refusals are now asserted, so the route's join is defence in depth over a database that already rejects the dangerous shapes. (2) **The material/contextual split survives the wire** (ADR-0032): dependents are filterable by materiality and `/canon/stale` states explicitly that contextual dependents are review suggestions, because flattening them would push operators into needless regeneration. (3) **Cost data cannot leak prose** — it is derived from the append-only `llm_calls` audit, which stores hashes, sizes and cents and never bodies; the test asserts the accepted text's opening does not appear in a cost report. Budgets report the PINNED `production_policy_version` rather than a copied threshold, so the API never becomes a second drifting source for policy numbers (ADR-0041). Repairs found while writing the tests: the facts projection named three columns that do not exist (`importance`, `committed_at_version`) and the cost query assumed token columns that live inside the `usage` jsonb; `/canon/stale` read a `stale_since_version` field that does not exist, since staleness is recorded on `chapters.status` and a manuscript version is immutable and therefore has no staleness field at all. 12 tests, incl. unauthenticated refusal on all six routes, cross-workspace 404s, a cursor walk at `limit=1` reproducing the unpaged order exactly, and malformed filters answered 422 rather than as an empty page |
| Observability: structured logs, trace correlation, metrics and redaction | **done** (observability plan §5): one line-delimited JSON record per request carrying `request_id`, an adopted `trace_id`, route pattern, method, status and duration; a `/metrics` endpoint in Prometheus text format covering request counts and latency, auth failures, rate-limit refusals, canon commits, lease loss, job control, SSE connections/replays, exports, budget blocks and provider attempts. The design decision worth recording is that redaction is **default-deny**, not a blocklist: `logFields` accepts only an explicit allowlist of key shapes (ids, `*_hash` digests, counts, closed enums, durations) and DROPS anything else, because a blocklist exposes every new field until somebody remembers to add it — and for logs sitting next to manuscripts, provider keys and session secrets the first forgotten field is a leak, not a cosmetic bug. Two narrow carve-outs are load-bearing and reasoned: a `*_hash` digest is permitted (a digest of prose is not prose; `content_hash`/`prompt_hash` are the plan's required span attributes) **except** for credential digests, since a password hash is the verifier an attacker cracks offline and a session/key hash is the stored form the server compares against; and `*_tokens`/`*_count`/`*_cents`/`*_ms`/`*_bytes`/`*_size` measures are permitted (a count cannot reconstruct prose) while the bare `input`/`output`/`text`/`prose` keys stay refused. Getting the plural/singular distinction right required stripping the measure suffix before applying the credential fragments — naive substring matching rejects `input_tokens` because it contains `token`. Nested objects and arrays are never rendered (an array becomes its length), strings are length-bounded, and `msg` is a fixed developer string never interpolated with request data. An inbound W3C `traceparent` is adopted ONLY if it strictly parses, so a client cannot inject text into logs or the `llm_calls` audit through the header; an all-zero or malformed id yields no trace id rather than a fabricated one. Metric labels use the route PATTERN (`/v1/projects/:projectId`), never the resolved path, so tenant ids never become label values — a leak and a cardinality explosion at once. `/metrics` is deliberately unauthenticated and safe to be so: it renders names, allowlisted labels and numbers only. **Honest scope: these are per-process counters that reset on restart and are scraped per instance; aggregation is the scraper's job and nothing here is a distributed counter.** 25 tests (15 unit + 10 integration): every unallowlisted field dropped incl. one on no blocklist, credential names refused despite safe identifier shapes, the login password / issued CSRF token / session cookie / email all absent from that request's log line, a bogus `Authorization` header refused (which is also correct fail-closed precedence over the session cookie) and never logged, accepted manuscript prose returned to the client by an export download and absent from the log, no stack/SQL/path in an error line, an injected `traceparent` ignored, and the metrics endpoint free of project, workspace, email and token values |
| Deployment and incident runbooks | **done**: `docs/08-delivery/11-deployment-and-incident-runbooks.md` covers prerequisites and pinned versions, PostgreSQL 16 setup, the `yeonjae_app` non-superuser/`NOBYPASSRLS` role and why both attributes matter (a superuser silently bypasses every RLS policy while leaving it visibly "enabled"), the 0001–0009 migration inventory with clean-database verification, Temporal for development (the SDK's time-skipping test server — no server and no credentials needed for `pnpm test`) and what a deployment would require, the environment variables the code actually reads, the replay/mock/**not-implemented-live** provider modes, startup and shutdown ordering, the liveness/readiness/metrics probes and why `/health` deliberately does not touch the database, local reproducible development, a production outline marked *not exercised*, backup/restore with post-restore integrity queries, application rollback and forward-only migration recovery, and twelve incident runbooks (provider outage, Temporal outage and worker restart, lost/fenced lease with the four reasons and their distinct actions, stuck/paused/cancelled job incl. `too_late`, stale canon conflict, canon repair, budget exhaustion, SSE disconnect/replay, credential compromise, export incident, logs and metrics triage). Truthfulness is enforced rather than asserted: every command was run against this repository, every undemonstrated procedure is labelled *not exercised*, §9.8 states that rate limiting is **not implemented** instead of describing a procedure for an absent control, §11 lists what does not exist (`apps/web`, object storage, KMS, OAuth, live providers, secret rotation with no key path to rotate), and §12 records the per-process metric scope, the absence of live-provider validation, uncalibrated evaluators, that fencing does not abort in-flight spend, and that vector retrieval is an interface only. Factual claims were checked against the code and schema rather than written from memory |
| Rate limiting and spoof-resistant client identity | **done** (security plan §2): a sliding-window limiter with per-scope limits (auth 10/min, job 20/min, mutation 60/min, stream 30/min, read 300/min), enforced in an `onRequest` hook. Three decisions are the substance. (1) **The limit runs BEFORE authentication.** A limiter placed after the auth check still pays for a scrypt verification on every guess, so it cannot stop credential stuffing; the test proves two wrong passwords exhaust the allowance and the *correct* password is then refused too, because the limit is on attempts rather than failures. (2) **`X-Forwarded-For` is ignored unless a proxy is explicitly trusted**, and `trustedProxies` is empty by default. A limiter keyed on a client-controlled header is not a limiter — an attacker rotates it and every request looks new, so the control silently does nothing while appearing configured — and it additionally lets an attacker impersonate a victim's address to exhaust their budget. When a proxy IS trusted, the rightmost *untrusted* hop is taken, because a client can prepend entries but cannot append after what the trusted proxies added. (3) **Sliding, not fixed-bucket**: a fixed bucket permits 4 requests in 3 seconds across a boundary while nominally honouring "2 per minute", which for an auth limit is the entire point. Refusals are not counted, so a limited client is not locked out beyond the window by its own retries; idle windows are swept so rotating identities cannot grow the map without bound; health, readiness and metrics are exempt, because throttling a probe would make a load balancer eject a healthy instance under exactly the load the limiter exists to survive. Refusals are RFC 9457 documents with `Retry-After` and a `retry_after_seconds` hint, carry the standard security headers, and increment `yeonjae_rate_limited_total{scope}`. **Honest limitation, also recorded in the runbooks: the window store is in-memory and per-process.** It resets on restart and is not shared, so N instances permit roughly N× the configured rate; the interface is narrow enough that a shared store can replace the map without touching call sites. This is deliberately NOT described as distributed rate limiting. 22 tests (16 unit with an injected clock — no sleeps — plus 6 integration). The integration suites construct `RateLimiter.disabled()` because they legitimately authenticate dozens of times from one identity; the limiter's own behaviour is proved in its two dedicated suites, so nothing is left uncovered |
| Configurable CORS allowlist | **done** (security plan §2): exact-origin allowlist, default deny. The browser's same-origin policy is what stops a malicious page reading an authenticated response, so every rule here is about relaxing it narrowly and never by accident. (1) **Default deny** — with no configured origins no CORS header is emitted at all, leaving same-origin traffic untouched, so an unconfigured deployment is strict rather than broken. (2) **Never reflect an arbitrary `Origin`** — echoing the request's origin back plus `Allow-Credentials: true` is functionally equivalent to having no same-origin policy, and is the most common "just make it work" fix. (3) **No wildcard with credentials** — `*` is refused at startup rather than silently downgraded, because this API authenticates with cookies. (4) **Exact match on the parsed origin**, comparing scheme/host/port as components: `startsWith`/`endsWith`/`includes` matching is precisely how `https://studio.example.com.evil.net` and `https://evil-studio.example.com` get admitted. The `null` origin (sandboxed iframes) cannot even be configured. `Vary: Origin` is set even when denying, so a shared cache cannot serve an allowed-origin response to a denied one. A denied request is **not** failed server-side — it is answered without a grant and the browser refuses it, because a 403 would be indistinguishable from an authorization failure and would confirm the origin was evaluated; only a denied *preflight* gets an explicit 403, since a preflight has no other purpose. Preflight is answered **without authentication** (a browser sends no credentials on one, so requiring auth would make every cross-origin write impossible) with an explicit method/header list rather than a reflection of `Access-Control-Request-Headers`. Configured by `YEONJAE_CORS_ORIGINS` (comma-separated) with **startup validation** naming an invalid value, because a silently dropped typo yields a deployment that looks configured and denies everything. 26 tests (15 unit + 11 integration) covering allowed/denied/absent/malformed origins, lookalike, subdomain, wrong-scheme and wrong-port attacks, multiple origins, the empty allowlist, preflight methods/headers, credential behaviour, security headers intact on preflight, same-origin untouched, a CORS grant *not* substituting for authentication, and startup refusal of `*` and of a malformed entry |
| Dependency-audit CI gate | **done**: the step named "high+ fails" ended in `|| (echo … && exit 0)`, so every finding became a success and the gate never existed. `tools/audit-gate.mjs` replaces it: high and critical advisories fail the build, an advisory that must be tolerated needs an entry in `.audit-allowlist.json` carrying a justification, scope and expiry, and an expired or incomplete entry suppresses nothing. Verified by injecting a synthetic high advisory — the gate fails, a current allowlist entry lets it pass, and an expired entry does not |
| Remaining `/v1` write families | **done**: migration 0010 adds the operator-editable resource families the API plan names — story specification versions, assumption decisions, directions, concept candidates and selections, register profiles, narrative-identity / naming-registry / terminology-policy documents, planning documents (series blueprint, arcs, chapter contracts, scene plans) and chapter review decisions. The design decision that shapes the migration: `workflow_artifacts` is content-addressed and `putArtifact` refuses a retry that produces different bytes, which is exactly the determinism guarantee the production loop depends on and exactly why an operator EDIT cannot live there. Operator state therefore sits beside the artifacts, versioned, recording the artifact it descends from as provenance; nothing the workflow produced is mutated. The invariants are enforced by the DATABASE, not by route handlers, because a rule that lives in one handler is bypassable by the CLI, a worker, or the next route: optimistic concurrency is a `UNIQUE (project, …, version)` key so two writers racing the same version cannot both win (the test drives the real race and asserts one refusal); triggers refuse to rewrite or unpin a pinned identity version and to rewrite a locked plan version, through any caller including raw SQL; concept selection commits the selection row and every winner/loser transition in one transaction, mirroring `candidate_selections` (0005), so no reader can observe two selected concepts and nothing can promote a rejected one. Two boundaries are stated in the responses rather than implied: a chapter review decision answers `canon_accepted: false` (approval is the operator SIGNAL that feeds the Checkpoint 2–6 acceptance path, never a shortcut around evidence verification, winner-only propagation and the atomic commit), and an assumption decision answers `spec_updated: false` and names the follow-up (promotion is a new spec version with its own concurrency check — never a silent rewrite of the spec downstream planning already read). An operator-authored spec is validated with the SAME `story-spec.schema.json` validator the production loop uses on its own output. The chapter trace is redacted BY SHAPE: it selects artifact metadata and excludes `llm_output` in the query itself, so prompts, provider payloads and raw model text have no path into the response rather than being stripped from one. All new tables get the same FORCE RLS workspace policy and 0007's least-privilege grants, with no DELETE (these families are append-only history). 35 tests (9 database invariant + 26 API contract) covering unauthenticated access, the viewer/editor/owner matrix, a forged workspace header, cross-workspace id parity with a nonexistent one, stale `expected_version`, a genuine concurrent-edit race, duplicate `Idempotency-Key` replay and changed-payload refusal, pinned/locked refusal, concept winner-only propagation with retained losers, non-NFC normalization, deterministic cursor pagination and trace redaction |
| `apps/web` — the operator application | **done**: a Next.js 16 / React 19 app in the pnpm workspace with all 11 operator work areas — authentication; workspace and project selection; story specification and assumption review; directions and concept comparison; bible and register profiles; narrative identity and terminology; planning; chapters and production; candidate and scorecard review; canon and change operations; operations (jobs, SSE, costs, budgets, export). It calls the REAL `/v1` API: there is no mock, fixture or local store behind the client, because a UI backed by a static success path proves nothing about whether the product works. Security: the session secret is the server's HttpOnly cookie and is never readable by this code, so it cannot be written to browser storage; only the CSRF token lives in memory, is attached to unsafe methods automatically, and dies with a reload (re-read via `/v1/me`); a 401 revokes local authenticated state immediately while a 403 deliberately does NOT, since signing an operator out for lacking a role would be a bug; roles are presentation-only and every action is re-authorized server-side; an unrecognised error body is never rendered. SSE follows the persisted `job_events` log rather than the transport: reconnect sends the last APPLIED id (not the last received), duplicates are suppressed by sequence, a replayed non-terminal event can never relabel a terminal status (the bug that makes an operator cancel a finished run), a terminal event closes the stream, heartbeats reach neither the UI nor assistive technology, and disconnected/reconnecting is shown in words. Accessibility is centralized in shared primitives: status is always a WORD with colour as decoration, error summaries take focus and link to their fields, live regions are polite and carry only meaningful transitions, destructive canon operations confirm with a MATERIAL-versus-CONTEXTUAL impact summary from the server's own dry run, retcon and rollback additionally require typing the operation name, focus moves into a dialog and returns to its trigger, focus is never suppressed, and layouts are responsive with `prefers-reduced-motion` honoured. 63 tests: 19 unit (SSE replay semantics and API client contract) and 44 journey tests rendering the real screens against a transport that speaks the real `/v1` contract, including an axe pass on every work area and two keyboard-only critical paths. CI gains the web production build, a startup smoke test that asserts the shell and its landmarks actually render, and explicit guards that fail the build if the web journey or accessibility suites silently did not run |
| Remaining Checkpoint 7 scope | **none — Checkpoint 7 is complete and merged upstream** (PR #10 at `59d6275`, post-merge CI and planning validation green). The following limitations are **open, not closed**: rate limiting and metrics are **per process**; fencing prevents a stale result from committing but does **not** abort an already-running provider request; **no live-provider validation has occurred**; evaluator thresholds remain **uncalibrated** (deterministic replay agreement only, ADR-0029); vector retrieval remains an interface; **no production deployment has occurred**; gitleaks is **unavailable locally** (CI-only); upstream **branch protection is unavailable/unconfigured**. Closing these is Phase 4 — MVP hardening, which is ACTIVE. Phase 4's four implemented tranches close only the credential-free deterministic halves of B-4-1, B-4-2, B-4-3, B-4-4 and B-4-6; they do not close any limitation in this row except that restore is no longer "not exercised" **for a local disposable database only**, and that tenant-isolation coverage is now derived from the live schema. Every other limitation listed here remains open |

Honest scope note (ADR-0043): Checkpoint 7 is the largest checkpoint in the roadmap. Its platform and API
foundation, job control, SSE, accepted-only export, durable orchestration, atomic lease fencing, the canon
correction/retcon/rollback services and their HTTP surface, inspectors, observability, rate limiting, the CORS
allowlist, the runbooks, the `/v1` write families and `apps/web` with all 11 operator work areas are
delivered to the same evidence bar as earlier checkpoints — real PostgreSQL tests, real journeys against the
real API contract, no suppressions, no placeholder routes — and are merged upstream with green post-merge
checks. The table above is the authoritative statement of what does and does not exist, including the
limitations that remain open. What merging does **not** establish: nothing has been deployed to production,
no live provider call has ever been made, and evaluator thresholds are uncalibrated, so none of this is
evidence of live-model prose quality or of production operability.

Final Checkpoint 7 validation (recorded at closeout, re-run locally on the merge commit
`59d62752f31261a0c86921603993f37992194dd2`): **55 test files / 772 tests passing** — the 674 recovered tests
reproduced plus **98 tests added during the final continuation** — contrast **800 evaluations with 280/280
agreement, 0 false positives and 0 false negatives**, against **PostgreSQL 16**, with **no live paid-provider
calls** at any point.

### Checkpoint 7 provenance (historical)

The paragraphs below record how the Checkpoint 7 work was recovered and continued across writable forks. They
are **historical provenance**, not current work: the branches and staging PRs they name are no longer written
to, and the authoritative current state is the Current state table at the top of this file.

Continuation provenance (fourth session, 2026-09-16). Work moved again to the writable fork
`sigma26web/New`. The partial head `0880de679ab453de2080fc1058c9a70014a68449` was recovered **unchanged** —
same commit objects, same SHAs, no cherry-pick, rebase, squash or force-push — and verified before any new
work: `upstream/hoplite/ainos-1ac771f8` resolved at that time to `6195700a068b04108e26f87affd738842f39a15a`,
that base is
an ancestor of `0880de6`, the comparison is exactly **16 commits ahead and 0 behind** on a single linear
parent chain, and `a3072ae` → `4680520` → `0880de6` appear in that ancestry in order. Immutable markers in
`sigma26web/New`: `hoplite/medma-023f017e--checkpoint-07-base-6195700` @ `6195700` and
`hoplite/medma-023f017e--checkpoint-07-recovery-0880de6` @ `0880de6`, both verified by `git ls-remote` after
publication. Continuation branch `hoplite/medma-023f017e`, created at exactly `0880de6`; the platform's Git
broker publishes only to this thread's branch and branches derived from it, so the markers carry that prefix
rather than the bare names in the brief — their SHAs are exactly as specified. GitHub Actions were confirmed
ENABLED in the new fork (two active workflows, with a green `ci` and `planning-validation` run observed on
the branch) before any branch was treated as CI-verified. That branch's head
`2f51c4ecef685a28a4ab717934510d9a20a26483` became the second parent of the upstream Checkpoint 7 merge.

The recovered baseline was reproduced in full before being extended: **50 test files / 674 tests**, contrast
800 evaluations with 280/280 agreement and zero false positives or negatives, corpus hash
`sha256:ba75bf8e46386375c988eeea202dd3466c004d6edfeef5b5a7d91ca84ce63ef0` unchanged, planning validation
ALL OK (33 schemas), types-fresh / typecheck / lint / format:check / dependency-audit gate all green,
PostgreSQL 16.14, Node 22, pnpm 10.26.0. (One worker control-and-fencing assertion failed once under full-suite
ordering and passed in isolation and on re-run; it is timing-sensitive, not a regression, and CI has been green
on it.) After the remaining `/v1` write families and `apps/web`: **55 files / 772 tests** (674 inherited + 98
new), with every other gate re-run green. No live paid-provider calls occurred.

Tool limitation, recorded once (not an implementation blocker): the continuation brief asks for a comment on
`sigma25web/New#1` pointing at the replacement. The available source-control tools are bound to this thread's
repository (`sigma26web/New`) and the local `gh` CLI is unauthenticated, so a cross-repository comment could
not be posted. `sigma25web/New#1` remains **open and unmerged**, and this file plus the sigma26 staging PR
body carry the pointer instead: the continuation moved without history rewriting to `sigma26web/New` from
exact source commit `0880de679ab453de2080fc1058c9a70014a68449`.

Earlier continuation provenance (third session, 2026-09-16). Work moved to the writable fork
`sigma25web/New` after the previous fork's credits were exhausted. The partial head
`a3072ae40e6944462d598fe27409ef57f3d9fa43` was recovered **unchanged** — same commit objects, same SHAs, no
cherry-pick, rebase, squash or force-push — and verified before any new work: `upstream/hoplite/ainos-1ac771f8`
resolves to `6195700a068b04108e26f87affd738842f39a15a`, that base is an ancestor of `a3072ae`, and the
comparison is exactly nine commits ahead and zero behind on a single linear parent chain. Immutable markers
in `sigma25web/New`: `hoplite/kydonia-32097fa9--checkpoint-07-base-6195700` @ `6195700` and
`hoplite/kydonia-32097fa9--checkpoint-07-recovery-a3072ae` @ `a3072ae`. Continuation branch
`hoplite/kydonia-32097fa9`, created at exactly `a3072ae` (historical: superseded by the sigma26 continuation
above; sigma25web/New#1 remains open and unmerged). The platform's Git broker only publishes to this
thread's branch and branches derived from it, so the markers carry that prefix rather than the bare names in
the continuation brief; their SHAs are exactly as specified. The recovered baseline was reproduced in full
before being extended: **41 test files / 559 tests passing**, contrast 800 evaluations with 280/280
agreement and zero false positives or negatives, planning validation ALL OK, types-fresh / typecheck / lint
/ format:check / dependency-audit gate all green, `git diff --check` clean, PostgreSQL 16.14, Node 22,
pnpm 10.26.0, Python 3.12.3. After the atomic lease-fencing correction: **42 files / 569 tests** (559
inherited + 10 new). After the canon operator HTTP surface: **43 files / 589 tests** (569 inherited + 20
new). After the canon inspector, cost and budget reads: **44 files / 601 tests** (589 inherited + 12 new).
After observability and redaction: **46 files / 626 tests** (601 inherited + 25 new).
After rate limiting and client identity: **48 files / 648 tests** (626 inherited + 22 new).
After the CORS allowlist: **50 files / 674 tests** (648 inherited + 26 new), with every other gate re-run
green. No live paid-provider calls occurred.

Earlier continuation provenance (second session). The partial head `d5362d2` was recovered unchanged into the fork `sigma24web/New` and
preserved on the immutable branch `hoplite/klazomenai-1ae11ab0--checkpoint-07-recovery-d5362d2`, with the
Checkpoint 6 baseline on `hoplite/klazomenai-1ae11ab0--checkpoint-07-base-6195700` @ `6195700`. Work
continues on `hoplite/klazomenai-1ae11ab0`, which descends from `d5362d2` with none of its three commits
rewritten. The recovered baseline was reproduced before being extended: 32 files / 455 tests passing,
contrast 800 evaluations with 280/280 agreement and zero false positives or negatives, planning validation
green. Branch naming note: the platform's Git broker only publishes to this thread's branch and branches
derived from it, so the recovery and base markers carry that prefix rather than the bare names in the
continuation brief; their SHAs are exactly as specified.

## Phase 4 — MVP hardening (active; incomplete)

**Status: active and incomplete — deterministic portions MERGED UPSTREAM.** The credential-free deterministic
work reached the upstream base branch through [PR #12](https://github.com/jsisiwb/New/pull/12) at merge commit
`99e6bf5ccf962c2283589745ccbef7983cb682d6`, and the reviewed 100-set contrast corpus through
[PR #13](https://github.com/jsisiwb/New/pull/13) at merge commit `4df7d92ff3d1641da0f0f270940aa31d33c7cc89`
(parents `99e6bf5ccf962c2283589745ccbef7983cb682d6` and `bafc9cc23ce632608f38ed3984ea5c0ccc3b72df`). Corpus
evidence at that merge, **reproduced locally in the current continuation**: **100 accepted contrast sets**,
2,000 deterministic evaluations, **700/700 agreement**, **0 false positives**, **0 false negatives**,
distinctness threshold unchanged at **0.60**, corpus hash
`sha256:4c9ef2225e0e72ada566401183c453b19b7383c29cfac1a5617958aaeadbb97b`, calibration **`uncalibrated`**.
Baseline suite at that merge, also reproduced locally: **68 test files / 1,008 tests / 0 skipped** against
PostgreSQL 16.14. Every item that needs a paid provider, a deployment environment, repository administration
or a human reviewer remains **not run**, so **Phase 4 is NOT complete** and neither is B-4-1, B-4-2 or
B-4-5. One upstream caveat is recorded rather than glossed: the upstream check runs associated with
`4df7d92f` reported success at the time of reading, and fresh validation for the continuation was
established independently on the writable fork rather than inherited.

| # | Scope item | Status | Closes which open limitation |
| --- | --- | --- | --- |
| 1a | 120-chapter compressed continuity validation, **deterministic** | **done** (evidence below) | long-form continuity was previously proven only to chapter 3 |
| 1b | Live 20-chapter validation, five consecutive nights | **not run** — needs paid providers | no live-provider validation has occurred |
| 2a | Deterministic chaos and provider-fallback drills (B-4-2) | **done** (evidence below) | fallback was previously untested and unclassified |
| 2b | Chaos/fallback under a REAL provider outage | **not run** — needs paid providers | requires live provider access |
| 3a | **Local disposable** logical backup/restore drill (B-4-3) | **done** (evidence below) | restore was previously "not exercised" |
| 3b | Secret-configuration boundary tests + rotation runbooks (B-4-3) | **done** (evidence below) | rotation had no tests and no procedure |
| 3c | Staging restore, production restore, PITR, off-site backup, RTO/RPO | **not run** — no staging/production exists | unchanged |
| 3d | Live credential rotation | **not run** — no secret manager or credentials | unchanged |
| 4 | Defensive security suite and CI security gates (B-4-4) | **done for the automated surfaces** (evidence below) | tenant/operator boundaries were covered only where suites happened to touch them |
| 5a | Contrast corpus expansion toward 100 sets (B-4-5) | **done for the automated scope** — corpus expanded 40 → **100 accepted sets**, 2,000 evaluations, 700/700 agreement, thresholds unmoved (evidence below); **not** human calibration | the corpus no longer falls short of its pre-calibration target |
| 5b | Blinded reviewer tooling (B-4-5) | **done** (evidence below) — tooling only, **not** human-review evidence | unchanged |
| 5c | Bilingual human review and threshold calibration | **not run** — needs human reviewers | thresholds remain `uncalibrated` |
| 6a | Deterministic cost/attempt accounting (B-4-6) | **done** (evidence below) | attempt-level spend was recorded but never read |
| 6b | Attempt-level cost API surface (B-4-6) | **done** (evidence below) | retry/fallback visibility had no API |
| 6c | Real billing calibration against provider invoices | **not run** — needs live providers and invoices | unchanged |
| 7a | **Safe cancellation of already-running provider requests** | **done for the automated scope** (evidence below) | fencing prevented a stale commit but could not abort an in-flight provider request |
| 7b | Confirmed REMOTE cancellation against a real provider API | **not run** — needs paid provider access | a cancelled call's remote state and remote billing may be genuinely unknown, and are recorded as such |
| 8a | **Database least privilege, RLS, migration-safety and recovery-integrity hardening** | **done for the automated scope** (evidence below) | append-only, immutable and canon-history tables retained request-scoped `UPDATE`/`DELETE`, and every `canon` function was `PUBLIC`-executable |
| 8b | The same privilege model verified on a deployed cluster | **not run** — no staging or production database exists | unchanged |

### Database least-privilege hardening (Phase 4 item 8a; automated scope complete)

**Status: implemented for the automated scope. This does NOT complete Phase 4.** Continuation tranche
beginning at the upstream merge commit `30cb62af6fed0ac685fe29d44cae0f471577aab1` (upstream
[PR #14](https://github.com/jsisiwb/New/pull/14), **merged**; parents
`4df7d92ff3d1641da0f0f270940aa31d33c7cc89` and the reviewed cancellation head
`b1ea8f2af7dea24868f8d32b73c8f64c841d09a2`, verified by reading the merge commit directly). The writable
fork for this tranche is `sigma31web/New`.

**What the audit found.** Migration 0013 repaired `llm_calls`, whose own comment claimed "INSERT/SELECT
only" while the catalog reported `DELETE, INSERT, SELECT, UPDATE`. A repository-wide audit of the privilege
model at the base established that this was **structural, not table-specific**: migration 0006 granted DML
on `ALL TABLES` and only the tables 0007/0013 happened to name were ever narrowed, leaving **48 tables**
with `UPDATE` or `DELETE` for the request-scoped role — including `audit_log`, `job_events`,
`workflow_artifacts`, `context_packs`, `active_constraint_sets` and every canon-history table, each of
which already carries a `BEFORE` trigger refusing that exact command for every caller, and none of which
has any `UPDATE`/`DELETE` call site in the repository. Two further defects were catalog-level rather than
per-table: **all 41 `canon` functions were executable by `PUBLIC`** (the default grant was never revoked,
so `commit_delta`, `rollback_latest`, `quarantine_version` and the lease functions were callable by every
role in the cluster), and the role held more than `nextval` needs on the append-only `job_events` sequence,
where `setval` would let a request-scoped connection rewind the stream into collision with existing rows.

**What migration `0014_append_only_least_privilege` does** (forward-only; no existing migration edited):
revokes `UPDATE`/`DELETE` on the five append-only and immutable tables; revokes `DELETE` on
`canon_commits` and 13 canon-history tables while **retaining** the `UPDATE` that `canon.commit_delta`
requires because it is `SECURITY INVOKER`; revokes `EXECUTE` from `PUBLIC` across the `canon` schema after
granting the two policy helpers explicitly; narrows the sequence to `USAGE`; and sets narrow default
privileges for future sequences and future `canon` functions. Rationale, the retained-privilege
justifications and the rejected alternatives are in **ADR-0050**.

**Evidence (all local PostgreSQL 16.14 plus fork CI; no live provider call, no credentials).** 22 new
deterministic tests: `packages/db/src/append-only-privileges.integration.test.ts` (14) and
`packages/db/src/migration-replay.integration.test.ts` (4), plus 4 new restore-drill assertions. Every
negative case was **PERMITTED at the base**, and each checks two independent layers — the grant is gone at
a real non-owner, `NOBYPASSRLS` request-scoped connection, the trigger still refuses the same command on
the owner connection, and the legitimate write path still succeeds. Mutation-checked: removing two
revocations failed 4 tests, removing the `PUBLIC` `EXECUTE` revocation failed 1, and running the restore
behaviour checks as the owner instead of the application role failed 4. No mutation was committed.

The restore drill now treats the security model as a restore invariant, **23 → 40 invariants**: table,
sequence and function `EXECUTE` grants, function security modes and `search_path`, full policy
definitions, per-table `RLS`/`FORCE RLS`, trigger definitions with enabled state, table owners and schema
privileges compared source-to-target, plus role attributes, no `PUBLIC` `EXECUTE`, and re-executed
behaviour in the restored database (the legitimate audit append succeeds; direct `audit_log`
update/delete, `job_events` update, `canon_commits` delete and `llm_calls` cost rewrite are each refused).
It remains a **local logical dump/restore** — not staging, not production, not PITR.

Migration properties are asserted rather than assumed: idempotent across a second and third run compared
by a security fingerprint, a clean install converging on exactly the fingerprint an upgrade produces (and
the upgrade **changing** it, so a no-op migration fails), the existing content-hash protection rejecting a
modified historical migration, and a mid-file failure rolling back completely so no partial grant
survives.

**Cancellation and accounting compatibility (ADR-0049) is unaffected in substance and stronger in depth:**
a cancelled attempt still records its audit row by `INSERT`, `usage_status`/`billing_status = unknown`
remain first-class and representable, and the false-zero cost rewrite that 0012's trigger refuses is now
also unreachable by privilege. The full deterministic suite passes unchanged, which is the evidence that
every revoked privilege genuinely had no caller.

### Credential-free operational hardening (Phase 4 items 9a–9d; automated scope)

**Status: implemented for the automated scope. This does NOT complete Phase 4.** Continuation of the same
working branch, after the least-privilege tranche at `bfb3e6e`. Four controls that the system *presented*
as protections, and which were per-process or absent, now exist where they have to.

**9a — shared rate and concurrency limiting (migration 0015).** `apps/api/src/rate-limit.ts` is an
in-memory sliding window and says so in its own header: "N instances permit roughly N× the configured
rate". It also constrained nothing on the side that costs money — the gateway had no limiter in front of
the provider at all. Admission is now a fixed-window counter in Postgres (per provider, model, workspace
and operation class; request count and estimated tokens; explicit burst), and concurrency is an expiring
**lease** rather than a counter, because a decrement is lost forever when the holder is killed while a
deadline is not. Time is a parameter, so all 17 tests drive window rollover, boundaries and expiry
deterministically with no `sleep()`; the two-connection race for the final slot asserts exactly one
winner. **Not yet wired into the worker's production path** — that is listed as open in
`12-remaining-external-work.md`.

**9b — shared budget enforcement (migration 0015).** `MemoryBudget` was the only `BudgetLedger`: spend in
a `Map`, reset on restart, invisible to other processes, so two workers each believed they owned the whole
budget. `SharedBudget` enforces it in the database, with reservations that expire (a dead worker must not
strand budget forever), idempotent settlement (at-least-once activity delivery must not double-charge),
and **unknown cost that is never zero** — an unreported final cost keeps the reservation's estimate and
is marked `cost_known = false`, the same rule migration 0012 enforces for `llm_calls`. A settled row is
immutable by trigger and holds no `DELETE` grant. 16 tests; the decisive one is two workers each asking
for 60% of the budget, where exactly one succeeds — a case that cannot be expressed against
`MemoryBudget`, because there was nowhere for the second worker to look.

**9c — deterministic provider simulator and HTTP adapter.** `MockProvider` and `ReplayProvider` are
in-process: they return values, so every test using them proves things about gateway *logic* while
skipping the part that breaks in production. `SyntheticProviderService` is a real `node:http` server with
18 scenarios (reset before headers, truncated body, 429 with `Retry-After`, 5xx, malformed JSON, wrong
shape, oversized body, delayed headers/body, late success, remote-cancel acknowledged/unsupported), and
`HttpProvider` is the adapter shape a real provider would use. 27 tests over a loopback socket.
**This is SIMULATED provider validation and is labelled as such everywhere** — it is not evidence about
any live provider's behaviour, billing or remote cancellation, and no request leaves loopback.

**9d — readiness that fails for the reasons that matter.** `/ready` ran `SELECT 1`, which passes against a
database that is behind on migrations, ahead of the build, carrying a tampered ledger, or whose
application role has been granted `BYPASSRLS` — the last of which voids every tenant-isolation guarantee
in ADR-0050 while the app looks healthy. All four now refuse readiness. Liveness is deliberately
untouched, and optional dependencies report **degraded** rather than failing, so an orchestrator does not
kill healthy processes during a provider outage. 14 tests.

**Defects found and fixed by the new tests, not by inspection:**

| ID | Severity | Defect |
| --- | --- | --- |
| O-1 | HIGH | migration 0015's new `canon` functions were born `PUBLIC`-executable, reintroducing the exact defect 0014 repaired: 0014's `ALTER DEFAULT PRIVILEGES` does not cover functions the migration's own owner creates in the same schema. Caught by the existing `append-only-privileges` and restore-drill guards |
| O-2 | MEDIUM | `window_start` as a `RETURNS TABLE` column shadowed the table column of the same name, making every reference inside `canon.rate_limit_admit` ambiguous. Renamed `window_started_at` |
| O-3 | MEDIUM | a microtask spin (`while (…) await Promise.resolve()`) used to wait for a request to reach the simulator **wedged the event loop** and hung the suite: draining microtasks never yields to the I/O phase. Replaced with `waitForRequests`/`waitForClientAbort`, which yield via `setImmediate` |
| O-4 | LOW | the migration-replay suite pinned the newest migration's filename and a hard-coded chain length, so it failed the moment 0015 landed. Both are now read from disk |

**Scope limits recorded rather than glossed.** A container topology (Dockerfiles, Compose profiles, a
one-command local stack) was **not** built: neither `docker` nor `podman` exists in this workspace, so any
manifest written here would be unvalidated YAML presented as working infrastructure. The remaining
credential-free work — wiring the new controls into the worker path, local deterministic embeddings and
versioned vector retrieval, the name thesaurus, multi-process tests, metrics for the new signals, and
deployment/alert templates — is listed openly in `docs/08-delivery/12-remaining-external-work.md`
under "Not blocked, and honestly still open". **Phase 4 remains incomplete.**

### Active-request cancellation (Phase 4 item 7a; automated scope complete)

**Status: implemented for the automated scope. This does NOT complete Phase 4.**

**The gap it closes.** `jobs.control = 'cancel'` was a durable intent observed only at a `runStep`
checkpoint boundary. That is safe — nothing is torn in half and no partial canon exists — but it is not
prompt: a provider call already in flight ran to completion, so an operator cancelling mid-draft waited
for the longest operation in the pipeline before anything stopped. `Provider.complete` had always accepted
an `AbortSignal`; nothing ever supplied one.

**What now happens.** The gateway composes a cancellation handle per call, passes its signal to the
adapter AND races the call against it, so cancellation does not depend on adapter goodwill. Three labelled
sources reach an in-flight request from the orchestrated path: Temporal's activity cancellation signal, the
heartbeat's refused lease renewal, and a bounded single-row probe of the durable `jobs.control` / `status`
intent. One gate before every attempt makes "no retry", "no repair" and "no fallback" after an
authoritative cancellation a single property, because in this codebase all three are another iteration of
the same loop.

**Stable classifications.** `operator_cancelled`, `timeout`, `activity_cancelled`, `worker_shutdown`,
`lease_lost`, plus the outcomes `provider_failed`, `late_result_discarded` and `cancel_too_late`. The
FIRST reason to fire stays authoritative, so a deadline that expires a moment after an operator acts never
relabels their decision as a provider fault. Operator cancellation is classified `cancelled`, never as a
retryable provider failure — checked before the transport pattern, which matches the word "aborted" and
would otherwise have rerouted a cancel to the next paid model.

**Precedence, highest first:** an atomic canon commit that already happened (`cancel_too_late`, history is
never retracted) → lease loss (`LEASE_LOST`, another holder owns the target) → authoritative cancellation
(operator / activity / shutdown) → call deadline (`timeout`) → ordinary provider failure.

**Truthful accounting (migration 0012, forward-only, nullable, no destructive down migration).** A
cancelled call writes one audit row carrying reason, outcome, remote-cancellation status, usage status,
billing status, timestamps, whether a response was discarded and whether any provider was contacted at
all. The honesty rules are enforced by the **database**, for every writer including raw SQL: a row
claiming the cancelled status must carry provenance; reason and remote-cancellation status are closed
enums; and `billing_status` cannot be `known` when `usage_status` is `unknown`. Usage the provider
reported — including on a discarded late success — is preserved and priced with the same integer millicent
arithmetic as every other row, so cost reconciliation still balances exactly. Usage it did not report is
recorded as **unknown, never as zero**: a missing token count and a real zero are different facts.

**What is deliberately NOT claimed.** Aborting a local request is not evidence that remote computation
stopped or that nothing will be billed. `remote_cancellation` is `acknowledged` only on a positive
provider acknowledgement, and otherwise `unsupported` (the adapter has no remote side or no cancellation
endpoint) or `unknown`. No deterministic provider in this repository can acknowledge anything, so in
practice every cancelled call here records `unsupported` or `unknown`. **Item 7b — confirmed remote
cancellation, and real post-abort billing, against a live provider API — has not run and needs paid
provider access.**

**Boundaries preserved.** Lease fencing and `canon.assert_lease_fence` remain authoritative; a stale or
fenced worker still cannot persist protected state. A cancelled pre-commit operation commits no canon. A
cancellation arriving after the atomic commit is `too_late` and the accepted chapter keeps its meaning. A
cancelled step settles the job as `cancelling` rather than `failed`, leaving the single terminal write
where it already was. Repeated and concurrent cancellation requests are idempotent — no duplicated event
and no duplicated cost. Resume after a cancellation replays completed steps and re-charges nothing.
Existing uncancelled retry, fallback and replay behaviour is unchanged, and a caller that supplies no
cancellation options behaves exactly as before.

**CI evidence on the final head `e14883b11d39e426f6fb1ed1bcf7545643025cbd`** (draft staging PR
[sigma30web/New#1](https://github.com/sigma30web/New/pull/1), which must not be merged): all three checks
succeeded —
[ci / typecheck+lint+format+types+tests with PostgreSQL 16](https://github.com/sigma30web/New/actions/runs/35256652318),
[planning-validation](https://github.com/sigma30web/New/actions/runs/35256652586) and
[secret scanning (gitleaks)](https://github.com/sigma30web/New/actions/runs/35256652318). Final local
totals on the same head: **70 test files / 1,048 tests / 0 skipped** (554.87 s) against PostgreSQL 16.14,
plus replay-120, 49 chaos scenarios, 23 restore-drill invariants, 16 defensive-security scenarios, 14 cost
scenarios and the contrast regression. Gitleaks is unavailable locally and ran in CI only.

**Evidence.** 40 deterministic tests, all of which fail against the previous implementation:
`packages/gateway/src/cancellation.test.ts` (31) and
`apps/worker/src/active-cancellation.integration.test.ts` (9, against real PostgreSQL 16). Mid-call
cancellation is driven by deferred promises a test resolves and by injected timers — no `sleep()` — and
the assertions inspect durable state (job status, `job_events`, `llm_calls`, `canon_commits`, chapter
lifecycle), not merely the thrown error. Both suites are in the chaos matrix (minimum raised 30 → 46; 49
scenarios reported) and are guarded by name in CI against a silent skip. No live-provider call and no
credentials are involved in any of it.

### Independent release-gate review of active-request cancellation (four further defects repaired)

A second, independent review pass re-derived the evidence rather than trusting the first pass, and found
four more defects. All are repaired on the same branch as appended commits; no published commit was
rewritten.

**R-1 (HIGH, gateway).** A caller-supplied late-result callback that THREW became an unhandled rejection,
because the notification ran inside the observer attached to the provider promise and nothing awaits that
promise on the late path. An unhandled rejection can take a worker process down — precisely the failure
the module documents itself as preventing. Reproduced on both late paths before the fix; the callback is
now isolated, so a caller's bug cannot alter the cancellation outcome or crash the process. A non-Error
provider rejection is also normalized rather than escaping as an unhandled non-Error throw.

**R-2 (HIGH, truthfulness).** Migration 0012's own comment and ADR-0049 asserted that `llm_calls` is
"INSERT/SELECT only for `yeonjae_app`". The database said otherwise: 0007 narrowed the request-scoped role
table by table and never listed `llm_calls`, so the role still held UPDATE and DELETE. Nothing was
exploitable — 0002's append-only trigger refuses both for every caller, verified directly — so this was a
truthfulness and defence-in-depth defect rather than a live authorization bypass. **Migration 0013** now
revokes them, making the documented claim true; the grant set is asserted by test. Other
append-only-by-trigger tables carry the same redundant grants from 0007: that is **pre-existing and still
open**, deliberately out of scope for a cancellation review, and recorded here rather than swept in.

**R-3 (MEDIUM, database).** 0012's trigger refused a `cancelled` row with no provenance but never asked the
converse, so a row could claim both that the call succeeded and that an operator cancelled it. No
application path produces that, which is exactly why the trigger is the right guard: it is the only one
covering raw SQL, a future writer, or a restore from a doctored dump. Closed in 0013, which keeps every
0012 rule verbatim and adds the converse check.

**R-4 (MEDIUM, tooling).** The D-10 repair fixed the restore drill's wrong-direction comparison but left it
accepting garbage: it compared a raw four-character prefix as a string, and `abc`, `999` and `9_weird` all
sort above `0011`. The decision moved out of the runner into `@yeonjae/db`'s `assessRestoredMigration` —
it had been wrong twice while inline and untestable both times — and now requires four digits followed by a
separator or nothing, compared numerically so a future `0100` cannot be defeated by lexicographic ordering.
Anything uninterpretable fails closed. Proved by an exhaustive table.

**D-2 re-examined.** The first pass's "bounded one-macrotask adoption of the adapter's verdict" was attacked
directly and holds: usage reported across a microtask chain is adopted; an adapter that never settles does
not delay the cancellation; an adapter answering after the bound cannot retroactively claim
acknowledgement; the outcome was identical across 200 runs; and an adapter cannot relabel the reason that
actually fired.

**D-9 re-verified as pre-existing.** The distinctness cross-check timeout was reproduced at the exact base
SHA `4df7d92f` in an isolated worktree, with none of this branch applied, leaving the working branch
untouched. It is inherited, unrelated to cancellation, and is why CI for the base tree fails on this fork.

**Final validation after the repairs:** **70 test files / 1,059 tests / 0 skipped** (597 s) against
PostgreSQL 16.14 — 11 more tests than the first pass. Replay-120 (120 chapters, canon v122), 49 chaos
scenarios, **23 restore invariants at schema `0013`**, 16 defensive-security scenarios / 178 tests, 14 cost
scenarios, contrast regression PASSED with the corpus hash, threshold `0.60` and `uncalibrated` status all
unchanged, dependency audit clean, web build OK. No threshold was moved to make anything pass. Still no
live-provider call and no credentials, and **neither B-4-5 nor Phase 4 is complete**.

### B-4-5a corpus expansion — 100 accepted sets (automated scope complete; NOT calibration)

**Status: B-4-5a automated corpus expansion is implemented.** The corpus is **100 accepted sets**
(`cs-001`–`cs-100`); the target was 100. `cs-041`–`cs-100` were authored as continuation work in the
writable fork `sigma29web/New` on `hoplite/morgantina-64e49616`, in twelve validated five-set batches,
each committed and pushed only after passing the full gate.

**This is not human calibration and does not complete B-4-5.** No bilingual reviewer has seen a packet,
no human judgment exists, no threshold was changed, and evaluator calibration remains `uncalibrated`
(ADR-0029). The distinctness report continues to state `proves_literary_diversity: false` about itself: a
surface-similarity score is a necessary condition for corpus quality and never a sufficient one.

**Final metrics, measured at the accepted state.**

| Measure | Before | After |
| --- | --- | --- |
| Accepted sets | 40 | **100** |
| Evaluations (sets × 5 variants × 4 dimensions) | 800 | **2,000** |
| Expected-dimension assertions | 280 | **700** |
| Agreement | 280/280 | **700/700** |
| False positives / false negatives | 0 / 0 | **0 / 0** |
| Highest same-class similarity between two sets | 0.341 (`cs-020`/`cs-022`) | **0.419** (`cs-083`/`cs-088`) |
| Near-duplicate threshold | 0.60 | **0.60 (unchanged)** |
| Corpus hash | `sha256:ba75bf8e…3ef0` | `sha256:4c9ef2225e0e72ada566401183c453b19b7383c29cfac1a5617958aaeadbb97b` |
| Evaluator calibration | `uncalibrated` | `uncalibrated` |

**Coverage is balanced by construction, not by accident:** 20 sets per genre; 12 or 13 per narrative
function; all 40 genre × function cells occupied by two or three sets each; 40 distinct lint codes
expected across the corpus; the coverage audit reports no concentrated genre.

**What was authored.** Each set is five parallel renderings of one passage (`kwn_english`,
`western_english`, `translation_like`, `literary`, `weak_serial`) in original English prose composed
directly in the Korean serialized-webnovel tradition (ADR-0026), with authored `prose_rank`,
`structure_rank`, `min_gap_*` and expected lint codes. The frozen replay fixtures were regenerated from
the enlarged corpus at every batch (800 → 2,000 entries) and reviewed as a diff before acceptance, so
generation and validation stayed separate programs.

**Adversarial review beyond the automated gate.** All 60 new sets were audited for the failure modes a
similarity score cannot see, with **zero findings**: no variant's prose contains a class name, rank word
or other answer-leaking token; no two classes inside a set exceed 0.85 similarity; `kwn_english` is
tighter than both long registers in every set; `weak_serial` is an undivided block and `western_english`
a single paragraph in every set; no variant is shorter than 60 words; and every set's authored ranks obey
the corpus contract (kwn_english first on both dimensions, translation_like last on prose, weak_serial
last on structure). Two batches raised the corpus-wide maximum similarity — `cs-047`/`cs-060` to 0.414 and
`cs-083`/`cs-088` to 0.419 — and both pairs were inspected individually rather than accepted on their
number. Each is a deliberate cross-set continuity pair sharing a cast and a device vocabulary while
differing in narrative function, conflict progression and outcome, which is the same device the original
corpus already uses for Do-yoon across `cs-001`, `cs-009` and `cs-016`. No set was quarantined and none
was rejected after authoring.

**Defect found and repaired (D-8).** Two distinctness tests asserted a literal corpus size of 40, so the
first legitimate addition converted them from checks into stale evidence. They now derive the count from
the loaded corpus and pin the property that actually matters — that every same-class pair was compared —
and a regression test was added pinning that additions land in new genre × function cells rather than
piling into existing ones. Documentation counts are kept synchronized with the corpus file, and three
documents that hardcoded "40 sets exist today" now reference the corpus instead.

**Reviewer tooling was exercised at the new scale rather than assumed.** Packet generation over all 100
sets produces three packets covering every set exactly once, with independent item order and independent
A/B side assignment per reviewer, status `generated`, and zero variant-class or provenance tokens in the
blinded payload.

### Phase 4 tranche 5 — blinded reviewer tooling (B-4-5, automation portion only)

**The protocol is not invented here.** `docs/07-quality/01-testing-strategy.md` §6 specifies it exactly:
30 chapters, 3 bilingual reviewers, blind 1–5 on TWO scales ("natural English" and "reads as a Korean
webnovel of this genre") plus free comments, Spearman ≥ 0.8 between each judge and its scale, feeding
threshold calibration (ADR-0029). `packages/eval/src/review-packet.ts` implements that shape and refuses
to generate a short packet rather than silently weakening it.

**Blinding.** A packet carries no model id, provider, route, variant class or prompt version — asserted by
test. The A/B side assignment lives only in the manifest, hashed into the packet so the key provably
existed at generation without being shipped. Ordering and side assignment come from a seeded PRNG, so a
run is reproducible for the operator and unguessable from the packet alone, and each reviewer gets an
independent order so nobody can copy a neighbour's positional habit.

**Intake fails closed.** `importResponses` rejects an incomplete set, a duplicate response, a response
from another packet, merged reviewer identities, a missing reviewer identity, a rating outside 1–5 or
non-integer, and a packet whose content hash no longer matches — returning nothing accepted rather than
importing part of a set, because an agreement figure computed over partially-reviewed data would be worse
than none.

**What it CANNOT do, by construction.** It never invents a reviewer name or a judgment; a generated packet
is `status: 'generated'` and nothing in the module can advance that; `reviewReport` returns
`calibration: 'uncalibrated'` and `requires_human_approval: true` unconditionally; and
`recommendThresholds` returns a RECOMMENDATION with its blockers, never a threshold and never
`contrast_calibrated`. One test exists solely to pin that a packet with no responses yields zero reviewers
and NaN agreement.

**Evidence.** 28 tests. Also included: Spearman with average-rank tie handling (a reviewer who used only
part of the scale must not get an order-dependent correlation) returning NaN rather than a fabricated
number when a series has no variance.

**What this is NOT.** **Not human-review evidence.** No reviewer has been contacted, no packet has been
reviewed, no judgment exists. Thresholds remain `uncalibrated` and B-4-5 remains **partial** — the corpus
is now 100 sets, but that is an automated expansion under a deterministic gate — the bilingual review has not run.

### Phase 4 tranche 6 — deterministic cost and attempt accounting (B-4-6, deterministic portion)

**What exists.** `packages/db/src/cost-accounting.ts` reads `llm_calls` together with migration 0011's
`attempt_records`, which nothing previously did — so "how many ACTUAL provider attempts was this spend"
and "did a retry or a fallback happen" had no implementation. `/v1/projects/:id/cost-attempts` exposes it,
grouped by role, model, provider, model class, job, policy version or outcome.

**The arithmetic rule it enforces.** `llm_calls.cost_cents` is the authoritative total;
`attempt_records[].cost_cents` attributes that total and is never added to it. An attribution that does
not reconstruct the total is a reported violation.

**Money is exact integer MILLICENTS internally, cents at the boundary.** The gateway computes
`(tokens × pricePerMTokCents) / 1_000_000`, which is **fractional** — a replay-priced call costs `0.3`
cents — and `cost_cents` is an unconstrained `numeric` that stores it exactly. The release-gate review
found that the first implementation parsed only the integral part, so **every sub-cent call reported as
zero** (defect D-6, repaired). Values are now scaled to integer millicents before any arithmetic, summed
as integers so no float drift accumulates, and exposed in both forms: `*_millicents` is the exact integer
for comparison and summation, `*_cents` is the human-facing decimal derived from it. Every summary states
its currency and unit.

**Truthfulness.** Summaries state their BASIS. `billed` is deliberately not a representable value — a
provider invoice is not something this system observes — and the only basis reachable today is
`recorded_replay`. Usage a provider never reported stays **unknown** rather than becoming zero.

**Evidence.** `pnpm test:costs` → 13 scenarios, all passed, durable report at
`coverage/cost-report.json` declaring `basis: synthetic_replay`, `real_billing_calibrated: false`,
`live_provider_calls: 0`. Scenarios: first-attempt success; retry then success (two attempts, one model —
not a fallback); fallback then success; all routes fail; cancellation and pre-dispatch budget denial;
replay unable to double-charge (the audit's unique idempotency key refuses the second write);
partial vs absent usage; aggregation across all seven dimensions with attempts exceeding calls where
retried; time-window filtering; tenant isolation through an RLS-scoped connection; 1000 one-cent calls
totalling exactly 1000; **a sub-cent cost preserved rather than truncated, and 1000 calls of 0.3 cents
summing to exactly 300 000 millicents**; a deliberately broken attribution detected; no prose or
credentials in any dimension key. Plus 9 API tests (totals reconciled against a direct SQL sum on the
exact integer field, sub-cent cost reported exactly, malformed window refused with 422, cross-tenant read
indistinguishable from absent).

**What this is NOT.** Synthetic/replay evidence. No live provider call, no price table consulted, no
invoice reconciled. **Real billing calibration has not occurred.** Metrics and rate limiting remain
**per process** — that limitation is unchanged by this tranche.

### Phase 4 tranche 4 — defensive security suite and CI gates (B-4-4, automated portion)

**Defensive only.** Every case drives the application's own local test client with inert inputs and
asserts refusal. No scanner, no brute-force, no credential harvesting, no command-execution
demonstration, and no offensive tooling was created.

**The substantive gap it closed was an inventory problem, not a missing assertion.** RLS coverage is now
DERIVED FROM THE LIVE SCHEMA: every table carrying a `workspace_id` must have RLS enabled, forced and
policied; every other public table must be explicitly classified as isolated through a parent row,
self-scoped on its own id (`workspaces`), or intentionally global with a stated reason (the immutable
prompt registry, identity, schema metadata). **A new tenant-owned table shipping without a policy now
fails CI** — which no test naming tables by hand would catch. The inventory also pins that attempt
provenance is a jsonb column on `llm_calls`, not an `attempt_records` table, so it inherits that table's
policy.

**Also covered:** SELECT/INSERT/UPDATE/DELETE isolation, isolation through joins, isolation for a query
carrying no workspace predicate at all, nothing visible without a workspace context, no tenant residue on
a pooled connection; manuscript text staying data (a story paragraph cannot override the identity,
language or tradition contract, because the Guard hashes the rendered system prompt rather than trusting
it); export filenames that cannot traverse or inject a header; telemetry carrying no prose or prompts,
with bounded label cardinality and causal error chains reduced to classes and codes; and forwarded headers
unable to mint a rate-limit identity without an explicit trusted proxy.

**Evidence.** `pnpm test:security` → **178 tests, 16 declared scenarios** across the `rls`,
`input_output`, `telemetry` and `rate_limit` surfaces; durable report at `coverage/security-report.json`
declaring `defensive_only: true`, `live_provider_calls: 0`. CI runs it and verifies the report separately.

**Open limitations, unchanged:** rate limiting and metrics are **per process**; there is no WAF, no
network-layer control and no external penetration test; no production deployment exists to test against.

### Phase 4 tranche 3 — disposable backup/restore drill and secret boundaries (B-4-3, credential-free portion)

**Evidence classification — the distinction matters more than the result.**

| Procedure | Status |
| --- | --- |
| Local **disposable** logical restore drill | **executed**, automated, verified in CI |
| Staging restore | **not executed** — no staging environment exists |
| Production restore | **not executed** — no production environment exists |
| Point-in-time recovery (PITR) | **not executed** — no WAL archive configured |
| Off-site backup verification | **not executed** |
| RTO/RPO measurement | **not measured** |
| Live credential rotation | **not executed** — no secret manager, no credentials |

**What the drill does.** `pnpm drill:restore` creates its own disposable PostgreSQL 16 databases, applies
migrations 0001–0011, seeds two workspaces of representative data through the **real** lifecycle
(`createManuscriptVersion` → `approveManuscriptVersion` → `commitDelta`, plus a quarantined rejected
draft), captures a custom-format `pg_dump`, restores it with `pg_restore`, and verifies **23 invariants**:
migration count/version, tables/indexes/triggers, RLS policy count and `FORCE ROW LEVEL SECURITY` still
set, per-workspace row counts, canon version contiguity, manuscript content hashes, evidence code-point
offsets and quote hashes, accepted-only pointers, quarantine preserved and excluded, exactly one terminal
job event, job checkpoints, attempt-level provider provenance, per-workspace cost totals, derived-row
orphans, sequence non-collision, **cross-workspace RLS still enforced in the restored database**,
whole-database logical checksum equality, and the source database verified unchanged.

The fixture goes through the real lifecycle because the schema refuses the shortcut
(`ILLEGAL_TRANSITION`, `CANON_WRITE_OUTSIDE_COMMIT`). A drill whose fixture bypassed the invariants would
verify data the product can never produce.

**Safety.** `packages/db/src/restore-safety.ts` defaults every guard to refusal: the host must be local,
the database NAME must carry a word-delimited disposable marker, a protected word
(`prod`/`staging`/`live`/`customer`/…) refuses even alongside a marker, destruction needs an
acknowledgement independent of supplying the URL, and only databases the drill created are dropped.
**`NODE_ENV` is never consulted** — it says what a process believes about itself, not what database it is
pointed at. Passwords and complete connection URLs never reach a log, an error or the report. 33 guard
tests.

**Secret boundaries (rotation validation, not rotation).** 15 tests prove a missing or malformed secret
fails closed, no path defaults a secret into existence, CORS is default-deny and rejects a credentialed
wildcard, the worker refuses to start without an explicit provider mode, no secret reaches a log field or
a rendered log line, a database error carries a redacted target rather than a URL, and the provider
failure classifier returns a fixed enum member without echoing key material. The observability layer is
an ALLOWLIST, so the test that matters is the one proving an *unanticipated* field name is not logged
verbatim. Runbooks (§8.2, §8A of `11-deployment-and-incident-runbooks.md`) carry prerequisites, target
verification, abort conditions, post-restore verification, cleanup, evidence retention, redaction and
escalation, and state plainly that no live rotation occurred.

**Evidence.** 62 tests via `pnpm drill:restore` (33 guards + 29 drill assertions), durable report at
`coverage/restore-drill-report.json` whose `scope` block records `pitr_tested: false`,
`staging_restore_tested: false`, `production_restore_tested: false`, `offsite_backup_tested: false`,
`rto_rpo_measured: false`. The runner fails if the report ever starts claiming otherwise.


### Phase 4 tranche 2 — deterministic chaos and provider-fallback drills (B-4-2, deterministic portion)

**Two production defects were found and fixed** (this is why the tranche exists rather than only adding
tests):

1. **Fallback was unauthorized.** `Gateway.call` treated EVERY thrown provider error as a reason to move to
   the next route. A rejected request, an authentication failure, a content refusal and an unrecognized
   fault were all rerouted — re-sending the same bytes to a second paid model to reach the same refusal, and
   turning one deterministic failure into N. Fixed by `packages/gateway/src/failures.ts`: a provider adapter
   states its own verdict by throwing `ProviderFailure`, anything else is classified from its shape, and an
   UNRECOGNIZED failure defaults to **non-retryable** so an unknown fault cannot multiply spend. Only
   `retryable_transport`, `retryable_throttled` and `retryable_provider` authorize a reroute. Regression
   tests: `failures.test.ts` (9) and scenarios GW-05…GW-08, which assert the second provider's call count is
   **0**.
2. **Fallback had no attempt-level provenance.** `llm_calls` recorded one row per CALL, so a call that fell
   back named the winning model and `fallback_from_model_id` but recorded neither why route 1 was abandoned
   nor what each attempt cost. Migration **0011** adds `attempt_records` (validated by a trigger, because a
   CHECK constraint cannot contain a subquery) and the gateway now emits one entry per ACTUAL attempt. The
   row's summed `cost_cents` remains the authoritative total; attempt entries attribute it and must not be
   added to it. Regression tests: GW-09, GW-11, GW-17, GW-22.

**What exists.** `packages/gateway/src/fallback.chaos.test.ts` (22 gateway scenarios, `GW-nn`) and
`packages/workflows/src/chaos.integration.test.ts` (11 workflow/control-plane scenarios, `WF-nn`) run
against the REAL `Gateway`, the REAL `produceChapter` loop and real PostgreSQL 16, with faults injected only
at the provider boundary. `packages/gateway/src/chaos-report.ts` merges a machine-readable report
(`coverage/chaos-report.json`) carrying scenario ids, outcomes and short invariant labels — never prose,
prompts, provider payloads or credentials, which the report writer and the runner both assert.
`pnpm test:chaos` (`tools/run-chaos-drills.mjs`) is the explicit command: it refuses to start without
`DATABASE_URL`, deletes any stale report first, and fails unless every declared scenario reported `passed`
with no duplicate ids, no live provider call and no secret-shaped content. `ci.yml` runs it and additionally
greps `coverage/junit.xml` for both matrix names, so a skipped or filtered suite fails the build.

**Invariants proved (33 scenarios).** Fallback only for policy-retryable failures (GW-01…GW-04) and never
for a rejected request, auth failure, content refusal or unknown fault (GW-05…GW-08); every route
unavailable and an unconfigured fallback both fail closed (GW-09, GW-10); malformed output exhausts its
bounded repair budget on its own route before rerouting and fails closed when every route is invalid
(GW-11, GW-12); non-English output is regenerated once, rerouted once, then fails closed (GW-13); budget
denial precedes dispatch and a fallback cannot spend past the reservation (GW-14, GW-15); a missing identity
contract never reaches a provider (GW-16); each actual attempt has its own audit entry with its own verdict
(GW-17); a fallback call retains every pinned policy/prompt/identity/contract value and still runs the
output-language check (GW-18); a lost response followed by a retry reads the recorded call instead of
spending again (GW-19); usage is stored verbatim rather than guessed (GW-20); the surfaced error names its
`failure_class` without prose, prompts or secrets (GW-21); fallback order follows configured priority
deterministically (GW-22). On the workflow side: a crash after extraction leaves canon untouched and resumes
to exactly one commit (WF-01, WF-02); two concurrent runs of one chapter produce one acceptance and one
canon transition (WF-03); pause and cancel requested before dispatch stop the run at a step boundary with
no canon, no manuscript and no spend (WF-04, WF-05); a completed run emits exactly one terminal event and a
late cancel cannot rewrite it (WF-06, WF-07); a genuine replay miss fails closed without substituting a
draft (WF-08); a rerun re-reads recorded spend and refuses a second canon transition (WF-09, WF-10); and
control requested on an already-terminal job is refused rather than reopening it (WF-11).

**Measured (this session, local).** `pnpm test:chaos` — 33 scenarios, 64 tests, **20.5 s**, 0 live provider
calls. Repository test counts moved from **56 files / 790 tests** to **59 files / 824 tests**.

**What this tranche explicitly does NOT claim.**

- **No real provider outage was exercised.** Every fault is injected deterministically at the provider
  boundary. A mock/replay fallback drill is valid evidence about this system's decision logic and is **not**
  evidence that a vendor failed over successfully in production.
- Fencing still does **not** abort an already-running provider request. The lease fence prevents a stale
  result from committing; it does not cancel an in-flight HTTP call. Unchanged by this tranche.
- No provider credential, paid scheduled workflow or live call was added.
- B-4-2's live half and Phase 4 as a whole remain **incomplete**.

### Phase 4 tranche 1 — deterministic 120-chapter continuity replay (B-4-1, deterministic portion)

**What exists.** `packages/workflows/src/longform-replay.integration.test.ts` produces exactly 120
sequential chapters to acceptance in one project on real PostgreSQL 16 migrations, through the SAME
`produceChapter` the CLI and the Temporal worker run — real context packs, real deterministic checks, all
six replayed evaluators, the real approval lock, the real extraction, the real atomic acceptance commit, the
real L1 summary, the real accepted-only index and the real dependency edges. Only the model responses are
replaced. `packages/workflows/src/longform-fixture.ts` generates every chapter-scoped recording as a pure
function of the chapter number over the existing `examples/fixture/` story bible, so no manuscripts are
added to Git; `longform-harness.ts` wires the generated seed to the production `Gateway` (Guard, budget,
Postgres audit store, English output-language check) with the `ReplayProvider`.
`pnpm test:replay-120` (`tools/run-longform-replay.mjs`) is the explicit command; it refuses to start
without `DATABASE_URL` and fails unless the suite's own completion evidence records a full 120-chapter run
with zero replay misses and zero live provider calls. `ci.yml` runs it and additionally greps
`coverage/junit.xml` for the suite's completion marker, so a skipped or filtered suite fails the build.

**What it proves (18 tests).** Exactly 120 chapters, each accepted exactly once, with 120 accepted
manuscript versions and a final canon version of 122; every accepted manuscript passes the English
output-language check at confidence ≥ 0.99 and every scene passed the gateway's own check; canon advances
monotonically by exactly 1 per acceptance with no gaps or repeats and each acceptance commit's
`base_canon_version` is its predecessor's output; chapter k's pack carries chapter k−1's L1 summary,
verbatim tail, exact ending hook and committed canon deltas — asserted at the boundaries 1→2, 59→60 and
119→120, and asserted to be the immediate predecessor rather than an older chapter. Long-range continuity is
structural, not decorative: a porter-share fact asserted in chapter 1 is superseded at chapters 21, 41, 61,
81 and 101, each supersede citing the canon id the previous one created and each superseded row closed and
pointing at its replacement; three promises opened in chapter 1 are paid at chapters 3, 60 and **120** (119
chapters after setup); a relationship state changed at chapter 2 is superseded at chapter 119. Idempotency:
re-running chapters 1, 2, 59, 60, 119 and 120 replays every step from its checkpoint and changes no counter
(model-spend records, accepted versions, canon commits, summaries, search documents, dependency edges,
terminal job events), with zero duplicate `llm_calls` idempotency keys and no second terminal job event; a
chapter interrupted after extraction leaves canon untouched and, on resume, commits exactly once. Isolation:
a quarantined non-accepted candidate appears in no canon evidence, no accepted corpus, no summary, no search
document, no dependency edge and no export. Determinism: an independent run of the same seed against a clean
schema reproduces identical active-constraint-set, manuscript-content and L1-summary hashes and identical
context-pack content (normalized for the UUIDs the database allocates, which legitimately differ between
independent runs; byte-exact pack stability WITHIN a run is what replay depends on and is proved by the
rerun test requiring every step to replay from its checkpoint).

**Measured (this session, local).** 120 chapters accepted in **25.2–27.2 s** across runs (≈ 210–227 ms per
chapter), **0 replay misses**, **0 live provider calls**. Suite total 18 tests. Repository test counts moved
from **55 files / 772 tests** (baseline at `d63e05de`) to **56 files / 790 tests**.

**What this tranche explicitly does NOT claim.**

- The live 20-chapter nightly validation for five consecutive nights **has not run**. No live model was
  called, no provider credential was added, and no scheduled paid workflow exists. A deterministic replay is
  **not** a substitute for live evidence and is not offered as one.
- **B-4-1 is not complete** and **Phase 4 is not complete**.
- Evaluator thresholds remain **`uncalibrated`** (ADR-0029); this tranche changed no calibration status.
- **No production deployment has occurred.**
- Branch protection on the upstream base branch remains **unavailable/unconfigured**.
- Metrics and rate limiting remain **per process**; this tranche changed neither.
- Fencing still does **not** abort an already-running provider request.
- Vector retrieval remains an **interface** only (ADR-0045).

**Prerequisites for the live half (documented, not executed).** A funded provider credential held in the
secret manager and never in the repository; an explicit per-night budget ceiling enforced by the existing
`Gateway` budget; a nightly schedule that is opt-in and separate from normal CI (normal CI must stay
credential-free); recording of each night's run id, chapter count, spend and evaluator scores; and five
consecutive successful nights before any claim of B-4-1 completion. None of this is authorized or
implemented in this tranche.

| # | Scope item | Closes which open limitation |
| --- | --- | --- |
| 1 | 120-chapter compressed continuity validation | **deterministic half done in tranche 1** (above); long-form continuity is now exercised to chapter 120 deterministically |
| 2 | Live 20-chapter nightly validation for five consecutive nights | no live-provider validation has occurred; every model call to date is replayed |
| 3 | Provider fallback and chaos drills | **deterministic half done in tranche 2** (above): fallback is now classified and authorized, and 33 deterministic scenarios run in CI. Still open: fencing does not abort an already-running provider request, and fallback under a REAL provider failure is untested |
| 4 | Backup/restore and recovery drills | no production deployment has occurred and no restore has ever been exercised |
| 5 | Security test expansion | the RLS/least-privilege/rate-limit surfaces are tested but not adversarially exercised at MVP scale |
| 6 | Bilingual reviewer evaluation and threshold calibration | evaluator thresholds remain `uncalibrated` (ADR-0029); contrast agreement is deterministic replay agreement, not measured judge quality |
| 7 | Cost calibration and operational dashboards | metrics and rate limiting are per process; no aggregated or multi-process view and no calibrated cost model exist |

Vector retrieval also remains an interface only (no embedder, no pgvector; ADR-0045) and is not in the seven
items above; it is scheduled by ADR-0045 rather than by this phase.

## Checkpoint 6 — quality and long-form validation (merged upstream at `6195700`)

| Item | State |
| --- | --- |
| B-6-1 multi-chapter continuity | **done for chapters 1 → 2 → 3 (three consecutive accepted chapters)**: `examples/fixture/ch02` and `examples/fixture/ch03` (authored scenes + generated recordings) and 28 Postgres/Replay tests. One canon bump per accepted chapter (v3, v4, v5) with chapter 3's delta based on v4; chapter 3's pack carries chapter 2's summary, hook and verbatim tail and **not** chapter 1's; concrete carry-over asserted by content (the eighteen-percent share, the saved leg, the flagged gate) rather than row counts; the gate fact chapter 2 committed is superseded by chapter 3, not duplicated; StoryClock monotone across D+0/D+1/D+2; the promise chain opened(ch.1) → paid(ch.2) → advanced(ch.3); export returns 1, 2, 3 in order, accepted text only; a rerun adds nothing. Predecessor gate: chapter 3 requested while chapter 2 is absent, working or rejected fails with exactly `PREVIOUS_CHAPTER_NOT_ACCEPTED` at step `chapter_contract` with **zero** model calls and no manuscript, canon, summary, index or dependency edge. Resume: chapter 3 interrupted after `scene_plan`, `scene_draft`, `assemble`, `evaluate`, `approve` and `extract` resumes to exactly one accepted chapter 3, one canon advancement, one summary and no duplicate successful call by idempotency key. The compressed 120-chapter long-form run remains B-4-1 |
| B-6-2 failure-recovery tests (commit fault, stale canon, provider fault, resume) | **done**: 30 Postgres/Replay tests. Failure after each of 8 pre-commit steps leaves no chapter commit/accepted version/summary/index; resume replays every completed step and a third run adds no spend; a racing canon commit fails `CANON_STALE` with nothing half-committed; a provider fault fails closed without substituting a draft; a blocked gate reports `needs_attention` rather than `failed`. Added in this change: budget exhaustion refused **before** the provider and audited as `budget_blocked`, with the resumed run completing and no duplicate successful call by idempotency key; malformed, truncated and empty structured output each failing closed at the drafting boundary; a non-English draft failing the output-language boundary; in-transaction canon rejection (unsupported claim, planned frame) leaving only the bible commits with canon exactly at their version and no fact from a chapter acceptance; the **ambiguous post-commit** case — acceptance committed, process died before the checkpoint — where the retry reuses the same commit id and canon version with no second commit, acceptance, summary or index; and cross-project isolation. **This suite found and fixed a real defect** (see decisions log) |
| B-6-3 contrast corpus 4 → ≥ 40 original sets with expectations | **done in this change**: 40 sets in `examples/fixture/contrast-sets.seed.json` (5 genres × 8 narrative functions; 36 authored here), validator count/structure checks green; the judge calibration *run* is B-4-5 and has not happened |
| B-6-4 candidate comparison, selection and patch regression on replay | **done**: `chapter_comparator` prompt family (25th), `packages/workflows/src/comparison.ts` (position-swapped pairwise judging, shuffled-rubric retry, deterministic tie ladder — ADR-0015; per-dimension patch regression and smoke checks — ADR-0014) and `selection.ts` (N-candidate selection). 41 unit + 47 Postgres/Replay integration tests. **Enforcement is at the production boundary**: `requireSelectedWinner` runs inside `approveVersion` and, independently, inside `acceptDelta`, so a direct call to either with a loser fails closed; whether selection is required is decided from the pinned policy and durable candidate rows, never a caller flag. Eligibility reads the **persisted** scorecard artifact for the exact manuscript version and refuses fabricated, foreign, stale-canon, missing and malformed evidence. A committed decision answers exactly one request: the fingerprint pins workspace, project, chapter, contract, candidate slots and content hashes, canon base, identity, policy, prompt set, scorecard artifacts and evaluator provenance, and a changed request is refused rather than silently answered. Finalization is atomic — migration 0005 `candidate_selections` commits the decision and every loser transition in one transaction — and a lost concurrency race surfaces as a typed retriable `SELECTION_CONFLICT`, never a raw database error. Tie fallback requires the explicit policy field `candidates.tie_fallback_ladder_authorized`. Cyclic comparator preferences return `needs_attention` instead of a schedule artifact presented as a winner |

Known mismatch surfaced by B-6-4 (recorded, not fixed here): `standard.v1` gates four dimensions
(`prose`, `structure`, `genre`, `voice`) but the Checkpoint 5 evaluator scores only the first two, so no
candidate can satisfy the ADR-0015 early stop under that policy. `earlyStopDecision` therefore refuses to
stop and names the missing dimensions rather than treating an absent judge as a silent pass; a test asserts
exactly that. Wiring the genre and voice judges (or narrowing the policy) is a separate decision.

B-6-1 scope note (truthfulness, ADR-0043): what exists is a **three-chapter** chain, proved end to end on
replayed fixtures. Three chapters rather than two because a two-chapter chain cannot distinguish "reads the
previous chapter" from "reads chapter 1"; chapter 3 is written to be consumed — its premise is chapter 2's
ending hook, it carries chapter 2's committed state, and it supersedes the fact chapter 2 committed. The
compressed 120-chapter long-form run remains B-4-1. Nothing here is evidence about live-model prose over
many chapters.

N-candidate scope note (truthfulness, ADR-0043): `standard.v1` sets `chapter_candidates: 1`, so **default
production still generates one candidate** and `produceChapter` does not fan out into N candidates. That is
deliberate and unchanged in this checkpoint. What the checkpoint guarantees is that selection is
*enforceable* whenever it applies: when the pinned policy asks for more than one candidate, or when more
than one live candidate version exists on a chapter, approval and canon acceptance both require the
committed winner and fail closed otherwise. The selection ordering claim is equally narrow: the outcome is
deterministic for the pinned `stable_slot_single_elimination` schedule, which is persisted with the
decision as provenance — it is **not** a claim of a schedule-independent global winner, because a pairwise
comparator is not guaranteed transitive (ADR-0015). Observed cycles return `needs_attention`.

B-6-3 scope note (truthfulness, ADR-0043): the corpus is now large enough for the calibration round, but
nothing in this change measures judge behavior. Every `expected` block is an authored starting expectation
(rank orders, illustrative lint ids from the EP-*/ST-*/RG-*/TRN-* catalog, two gap thresholds); profile and
policy thresholds remain `uncalibrated`. Deterministic replay in CI is not evidence of live-model prose
quality, and synthetic contrast sets are not a substitute for the bilingual reviewer panel (B-4-5).

## Important decisions log

| 2026-09-15 | Known fixture-tooling drift (recorded, not fixed here): `tools/build-ch01-fixture.py` does not emit the `variant:*` recordings that were added to `examples/fixture/ch01/replay.ch01.json` later for fault-injection tests, so re-running that builder would drop them. The chapter-2 and chapter-3 builders reproduce their outputs exactly. Re-running the ch.1 builder is therefore currently safe only for `ids.ch01.json`; reconciling the variants into the builder is a separate change | `tools/build-ch01-fixture.py`, `examples/fixture/ch01/replay.ch01.json` |
| 2026-09-15 | Concurrency repair found by the strengthened B-6-4 assertion (CI caught it first, then reproduced locally on ~half of eight runs): a caller that lost a concurrent race received `INTERNAL` carrying a raw PostgreSQL duplicate-key message. Two paths, both fixed at the source — `llm_calls_idempotency_succeeded` now raises a typed `DuplicateCallError` mapped to the retriable `CONCURRENT_CALL`, and the content-addressed `workflow_artifacts` insert absorbs either conflict target and re-reads the committed row. Neither constraint was weakened; the conflicts are still refused, just reported as the typed retriable conditions they are | `packages/db/src/audit.ts`, `packages/db/src/workflow.ts`, `packages/workflows/src/errors.ts` |
| 2026-09-15 | N-candidate repairs (B-6-4): winner enforcement moved from an optional helper into `approveVersion` and `acceptDelta` themselves; eligibility switched to persisted scorecard artifacts; a complete request fingerprint added; finalization made atomic in `candidate_selections` (migration 0005) with a typed `SELECTION_CONFLICT` instead of a raw duplicate-key error; tie fallback given a real policy field (`candidates.tie_fallback_ladder_authorized`) in place of inferring authorization from an unrelated field's existence; and the schedule-independence claim withdrawn in favour of persisted-schedule determinism with cycle detection | `packages/workflows/src/selection.ts`, `packages/workflows/src/acceptance.ts`, `packages/db/src/selection.ts`, `packages/db/migrations/0005_candidate_selection.sql`, `schemas/production-policy.schema.json` |
| 2026-09-15 | Acceptance repair found by B-6-2: `acceptChapter` passed the project's *current* `canon_version` as the commit's parent, so the optimistic check compared a value with itself and a commit landing between extraction and acceptance was absorbed silently instead of raising `STALE_CANON`. The parent is now the delta's own `base_canon_version` (the version extraction was performed against), and a delta without an integer `base_canon_version` is rejected rather than committed unpinned | `packages/canon/src/accept.ts`, `packages/workflows/src/recovery.integration.test.ts` |

| Date | Decision | Where |
| --- | --- | --- |
| 2026-09-13 | Lifecycle: `origin` + `status`; approval-locked extraction; accepted on commit | ADR-0037 |
| 2026-09-13 | Five bitemporal change classes; extraction emits transitions only | ADR-0038 |
| 2026-09-13 | `source_story` = fact-bearing timeline kind reached through knowledge; reincarnation reuses prior-loop timelines | ADR-0039 |
| 2026-09-13 | StoryClock: narrative order authoritative; world order partial; calendars; `narrated_at` | ADR-0040 |
| 2026-09-13 | Production Policy = single versioned source of limits/gates; per-dimension gates only | ADR-0041 |
| 2026-09-13 | Issue-override matrix (never / canon_workflow / reviewer / advisory) | ADR-0042 |
| 2026-09-13 | Truthful baseline: starter labels, one progress doc | ADR-0043 |
| 2026-09-13 | Modular monolith first; CLI before API/UI; Temporal after the core loop | ADR-0044 |
| 2026-09-14 | Prompt families live in the repo (`packages/prompts/families/<family>/vX.Y.Z/`) as the review surface; the DB mirror (`prompt_versions`) is hash-verified and immutable; `tools/seed-prompt-families.py` authored v1.0.0 and is idempotent | `packages/prompts` |
| 2026-09-14 | Gateway audit rows never contain prompt or output text (hashes + sizes only; outputs live in the artifact store the workflow owns) | `packages/gateway/src/gateway.ts`, migration 0002 |
| 2026-09-14 | Canon boundary is the SQL function: all canon tables carry BEFORE triggers that refuse writes unless `canon.in_commit` is set by `canon.commit_delta`/`rollback_latest`, and refuse DELETE/TRUNCATE outright; `btree_gist` exclusion constraints make overlapping validity impossible; evidence trigger uses Postgres code-point `substring` on NFC text | `packages/db/migrations/0001_canon_core.sql` |
| 2026-09-14 | Toolchain: TypeScript 5.9 (typescript-eslint peer range), Vitest 4, ESLint 10 flat config, Prettier 3, `json-schema-to-typescript` for types with a freshness check in CI, Ajv 2020-12 at runtime; UUIDv7 implemented in-house (no dependency); deterministic script/lexicon output-language check (no statistical language-id dependency) | README.dev.md |
| 2026-09-14 | Context packs are pure functions of pinned inputs (pack id = UUIDv8 of the pack hash; ACS id = UUIDv8 of its content hash); lexical index is accepted-only by SQL trigger, synchronous with acceptance, removed on de-acceptance; vector retrieval is an interface until an embedder exists; structured failure blocks, optional failure degrades with flags; per-template input budgets live in the Production Policy | ADR-0045 |
| 2026-09-14 | Repair: `createManuscriptVersion` numbers versions across `manuscript_versions ∪ quarantine_versions` so a quarantined draft and its replacement never share a `version_no` (found while seeding the fixture; regression test in `canon.integration.test.ts`) | `packages/db/src/repo.ts` |
| 2026-09-15 | Chapter-production repair: previous-chapter gate runs before any model spend or canon write (T17); Replay `activity:<id>` binding with prompt-hash priority (no live calls); canon identity stays global, failure-paths tests isolate per-test via DB reset (T19/T19b); T11 extract-variant fixture carries schema-valid plan-frame + future-dated items | ADR-0046, `packages/workflows`, `examples/fixture/ch01/replay.ch01.json` |
| 2026-09-15 | CLI chapter surface over the production workflow (no parallel orchestration): `chapter:produce` runs/resumes `produceChapter` with replay-only routing and deterministic workflow ids, `chapter:status` reads the persisted job, `chapter:resume` re-runs the same workflow id explicitly, `export:accepted` exports accepted text only; nonzero exit on failure; T19b proves two live projects cannot share deterministic fixture UUIDs | `apps/cli`, `apps/cli/src/chapter.test.ts` |

### Credential-free automated readiness — shared enforcement, retrieval and operational templates

**Status: implemented for the scope below. This does NOT complete Phase 4, the MVP or production
readiness.** Continuation branch `hoplite/selinous-f82579f4` in the writable fork `sigma32web/New`, imported at exactly
`5768f79a8a6314805ef5330eb275b8ad91928ea5` from `sigma31web/New:hoplite/akragas-7c1f75a8` with its
13-commit ancestry preserved (13 ahead, 0 behind the base `30cb62af6fed0ac685fe29d44cae0f471577aab1`;
26 files, +5,306/−20). Markers: `--automated-readiness-handoff-5768f79` and
`--automated-readiness-baseline-5768f79` at the imported SHA.

**Baseline at the imported SHA reproduced exactly before any edit:** 76 test files, 1,168 tests, 0
skipped; 40 restore invariants; 49 chaos scenarios; 120-chapter replay with final canon version 122; 100
contrast sets × 5 variants × 4 dimensions = 2,000 evaluations, 700/700 agreement, 0 false positives, 0
false negatives, threshold 0.60, calibration `uncalibrated`, corpus hash
`sha256:4c9ef2225e0e72ada566401183c453b19b7383c29cfac1a5617958aaeadbb97b`. Dependency audit 0 blocking;
`git diff --check` clean; no file changed during the baseline.

**Shared enforcement is now active in the worker's production path.** The limiter and `SharedBudget`
existed but nothing used them: the gateway the worker constructed held a `MemoryBudget`, whose `Map` of
spend is not a budget once the worker runs twice. `PgProviderAdmission` adapts migration 0015's
primitives, taking the releasable concurrency lease BEFORE the un-undoable window counter so a refusal
unwinds exactly. The gateway admits **per attempt, inside the loop**, so retry, bounded repair and route
fallback each earn their own admission for the model they will actually pay; a refusal is not a provider
fault and is never rerouted or repaired. The worker defaults to shared enforcement, reaches
`MemoryBudget` only through an explicit `YEONJAE_ENFORCEMENT_MODE=isolated_test`, fails closed on an
unrecognized value, and asserts the 0015 functions exist before accepting work.

**Multi-process tests now exist**, which required fixing the inherited shared-database reset race.
`resetDatabase` drops the `public` and `canon` schemas, so two contexts on one database delete each
other's tables; the fix is a database per context created from the same migrations, not sleeps or retries.
Children are real OS processes reporting JSON state lines, so "the holder died" means it died, and the
parent synchronises on printed state rather than elapsed time.

**Retrieval.** A deterministic local embedder (hashed lexical features, fixed 256 dimensions, SHA-256
bucketing, L2-normalized with rounded components). It captures lexical overlap, **not meaning**: fixture
recall measured against it is evidence the pipeline works and says nothing about production embedding
quality. Migration 0016 completes the embedding-set lifecycle 0003 left as a registry, with activation as
a locked function rather than two UPDATEs, so a reader never observes two active sets or none, and an
empty or incomplete set is refused. Migration 0017 adds the project-scoped thesaurus, where expansion is
a retrieval aid and never a canon assertion. Hybrid ranking normalizes each side against its own best hit
before weighting, with a total order so ties are deterministic, and degrades to lexical-only rather than
failing.

**Operational templates exist and are statically validated — never built, never run, never deployed.**
No container runtime and no monitoring system are available here. 32 tests check the compose service
graph, dependency conditions, published ports, credential defaults, Dockerfile stages, a secret scan, and
every alert and dashboard metric and label against the observability registry.

**Defects found and fixed in this tranche**

| ID | Severity | Defect |
| --- | --- | --- |
| R-1 | HIGH | the metrics registry filtered labels with `isLoggableKey`, the LOG allowlist, which permits any `*_id` suffix — so a tenant identifier could become a metric label on the deliberately unauthenticated `/metrics` endpoint, an unbounded-cardinality and disclosure defect at once. Metric labels now use their own strict allowlist and values outside a bounded shape collapse to `other` |
| R-2 | HIGH | the gateway recognized a budget refusal by CLASS (`GatewayError`), so a `SharedBudget` rejection — which raises `BudgetExhaustedError` from `@yeonjae/db` and cannot import that class without inverting the package dependency — produced **no `budget_blocked` audit row**. Now matched on `code` |
| R-3 | MEDIUM | `canon.gc_eligible_embedding_sets` filtered the rollback target BEFORE computing recency, renumbering the remaining rows and hiding genuinely eligible sets behind the keep window |
| R-4 | MEDIUM | the thesaurus normalized surfaces with `toNfcText`, which returns a `{ text, codePoints }` record rather than a string, corrupting every stored surface to `"[object Object]"` |
| R-5 | LOW | the Dockerfile healthcheck probed `/readyz` against a server that serves `/ready`; every container would have reported unhealthy. Caught by the static validator written alongside it |
| R-6 | LOW | alert runbook links pointed at sections that did not exist; 24 response sections were added and the validator now fails on a missing anchor |

**Known flake, recorded rather than hidden.** `lease-fence.integration.test.ts` → "serializes a
concurrent steal against an open fenced transaction" failed once in a combined
`packages/db packages/prose packages/context` run and passed on every isolated and repeated run
(3/3 isolated, 323/323 for `packages/db`, 403/403 on the combined retry). It is inherited, timing-sensitive
and not caused by this tranche's changes; it does not block deterministic continuation and is **not**
worked around by weakening the assertion.

**Scope limits, stated rather than glossed.** The following were credential-free and **were not done** in
that tranche: worker liveness/readiness endpoints and an explicit API drain phase; operator `/v1` and CLI
surfaces for the new subsystems (the controls existed as tested library functions); **metric call sites**
for the new counters (names, labels, cardinality guards and template validation existed, but the gateway,
worker and retrieval paths did not increment them); the remaining deterministic workflow surfaces; local
recovery completion beyond the current 40 invariants; credential-rotation simulation; bounded performance
smoke tests; and the single end-to-end automated-readiness scenario. Several of these were completed
afterwards — see the continuation section below. **Phase 4 remains incomplete**, no live provider call was
made, and no real credential was used.

### Credential-free automated-readiness continuation (`sigma33web/New`, 2026-09-18)

Continued from the inherited head `f65a4c9c42ff6b970b1889cc574613ef3e9d43d1` (22 commits ahead of the
base `30cb62af6fed0ac685fe29d44cae0f471577aab1`, 0 behind), preserved commit-for-commit on the branch
`hoplite/hattusa-72f3a6b9` in the writable fork `sigma33web/New`. No inherited commit was amended,
cherry-picked, squashed or rewritten, and nothing was pushed to any other repository.

**The inherited head was not CI-validated.** sigma32's exact-head run failed at `pnpm format:check`, and
because formatting runs before the test stages, *every test stage was skipped*. The cause was a single
file: commit `32b12ae` widened the `@yeonjae/domain` import in `packages/db/src/repo.ts` past the
configured print width without reformatting. The repair re-wraps that import list and contains no
semantic change. With formatting fixed, the complete suite was run against local PostgreSQL 16.14 for the
first time at this head: **89 files, 1,360 tests, all passing, none skipped.**

Completed in this continuation:

| Work | Evidence |
| --- | --- |
| Operator API and CLI surfaces | `/v1/operator/*` routes and `operator:*` CLI commands over ONE shared service layer (`packages/db/src/operator-diagnostics.ts`): limiter counters, live lease occupancy, shared-budget state, embedding-set completeness, GC candidates, thesaurus listing with ambiguity diagnostics, bounded retrieval diagnostics. 27 tests (16 API, 11 CLI) covering authentication, tenant isolation, scope-from-auth, bounding, malformed input and redaction |
| Versioned backup manifests | `packages/db/src/backup-manifest.ts`; 15 tests covering the valid case, checksum mismatch, truncation, missing/malformed manifests, unsupported versions, schema newer than the application, schema below the floor, wrong manifest/artifact association, missing artifact, absent secret-exclusion assertion, credential refusal, repeatability and numeric ordering |
| Local WAL/PITR rehearsal | `pnpm drill:pitr`. **PASSED** on local PostgreSQL 16.14: base backup, recorded recovery target, restore-and-replay, pre-target rows present (2), post-target rows absent (0), all processes and files cleaned up. Capability-gated with a structured `CAPABILITY_BLOCKED` result where no server can be started |
| Bounded performance smoke tests | `pnpm test:perf-smoke`, separate from the correctness suites; 8 tests over 10 measured paths, monotonic timing, warm-up, broad ceilings, registry-growth and output-size bounds, environment metadata recorded to `coverage/perf-smoke-report.json` |

**This is local evidence only.** The PITR rehearsal proves the WAL/recovery-target configuration works on
this PostgreSQL build; it says nothing about staging or production recovery, off-site backup, retention or
object-store durability. The performance figures are bounded smoke results on a shared 2-CPU sandbox and
are **not** production throughput, latency or capacity.

**Still open and credential-free** (carried in `12-remaining-external-work.md`): an explicit API drain
phase with telemetry flush and a degraded-versus-unavailable distinction; operator *mutations* (embedding-
set activation/rollback, thesaurus create/deactivate/reactivate, job cancellation) as audited owner-gated
endpoints — the current operator surface is read-only; the remaining deterministic workflow surfaces from
`02-backlog.md`; and the single wired end-to-end automated-readiness scenario.

### Final credential-free tranche (`sigma33web/New`, continued 2026-09-18)

Continued on the same branch `hoplite/hattusa-72f3a6b9` from `8d35a9889d7ceff97e44d210ed82df1de09caf0e`,
whose CI and planning validation were both green. The four items listed immediately above are now
implemented, with one deliberate exception recorded below.

| Work | Evidence |
| --- | --- |
| **API graceful drain** | The API runs the same `LifecycleCoordinator` as the worker: readiness fails synchronously the instant drain begins (before any dependency probe), liveness keeps succeeding and reports `stopping`, new work is refused with a 503 `SERVICE_DRAINING` problem document and a `retry-after`, in-flight requests finish inside a bounded deadline, the deadline produces a distinct exit code, telemetry flush is bounded independently, and a close that throws never strands the other resources. **15 real-process tests** spawn the actual API and signal it, synchronising on JSON state lines and HTTP probes with no sleeps. |
| **Operator mutations** | Embedding-set activation and rollback, and thesaurus create/deactivate/reactivate, on `/v1/operator/*` and the CLI over one shared service layer. Owner-gated, audited on **both** success and refusal, idempotent, with cross-tenant and cross-project targets answered as 404. **18 API + 16 CLI tests.** |
| **End-to-end readiness scenario** | One ordered **20-stage** run through real boundaries (`pnpm test:e2e-readiness`), failing if any stage is skipped. Recorded: 17 migrations with hashes, 25 provider attempts, 43 artifacts all content-hashed, 74 vectors, incomplete-set activation refused, budget settled at 4,200 millicents with a released reservation leaving 0 outstanding, 0 live leases, second tenant observing 0 projects / 0 calls / 0 aliases, backup manifest verified, FORCE RLS intact and PUBLIC EXECUTE revoked. |

**Defects found and fixed in this tranche** (all found by the new tests, none pre-existing in production
paths): operator mutation body and path validation ran **before** authentication, so an anonymous caller
with a malformed body received 422 and learned the request schema; the thesaurus route re-resolved the
auth scope **inside** its transaction, taking a second pooled connection while holding one and
deadlocking a small pool into a 500; and migration 0017's rule that every alias kind except `terminology`
names an entity was unenforced at the boundary, surfacing as a 500 constraint violation instead of a
stable `ALIAS_INVALID`.

**Workflow-surface reconciliation.** All 35 deterministic lifecycle capability areas were reconciled
against the code. Every one is implemented and tested; no genuine gap remained to implement. Two backlog
notes were **stale rather than open**: B-4-9's "limiter and budget not yet wired into the worker's
production path" was completed by `45e6b2e`, and the outbox entry is satisfied by the append-only
`job_events` log plus SSE rather than a separate outbox table.

**Deliberately not done, with reason.** Job cancellation is NOT duplicated as an `/v1/operator/*`
mutation. It is already implemented, owner-gated and tested through `POST /v1/jobs/:jobAction` and the
durable control path; a second route onto the same state machine would mean two authorization surfaces
for one action, which is a security regression rather than a feature.

**Inherited lease-fence flake:** still not reproduced. It passed every observation in this tranche as
well. Nothing was weakened, skipped or slept around; it remains recorded rather than hidden.

**CI no-skip guard, installed.** The workflow change this tranche proposed could not be pushed by the
agent's GitHub App, which lacks the `workflows` permission. A maintainer applied it as
`6ab8b286f4526461756450eb6a72185e5f577a5f`, identical to the proposed patch, and all five guard steps
executed and passed in CI: the explicit `pnpm test:e2e-readiness` run, its forty-stage durable-report
check, the explicit `pnpm test:perf-smoke` run, the junit guards that the six product suites ran, and the
zero-skipped-tests gate. The guards are verified as *running*, not merely present.
