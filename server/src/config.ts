import path from "node:path";
import { MAX_SYNC_INTERVAL_MINUTES } from "./remote-sync-scheduler.js";

export interface ServerConfig {
  host: string;
  port: number;
  corePath: string;
  dataDir: string;
  coreRequestTimeoutMs: number;
  gcMaxBytes: number;
  defaultLanguage: string;
  defaultCurrency: "USD" | "CNY";
  exchangeRate: {
    url?: string;
    timeoutMs: number;
    fixedUsdCnyRate?: string;
  };
  /** 全局 Job Object 资源限制覆盖（仅 Windows）；缺省不下发，core 用内置默认值 */
  sandbox?: {
    allowPaths?: string[];
    jobObject?: { memoryMB?: number; maxProcesses?: number };
  };
  /** Optional remote model and pricing catalogs. A zero interval means manual sync only. */
  models: {
    catalogSyncUrl?: string;
    pricingSyncUrl?: string;
    syncIntervalMinutes: number;
  };
  anthropic?: { apiKey?: string; baseURL?: string; promptCaching?: boolean };
  openai?: { apiKey?: string; baseURL: string };
  provider2?: { baseURL: string; apiKey?: string; model: string };
  search?: { provider: "brave" | "custom"; apiKey?: string; baseURL?: string };
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

/** 可选的正整数环境变量，带上限（与 core 侧 session.configure 校验一致）；未设置返回 undefined */
function boundedInteger(value: string | undefined, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = positiveInteger(value, 1);
  if (parsed > maximum) {
    throw new Error(`Expected an integer <= ${maximum}, received ${value}`);
  }
  return parsed;
}

function booleanWithDefault(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error(`Expected a boolean, received ${value}`);
}

function currency(value: string | undefined): "USD" | "CNY" {
  const normalized = (value ?? "CNY").toUpperCase();
  if (normalized === "RMB") return "CNY";
  if (normalized === "USD" || normalized === "CNY") return normalized;
  throw new Error(`Expected USD, CNY, or RMB, received ${value}`);
}

function boundedNonNegativeInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, received ${value}`);
  }
  if (parsed > maximum) {
    throw new Error(`Expected an integer <= ${maximum}, received ${value}`);
  }
  return parsed;
}

function optionalHttpUrl(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid http/https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${name} must use http or https`);
  }
  return value;
}

function pathList(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const paths = value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
  if (paths.length > 16) throw new Error("OWC_SANDBOX_ALLOW_PATHS accepts at most 16 paths");
  return paths.length > 0 ? paths : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const jobMemoryMB = boundedInteger(env.OWC_JOB_MEMORY_MB, 1_048_576);
  const jobMaxProcesses = boundedInteger(env.OWC_JOB_MAX_PROCESSES, 4096);
  const allowPaths = pathList(env.OWC_SANDBOX_ALLOW_PATHS);
  const catalogSyncUrl = optionalHttpUrl(env.OWC_MODELS_CATALOG_SYNC_URL, "OWC_MODELS_CATALOG_SYNC_URL");
  const pricingSyncUrl = optionalHttpUrl(env.OWC_MODELS_PRICING_SYNC_URL, "OWC_MODELS_PRICING_SYNC_URL");
  return {
    host: env.OWC_HOST ?? "127.0.0.1",
    port: positiveInteger(env.OWC_PORT, 3210),
    corePath: env.OWC_CORE_PATH ?? "../build/Debug/owc-exec.exe",
    dataDir: env.OWC_DATA_DIR ?? "../.openwebcode",
    coreRequestTimeoutMs: positiveInteger(env.OWC_CORE_REQUEST_TIMEOUT_MS, 130_000),
    gcMaxBytes: positiveInteger(env.OWC_GC_MAX_BYTES, 2_147_483_648),
    defaultLanguage: env.OWC_DEFAULT_LANGUAGE ?? "zh-CN",
    defaultCurrency: currency(env.OWC_DEFAULT_CURRENCY),
    exchangeRate: {
      ...(env.OWC_EXCHANGE_RATE_URL ? { url: env.OWC_EXCHANGE_RATE_URL } : {}),
      timeoutMs: positiveInteger(env.OWC_EXCHANGE_RATE_TIMEOUT_MS, 5_000),
      ...(env.OWC_USD_CNY_RATE ? { fixedUsdCnyRate: env.OWC_USD_CNY_RATE } : {}),
    },
    models: {
      ...(catalogSyncUrl ? { catalogSyncUrl } : {}),
      ...(pricingSyncUrl ? { pricingSyncUrl } : {}),
      syncIntervalMinutes: boundedNonNegativeInteger(env.OWC_MODELS_SYNC_INTERVAL_MINUTES, 0, MAX_SYNC_INTERVAL_MINUTES),
    },
    ...(allowPaths !== undefined || jobMemoryMB !== undefined || jobMaxProcesses !== undefined
      ? {
          sandbox: {
            ...(allowPaths !== undefined ? { allowPaths } : {}),
            ...(jobMemoryMB !== undefined || jobMaxProcesses !== undefined
              ? { jobObject: {
                  ...(jobMemoryMB !== undefined ? { memoryMB: jobMemoryMB } : {}),
                  ...(jobMaxProcesses !== undefined ? { maxProcesses: jobMaxProcesses } : {}),
                } }
              : {}),
          },
        }
      : {}),
    ...(env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL
      ? {
          anthropic: {
            ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
            ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}),
            promptCaching: booleanWithDefault(env.ANTHROPIC_PROMPT_CACHING, true),
          },
        }
      : {}),
    ...(env.OPENAI_BASE_URL
      ? {
          openai: {
            baseURL: env.OPENAI_BASE_URL,
            ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
          },
        }
      : {}),
    ...(env.OWC_PROVIDER2_BASE_URL && env.OWC_PROVIDER2_MODEL
      ? {
          provider2: {
            baseURL: env.OWC_PROVIDER2_BASE_URL,
            model: env.OWC_PROVIDER2_MODEL,
            ...(env.OWC_PROVIDER2_API_KEY ? { apiKey: env.OWC_PROVIDER2_API_KEY } : {}),
          },
        }
      : {}),
    ...(env.OWC_SEARCH_PROVIDER === "brave" || env.OWC_SEARCH_PROVIDER === "custom"
      ? {
          search: {
            provider: env.OWC_SEARCH_PROVIDER,
            ...(env.OWC_SEARCH_API_KEY ? { apiKey: env.OWC_SEARCH_API_KEY } : {}),
            ...(env.OWC_SEARCH_BASE_URL ? { baseURL: env.OWC_SEARCH_BASE_URL } : {}),
          },
        }
      : {}),
  };
}
