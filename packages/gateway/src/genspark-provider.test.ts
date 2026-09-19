import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_GENSPARK_BRIDGE_URL,
  DEFAULT_GENSPARK_TIMEOUT_MS,
  GensparkProvider,
} from './genspark-provider.js';
import { DEFAULT_PARAMS } from './mock-provider.js';
import { SyntheticProviderService } from './synthetic-provider-service.js';
import { type ProviderRequest } from './types.js';

describe('GensparkProvider', () => {
  let service: SyntheticProviderService;

  beforeEach(async () => {
    service = new SyntheticProviderService({ oversizedBytes: 64 * 1024 });
    await service.start();
  });

  afterEach(async () => {
    await service.close();
  });

  it('exposes expected defaults and constants', () => {
    expect(DEFAULT_GENSPARK_BRIDGE_URL).toBe('http://127.0.0.1:8091');
    expect(DEFAULT_GENSPARK_TIMEOUT_MS).toBe(180_000);

    const provider = new GensparkProvider();
    expect(provider.name).toBe('genspark');
  });

  it('allows custom name and options override', () => {
    const provider = new GensparkProvider({
      name: 'custom-genspark',
      baseUrl: 'http://127.0.0.1:8099',
      timeoutMs: 60_000,
      maxResponseBytes: 1024 * 1024,
    });
    expect(provider.name).toBe('custom-genspark');
  });

  it('delegates complete() requests to the target bridge endpoint over HTTP', async () => {
    const provider = new GensparkProvider({
      baseUrl: service.baseUrl(),
    });

    const req: ProviderRequest = {
      modelId: 'claude-3-7-sonnet',
      system: 'You are a test novel writer.',
      user: 'Write episode 1 opening.',
      params: DEFAULT_PARAMS,
      trace: { role: 'scene_writer', activityId: 'act-1', idempotencyKey: 'test-1' },
    };

    const res = await provider.complete(req);
    expect(res.provider).toBe('genspark');
    expect(res.finishReason).toBe('stop');
    expect(res.usageReported).toBe(true);
    expect(res.text).toContain('synthetic completion');
  });
});
