import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

let cachedVersion: string | undefined;

/**
 * Synchronous accessor for the resolved server version.
 * Returns "0.0.0" until `initServerVersion` has been called (at startup) or
 * `setServerVersion`/`readServerVersion` has populated the cache. Callers in
 * the request path can rely on this being initialized by boot time.
 */
export function getServerVersion(): string {
  return cachedVersion ?? "0.0.0";
}

/**
 * The server version, read once from `server/package.json`.
 * This is the single runtime source of truth for the Node layer (the web and
 * core tiers keep their own `package.json`/`CMakeLists.txt` values in sync at
 * release time). Reading the file lazily keeps tests free of import-time side
 * effects; a missing or malformed package.json falls back to "0.0.0".
 */
export async function readServerVersion(): Promise<string> {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = await readFile(path.join(moduleDirectory, "..", "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { version?: unknown };
    if (typeof parsed.version === "string" && parsed.version.length > 0) {
      cachedVersion = parsed.version;
      return cachedVersion;
    }
  } catch {
    // Fall through to default below.
  }
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/** Initialize the cached version from the resolved server version (called once at startup). */
export function setServerVersion(version: string): void {
  cachedVersion = version;
}

/** The GitHub repository hosting releases, used by update checks. */
export const GITHUB_REPO = "snnh/openwebcode";

/** GitHub releases/latest 端点（更新检查默认目标；由 GITHUB_REPO 单一来源拼出）。 */
export const GITHUB_RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

