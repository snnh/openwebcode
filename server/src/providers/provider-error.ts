export type ProviderErrorKind =
  | "authentication"
  | "permission"
  | "not_found"
  | "rate_limit"
  | "overloaded"
  | "network"
  | "stream_interrupted"
  | "invalid_request"
  | "unknown";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ProviderError";
  }
}

export function classifyHttpError(status: number, message: string, retryAfterMs?: number): ProviderError {
  if (status === 401) return new ProviderError("authentication", message, false);
  if (status === 403) return new ProviderError("permission", message, false);
  if (status === 404) return new ProviderError("not_found", message, false);
  if (status === 400 || status === 409 || status === 422) return new ProviderError("invalid_request", message, false);
  if (status === 408 || status === 429) return new ProviderError("rate_limit", message, true, retryAfterMs);
  if (status === 529) return new ProviderError("overloaded", message, true, retryAfterMs);
  if (status >= 500) return new ProviderError("overloaded", message, true, retryAfterMs);
  return new ProviderError("unknown", message, false);
}

export function normalizeProviderError(error: unknown, streamStarted = false): ProviderError {
  if (error instanceof ProviderError) return error;
  if (isAbortError(error)) throw error;

  const message = error instanceof Error ? error.message : String(error);
  const status = getNumber(error, "status");
  if (status !== undefined) {
    return classifyHttpError(status, message, retryAfterFromError(error));
  }
  if (streamStarted) {
    return new ProviderError("stream_interrupted", message, true, undefined, { cause: error });
  }
  if (error instanceof TypeError || getString(error, "code")) {
    return new ProviderError("network", message, true, undefined, { cause: error });
  }
  return new ProviderError("unknown", message, false, undefined, { cause: error });
}

export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isNaN(at)) return Math.max(0, at - Date.now());
  return undefined;
}

function retryAfterFromError(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (!headers || typeof headers !== "object") return undefined;
  if (headers instanceof Headers) return parseRetryAfter(headers.get("retry-after"));
  const value = (headers as Record<string, unknown>)["retry-after"];
  return typeof value === "string" ? parseRetryAfter(value) : undefined;
}

function getNumber(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "number" ? candidate : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
