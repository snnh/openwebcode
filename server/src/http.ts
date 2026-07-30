/**
 * Shared HTTP helpers for outbound requests. All outbound network stays in the
 * Node layer (per the project boundary rules); this module injects the project
 * User-Agent consistently.
 *
 * This does NOT replace SSRF / redirect / response-size boundaries -- those
 * remain enforced at each call site (notably `web-tools.ts`). It only adds the
 * UA header so every outbound request identifies itself.
 */
import { buildUserAgent, getServerVersion } from "./version.js";

/**
 * The User-Agent string sent on every outbound HTTP request.
 * Resolved lazily on first use from the cached server version; tests may
 * override it by calling `setServerVersion` from version.ts.
 */
export function getUserAgent(): string {
  return buildUserAgent(getServerVersion());
}

export interface FetchJsonOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Fetch a URL and parse JSON, injecting the project User-Agent and an optional
 * timeout. Throws on non-2xx responses. Does not follow redirects or enforce
 * SSRF rules -- callers that need those boundaries keep using their own fetch.
 */
export async function fetchJson(url: string, options: FetchJsonOptions = {}): Promise<unknown> {
  const signal = options.timeoutMs
    ? mergeSignal(options.signal, options.timeoutMs)
    : options.signal;
  const init: RequestInit = {
    headers: { "User-Agent": getUserAgent(), ...(options.headers ?? {}) },
  };
  if (signal) init.signal = signal;
  const response = await fetch(url, init);
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  return response.json();
}

function mergeSignal(caller: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
}

/**
 * Returns the headers object that should be merged into an outbound fetch call.
 * Use this when a call site needs to add the UA alongside other headers but
 * keep control of its own fetch options (timeout, redirect policy, etc.).
 */
export function withUserAgent(headers: Record<string, string> = {}): Record<string, string> {
  return { "User-Agent": getUserAgent(), ...headers };
}
