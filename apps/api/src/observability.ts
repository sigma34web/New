/**
 * Structured logging, redaction and metrics (Checkpoint 7; observability plan §5).
 *
 * The plan's requirement is short and absolute: "Structured JSON; no manuscript/prompt text (IDs + hashes
 * only); correlation by trace ID". Implementing it as a *default-deny serializer* rather than a list of
 * things to strip is the whole design decision here, and it is worth stating why.
 *
 * A redaction blocklist fails in one direction: every new field is exposed until somebody remembers to add
 * it. For a system whose logs sit next to customer manuscripts, provider credentials and session secrets,
 * that default is the wrong way round — the first forgotten field is a leak, not a cosmetic bug. So
 * `logFields` accepts only an explicit allowlist of key shapes (ids, hashes, counts, enums, durations) and
 * replaces anything else with a type marker. A field nobody thought about is therefore absent from the log,
 * which is a recoverable mistake, instead of present, which is not.
 *
 * Metrics are an in-process registry rendered in Prometheus text format. That is honest about what it is:
 * per-process counters that reset when the process restarts and are scraped per instance. It is not a
 * distributed aggregation layer, and §5.2's dashboards assume a scraper doing the aggregation.
 */

/** Values a log field may carry once accepted. Deliberately narrow: no nested objects, no free text. */
export type LogValue = string | number | boolean | null;

/** The marker a rejected value is replaced with, so its absence is visible rather than silent. */
export const REDACTED = '[redacted]';

/**
 * Field names that are always dropped, regardless of shape.
 *
 * This list is NOT the mechanism — the allowlist below is — but it exists so a value that would otherwise
 * look like a harmless opaque string (a session token is, structurally, just a string) cannot slip through
 * on shape alone. Matching is on a normalized name, so `Authorization`, `authorization` and
 * `auth_header` are all caught.
 */
const FORBIDDEN_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'verifier',
  'secret',
  'token',
  'csrf',
  'cookie',
  'authorization',
  'auth_header',
  'api_key',
  'apikey',
  'session',
  'credential',
  'connection_string',
  'database_url',
  'dsn',
  'prompt',
  'manuscript',
  'text',
  'prose',
  'quote',
  'content',
  'body',
  'output',
  'input',
  'delta',
  'payload',
  'justification',
  'statement',
  'summary',
  'title',
  'email',
  'display_name',
];

/**
 * Field names that may carry a value, as exact names or `*_suffix` shapes.
 *
 * Everything here is an identifier, a hash, a count, a duration or a closed enum — the vocabulary §5.1
 * lists as span attributes. Note what is NOT here: anything that could contain prose, a credential or a
 * free-form message. `detail`-style fields are excluded on purpose; an operator-facing explanation belongs
 * in the RFC 9457 problem document sent to the client, not in a log line that may be shipped elsewhere.
 */
/**
 * Fragments that make a digest a CREDENTIAL digest rather than a content digest.
 *
 * The `_hash` carve-out below must not cover these: a password hash is the verifier an attacker cracks
 * offline, and a session or API-key hash is the stored form the server compares against, so either one is
 * security-relevant even though it is technically one-way.
 */
const CREDENTIAL_FRAGMENTS: readonly string[] = [
  'password',
  'passwd',
  'verifier',
  'secret',
  // Singular `token` only. `_token`/`token_` substring matching was tried and is wrong: `input_tokens`
  // contains `_token`, and those usage counts are required metrics (§5.2 `llm_tokens_total`). The
  // singular form still catches `csrf_token`, `session_token`, `bearer_token` and `token_hash`, because
  // every credential name uses the singular while every measure uses the plural.
  'token',
  'csrf',
  'cookie',
  'session',
  'api_key',
  'apikey',
  'credential',
  'authorization',
];

/** Suffixes that make a field a numeric measure of content rather than the content itself. */
const COUNT_SUFFIXES: readonly string[] = ['_tokens', '_count', '_cents', '_ms', '_bytes', '_size'];

const ALLOWED_EXACT: readonly string[] = [
  'action',
  'attempt',
  'basis',
  'canon_version',
  'chapter_no',
  'code',
  'control',
  'count',
  'duplicate',
  'duration_ms',
  'event',
  'fence',
  'format',
  'byte_size',
  'items',
  'kind',
  'latency_ms',
  'limit',
  'materiality',
  'method',
  'model_class',
  'origin',
  'outcome',
  'phase',
  'provider',
  'reason',
  'replayed',
  'result',
  'role',
  'route',
  'schema_valid',
  'seq',
  'source',
  'stale_marked',
  'status',
  'status_code',
  'step',
  'target_kind',
  'tier',
  'verb',
  'version',
  'version_no',
];

/** Suffixes that make a field an identifier, hash or counter rather than content. */
const ALLOWED_SUFFIXES: readonly string[] = ['_id', '_ids', '_hash', '_count', '_cents', '_tokens'];

/**
 * Whether a name denotes a credential rather than a measure of one.
 *
 * The plural/singular distinction does the work: `token` is a credential, `tokens` is a usage count. Naive
 * substring matching cannot express that — `input_tokens` contains `token` — so the plural measure
 * suffixes are stripped before the credential fragments are applied.
 */
function isCredentialName(normalizedKey: string): boolean {
  const stem = COUNT_SUFFIXES.reduce(
    (k, suffix) => (k.endsWith(suffix) ? k.slice(0, -suffix.length) : k),
    normalizedKey,
  );
  return CREDENTIAL_FRAGMENTS.some((f) => stem.includes(f));
}

function normalizeKey(key: string): string {
  return key.toLowerCase();
}

/** Whether a field name may appear in a log at all. Forbidden fragments win over the allowlist. */
export function isLoggableKey(key: string): boolean {
  const k = normalizeKey(key);
  /**
   * A `*_hash` field is a digest, and a digest of prose is not prose.
   *
   * This exception exists because the fragment rule alone rejects `content_hash` (it contains "content")
   * and `prompt_hash` (it contains "prompt") — exactly the two fields the observability plan §5.1 names as
   * required span attributes, and the whole point of "IDs + hashes only". The narrow carve-out is safe
   * precisely because a hash is one-way: it correlates without disclosing. Two limits keep it narrow: it
   * applies to the `_hash` SUFFIX rather than any occurrence of "hash", and it never applies to a
   * credential digest. `password_hash` is a verifier — the thing an attacker cracks offline — so it is not
   * covered, and neither is a session or API-key hash, which is the stored form the server compares
   * against and therefore as good as the secret for lookup purposes.
   */
  if (k.endsWith('_hash') && !isCredentialName(k)) return true;
  /**
   * Numeric measures of content are not content.
   *
   * `input_tokens` and `output_tokens` are required metrics (observability plan §5.2 `llm_tokens_total`),
   * yet they contain the fragments "input" and "output" that exist to block prompt and completion BODIES.
   * A token count cannot reconstruct prose, so the count suffixes are permitted while the bare `input` and
   * `output` keys stay refused. As with hashes, a credential measure is excluded.
   */
  if (COUNT_SUFFIXES.some((suffix) => k.endsWith(suffix)) && !isCredentialName(k)) return true;
  // Otherwise a name containing a forbidden fragment is refused even when its shape looks safe:
  // `session_id` is an identifier, yet logging it would let a log reader correlate a live session.
  if (FORBIDDEN_FRAGMENTS.some((f) => k.includes(f))) return false;
  if (ALLOWED_EXACT.includes(k)) return true;
  return ALLOWED_SUFFIXES.some((s) => k.endsWith(s));
}

/**
 * Project arbitrary fields into a safe log record.
 *
 * Rejected keys are dropped entirely rather than included as `[redacted]`: keeping the key would leak the
 * SHAPE of the data (that a password was involved, that a particular field exists) and would grow log lines
 * with no diagnostic value. A rejected VALUE under an allowed key becomes `[redacted]`, because there the
 * key itself is the useful signal and its absence would look like "not measured".
 */
export function logFields(fields: Readonly<Record<string, unknown>>): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!isLoggableKey(key)) continue;
    out[key] = safeValue(value);
  }
  return out;
}

/** Accept only scalars; anything structured becomes a type marker so nested prose cannot ride along. */
function safeValue(value: unknown): LogValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    // A bounded length is the second half of "IDs + hashes only": an id or hash is short, so a long string
    // under an allowed key is a sign the field is carrying something it should not.
    return value.length <= 200 ? value : REDACTED;
  }
  // Arrays and objects are never rendered. A count is the useful, safe projection of a list.
  if (Array.isArray(value)) return value.length;
  return REDACTED;
}

export interface LogRecord {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly request_id?: string | undefined;
  readonly trace_id?: string | undefined;
  readonly workspace_id?: string | undefined;
  readonly project_id?: string | undefined;
  readonly job_id?: string | undefined;
  readonly workflow_id?: string | undefined;
}

/**
 * Render one structured JSON log line.
 *
 * `msg` is a fixed developer-authored string, never interpolated with request data — an interpolated
 * message is exactly how prose and secrets end up in logs that were otherwise carefully structured.
 */
export function logLine(record: LogRecord, fields: Readonly<Record<string, unknown>> = {}): string {
  const base: Record<string, LogValue> = {
    level: record.level,
    msg: record.msg,
    ...(record.request_id ? { request_id: record.request_id } : {}),
    ...(record.trace_id ? { trace_id: record.trace_id } : {}),
    ...(record.workspace_id ? { workspace_id: record.workspace_id } : {}),
    ...(record.project_id ? { project_id: record.project_id } : {}),
    ...(record.job_id ? { job_id: record.job_id } : {}),
    ...(record.workflow_id ? { workflow_id: record.workflow_id } : {}),
  };
  return JSON.stringify({ ...base, ...logFields(fields) });
}

// ---------------------------------------------------------------------------------------------------------
// trace correlation
// ---------------------------------------------------------------------------------------------------------

/** W3C `traceparent`: `00-<32 hex trace id>-<16 hex span id>-<2 hex flags>`. */
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

/**
 * Extract an inbound trace id, or `undefined` when the header is absent or malformed.
 *
 * A malformed `traceparent` is IGNORED rather than passed through. Trace ids reach logs and the `llm_calls`
 * audit, so accepting an arbitrary client string would let a caller inject content into both — the same
 * class of problem as trusting a forwarded client IP. Strict parsing means the only ids that propagate are
 * ones that are structurally trace ids.
 */
export function traceIdFrom(traceparent: string | undefined): string | undefined {
  if (!traceparent) return undefined;
  const m = TRACEPARENT.exec(traceparent.trim().toLowerCase());
  const traceId = m?.[1];
  // An all-zero trace id is explicitly invalid in the W3C spec.
  if (!traceId || /^0+$/.test(traceId)) return undefined;
  return traceId;
}

// ---------------------------------------------------------------------------------------------------------
// metrics
// ---------------------------------------------------------------------------------------------------------

/**
 * The metric registry now lives in `@yeonjae/domain` so every package can emit.
 *
 * Re-exported here rather than moved outright: `apps/api` was the registry's original home and every
 * existing import path stays valid, which keeps this change to the mechanism rather than the callers.
 */
export {
  BUCKETS,
  isMetricLabel,
  METRIC,
  METRIC_HELP,
  METRIC_LABEL_OTHER,
  Metrics,
  safeLabelValue,
  type MetricKind,
} from '@yeonjae/domain';
