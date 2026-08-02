import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  CoreClientLike,
  CoreInfo,
  ExecResult,
  FsGlobResult,
  FsGrepResult,
  FsListResult,
  FsReadResult,
  FsScanResult,
  FsStatResult,
  FsStatManyResult,
  FsWriteRequest,
  FsEditRequest,
  FsReadRequest,
  FsSearchRequest,
  FsPathRequest,
  JobStatus,
  JobOutputResult,
} from "../core-client.js";
import type { SandboxPolicy } from "../sessions/types.js";

const CORE_INFO: CoreInfo = {
  version: "eval-stub",
  platform: process.platform === "win32" ? "windows" : "linux",
  sandboxCapability: "advisory",
  features: { fsStat: true, fsStatMany: false, fsWriteBase64: false, jobControl: false, fsHash: false, fsScanPagination: true, fsWatch: false },
};

function globToRegex(pattern: string): RegExp {
  let re = "";
  for (const char of pattern) {
    if (char === "*") re += "[^/]*";
    else if (char === "?") re += "[^/]";
    else re += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

/**
 * In-process stub CoreClientLike that performs real file operations
 * against a workspace directory. This lets eval assertions check actual
 * file state after a replayed agent session, without spawning a C core.
 *
 * Methods not needed by the eval flow return safe defaults.
 */
export function makeEvalCore(): CoreClientLike & { setWorkspace(sessionId: string, cwd: string): void } {
  const workspaces = new Map<string, string>();

  function resolve(sessionId: string, relativePath: string): string {
    const cwd = workspaces.get(sessionId);
    if (!cwd) throw new Error(`No workspace configured for session ${sessionId}`);
    const root = path.resolve(cwd);
    const resolved = path.resolve(root, relativePath);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Path escapes evaluation workspace: ${relativePath}`);
    }
    return resolved;
  }

  async function walk(dir: string, base: string, pattern: RegExp, results: string[]): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(base, full).replace(/\\/g, "/");
      if (entry.isDirectory()) {
        await walk(full, base, pattern, results);
      } else if (pattern.test(rel) || pattern.test(entry.name)) {
        results.push(rel);
      }
    }
  }

  return {
    setWorkspace(sessionId: string, cwd: string): void {
      workspaces.set(sessionId, cwd);
    },

    on(): unknown { return this; },
    setRequestTimeoutMs(): void { /* no-op */ },

    async start(): Promise<CoreInfo> { return CORE_INFO; },
    async stop(): Promise<void> { /* no-op */ },
    async ping(): Promise<CoreInfo> { return CORE_INFO; },

    async configureSession(request: { sessionId: string; cwd: string; sandbox: SandboxPolicy }): Promise<{ sandboxCapability: string }> {
      workspaces.set(request.sessionId, request.cwd);
      return { sandboxCapability: "advisory" };
    },
    async cleanupSession(): Promise<{ ok: true }> { return { ok: true }; },

    async run(): Promise<ExecResult> { return { exitCode: 0, durationMs: 0, truncated: false }; },

    async readFile(request: FsReadRequest): Promise<FsReadResult> {
      const filePath = resolve(request.sessionId, request.path);
      const content = await readFile(filePath, "utf8");
      const lines = content.split("\n");
      const offset = request.offset ?? 0;
      const limit = request.limit ?? lines.length;
      const sliced = lines.slice(offset, offset + limit).join("\n");
      return { content: sliced, totalLines: lines.length, encoding: "utf-8", truncated: false };
    },

    async writeFile(request: FsWriteRequest): Promise<{ ok: true }> {
      const filePath = resolve(request.sessionId, request.path);
      if (request.createDirs) await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, request.content, "utf8");
      return { ok: true };
    },

    async editFile(request: FsEditRequest): Promise<{ matches: number }> {
      const filePath = resolve(request.sessionId, request.path);
      const content = await readFile(filePath, "utf8");
      if (request.replaceAll) {
        const parts = content.split(request.oldText);
        const matches = parts.length - 1;
        if (matches === 0) return { matches: 0 };
        await writeFile(filePath, parts.join(request.newText), "utf8");
        return { matches };
      }
      const index = content.indexOf(request.oldText);
      if (index === -1) return { matches: 0 };
      const updated = content.slice(0, index) + request.newText + content.slice(index + request.oldText.length);
      await writeFile(filePath, updated, "utf8");
      return { matches: 1 };
    },

    async statFile(request: FsPathRequest): Promise<FsStatResult> {
      const filePath = resolve(request.sessionId, request.path);
      const info = await stat(filePath);
      return {
        type: info.isDirectory() ? "directory" : "file",
        size: info.size,
        modifiedMs: info.mtimeMs,
      };
    },

    async statFiles(): Promise<FsStatManyResult> { return { entries: [] }; },
    async hashFile(): Promise<{ sha256: string; size: number }> { return { sha256: "", size: 0 }; },

    async scanFiles(request: FsPathRequest & { cursor?: number; limit?: number; maxDepth?: number }): Promise<FsScanResult> {
      const dir = resolve(request.sessionId, request.path);
      const entries: Array<{ path: string; type: "file" | "directory" | "other"; size: number }> = [];
      const base = dir;
      async function scan(d: string): Promise<void> {
        let items;
        try { items = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const item of items) {
          const full = path.join(d, item.name);
          const rel = path.relative(base, full).replace(/\\/g, "/");
          const info = await stat(full).catch(() => undefined);
          if (!info) continue;
          entries.push({ path: rel, type: info.isDirectory() ? "directory" : "file", size: info.size });
          if (item.isDirectory()) await scan(full);
        }
      }
      await scan(dir);
      return { entries, truncated: false };
    },

    async watchFiles(): Promise<{ watchId: number }> { return { watchId: 0 }; },
    async pollWatch(): Promise<{ events: never[]; overflow: false }> { return { events: [], overflow: false }; },
    async cancelWatch(): Promise<{ ok: true }> { return { ok: true }; },

    async listFiles(request: FsPathRequest): Promise<FsListResult> {
      const dir = resolve(request.sessionId, request.path);
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return { entries: [], truncated: false }; }
      const result = await Promise.all(entries.map(async (entry) => {
        const info = await stat(path.join(dir, entry.name)).catch(() => ({ isDirectory: () => false, size: 0 }));
        return { name: entry.name, type: info.isDirectory() ? ("directory" as const) : ("file" as const), size: info.size };
      }));
      return { entries: result, truncated: false };
    },

    async globFiles(request: FsSearchRequest): Promise<FsGlobResult> {
      const dir = resolve(request.sessionId, request.path);
      const pattern = globToRegex(request.pattern);
      const results: string[] = [];
      await walk(dir, dir, pattern, results);
      return { paths: results.sort(), truncated: false };
    },

    async grepFiles(request: FsSearchRequest): Promise<FsGrepResult> {
      const dir = resolve(request.sessionId, request.path);
      const matches: Array<{ path: string; line: number; text: string }> = [];
      async function search(d: string, base: string): Promise<void> {
        let entries;
        try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(d, entry.name);
          const rel = path.relative(base, full).replace(/\\/g, "/");
          if (entry.isDirectory()) { await search(full, base); continue; }
          try {
            const content = await readFile(full, "utf8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line && line.includes(request.pattern)) {
                matches.push({ path: rel, line: i + 1, text: line.trim().slice(0, 200) });
              }
            }
          } catch { /* skip unreadable */ }
        }
      }
      await search(dir, dir);
      return { matches: matches.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line), truncated: false };
    },

    async startJob(): Promise<JobStatus> { return { jobId: "", state: "completed", durationMs: 0, truncated: false }; },
    async startIndexScan(): Promise<JobStatus> { return { jobId: "", state: "completed", durationMs: 0, truncated: false }; },
    async startGrepJob(): Promise<JobStatus> { return { jobId: "", state: "completed", durationMs: 0, truncated: false }; },
    async startGlobJob(): Promise<JobStatus> { return { jobId: "", state: "completed", durationMs: 0, truncated: false }; },
    async startIndexExtract(): Promise<JobStatus> { return { jobId: "", state: "completed", durationMs: 0, truncated: false }; },
    async cancelJob(): Promise<{ jobId: string; accepted: true }> { return { jobId: "", accepted: true }; },
    async jobStatus(): Promise<JobStatus> { return { jobId: "", state: "completed", durationMs: 0, truncated: false }; },
    async jobOutput(): Promise<JobOutputResult> { return { chunks: [], nextSeq: 0, truncated: false }; },
  };
}
