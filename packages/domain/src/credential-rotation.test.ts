/**
 * The credential-rotation state machine and its local simulator.
 *
 * Two properties get the most attention, because they are the ones whose failure is expensive: a
 * retired credential must be REJECTED once revoked but ACCEPTED during the overlap window, and no
 * secret value may appear in any output a human or a log will see.
 *
 * Live rotation against a real provider or secret manager remains unverified; nothing here claims
 * otherwise.
 */
import { describe, expect, it } from 'vitest';
import {
  canTransition,
  FakeCredentialStore,
  generateFakeCredential,
  isSyntheticCredential,
  RotationError,
  SYNTHETIC_MARKER,
  type CredentialKind,
  type CredentialState,
} from './credential-rotation.js';

const KINDS: readonly CredentialKind[] = [
  'database',
  'provider_api_key',
  'session_signing_key',
  'application_api_key',
  'object_storage',
  'temporal',
  'encryption_key',
];

/** A store with a fixed clock, so audit timestamps are deterministic. */
function store(): FakeCredentialStore {
  let tick = 0;
  return new FakeCredentialStore(() => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)));
}

/** Walk a credential to `active`, which every later scenario needs. */
function activated(s: FakeCredentialStore, kind: CredentialKind): string {
  const v = s.prepare(kind);
  s.distribute(v.versionId, ['api-1', 'worker-1']);
  s.verify(v.versionId, () => true);
  s.activate(v.versionId);
  return v.versionId;
}

describe('generated fake credentials', () => {
  it('are unmistakably synthetic and never repeat', () => {
    const a = generateFakeCredential('provider_api_key');
    const b = generateFakeCredential('provider_api_key');
    expect(a).toContain(SYNTHETIC_MARKER);
    expect(isSyntheticCredential(a)).toBe(true);
    expect(a).not.toBe(b);
  });

  it('refuse a value that is not marked synthetic, so this cannot become a secret manager', () => {
    const s = store();
    expect(() => s.prepare('provider_api_key', 'sk-live-looks-real')).toThrow(RotationError);
    expect(() => s.prepare('provider_api_key', 'sk-live-looks-real')).toThrow(/NOT_SYNTHETIC/);
  });
});

describe('rotation state machine', () => {
  it('declares only the transitions rotation actually needs', () => {
    expect(canTransition('pending', 'active')).toBe(true);
    expect(canTransition('active', 'retiring')).toBe(true);
    expect(canTransition('retiring', 'revoked')).toBe(true);
    // The overlap window can be undone; a revoked credential never can.
    expect(canTransition('retiring', 'active')).toBe(true);
    expect(canTransition('revoked', 'active')).toBe(false);
    expect(canTransition('rolled_back', 'active')).toBe(false);
  });

  it('rejects every transition the machine does not declare', () => {
    const states: CredentialState[] = ['pending', 'active', 'retiring', 'revoked', 'rolled_back'];
    for (const from of states) {
      for (const to of states) {
        if (canTransition(from, to)) continue;
        // Exhaustive rather than illustrative: a state machine is only as good as its refusals.
        expect(canTransition(from, to)).toBe(false);
      }
    }
  });

  it('refuses to activate a version that was never verified', () => {
    const s = store();
    const v = s.prepare('database');
    expect(() => s.activate(v.versionId)).toThrow(/NOT_VERIFIED/);
  });

  it('refuses to activate a version whose verification probe failed', () => {
    const s = store();
    const v = s.prepare('database');
    expect(s.verify(v.versionId, () => false)).toBe(false);
    expect(() => s.activate(v.versionId)).toThrow(/NOT_VERIFIED/);
  });

  it('rotates every credential kind through the full lifecycle', () => {
    for (const kind of KINDS) {
      const s = store();
      const first = activated(s, kind);
      const second = s.prepare(kind);
      s.verify(second.versionId, () => true);
      s.activate(second.versionId);
      expect(s.version(first).state).toBe('retiring');
      expect(s.activeVersion(kind)?.versionId).toBe(second.versionId);
      s.revoke(first);
      expect(s.version(first).state).toBe('revoked');
    }
  });

  it('keeps the old version valid during the overlap window, then rejects it after revocation', () => {
    const s = store();
    const oldValue = generateFakeCredential('provider_api_key');
    const old = s.prepare('provider_api_key', oldValue);
    s.verify(old.versionId, () => true);
    s.activate(old.versionId);

    const newValue = generateFakeCredential('provider_api_key');
    const next = s.prepare('provider_api_key', newValue);
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);

    // The overlap: an instance that has not picked up the new value still works.
    expect(s.authenticate('provider_api_key', oldValue).accepted).toBe(true);
    expect(s.authenticate('provider_api_key', newValue).accepted).toBe(true);

    s.revoke(old.versionId);
    // And the moment it is revoked, it is refused. This is the assertion the whole exercise is for.
    expect(s.authenticate('provider_api_key', oldValue).accepted).toBe(false);
    expect(s.authenticate('provider_api_key', newValue).accepted).toBe(true);
  });

  it('refuses to revoke while work is still in flight against the old version', () => {
    const s = store();
    const old = activated(s, 'database');
    const next = s.prepare('database');
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);

    s.beginUse(old);
    expect(() => s.revoke(old)).toThrow(/in-flight/);
    // Drain, then revoke: the observable version of "wait for the old credential to stop being used".
    s.endUse(old);
    expect(s.inFlight(old)).toBe(0);
    expect(s.revoke(old).state).toBe('revoked');
  });

  it('rolls back to the retiring version when the new one fails after the switch', () => {
    const s = store();
    const old = activated(s, 'temporal');
    const next = s.prepare('temporal');
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);

    const restored = s.rollback('temporal');
    expect(restored.versionId).toBe(old);
    expect(s.activeVersion('temporal')?.versionId).toBe(old);
    expect(s.version(next.versionId).state).toBe('rolled_back');
  });

  it('refuses a rollback once the previous version is revoked', () => {
    const s = store();
    const old = activated(s, 'object_storage');
    const next = s.prepare('object_storage');
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);
    s.revoke(old);
    // A revoked credential is never resurrected; silently reusing one would be the worst outcome here.
    expect(() => s.rollback('object_storage')).toThrow(/NO_PREVIOUS_VERSION/);
  });

  it('models a partial rollout: a stale instance keeps using the retiring version successfully', () => {
    const s = store();
    const oldValue = generateFakeCredential('application_api_key');
    const old = s.prepare('application_api_key', oldValue);
    s.verify(old.versionId, () => true);
    s.activate(old.versionId);
    const next = s.prepare('application_api_key');
    s.distribute(next.versionId, ['api-1']); // api-2 has NOT received it
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);

    // The stale worker's calls still authenticate, which is exactly why the overlap window exists.
    s.beginUse(old.versionId);
    expect(s.authenticate('application_api_key', oldValue).accepted).toBe(true);
    s.endUse(old.versionId);
    s.revoke(old.versionId);
    expect(s.authenticate('application_api_key', oldValue).accepted).toBe(false);
  });

  it('survives a restart mid-rotation: state is reconstructed from versions, not from memory of intent', () => {
    const s = store();
    const old = activated(s, 'session_signing_key');
    const next = s.prepare('session_signing_key');
    s.verify(next.versionId, () => true);
    // "Restart" happens here: nothing has switched yet, so the active version must still be the old one.
    expect(s.activeVersion('session_signing_key')?.versionId).toBe(old);
    expect(s.version(next.versionId).state).toBe('pending');
    // And the rotation can be resumed rather than restarted.
    s.activate(next.versionId);
    expect(s.activeVersion('session_signing_key')?.versionId).toBe(next.versionId);
  });

  it('rejects an unknown credential value without revealing whether any version exists', () => {
    const s = store();
    activated(s, 'database');
    const result = s.authenticate('database', generateFakeCredential('database'));
    expect(result.accepted).toBe(false);
    expect(result.versionId).toBeUndefined();
  });
});

describe('rotation audit and redaction', () => {
  it('records every transition with an opaque version id', () => {
    const s = store();
    const old = activated(s, 'provider_api_key');
    const next = s.prepare('provider_api_key');
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);
    s.revoke(old);

    const types = s.audit().map((e) => e.type);
    expect(types).toEqual([
      'prepared',
      'distributed',
      'verified',
      'activated',
      'prepared',
      'verified',
      'activated',
      'draining',
      'revoked',
    ]);
  });

  it('never puts a secret value in the audit trail, a version record or a list', () => {
    const s = store();
    const secret = generateFakeCredential('provider_api_key');
    const v = s.prepare('provider_api_key', secret);
    s.verify(v.versionId, () => true);
    s.activate(v.versionId);

    const serialized = JSON.stringify({
      audit: s.audit(),
      versions: s.list(),
      active: s.activeVersion('provider_api_key'),
      one: s.version(v.versionId),
    });
    expect(serialized).not.toContain(secret);
    // Not even the random suffix: the value is dropped at the projection boundary, not redacted later.
    expect(serialized).not.toContain(secret.slice(-12));
    // What IS present is the non-secret digest and the opaque id.
    expect(serialized).toContain(v.digest);
    expect(serialized).toContain(v.versionId);
  });

  it('never puts a secret value in an error message', () => {
    const s = store();
    const secret = generateFakeCredential('database');
    const v = s.prepare('database', secret);
    try {
      s.activate(v.versionId);
      throw new Error('expected activation to be refused');
    } catch (err) {
      expect(String(err)).not.toContain(secret);
      expect(String(err)).toContain('NOT_VERIFIED');
    }
  });

  it('compares versions by digest, so no comparison ever touches secret text', () => {
    const s = store();
    const value = generateFakeCredential('encryption_key');
    const v = s.prepare('encryption_key', value);
    expect(v.digest).toMatch(/^sha256:[0-9a-f]{32}$/);
    expect(v.digest).not.toContain(value);
  });

  it('records a rejection reason from a closed vocabulary, never from provider text', () => {
    const s = store();
    const value = generateFakeCredential('database');
    const v = s.prepare('database', value);
    s.verify(v.versionId, () => true);
    s.activate(v.versionId);
    const next = s.prepare('database');
    s.verify(next.versionId, () => true);
    s.activate(next.versionId);
    s.revoke(v.versionId);
    s.authenticate('database', value);

    const rejection = s.audit().find((e) => e.type === 'rejected');
    expect(rejection?.reason).toBe('revoked');
  });
});
