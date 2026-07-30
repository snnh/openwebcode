import path from "node:path";
import { MAX_SYNC_INTERVAL_MINUTES } from "./remote-sync-scheduler.js";
import type { FastModelConfig } from "./fast-model.js";
import type { PythonEnv } from "./sessions/types.js";

export interface ServerConfig {
  host: string;
  port: number;
  /** Required whenever the HTTP listener is reachable off-host. */
  accessToken?: string;
  /** Browser origins allowed to open the event WebSocket. */
  allowedOrigins: string[];
  corePath: string;
  dataDir: string;
  coreRequestTimeoutMs: number;
  gcMaxBytes: number;
  defaultLanguage: string;
  defaultCurrency: "USD" | "CNY";
  /** bash 工具 python 运行环境的全局默认（会话可覆盖）；global = 本机环境。 */
  pythonEnv: PythonEnv;
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
  /** Optional update check against GitHub Releases. Disabled by default. */
  updateCheck: {
    enabled: boolean;
    url?: string;
    intervalHours: number;
  };
  fastModel?: FastModelConfig;
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

function currency(value: string | undefined): "USD" | "CNY" {
  const normalized = (value ?? "CNY").toUpperCase();
  if (normalized === "RMB") return "CNY";
  if (normalized === "USD" || normalized === "CNY") return normalized;
  throw new Error(`Expected USD, CNY, or RMB, received ${value}`);
}

function pythonEnv(value: string | undefined): PythonEnv {
  if (value === undefined || value === "global") return "global";
  if (value === "uv-workspace" || value === "uv-config") return value;
  throw new Error(`Expected global, uv-workspace, or uv-config, received ${value}`);
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

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return normalized === "localhost" || normalized === "::1" || normalized === "[::1]" ||
    normalized === "127.0.0.1" || normalized.startsWith("127.");
}

function originList(value: string | undefined): string[] {
  if (!value) return [];
  const origins = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (origins.length > 16) throw new Error("OWC_ALLOWED_ORIGINS accepts at most 16 origins");
  return origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`OWC_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error(`OWC_ALLOWED_ORIGINS entries must be http(s) origins: ${origin}`);
    }
    return parsed.origin;
  });
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
  const host = env.OWC_HOST ?? "127.0.0.1";
  const accessToken = env.OWC_ACCESS_TOKEN?.trim() || undefined;
  const allowedOrigins = originList(env.OWC_ALLOWED_ORIGINS);
  if (!isLoopbackHost(host)) {
    if (!accessToken || accessToken.length < 32) {
      throw new Error("Non-loopback OWC_HOST requires OWC_ACCESS_TOKEN with at least 32 characters");
    }
    if (allowedOrigins.length === 0) {
      throw new Error("Non-loopback OWC_HOST requires OWC_ALLOWED_ORIGINS (comma-separated http(s) origins)");
    }
  }
  return {
    host,
    port: positiveInteger(env.OWC_PORT, 3210),
    ...(accessToken ? { accessToken } : {}),
    allowedOrigins,
    corePath: env.OWC_CORE_PATH ?? "../build/Debug/owc-exec.exe",
    dataDir: env.OWC_DATA_DIR ?? "../.openwebcode",
    coreRequestTimeoutMs: positiveInteger(env.OWC_CORE_REQUEST_TIMEOUT_MS, 130_000),
    gcMaxBytes: positiveInteger(env.OWC_GC_MAX_BYTES, 2_147_483_648),
    defaultLanguage: env.OWC_DEFAULT_LANGUAGE ?? "zh-CN",
    defaultCurrency: currency(env.OWC_DEFAULT_CURRENCY),
    pythonEnv: pythonEnv(env.OWC_PYTHON_ENV),
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
    updateCheck: {
      enabled: env.OWC_UPDATE_CHECK_ENABLED === "1" || env.OWC_UPDATE_CHECK_ENABLED === "true",
      ...(env.OWC_UPDATE_CHECK_URL ? { url: env.OWC_UPDATE_CHECK_URL } : {}),
      intervalHours: boundedNonNegativeInteger(env.OWC_UPDATE_CHECK_INTERVAL_HOURS, 24, 24 * 30),
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
  };
}
