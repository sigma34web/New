# Remaining external work

What is left after the credential-free automated tranche. Everything here is blocked on something this
repository cannot contain: a paid provider, a deployed environment, a secret manager, or a human.

This file is deliberately short. If an item can be done locally and deterministically, it does not belong
here — it belongs in the backlog as work to do.

**Phase 4 is NOT complete, and the MVP is not production ready.** The milestone this tranche targets is
*automated readiness*: the practical credential-free implementation, simulation and validation that should
exist before the live tranche begins.

## Blocked on a live provider

| Item | Why it cannot be done here | What is already prepared |
| --- | --- | --- |
| Live-provider connectivity and prose quality | needs paid API access | `HttpProvider` speaks the real transport; `YEONJAE_PROVIDER_MODE=live` is a validated mode |
| Confirmed REMOTE cancellation | only a real provider can acknowledge a stop | the `/v1/cancel` path and `remote_cancellation` states (`acknowledged` / `unsupported` / `unknown` / `not_requested`) are exercised against the simulator |
| Proof that remote provider computation stopped | not observable without provider cooperation | recorded as `unknown` by construction; never claimed |
| Real provider outage and fallback drills | needs an actual outage | 49 deterministic chaos scenarios plus HTTP 429/500/502/503, resets and truncation against the simulator |
| Provider usage and invoice reconciliation | needs invoices | integer-millicent accounting, `cost_known`, and unknown-cost settlement that never books zero |
| Five-night live chapter campaign | needs paid generation over five nights | the 120-chapter deterministic replay |

## Blocked on deployed infrastructure

| Item | Why it cannot be done here | What is already prepared |
| --- | --- | --- |
| Staging and production deployment | no environment exists | readiness gates on migration state, schema drift and role attributes |
| Staging/production restore and real PITR | needs a deployed database and WAL archive | local deterministic logical dump/restore with 40 invariants, including security metadata and re-executed post-restore behaviour |
| Production monitoring observation | needs a running deployment scraping `/metrics` | per-process Prometheus registry with a STRICT metric-label allowlist, plus `ops/alerts.json` and `ops/dashboards.json` validated against that registry. **Nothing observes them**; no alert has ever fired |
| The privilege model verified on a deployed cluster | needs that cluster | ADR-0050's model asserted against local PostgreSQL 16 and in fork CI |
| **Building and running** the container topology | **no container runtime is available in this workspace** — `docker` and `podman` are both absent | `deploy/Dockerfile`, `deploy/.dockerignore` and `deploy/compose.yaml` exist and are **statically validated** by 32 tests (stage graph, dependency conditions, published ports, credential defaults, health paths checked against real routes, secret scan). They have **never been built or run** |

## Blocked on a real secret manager

| Item | Why it cannot be done here | What is already prepared |
| --- | --- | --- |
| Live credential rotation | rotating a credential requires having one | rotation runbooks; `.env.example` lists variable names only; gitleaks gate over full history |

## Blocked on human judgment

| Item | Why it cannot be done here | What is already prepared |
| --- | --- | --- |
| Bilingual human review | needs reviewers | blinded reviewer-packet tooling |
| Evaluator threshold calibration | needs review outcomes | 100-set corpus, 2,000 deterministic evaluations, 700/700 agreement, status `uncalibrated` |
| Product-owner acceptance | a decision, not a task | — |

## Not blocked, and honestly still open

Recorded here so the list above cannot be read as "everything else is done". These are credential-free and
could be implemented next. Entries for shared enforcement, local embeddings, versioned vector retrieval,
the thesaurus, multi-process tests, metrics and deployment/alert templates were removed earlier because
they are implemented (see `09-progress.md`).

Four further entries were removed in the same spirit, because they are now implemented and tested:

- **Metric call sites** — the new counters are incremented from the gateway, worker and retrieval paths
  (`32b12ae`), with emission and coverage suites.
- **Credential-rotation simulation** — the fake-credential state machine, overlap windows,
  retired-credential rejection and rollback exist with no real secret anywhere (`ca4e880`).
- **Worker liveness/readiness and bounded draining** — the worker health surface and the bounded drain
  state machine exist and are exercised by a real-process lifecycle suite (`f65a4c9`).
- **Operator API and CLI surfaces** — the `/v1/operator/*` routes and `operator:*` CLI commands now expose
  limiter counters, lease occupancy, shared-budget state, embedding-set completeness, GC candidates,
  thesaurus listings with ambiguity diagnostics and bounded retrieval diagnostics, over one shared service
  layer, with authorization, isolation, bounding, malformed-input and redaction tests.
- **Local recovery completion** — versioned backup manifests with checksums and compatibility metadata,
  the full matrix of refusal cases, and a local WAL/PITR rehearsal (`pnpm drill:pitr`) that passes on
  PostgreSQL 16 and reports `CAPABILITY_BLOCKED` where a server cannot be started.
- **Bounded performance smoke tests** — `pnpm test:perf-smoke`, separate from the correctness suites,
  recording environment metadata with every run.

Three further entries were removed because they are now implemented and tested:

- **API drain phase** — the API runs the same `LifecycleCoordinator` as the worker. Readiness fails
  synchronously the instant a drain begins, liveness keeps succeeding and reports `stopping`, new work is
  refused with a 503 `SERVICE_DRAINING` problem document, the deadline is enforced with a distinct exit
  code, and telemetry flush is bounded independently. 15 real-process signal tests.
- **Operator mutations** — embedding-set activation and rollback and thesaurus
  create/deactivate/reactivate are exposed as owner-gated, audited mutations on both `/v1/operator/*` and
  the CLI, over the same shared service layer as the reads.
- **The end-to-end automated-readiness scenario** — one ordered 20-stage run through real boundaries with
  a no-skip guard (`pnpm test:e2e-readiness`).

Still open and credential-free:

- **The remaining deterministic workflow surfaces** listed in `02-backlog.md` (batch operations,
  regeneration preview, typography and platform-format checks, deterministic export preparation). These
  are product surfaces rather than readiness gaps.
- **A degraded-versus-unavailable distinction for optional dependencies.** Readiness already reports a
  `degraded` status, but which dependencies are optional is not yet declared per dependency.
- **Job cancellation as an operator-surface mutation.** Cancellation is implemented and tested end to end
  through `POST /v1/jobs/:jobAction` (owner-gated) and through the durable control path; it is
  deliberately NOT duplicated under `/v1/operator/*`, because a second route onto the same state machine
  would be two authorization surfaces for one action.

## Needed a repository permission — resolved

The CI no-skip guards for the product suites were blocked, not missing. The GitHub App pushing the branch
lacks the `workflows` permission, so its commit touching `.github/workflows/` was rejected by the remote;
only that commit was reverted, and the exact patch was carried in the pull request body instead.

A maintainer applied it as `6ab8b286f4526461756450eb6a72185e5f577a5f`, byte-for-byte identical to the
proposed patch (79 insertions, no deletions, so no existing check was removed or weakened). All five new
guard steps then **executed and passed** in real CI: the explicit `pnpm test:e2e-readiness` run, its
forty-stage durable-report check, the explicit `pnpm test:perf-smoke` run, the junit guards that the six
product suites actually ran, and the zero-skipped-tests gate.

**Note for future agent tranches:** a change under `.github/workflows/` cannot be pushed by this app.
Propose the patch in the pull request body and mark it for maintainer action rather than attempting the
push as part of a larger commit, because the rejection fails the whole push.
