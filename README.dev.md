# Developing Yeonjae Studio

## Prerequisites

- Node 22 LTS (`.nvmrc`), pnpm 10 (`corepack enable` or `npm i -g pnpm@10`)
- Python 3.12 with `jsonschema` for the planning validator (`pip install jsonschema`)
- Temporal (optional locally; the test suite downloads and runs the time-skipping test server itself, so no
  server and no credentials are needed for `pnpm test`)
- Postgres 16 with `btree_gist` (bundled) — `DATABASE_URL=postgres://user:pass@127.0.0.1:5432/yeonjae_test`; integration tests skip (visibly) when it is unset

## Commands

| Command                                                                                                         | What it does                                                                       |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `pnpm install`                                                                                                  | install the workspace                                                              |
| `pnpm gen:types`                                                                                                | regenerate `packages/domain/src/generated` from `schemas/` (commit the result)     |
| `pnpm check:types-fresh`                                                                                        | fail if generated types are stale (CI)                                             |
| `pnpm typecheck`                                                                                                | `tsc -b` over all packages (strict)                                                |
| `pnpm lint` / `pnpm format` / `pnpm format:check`                                                               | ESLint (type-aware) / Prettier — never touches `examples/`, `docs/`, `schemas/`    |
| `pnpm test`                                                                                                     | Vitest unit tests                                                                  |
| `pnpm validate:planning`                                                                                        | planning-package validator (schemas, examples, evidence, references, stale terms)  |
| `pnpm check`                                                                                                    | everything CI runs                                                                 |
| `pnpm build:web`                                                                                                | production build of the operator web app                                           |
| `pnpm --filter @yeonjae/web dev`                                                                                | run the operator web app against a local API (see the environment variables below) |
| `pnpm cli <command>`                                                                                            | the CLI (`pnpm cli` prints usage)                                                  |
| `pnpm cli pack:build <project> <ch> <role> <contract.json> <spec.json> [--identity=<ref>] [--full] [--persist]` | build a Context Pack and print its manifest (no manuscript text unless `--full`)   |
| `pnpm cli chapter:produce <project> <ch>`                                                                       | run (or resume) chapter production through the Postgres-checkpointed workflow      |
| `pnpm cli chapter:status <workflow-id>`                                                                         | job status, pins, steps and llm call count (`chapter:<project>:<ch>`)              |
| `pnpm cli chapter:resume <workflow-id>`                                                                         | resume a started workflow (same entrypoint as re-running produce)                  |
| `pnpm cli export:accepted <project> [--chapters=1,2] [--format=markdown\|text] [--full]`                        | export accepted manuscripts only (never working/approved/quarantined)              |

Chapter production runs replay-only in this checkpoint: `chapter:produce` pins the fixture Narrative
Identity on the project, replays `examples/fixture/ch01/replay.ch01.json` (no live provider, no spend),
and prints a JSON summary with workflow/job ids and status (nonzero exit on failure). The workflow id is
deterministic (`chapter:<project>:<ch>`), so repeating `chapter:produce` — or calling `chapter:resume` —
replays completed steps from `job_steps` without re-spending. Example:

```
export DATABASE_URL=postgres://yeonjae:yeonjae@127.0.0.1:5432/yeonjae_test
pnpm cli db:migrate
pnpm cli project:create "Second Awakening"          # -> { projectId }
pnpm cli chapter:produce <projectId> 1              # -> { workflow_id, job_id, status: completed, accepted }
pnpm cli chapter:status chapter:<projectId>:1       # persisted job, steps, llm_calls
pnpm cli export:accepted <projectId>                # accepted chapter 1 summary (add --full for text)
```

## Layout (ADR-0021, ADR-0044)

```
apps/cli            operator surface for the core loop (first app, ADR-0044)
apps/worker         Checkpoint 7 durable orchestration (ADR-0047): a Temporal worker whose workflow
                    acquires a fenced target lease, observes the operator's pause/cancel intent at
                    checkpoint boundaries, runs packages/workflows' produceChapter as ONE durable
                    activity (which keeps its own Postgres step checkpoints, so a restart replays and
                    re-spends nothing), settles the terminal job state and releases the lease.
                    Versioned, prose-free activity contracts; retries classified by failure meaning;
                    replay-only provider routing — it refuses to start without YEONJAE_PROVIDER_MODE
apps/api            Checkpoint 7 Fastify /v1 operator API: session/API-key auth, membership-derived
                    authorization, RLS-scoped requests, RFC 9457 problem details, Idempotency-Key,
                    cursor pagination, security headers, health/readiness, audit log. A thin adapter
                    over packages/* — it holds no canon, selection or workflow logic of its own.
                    Adds job control (pause/resume/cancel), replayable SSE job events, accepted-only
                    TXT/DOCX export with authorized download, and the operator-editable write families
                    (story spec, assumption review, directions, concepts, register profiles, narrative
                    identity / naming / terminology, planning documents, chapter review, candidates,
                    scorecards, chapter trace) over migration 0010
apps/web            Checkpoint 7 operator application (Next.js 16 / React 19): the 11 operator work areas
                    over the REAL /v1 API — authentication, workspace/projects, spec and assumptions,
                    directions and concepts, bible and register profiles, narrative identity and
                    terminology, planning, chapters and production, candidate and scorecard review, canon
                    and change operations, and operations (jobs, replayable SSE, costs, budgets, export).
                    No mock or fixture backs a production path. The session secret stays in the server's
                    HttpOnly cookie and is never readable by app code; a 401 revokes local state at once
packages/prose      NFC boundary, code-point addressing, evidence verification, paragraphs, length model,
                    deterministic output-language check
packages/domain     schema loader + Ajv validators, generated types, UUIDv7, StoryClock ordering,
                    lifecycle state machines, Production Policy loader
packages/gateway    fail-closed Narrative Identity Guard, routing table, budget guard, bounded structured-output
                    repair, truncation handling, output-language discard→regenerate→reroute, idempotent audit;
                    MockProvider (fault injection) and ReplayProvider (no silent live calls)
packages/db         migrations (forward-only, hashed; 0004 = jobs workflow_id/idempotency/pins, workflow_artifacts,
                    context packs, embedding sets; 0005 = candidate_selections, the durable N-candidate decision
                    whose row and loser transitions commit in one transaction; 0006 = users/workspace_members/
                    sessions/api_keys, row-level security on every workspace-owned table plus the non-superuser
                    role yeonjae_app the application runs as, api_idempotency_keys, job control columns, the
                    append-only job_events log and exports), identity/session helpers, pool/transaction helpers,
                    0007/0013/0014 = least privilege for the request-scoped role: append-only and immutable
                    tables are INSERT/SELECT only, canon history keeps the UPDATE commit_delta needs but not
                    DELETE, EXECUTE is never granted to PUBLIC, and future objects get narrow default
                    privileges (ADR-0050),
                    typed repository over the canon
                    schema; canon.commit_delta / canon.rollback_latest are the only canon write paths;
                    retrieval.ts = accepted-only reads for context assembly
packages/canon      deterministic delta verification (schema, evidence, change-class, frame × timeline, future
                    validity) and chapter-acceptance orchestration
packages/narrative  profile store (examples/narrative-profiles), identity composition, Narrative Identity Block
                    compiler (role variants; both contracts first and never shed; hash + separate contract hashes)
packages/prompts    prompt registry: families/<family>/vX.Y.Z/{prompt.json,system.md,user.md}, immutable by
                    content hash, strict template variables, active prompt set
packages/context    Context Packs (ADR-0010/0045): Active Constraint Set compiler, role templates
                    (scene_writer, chapter_planner, continuity_checker, extractor), query plan, structured
                    fetch over accepted canon, Postgres FTS retriever + vector interface, T0–T3 tiering,
                    deterministic ranking, degradation ladder, provenance rendering, manifest + pack hash,
                    pre-call validation
tools/              gen-types.ts, validate-planning-package.py
schemas/ examples/  the contracts and fixture data (validated by CI)
docs/               the plan; status lives only in docs/08-delivery/09-progress.md
```

## Environment variables

| Variable                   | Used by                 | Meaning                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`             | cli, api, worker, tests | PostgreSQL 16 connection string. Integration tests skip visibly when unset                                                                                                                                                                                    |
| `YEONJAE_PROVIDER_MODE`    | worker                  | `replay` or `mock`. The worker REFUSES to start without it, so it can never default to a paid provider                                                                                                                                                        |
| `YEONJAE_INSECURE_COOKIES` | api                     | Local HTTP development only. Cookies are `Secure` by default; forgetting to configure a deployment cannot downgrade them                                                                                                                                      |
| `YEONJAE_CORS_ORIGINS`     | api                     | Comma-separated exact origins permitted to make credentialed cross-origin requests. **Absent or empty means deny all cross-origin requests**, which leaves same-origin traffic untouched. Validated at startup: `*` and malformed entries are refused by name |
| `YEONJAE_TRUSTED_PROXIES`  | api                     | Addresses whose `X-Forwarded-For` may be believed. **Empty by default**: an unconfigured deployment keys rate limits on the socket address, never on attacker-controlled header content                                                                       |
| `NEXT_PUBLIC_API_BASE_URL` | web                     | Base URL of the `/v1` API. **Empty by default, meaning same-origin** — the configuration that needs no CORS at all. Set it only when the web app is served from a different origin, and add that origin to `YEONJAE_CORS_ORIGINS`                             |

## Running the operator web app

```
export DATABASE_URL=postgres://yeonjae:yeonjae@127.0.0.1:5432/yeonjae_test
pnpm cli db:migrate
YEONJAE_INSECURE_COOKIES=true pnpm --filter @yeonjae/api start   # http://127.0.0.1:8080
pnpm --filter @yeonjae/web dev                                    # http://127.0.0.1:3000
```

Same-origin is the default, so no CORS configuration is needed for the two-process local setup above when
the web app proxies to the API. Serving them from different origins requires
`NEXT_PUBLIC_API_BASE_URL=http://127.0.0.1:8080` and `YEONJAE_CORS_ORIGINS=http://127.0.0.1:3000`.

## Shared enforcement, local retrieval and operational templates

`YEONJAE_ENFORCEMENT_MODE` selects the worker's protection. It defaults to `shared`, which uses the
database-backed `SharedBudget` and the PostgreSQL shared limiter (migration 0015). `isolated_test` is the
only way to reach the in-process `MemoryBudget`, and an unrecognized value is a startup error rather than
a silent downgrade — a `Map` of spend is not a budget once the worker runs twice.

| Variable                   | Default  | Meaning                                                         |
| -------------------------- | -------- | --------------------------------------------------------------- |
| `YEONJAE_ENFORCEMENT_MODE` | `shared` | `shared` or `isolated_test`; fails closed on anything else      |
| `YEONJAE_WORKER_ID`        | pid      | identifies this process on the concurrency leases it holds      |
| `YEONJAE_RATE_MAX_WAIT_MS` | `0`      | bounded wait for shared rate admission; `0` refuses immediately |
| `YEONJAE_SYNTHETIC_PORT`   | `8090`   | fixed port for the deterministic provider simulator             |

`pnpm run synthetic:provider` starts the simulator on a fixed loopback port. It is a **test double** whose
scenario header lets a caller choose failures, resets and late responses at will: never publish it to an
untrusted network, and never read success against it as evidence about a real provider.

Retrieval now has a deterministic local embedding backend (`@yeonjae/prose`, fixed 256 dimensions, no
network and no downloaded model), versioned embedding sets with atomic activation and rollback
(migration 0016), a project-scoped name/terminology thesaurus (migration 0017) and hybrid
lexical+vector ranking. The embedder captures **lexical overlap, not meaning** — it exists so the
pipeline can be built and tested deterministically, and it is not evidence of production retrieval
quality.

`deploy/` and `ops/` hold container, alert and dashboard templates. They are **statically validated and
never executed**: no container runtime or monitoring system exists in this workspace. `pnpm test` runs
`tools/validate-ops-templates.test.ts`, which parses them, walks the service graph and checks every metric
and label against the observability registry, so a template cannot drift from a metric that exists.

## Rules of the road

- Schemas first: change `schemas/*.schema.json`, run `pnpm gen:types`, then code (AGENTS.md rule 3).
- All manuscript offsets are Unicode code points into NFC text — use `@yeonjae/prose`, never `string.length`.
- Numbers come from the pinned Production Policy (`examples/production-policies/`), never from code constants.
- No inline production prompts: every call goes through `PromptRegistry` + `Gateway`; new prompt text = new version folder.
- No secrets, no Korean-to-English translation path.
