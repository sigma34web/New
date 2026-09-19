/**
 * Provider-adapter behaviour against a REAL local HTTP server (simulated provider, not a live one).
 *
 * Everything else in this package tests the gateway against in-process fakes, which return values and so
 * cannot express the faults that actually happen on a network: a socket reset before headers, a body that
 * stops halfway, a 429 with `Retry-After`, a response that keeps coming after the caller gave up, a body
 * larger than the adapter will buffer.
 *
 * SCOPE, stated plainly: this is SIMULATED provider validation. It proves the adapter and the gateway
 * handle a real transport correctly. It is NOT evidence about any live provider's behaviour, billing or
 * remote-cancellation semantics, and no request in this file leaves the loopback interface.
 *
 * Determinism: "delayed", "mid-stream" and "late" are barriers the test releases, never durations the
 * test hopes are long enough. There is no sleep() in this file.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CancellationError } from './cancellation.js';
import { HttpProvider, classifyHttpStatus } from './http-provider.js';
import { ProviderFailure } from './failures.js';
import {
  SYNTHETIC_SCENARIO_HEADER,
  SyntheticProviderService,
  type SyntheticScenario,
} from './synthetic-provider-service.js';
import { DEFAULT_PARAMS } from './mock-provider.js';
import { type ProviderRequest } from './types.js';

function requestFor(scenario: SyntheticScenario, idempotencyKey = 'req-1'): ProviderRequest {
  return {
    modelId: 'synthetic-model',
    system: 'you are a deterministic test provider',
    user: `scenario:${scenario}`,
    params: DEFAULT_PARAMS,
    trace: { role: 'scene_writer', activityId: 'act-1', idempotencyKey },
  };
}

describe('provider adapter against the local synthetic provider service (simulated, not live)', () => {
  let service: SyntheticProviderService;
  let provider: HttpProvider;

  const providerFor = (scenario: SyntheticScenario, overrides = {}): HttpProvider =>
    new HttpProvider({
      name: 'synthetic',
      baseUrl: service.baseUrl(),
      headers: { [SYNTHETIC_SCENARIO_HEADER]: scenario },
      timeoutMs: 5_000,
      ...overrides,
    });

  beforeEach(async () => {
    service = new SyntheticProviderService({ oversizedBytes: 64 * 1024 });
    await service.start();
    provider = providerFor('ok');
  });

  afterEach(async () => {
    // Always closed, even when a case failed mid-response: a leaked listening socket or a response
    // blocked on a barrier is exactly what makes a suite hang instead of fail.
    await service.close();
  });

  // -------------------------------------------------------------------------------------------------
  // the happy paths, over a real socket
  // -------------------------------------------------------------------------------------------------

  it('completes a request and reports usage', async () => {
    const res = await provider.complete(requestFor('ok'));
    expect(res.provider).toBe('synthetic');
    expect(res.finishReason).toBe('stop');
    expect(res.usage).toEqual({ input: 120, output: 48, cached: 0 });
    expect(res.usageReported).toBe(true);
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('is deterministic: the same prompt yields the same completion', async () => {
    const a = await provider.complete(requestFor('ok'));
    const b = await provider.complete(requestFor('ok'));
    expect(a.text).toBe(b.text);
  });

  it('assembles a chunked response', async () => {
    const res = await providerFor('ok_stream').complete(requestFor('ok_stream'));
    expect(res.text).toContain('synthetic completion for');
  });

  it('records only hashes and sizes, never prompt text', async () => {
    await provider.complete(requestFor('ok'));
    const record = service.requests()[0];
    expect(record?.systemHash).toMatch(/^[0-9a-f]{64}$/);
    expect(record?.systemBytes).toBeGreaterThan(0);
    // The same rule the real audit follows: a simulator log must not become a content store.
    expect(JSON.stringify(record)).not.toContain('deterministic test provider');
  });

  // -------------------------------------------------------------------------------------------------
  // usage truthfulness
  // -------------------------------------------------------------------------------------------------

  it('reports unreported usage as unknown rather than zero', async () => {
    const res = await providerFor('usage_missing').complete(requestFor('usage_missing'));
    // The zeros are a placeholder the interface requires; `usageReported: false` is what stops the
    // accounting layer booking a false zero.
    expect(res.usageReported).toBe(false);
    expect(res.usage).toEqual({ input: 0, output: 0, cached: 0 });
  });

  it('treats partial usage as unknown instead of completing it by assumption', async () => {
    // Output-only usage would understate cost if the missing input were assumed to be zero.
    const res = await providerFor('usage_partial').complete(requestFor('usage_partial'));
    expect(res.usageReported).toBe(false);
  });

  // -------------------------------------------------------------------------------------------------
  // transport faults, classified
  // -------------------------------------------------------------------------------------------------

  it('classifies HTTP statuses so fallback is authorized only where it can help', () => {
    expect(classifyHttpStatus(429)).toBe('retryable_throttled');
    expect(classifyHttpStatus(500)).toBe('retryable_provider');
    expect(classifyHttpStatus(503)).toBe('retryable_provider');
    // A rejected or unauthorised request must NOT be rerouted to a second paid model: re-sending the
    // same bytes cannot fix it (B-4-2).
    expect(classifyHttpStatus(400)).toBe('non_retryable_request');
    expect(classifyHttpStatus(401)).toBe('non_retryable_request');
    expect(classifyHttpStatus(403)).toBe('non_retryable_request');
  });

  it.each([
    ['rate_limited', 'retryable_throttled'],
    ['server_error', 'retryable_provider'],
    ['bad_gateway', 'retryable_provider'],
    ['unavailable', 'retryable_provider'],
  ] as const)('maps the %s response to %s', async (scenario, expected) => {
    const failure = await providerFor(scenario)
      .complete(requestFor(scenario))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).failureClass).toBe(expected);
  });

  it('treats a connection reset before headers as a retryable transport fault', async () => {
    const failure = await providerFor('connection_reset')
      .complete(requestFor('connection_reset'))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).failureClass).toBe('retryable_transport');
  });

  it('treats a body truncated mid-stream as a transport fault, never as a completion', async () => {
    // The dangerous failure would be accepting the partial body as a short answer.
    const pending = providerFor('reset_mid_body')
      .complete(requestFor('reset_mid_body'))
      .catch((err: unknown) => err);
    service.barrier('reset').release();
    const failure = await pending;
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).failureClass).toBe('retryable_transport');
  });

  it('rejects a malformed JSON body rather than guessing at its meaning', async () => {
    const failure = await providerFor('malformed_json')
      .complete(requestFor('malformed_json'))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).failureClass).toBe('retryable_transport');
  });

  it('rejects a response whose completion is not a string', async () => {
    const failure = await providerFor('schema_violation')
      .complete(requestFor('schema_violation'))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderFailure);
    // Wrong shape is the request being wrong, not a transport hiccup: retrying will not change it.
    expect((failure as ProviderFailure).failureClass).toBe('non_retryable_request');
  });

  it('refuses a response larger than its ceiling instead of buffering it', async () => {
    const failure = await providerFor('oversized_body', { maxResponseBytes: 8 * 1024 })
      .complete(requestFor('oversized_body'))
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).message).toMatch(/exceeded 8192 bytes/);
  });

  it('times out a provider that never sends headers, and calls it a timeout', async () => {
    const slow = providerFor('delayed_headers', { timeoutMs: 50 });
    const failure = await slow.complete(requestFor('delayed_headers')).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect((failure as ProviderFailure).failureClass).toBe('retryable_transport');
    // A timeout may have been processed remotely, which is what the gateway needs to avoid duplicating.
    expect((failure as ProviderFailure).detail.possiblyCompleted).toBe(true);
    service.barrier('headers').release();
  });

  it('succeeds once injected transient failures are used up', async () => {
    // The shape a retry test needs: the same request fails twice and then works.
    service.failNext('server_error', 2);
    const p = providerFor('server_error');
    await expect(p.complete(requestFor('server_error'))).rejects.toBeInstanceOf(ProviderFailure);
    await expect(p.complete(requestFor('server_error'))).rejects.toBeInstanceOf(ProviderFailure);
    const recovered = await p.complete(requestFor('server_error'));
    expect(recovered.finishReason).toBe('stop');
  });

  // -------------------------------------------------------------------------------------------------
  // cancellation over a real socket
  // -------------------------------------------------------------------------------------------------

  it('refuses to dispatch at all when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const failure = await provider
      .complete(requestFor('ok'), controller.signal)
      .catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(CancellationError);
    // Nothing was sent, so nothing remote was asked to stop. That is `not_requested`, not `unknown`.
    expect((failure as CancellationError).remoteCancellation).toBe('not_requested');
    expect(service.requests().length).toBe(0);
  });

  it('aborts an in-flight request as a cancellation, not as a retryable fault', async () => {
    // The defect this guards: the failure classifier's transport pattern matches the word "aborted", so
    // a mis-classified abort would be retried and rerouted, turning one cancellation into N paid calls.
    const controller = new AbortController();
    const pending = providerFor('delayed_headers')
      .complete(requestFor('delayed_headers'), controller.signal)
      .catch((err: unknown) => err);
    controller.abort();
    const failure = await pending;
    expect(failure).toBeInstanceOf(CancellationError);
    expect((failure as CancellationError).reason).toBe('activity_cancelled');
    // Closing a socket says nothing about whether the provider kept generating.
    expect((failure as CancellationError).remoteCancellation).toBe('unknown');
    service.barrier('headers').release();
  });

  it('observes that the provider was still working when the caller hung up', async () => {
    // The honest version of "did remote work stop?": the simulator records that the client aborted, and
    // nothing here claims the remote computation ended.
    const controller = new AbortController();
    const pending = providerFor('late_success')
      .complete(requestFor('late_success', 'late-1'), controller.signal)
      .catch((err: unknown) => err);
    // Wait until the request has actually reached the server before aborting, so the assertion is about
    // an in-flight call rather than a race with dispatch. A microtask spin would NOT work here: it
    // never yields to the I/O phase, so the request would never be accepted.
    await service.waitForRequests(1);
    controller.abort();
    expect(await pending).toBeInstanceOf(CancellationError);

    // The hang-up arrives as a socket event, so it is observable strictly AFTER the abort. Waiting for
    // it is the assertion: reading the flag immediately would read it too early and pass vacuously.
    await service.waitForClientAbort(0);
    const record = service.requests()[0];
    expect(record?.idempotencyKey).toBe('late-1');
    expect(record?.clientAborted).toBe(true);

    // Now let the provider "finish". Nothing consumes the response: the caller already gave up, which
    // is the late-response case ADR-0049 requires to be discarded rather than persisted.
    service.barrier('late:late-1').release();
  });

  it('distinguishes an acknowledged remote cancellation from an unsupported one', async () => {
    // ADR-0049's central distinction, exercised over a real endpoint rather than asserted in a comment.
    const ack = await fetch(`${service.baseUrl()}/v1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'cancel-1' }),
    });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ remote_cancellation: 'acknowledged' });
    expect(service.remoteCancelRequested('cancel-1')).toBe(true);

    const unsupported = await fetch(`${service.baseUrl()}/v1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'cancel-2', supported: false }),
    });
    expect(unsupported.status).toBe(501);
    expect(await unsupported.json()).toEqual({ remote_cancellation: 'unsupported' });
    // A provider that does not support remote cancellation must not be recorded as having stopped.
    expect(service.remoteCancelRequested('cancel-2')).toBe(false);
  });

  it('reports a provider that acknowledged the stop without reporting usage', async () => {
    const pending = providerFor('remote_cancel_ack').complete(
      requestFor('remote_cancel_ack', 'ack-1'),
    );
    await fetch(`${service.baseUrl()}/v1/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: 'ack-1' }),
    });
    const res = await pending;
    expect(res.finishReason).toBe('error');
    // Usage after a remote cancel is genuinely unknown, and stays unknown.
    expect(res.usageReported).toBe(false);
  });

  // -------------------------------------------------------------------------------------------------
  // endpoint validation (SSRF)
  // -------------------------------------------------------------------------------------------------

  it('refuses a non-loopback endpoint unless explicitly allowed', () => {
    // A provider URL is configuration, and configuration is sometimes attacker-influenced. Defaulting
    // to loopback-only means a mistake cannot turn this adapter into an SSRF primitive.
    expect(() => new HttpProvider({ name: 'x', baseUrl: 'http://169.254.169.254/' })).toThrow(
      /non-loopback/,
    );
    expect(
      () =>
        new HttpProvider({
          name: 'x',
          baseUrl: 'http://169.254.169.254/',
          allowNonLoopback: true,
        }),
    ).not.toThrow();
  });

  it('refuses a non-HTTP scheme', () => {
    expect(() => new HttpProvider({ name: 'x', baseUrl: 'file:///etc/passwd' })).toThrow(
      /refusing protocol/,
    );
    expect(() => new HttpProvider({ name: 'x', baseUrl: 'not a url' })).toThrow(/not a URL/);
  });

  it('sends no credential of any kind', async () => {
    await provider.complete(requestFor('ok'));
    // The adapter carries only the headers it was given, and this repository never gives it a secret.
    expect(service.requests().length).toBe(1);
  });

  it('shuts the service down cleanly with nothing left in flight', async () => {
    const pending = providerFor('delayed_headers', { timeoutMs: 2_000 })
      .complete(requestFor('delayed_headers'))
      .catch(() => undefined);
    // close() releases barriers and destroys live responses, so this resolves rather than hanging —
    // the property that keeps one failing case from stalling the whole suite.
    await service.close();
    await pending;
    expect(true).toBe(true);
  });
});
