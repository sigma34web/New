/**
 * Rate admission inside the gateway's attempt loop.
 *
 * The interesting assertions are about WHERE the admission sits. A single admission per `call()` would
 * satisfy a naive "the limiter is wired" test while letting a retry, a bounded repair and a route
 * fallback each issue an unmetered paid request — so these cases count admissions against attempts, and
 * check that a refusal is neither retried nor rerouted.
 */
import { describe, expect, it } from 'vitest';
import { compileBlock, composeIdentity, ProfileStore } from '@yeonjae/narrative';
import { PromptRegistry, renderPrompt } from '@yeonjae/prompts';
import { asUuid } from '@yeonjae/domain';
import {
  Gateway,
  MemoryAuditStore,
  MemoryBudget,
  type ProviderAdmissionControl,
  type RoutingTable,
} from './gateway.js';
import { MockProvider } from './mock-provider.js';
import { ProviderFailure } from './failures.js';
import { GatewayError, type GatewayRequest, type Provider } from './types.js';

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

/** A mock provider that answers every prompt with the same valid English scene. */
function sceneProvider(): MockProvider {
  return new MockProvider(() => ({ json: ENGLISH_SCENE }));
}

const ENGLISH_SCENE = {
  scene_no: 1,
  language: 'en',
  text: 'The device cried out, and the hall went quiet.\n\n“F-rank,” the officer said. “Porter registration is on the left.”\n\nDo-yoon looked at his hand. It was not shaking.',
  paragraphs: [{ id: 'p1', start: 0, end: 46, kind: 'narration' }],
  speaker_annotations: [],
  claims: [],
};

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

/** Records every admission decision, so a test can assert one per ATTEMPT. */
class RecordingAdmission implements ProviderAdmissionControl {
  readonly calls: { modelId: string; requestId: string; tokens?: number | undefined }[] = [];
  readonly released: string[] = [];
  constructor(private readonly verdict: (n: number) => boolean = () => true) {}
  async admit(req: {
    provider: string;
    modelId: string;
    requestId: string;
    tokens?: number | undefined;
  }) {
    this.calls.push({ modelId: req.modelId, requestId: req.requestId, tokens: req.tokens });
    const admitted = this.verdict(this.calls.length);
    const requestId = req.requestId;
    return {
      admitted,
      reason: admitted ? 'admitted' : 'request_limit',
      retryAfterMs: admitted ? 0 : 1_500,
      waitedMs: 0,
      release: async (): Promise<void> => {
        this.released.push(requestId);
      },
    };
  }
}

function gatewayWith(
  admission: ProviderAdmissionControl,
  providers?: ReadonlyMap<string, Provider>,
): { gateway: Gateway; audit: MemoryAuditStore } {
  const audit = new MemoryAuditStore();
  const gateway = new Gateway({
    providers:
      providers ??
      new Map<string, Provider>([
        ['mock', sceneProvider()],
        ['mock-alt', sceneProvider()],
      ]),
    routing,
    budget: new MemoryBudget(10_000_000),
    admission,
    audit,
  });
  return { gateway, audit };
}

describe('shared rate admission in the gateway', () => {
  it('admits once per successful call, before the provider is invoked', async () => {
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(admission);
    const res = await gateway.call(writerRequest());
    expect(res.attempts).toBe(1);
    expect(admission.calls).toHaveLength(1);
    expect(admission.calls[0]?.modelId).toBe('mock-p-primary');
    // The reservation estimate is passed so a token ceiling can refuse an oversized call.
    expect(admission.calls[0]?.tokens).toBeGreaterThan(5000);
  });

  it('releases the concurrency lease on success', async () => {
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(admission);
    await gateway.call(writerRequest());
    expect(admission.released).toEqual(admission.calls.map((c) => c.requestId));
  });

  it('refuses the call when admission is refused, with no provider invocation', async () => {
    let invocations = 0;
    const counting: Provider = {
      name: 'mock',
      complete: (req, signal) => {
        invocations++;
        return sceneProvider().complete(req, signal);
      },
    };
    const admission = new RecordingAdmission(() => false);
    const { gateway, audit } = gatewayWith(
      admission,
      new Map<string, Provider>([
        ['mock', counting],
        ['mock-alt', counting],
      ]),
    );
    await expect(gateway.call(writerRequest())).rejects.toThrow(GatewayError);
    expect(invocations).toBe(0);
    // A refusal is NOT a provider fault: it must not be rerouted to a second paid model.
    expect(admission.calls).toHaveLength(1);
    const record = audit.records.at(-1);
    expect(record?.status).toBe('failed');
    expect(record?.error?.class).toBe('RATE_LIMITED');
    // Nothing was billed, because nothing was sent.
    expect(record?.cost_cents).toBe(0);
    expect(record?.usage).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it('surfaces the exact reopen delay so a caller never has to guess a backoff', async () => {
    const { gateway } = gatewayWith(new RecordingAdmission(() => false));
    await expect(gateway.call(writerRequest())).rejects.toThrow(/retry after 1500 ms/);
  });

  it('a FALLBACK attempt requires its own admission for the model it will use', async () => {
    const failing: Provider = {
      name: 'mock',
      complete: () =>
        Promise.reject(new ProviderFailure('retryable_provider', 'overloaded', { status: 503 })),
    };
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(
      admission,
      new Map<string, Provider>([
        ['mock', failing],
        ['mock-alt', sceneProvider()],
      ]),
    );
    const res = await gateway.call(writerRequest());
    expect(res.modelId).toBe('mock-p-alt');
    // Two attempts, two admissions, and the second one names the model that was actually paid.
    expect(admission.calls.map((c) => c.modelId)).toEqual(['mock-p-primary', 'mock-p-alt']);
    expect(admission.released).toHaveLength(2);
  });

  it('a REPAIR attempt requires its own admission', async () => {
    // Invalid structured output forces bounded repair: same route, another paid attempt.
    let calls = 0;
    // A real MockProvider, so the response carries genuine usage and the cost path is exercised.
    const flaky = new MockProvider(() => {
      calls++;
      return { json: calls > 1 ? ENGLISH_SCENE : { not: 'a scene' } };
    });
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(
      admission,
      new Map<string, Provider>([
        ['mock', flaky],
        ['mock-alt', sceneProvider()],
      ]),
    );
    await gateway.call(writerRequest());
    expect(calls).toBeGreaterThan(1);
    // One admission per provider attempt, never one per call.
    expect(admission.calls.length).toBe(calls);
  });

  it('each attempt carries a distinct admission id so a retry earns fresh admission', async () => {
    const failing: Provider = {
      name: 'mock',
      complete: () =>
        Promise.reject(new ProviderFailure('retryable_provider', 'overloaded', { status: 503 })),
    };
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(
      admission,
      new Map<string, Provider>([
        ['mock', failing],
        ['mock-alt', sceneProvider()],
      ]),
    );
    await gateway.call(writerRequest());
    const unique = new Set(admission.calls.map((c) => c.requestId));
    expect(unique.size).toBe(admission.calls.length);
  });

  it('an idempotent replay of a completed call consumes no admission at all', async () => {
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(admission);
    const req = writerRequest();
    await gateway.call(req);
    const before = admission.calls.length;
    const replayed = await gateway.call(req);
    expect(replayed.replayed).toBe(true);
    expect(admission.calls.length).toBe(before);
  });

  it('releases the lease when the provider attempt fails', async () => {
    const failing: Provider = {
      name: 'mock',
      complete: () =>
        Promise.reject(new ProviderFailure('non_retryable_request', 'refused', { status: 400 })),
    };
    const admission = new RecordingAdmission();
    const { gateway } = gatewayWith(
      admission,
      new Map<string, Provider>([
        ['mock', failing],
        ['mock-alt', failing],
      ]),
    );
    await expect(gateway.call(writerRequest())).rejects.toThrow(GatewayError);
    expect(admission.released).toHaveLength(admission.calls.length);
  });

  it('a gateway with no admission control keeps its previous behaviour exactly', async () => {
    const audit = new MemoryAuditStore();
    const gateway = new Gateway({
      providers: new Map<string, Provider>([['mock', sceneProvider()]]),
      routing,
      budget: new MemoryBudget(10_000_000),
      audit,
    });
    const res = await gateway.call(writerRequest());
    expect(res.attempts).toBe(1);
    expect(audit.records.at(-1)?.status).toBe('succeeded');
  });
});
