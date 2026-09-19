/**
 * Metrics are emitted by the REAL gateway path, not by calling the helper.
 *
 * This distinction is the whole point of the suite. A test that calls `metrics.increment(...)` and
 * asserts the counter moved proves the registry works and proves nothing about whether production code
 * ever reaches it — which is exactly the state the previous tranche left behind. Every case here drives
 * `gateway.call(...)` and then reads the registry.
 */
import { describe, expect, it } from 'vitest';
import { compileBlock, composeIdentity, ProfileStore } from '@yeonjae/narrative';
import { PromptRegistry, renderPrompt } from '@yeonjae/prompts';
import { asUuid, METRIC, Metrics } from '@yeonjae/domain';
import {
  Gateway,
  MemoryAuditStore,
  MemoryBudget,
  type ProviderAdmissionControl,
  type RoutingTable,
} from './gateway.js';
import { MockProvider } from './mock-provider.js';
import { ProviderFailure } from './failures.js';
import { type CancellationInput } from './cancellation.js';
import { type GatewayRequest, type Provider } from './types.js';

const store = ProfileStore.fromDirectory();
const identity = composeIdentity(
  store,
  'project/0191b2a0-0000-7000-8000-000000000001@1',
  '0191b2a0-0000-7000-8000-000000060001',
);
const registry = PromptRegistry.fromDirectory();

const route = (modelId: string, provider: string, priority: number, family: string) => ({
  modelId,
  provider,
  priority,
  family,
  priceInPerMTokCents: 300,
  priceOutPerMTokCents: 1500,
  maxContextTokens: 128_000,
  supportsJsonSchema: true,
});

const routing: RoutingTable = {
  P: [route('mock-p-primary', 'mock', 1, 'alpha'), route('mock-p-alt', 'mock-alt', 2, 'beta')],
  R: [route('mock-r', 'mock', 1, 'alpha')],
  M: [route('mock-m', 'mock', 1, 'alpha')],
  C: [route('mock-c', 'mock', 1, 'alpha')],
  E: [],
};

const ids = {
  ws: asUuid('0191b2a0-0000-7000-8000-000000000000'),
  project: asUuid('0191b2a0-0000-7000-8000-000000000001'),
  job: asUuid('0191b2a0-0000-7000-8000-0000000f0001'),
  pack: asUuid('0191b2a0-0000-7000-8000-0000000f0002'),
  prompt: asUuid('0191b2a0-0000-7000-8000-0000000f0003'),
};

const ENGLISH_SCENE = {
  scene_no: 1,
  language: 'en',
  text: 'The device cried out, and the hall went quiet.\n\n“F-rank,” the officer said. “Porter registration is on the left.”\n\nDo-yoon looked at his hand. It was not shaking.',
  paragraphs: [{ id: 'p1', start: 0, end: 46, kind: 'narration' }],
  speaker_annotations: [],
  claims: [],
};

function sceneProvider(): MockProvider {
  return new MockProvider(() => ({ json: ENGLISH_SCENE }));
}

function writerRequest(overrides: Partial<GatewayRequest> = {}): GatewayRequest {
  const block = compileBlock(identity, { role: 'writer_full', budgetTokens: 6000 });
  const pv = registry.get('scene_writer@1.0.0');
  const vars = Object.fromEntries(pv.input_variables.map((v) => [v, `<${v}>`]));
  const rendered = renderPrompt(pv, {
    ...vars,
    narrative_identity_block: block.text,
    identity_tail: block.identityTail ?? '',
  });
  return {
    workspaceId: ids.ws,
    projectId: ids.project,
    jobId: ids.job,
    activityId: 'scene-1',
    idempotencyKey: `job:${ids.job}:scene:1:${Math.random()}`,
    role: 'scene_writer',
    styleSensitive: true,
    manuscriptProducing: true,
    promptVersionId: ids.prompt,
    promptHash: rendered.promptHash,
    productionPolicyVersion: 'policy/standard@1',
    pack: {
      id: ids.pack,
      hash: 'sha256:pack',
      renderedSystem: rendered.system,
      renderedUser: rendered.user,
      tokenEstimate: 5000,
    },
    narrativeIdentityRef: {
      blockHash: block.hash,
      identityVersionId: asUuid(identity.identityVersionId),
      roleVariant: 'writer_full',
      outputLanguage: 'en',
      outputLanguageContractHash: block.outputLanguageContractHash,
      traditionContractHash: block.traditionContractHash,
    },
    outputSchemaRef: 'scene-draft.schema.json',
    modelClass: 'P',
    ...overrides,
  };
}

class StubAdmission implements ProviderAdmissionControl {
  constructor(
    private readonly admitted: boolean,
    private readonly reason: string,
    private readonly waitedMs = 0,
  ) {}
  async admit() {
    return {
      admitted: this.admitted,
      reason: this.reason,
      retryAfterMs: this.admitted ? 0 : 1_000,
      waitedMs: this.waitedMs,
      release: (): Promise<void> => Promise.resolve(),
    };
  }
}

function build(opts: {
  providers?: ReadonlyMap<string, Provider>;
  admission?: ProviderAdmissionControl | undefined;
  budgetCents?: number;
}): { gateway: Gateway; metrics: Metrics } {
  const metrics = new Metrics();
  const gateway = new Gateway({
    providers:
      opts.providers ??
      new Map<string, Provider>([
        ['mock', sceneProvider()],
        ['mock-alt', sceneProvider()],
      ]),
    routing,
    budget: new MemoryBudget(opts.budgetCents ?? 10_000_000),
    ...(opts.admission ? { admission: opts.admission } : {}),
    metrics,
    audit: new MemoryAuditStore(),
  });
  return { gateway, metrics };
}

/** Every label of every series the registry rendered, for the negative assertions. */
function renderedLabels(metrics: Metrics): string {
  return metrics.render();
}

describe('gateway metric emission (real call path)', () => {
  it('a successful call records admission, a reservation, an attempt and a settlement', async () => {
    const { gateway, metrics } = build({ admission: new StubAdmission(true, 'admitted', 250) });
    await gateway.call(writerRequest());

    expect(
      metrics.total(METRIC.rateAdmission, {
        operation_class: 'provider_call',
        outcome: 'admitted',
        reason: 'admitted',
      }),
    ).toBe(1);
    expect(metrics.total(METRIC.concurrencyAcquired, { provider: 'mock' })).toBe(1);
    expect(
      metrics.total(METRIC.budgetReservations, { scope_kind: 'job', outcome: 'reserved' }),
    ).toBe(1);
    expect(
      metrics.total(METRIC.providerAttempts, {
        model_class: 'P',
        provider: 'mock',
        status: 'succeeded',
      }),
    ).toBe(1);
    expect(metrics.total(METRIC.budgetSettlements, { scope_kind: 'job', outcome: 'known' })).toBe(
      1,
    );
    // The wait is observed as a histogram, in SECONDS, from the grant's own measurement.
    expect(renderedLabels(metrics)).toContain(`${METRIC.rateWaitSeconds}_count`);
  });

  it('a refused admission records the refusal and saturates nothing it did not observe', async () => {
    const { gateway, metrics } = build({
      admission: new StubAdmission(false, 'concurrency_exhausted'),
    });
    await expect(gateway.call(writerRequest())).rejects.toThrow(/RATE_LIMITED/);
    expect(
      metrics.total(METRIC.rateAdmission, {
        operation_class: 'provider_call',
        outcome: 'refused',
        reason: 'concurrency_exhausted',
      }),
    ).toBe(1);
    expect(metrics.total(METRIC.concurrencySaturated, { provider: 'mock' })).toBe(1);
    // A refused call never reached a provider, so no attempt is counted.
    expect(
      metrics.total(METRIC.providerAttempts, {
        model_class: 'P',
        provider: 'mock',
        status: 'succeeded',
      }),
    ).toBe(0);
  });

  it('a budget refusal records a block and a refused reservation, and agrees with the audit row', async () => {
    const audit = new MemoryAuditStore();
    const metrics = new Metrics();
    const gateway = new Gateway({
      providers: new Map<string, Provider>([['mock', sceneProvider()]]),
      routing,
      // Far below the predicted cost of the call, so the reservation is refused.
      budget: new MemoryBudget(1),
      metrics,
      audit,
    });
    await expect(gateway.call(writerRequest())).rejects.toThrow(/BUDGET_EXHAUSTED/);
    expect(metrics.total(METRIC.budgetBlocks, { scope_kind: 'job' })).toBe(1);
    expect(
      metrics.total(METRIC.budgetReservations, { scope_kind: 'job', outcome: 'refused' }),
    ).toBe(1);
    // Metric and audit describe the SAME transition; a disagreement here is a real defect.
    expect(audit.records.at(-1)?.status).toBe('budget_blocked');
  });

  it('a retryable failure records a retry, a fallback and a failed attempt exactly once each', async () => {
    const failing: Provider = {
      name: 'mock',
      complete: () =>
        Promise.reject(new ProviderFailure('retryable_provider', 'overloaded', { status: 503 })),
    };
    const { gateway, metrics } = build({
      providers: new Map<string, Provider>([
        ['mock', failing],
        ['mock-alt', sceneProvider()],
      ]),
    });
    await gateway.call(writerRequest());
    expect(metrics.total(METRIC.retries, { reason: 'retryable_provider' })).toBe(1);
    expect(metrics.total(METRIC.fallbacks, { reason: 'retryable_provider' })).toBe(1);
    expect(
      metrics.total(METRIC.providerAttempts, {
        model_class: 'P',
        provider: 'mock',
        status: 'failed',
      }),
    ).toBe(1);
    // The second route succeeded, and is attributed to the model that was actually paid.
    expect(
      metrics.total(METRIC.providerAttempts, {
        model_class: 'P',
        provider: 'mock-alt',
        status: 'succeeded',
      }),
    ).toBe(1);
  });

  it('a non-retryable failure records no retry and no fallback', async () => {
    const refused: Provider = {
      name: 'mock',
      complete: () =>
        Promise.reject(new ProviderFailure('non_retryable_request', 'refused', { status: 400 })),
    };
    const { gateway, metrics } = build({
      providers: new Map<string, Provider>([
        ['mock', refused],
        ['mock-alt', refused],
      ]),
    });
    await expect(gateway.call(writerRequest())).rejects.toThrow();
    expect(metrics.total(METRIC.retries, { reason: 'non_retryable_request' })).toBe(0);
    expect(metrics.total(METRIC.fallbacks, { reason: 'non_retryable_request' })).toBe(0);
  });

  it('a bounded repair records a repair attempt', async () => {
    let calls = 0;
    const flaky = new MockProvider(() => {
      calls++;
      return { json: calls > 1 ? ENGLISH_SCENE : { not: 'a scene' } };
    });
    const { gateway, metrics } = build({
      providers: new Map<string, Provider>([
        ['mock', flaky],
        ['mock-alt', sceneProvider()],
      ]),
    });
    await gateway.call(writerRequest());
    expect(metrics.total(METRIC.repairs, { reason: 'schema_invalid' })).toBeGreaterThan(0);
  });

  it('a cancellation records the request, the observed phase, remote state and UNKNOWN cost', async () => {
    const controller = new AbortController();
    controller.abort();
    const cancellation: CancellationInput[] = [
      { signal: controller.signal, reason: 'operator_cancel' },
    ];
    const { gateway, metrics } = build({});
    await expect(gateway.call(writerRequest(), { cancellation })).rejects.toThrow(/CANCELLED/);

    expect(metrics.total(METRIC.cancellationRequests, { source: 'operator_cancel' })).toBe(1);
    expect(metrics.total(METRIC.cancellationObservations, { phase: 'before_first_attempt' })).toBe(
      1,
    );
    // Nothing acknowledged a remote stop, so the state is `unknown` -- never a comfortable claim.
    expect(metrics.total(METRIC.remoteCancellation, { state: 'unknown' })).toBe(1);
    // The cost is recorded as UNKNOWN, matching ADR-0049: a cancelled call is not assumed free.
    expect(metrics.total(METRIC.unknownCost, { scope_kind: 'job' })).toBe(1);
    // There is deliberately NO settlement counter on this path: the cancel landed before the budget
    // reservation, so nothing was reserved and nothing can be settled. Asserting a settlement here
    // would demand a counter for an event that did not happen.
    expect(metrics.total(METRIC.budgetSettlements, { scope_kind: 'job', outcome: 'unknown' })).toBe(
      0,
    );
    expect(
      metrics.total(METRIC.budgetReservations, { scope_kind: 'job', outcome: 'reserved' }),
    ).toBe(0);
  });

  it('publishes no tenant identifier, prompt, prose or credential in any rendered series', async () => {
    const { gateway, metrics } = build({ admission: new StubAdmission(true, 'admitted') });
    await gateway.call(writerRequest());
    const text = renderedLabels(metrics);
    for (const forbidden of [
      ids.ws,
      ids.project,
      ids.job,
      ids.pack,
      'scene_writer',
      'device cried out',
      'Porter registration',
      'sha256:pack',
    ]) {
      expect(text, `rendered metrics leaked ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('keeps series count bounded across many distinct calls', async () => {
    const { gateway, metrics } = build({ admission: new StubAdmission(true, 'admitted') });
    for (let i = 0; i < 25; i++) await gateway.call(writerRequest());
    const series = metrics
      .render()
      .split('\n')
      .filter((l) => l.startsWith('yeonjae_') && !l.startsWith('#'));
    // 25 calls with distinct ids and idempotency keys must not create 25x the series: the labels are
    // dimensions, not identities.
    expect(series.length).toBeLessThan(40);
  });

  it('a gateway built without a registry still works, so metrics are never load-bearing', async () => {
    const gateway = new Gateway({
      providers: new Map<string, Provider>([['mock', sceneProvider()]]),
      routing,
      budget: new MemoryBudget(10_000_000),
      audit: new MemoryAuditStore(),
    });
    await expect(gateway.call(writerRequest())).resolves.toBeDefined();
  });
});
