/**
 * Credential rotation as an explicit state machine, with a local simulator for testing it.
 *
 * WHAT THIS IS. The transitions, invariants and audit shape that rotating any credential must follow,
 * plus an in-memory adapter that exercises them with UNMISTAKABLY FAKE values. It exists so the
 * rotation procedure is designed, tested and reviewable before a real secret manager is available.
 *
 * WHAT THIS IS NOT, STATED BEFORE THE CODE. This is not a secret manager and must never become one.
 * The in-memory store below keeps values in a process's heap with no encryption, no access control and
 * no persistence, and it refuses any value that does not carry the synthetic marker — which is
 * deliberate, because a fake store that happens to work is a fake store somebody eventually points at
 * production. Live rotation against a real provider remains unverified.
 *
 * THE DESIGN DECISION THAT SHAPES EVERYTHING HERE: a rotation is compared and audited by VERSION ID
 * and DIGEST, never by secret text. That is what lets every state transition, audit event, metric and
 * error message be safe to emit, rather than safe only after somebody remembers to redact it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { METRIC, METRIC_HELP, type Metrics } from './metrics.js';

/** Credential families the system rotates. A closed set, so it is safe as a metric label. */
export type CredentialKind =
  | 'database'
  | 'provider_api_key'
  | 'session_signing_key'
  | 'application_api_key'
  | 'object_storage'
  | 'temporal'
  | 'encryption_key';

/**
 * Lifecycle of one credential VERSION.
 *
 * `pending` and `retiring` exist because rotation is not atomic across instances: a new version must be
 * distributed and verified before anything switches to it, and the old one must stay valid while
 * in-flight work drains. Collapsing either state would force a flag day.
 */
export type CredentialState = 'pending' | 'active' | 'retiring' | 'revoked' | 'rolled_back';

export interface CredentialVersion {
  readonly kind: CredentialKind;
  /** Opaque, non-secret identifier. Safe in logs, metrics, audit rows and API responses. */
  readonly versionId: string;
  /** Digest of the value, for equality checks that never compare secret text. */
  readonly digest: string;
  readonly state: CredentialState;
  readonly createdAt: string;
  readonly activatedAt?: string | undefined;
  readonly revokedAt?: string | undefined;
}

export type RotationEventType =
  | 'prepared'
  | 'distributed'
  | 'verified'
  | 'activated'
  | 'draining'
  | 'revoked'
  | 'rolled_back'
  | 'rejected';

export interface RotationAuditEvent {
  readonly type: RotationEventType;
  readonly kind: CredentialKind;
  readonly versionId: string;
  readonly at: string;
  /** Bounded, closed-vocabulary detail. Never a secret and never free-form provider text. */
  readonly reason?: string | undefined;
}

export class RotationError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_VERSION'
      | 'ILLEGAL_TRANSITION'
      | 'NOT_VERIFIED'
      | 'NO_ACTIVE_VERSION'
      | 'NO_PREVIOUS_VERSION'
      | 'CREDENTIAL_REJECTED'
      | 'NOT_SYNTHETIC',
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'RotationError';
  }
}

/**
 * The marker every generated fake value carries.
 *
 * Two purposes: a human reading a dump can tell instantly that nothing real leaked, and the store
 * below REFUSES values without it, so this machinery cannot quietly be handed a production secret.
 */
export const SYNTHETIC_MARKER = 'FAKE-DO-NOT-USE';

export function isSyntheticCredential(value: string): boolean {
  return value.includes(SYNTHETIC_MARKER);
}

/** Generate an unmistakably fake credential value. Random, so no fixture value is ever reused. */
export function generateFakeCredential(kind: CredentialKind): string {
  return `${SYNTHETIC_MARKER}-${kind}-${randomBytes(12).toString('hex')}`;
}

export function digestOf(value: string): string {
  return `sha256:${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 32)}`;
}

/** Legal transitions, declared as data so the state machine is inspectable rather than implied. */
const TRANSITIONS: Readonly<Record<CredentialState, readonly CredentialState[]>> = {
  pending: ['active', 'rolled_back'],
  // An active version may be superseded (retiring) or rolled back if its replacement fails.
  active: ['retiring', 'rolled_back'],
  // Retiring is the overlap window; it ends in revocation or, if the new version fails, reactivation.
  retiring: ['revoked', 'active'],
  // Terminal. A revoked credential is never resurrected: reuse defeats the point of rotating.
  revoked: [],
  rolled_back: [],
};

export function canTransition(from: CredentialState, to: CredentialState): boolean {
  return TRANSITIONS[from].includes(to);
}

interface StoredVersion extends CredentialVersion {
  readonly value: string;
  verified: boolean;
  inFlight: number;
}

/**
 * A LOCAL, in-memory rotation simulator.
 *
 * Every method is a state transition with its invariant checked first, so an invalid rotation fails
 * with a stable code rather than leaving the credential set in a state nobody designed.
 */
export class FakeCredentialStore {
  private readonly versions = new Map<string, StoredVersion>();
  private readonly order: string[] = [];
  private readonly events: RotationAuditEvent[] = [];
  private counter = 0;

  constructor(
    private readonly clock: () => Date = () => new Date(),
    private readonly metrics?: Metrics,
  ) {}

  private now(): string {
    return this.clock().toISOString();
  }

  private record(event: RotationAuditEvent): void {
    this.events.push(event);
    // Metric and audit are emitted from ONE place, so they cannot disagree about what happened.
    // Both labels are closed sets; the secret and the reason text never reach either.
    this.metrics?.increment(
      METRIC.credentialRotations,
      METRIC_HELP[METRIC.credentialRotations] ?? '',
      { kind: event.kind, outcome: event.type },
    );
  }

  private get(versionId: string): StoredVersion {
    const found = this.versions.get(versionId);
    if (!found) throw new RotationError('UNKNOWN_VERSION', `no version ${versionId}`);
    return found;
  }

  private setState(versionId: string, to: CredentialState): StoredVersion {
    const current = this.get(versionId);
    if (!canTransition(current.state, to)) {
      throw new RotationError(
        'ILLEGAL_TRANSITION',
        `${current.kind} version cannot move from ${current.state} to ${to}`,
      );
    }
    const updated: StoredVersion = { ...current, state: to };
    this.versions.set(versionId, updated);
    return updated;
  }

  /** Step 1: prepare a new version. It is NOT usable yet, which is the point of a separate step. */
  prepare(kind: CredentialKind, value = generateFakeCredential(kind)): CredentialVersion {
    if (!isSyntheticCredential(value)) {
      // The guard that stops this from being usable as a real secret store.
      throw new RotationError(
        'NOT_SYNTHETIC',
        'this simulator accepts generated fake credentials only; it is not a secret manager',
      );
    }
    this.counter += 1;
    const versionId = `${kind}.v${String(this.counter)}`;
    const stored: StoredVersion = {
      kind,
      versionId,
      digest: digestOf(value),
      state: 'pending',
      createdAt: this.now(),
      value,
      verified: false,
      inFlight: 0,
    };
    this.versions.set(versionId, stored);
    this.order.push(versionId);
    this.record({ type: 'prepared', kind, versionId, at: this.now() });
    return this.public(stored);
  }

  /** Step 2: distribute. Modelled explicitly because a partially-rolled-out version is a real state. */
  distribute(versionId: string, instances: readonly string[]): void {
    const version = this.get(versionId);
    this.record({
      type: 'distributed',
      kind: version.kind,
      versionId,
      at: this.now(),
      reason: `instances:${String(instances.length)}`,
    });
  }

  /** Step 3: verify the new version works BEFORE anything depends on it. */
  verify(versionId: string, probe: (value: string) => boolean): boolean {
    const version = this.get(versionId);
    const ok = probe(version.value);
    this.versions.set(versionId, { ...version, verified: ok });
    this.record({
      type: 'verified',
      kind: version.kind,
      versionId,
      at: this.now(),
      reason: ok ? 'probe_passed' : 'probe_failed',
    });
    return ok;
  }

  /**
   * Step 4: switch. The incumbent moves to `retiring`, not to `revoked`.
   *
   * That overlap is the whole reason rotation can be done without downtime: an instance that has not
   * yet picked up the new version keeps working, and in-flight requests finish.
   */
  activate(versionId: string): CredentialVersion {
    const candidate = this.get(versionId);
    if (!candidate.verified) {
      throw new RotationError(
        'NOT_VERIFIED',
        'refusing to activate a credential version that has not been verified',
      );
    }
    const incumbent = this.activeVersion(candidate.kind);
    if (incumbent) this.setState(incumbent.versionId, 'retiring');
    const activated: StoredVersion = {
      ...this.setState(versionId, 'active'),
      activatedAt: this.now(),
    };
    this.versions.set(versionId, activated);
    this.record({ type: 'activated', kind: candidate.kind, versionId, at: this.now() });
    if (incumbent) {
      this.record({
        type: 'draining',
        kind: incumbent.kind,
        versionId: incumbent.versionId,
        at: this.now(),
      });
    }
    return this.public(activated);
  }

  /** Mark work started against a version, so drain can be observed rather than assumed. */
  beginUse(versionId: string): void {
    const version = this.get(versionId);
    this.versions.set(versionId, { ...version, inFlight: version.inFlight + 1 });
  }

  endUse(versionId: string): void {
    const version = this.get(versionId);
    this.versions.set(versionId, { ...version, inFlight: Math.max(0, version.inFlight - 1) });
  }

  inFlight(versionId: string): number {
    return this.get(versionId).inFlight;
  }

  /** Step 5: revoke, only once the overlap window has genuinely drained. */
  revoke(versionId: string): CredentialVersion {
    const version = this.get(versionId);
    if (version.inFlight > 0) {
      throw new RotationError(
        'ILLEGAL_TRANSITION',
        `refusing to revoke a credential with ${String(version.inFlight)} in-flight uses`,
      );
    }
    const revoked: StoredVersion = {
      ...this.setState(versionId, 'revoked'),
      revokedAt: this.now(),
    };
    this.versions.set(versionId, revoked);
    this.record({ type: 'revoked', kind: version.kind, versionId, at: this.now() });
    return this.public(revoked);
  }

  /**
   * Roll back to the previous version, which is possible only BEFORE revocation.
   *
   * After revocation there is nothing to roll back to, and pretending otherwise would be the most
   * dangerous behaviour available here: silently reusing a credential that was declared dead.
   */
  rollback(kind: CredentialKind): CredentialVersion {
    const current = this.activeVersion(kind);
    if (!current) throw new RotationError('NO_ACTIVE_VERSION', `no active ${kind} credential`);
    const previous = [...this.order]
      .reverse()
      .map((id) => this.get(id))
      .find((v) => v.kind === kind && v.state === 'retiring');
    if (!previous) {
      throw new RotationError(
        'NO_PREVIOUS_VERSION',
        'no retiring version remains; a revoked credential is never resurrected',
      );
    }
    this.setState(current.versionId, 'rolled_back');
    this.setState(previous.versionId, 'active');
    this.record({ type: 'rolled_back', kind, versionId: current.versionId, at: this.now() });
    this.record({ type: 'activated', kind, versionId: previous.versionId, at: this.now() });
    return this.public(this.get(previous.versionId));
  }

  /**
   * Authenticate with a value, as a dependency would.
   *
   * `retiring` is accepted and `revoked` is not: that pair IS the overlap window, and it is what the
   * "retired credentials are rejected" requirement actually tests.
   */
  authenticate(kind: CredentialKind, value: string): { accepted: boolean; versionId?: string } {
    const match = [...this.versions.values()].find(
      (v) => v.kind === kind && v.digest === digestOf(value),
    );
    if (!match) return { accepted: false };
    const accepted = match.state === 'active' || match.state === 'retiring';
    if (!accepted) {
      this.record({
        type: 'rejected',
        kind,
        versionId: match.versionId,
        at: this.now(),
        reason: match.state,
      });
    }
    return { accepted, versionId: match.versionId };
  }

  activeVersion(kind: CredentialKind): CredentialVersion | undefined {
    const found = [...this.versions.values()].find((v) => v.kind === kind && v.state === 'active');
    return found ? this.public(found) : undefined;
  }

  version(versionId: string): CredentialVersion {
    return this.public(this.get(versionId));
  }

  list(kind?: CredentialKind): CredentialVersion[] {
    return this.order
      .map((id) => this.get(id))
      .filter((v) => kind === undefined || v.kind === kind)
      .map((v) => this.public(v));
  }

  audit(): readonly RotationAuditEvent[] {
    return this.events;
  }

  /**
   * Project a stored version to its PUBLIC shape.
   *
   * The secret value is dropped here, at the single boundary every reader goes through, rather than
   * being redacted by each caller. A caller cannot leak what it was never handed.
   */
  private public(v: StoredVersion): CredentialVersion {
    return {
      kind: v.kind,
      versionId: v.versionId,
      digest: v.digest,
      state: v.state,
      createdAt: v.createdAt,
      ...(v.activatedAt !== undefined ? { activatedAt: v.activatedAt } : {}),
      ...(v.revokedAt !== undefined ? { revokedAt: v.revokedAt } : {}),
    };
  }
}
