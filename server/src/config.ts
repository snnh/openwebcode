export interface ServerConfig {
  host: string;
  port: number;
  corePath: string;
  dataDir: string;
  coreRequestTimeoutMs: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer, received ${value}`);
  }
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    host: env.OWC_HOST ?? "127.0.0.1",
    port: positiveInteger(env.OWC_PORT, 3210),
    corePath: env.OWC_CORE_PATH ?? "../build/Debug/owc-exec.exe",
    dataDir: env.OWC_DATA_DIR ?? "../.openwebcode",
    coreRequestTimeoutMs: positiveInteger(env.OWC_CORE_REQUEST_TIMEOUT_MS, 130_000),
  };
}
