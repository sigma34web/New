/**
 * Genspark AI provider adapter.
 *
 * Connects to the local Genspark bridge service running genspark_auth.py with curl_cffi Chrome TLS
 * impersonation and session cookie rotation.
 *
 * Implements the Provider interface, delegating transport to HttpProvider while defaulting to the
 * local bridge endpoint (http://127.0.0.1:8091) and configuring appropriate timeouts for long-form
 * novel generation.
 */
import { HttpProvider, type HttpProviderOptions } from './http-provider.js';
import { type Provider, type ProviderRequest, type ProviderResponse } from './types.js';

export const DEFAULT_GENSPARK_BRIDGE_URL = 'http://127.0.0.1:8091';
export const DEFAULT_GENSPARK_TIMEOUT_MS = 180_000;

export interface GensparkProviderOptions {
  readonly name?: string | undefined;
  /** Base URL of the Genspark bridge service. Default 'http://127.0.0.1:8091'. */
  readonly baseUrl?: string | undefined;
  /** Extra headers per request. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Hard ceiling on response body size. Default 2 MiB. */
  readonly maxResponseBytes?: number | undefined;
  /** Whole-request deadline in milliseconds. Default 180 s (3 minutes). */
  readonly timeoutMs?: number | undefined;
  /** Allow a non-loopback endpoint. Default false. */
  readonly allowNonLoopback?: boolean | undefined;
}

export class GensparkProvider implements Provider {
  readonly name: string;
  private readonly adapter: HttpProvider;

  constructor(opts: GensparkProviderOptions = {}) {
    this.name = opts.name ?? 'genspark';
    const httpOpts: HttpProviderOptions = {
      name: this.name,
      baseUrl: opts.baseUrl ?? DEFAULT_GENSPARK_BRIDGE_URL,
      ...(opts.headers !== undefined ? { headers: opts.headers } : {}),
      maxResponseBytes: opts.maxResponseBytes ?? 2 * 1024 * 1024,
      timeoutMs: opts.timeoutMs ?? DEFAULT_GENSPARK_TIMEOUT_MS,
      ...(opts.allowNonLoopback !== undefined ? { allowNonLoopback: opts.allowNonLoopback } : {}),
    };
    this.adapter = new HttpProvider(httpOpts);
  }

  complete(
    req: ProviderRequest,
    signal?: AbortSignal,
  ): Promise<ProviderResponse & { readonly usageReported: boolean }> {
    return this.adapter.complete(req, signal);
  }
}
