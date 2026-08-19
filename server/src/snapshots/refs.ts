import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  newSnapshotId,
  readCheckpoints,
  truncateLines,
  validateSnapshotId,
  writeCheckpoints,
  type Checkpoint,
  type SnapshotBackend,
  type SnapshotCapabilityInfo,
} from "./backend.js";
import type { CommandRunner } from "./probe.js";
import { diffTrees, type SnapshotDiffExcludes } from "./tree-diff.js";

/** refs-clone.ps1 的资产路径（src 与 dist 下均位于 server/<src|dist>/snapshots，向上两级即 server/）。 */
export function refsScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "refs-clone.ps1");
}

/** Windows ReFS 块克隆快照（经 refs-clone.ps1 调用 FSCTL_DUPLICATE_EXTENTS，失败时脚本内回落普通拷贝）。 */
export class RefsBackend implements SnapshotBackend {
  readonly name = "refs";
  private readonly snapRoot: string;
  private readonly metadataPath: string;

  constructor(
    sessionRoot: string,
    private readonly workspace: string,
    private readonly runner: CommandRunner,
    private readonly excludes: SnapshotDiffExcludes = { excludePrefixes: [], excludeGlobs: [] },
  ) {
    this.snapRoot = path.join(sessionRoot, "refs-snaps");
    this.metadataPath = path.join(sessionRoot, "checkpoints.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.snapRoot, { recursive: true });
  }

  async capability(): Promise<SnapshotCapabilityInfo> {
    return { backend: "refs", costHint: "instant", requiresAdmin: false, detail: "ReFS 块克隆" };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const id = newSnapshotId();
    await this.runScript("create", path.join(this.snapRoot, id));
    const checkpoint: Checkpoint = { id, label, createdAt: new Date().toISOString(), messageCount, ...(ledger === undefined ? {} : { ledger }) };
    const checkpoints = await this.list();
    checkpoints.push(checkpoint);
    await writeCheckpoints(this.metadataPath, checkpoints);
    return checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    return readCheckpoints(this.metadataPath);
  }

  async diff(id: string): Promise<string> {
    validateSnapshotId(id);
    // 完整 unified diff 统一走 git；git 缺失时降级 walkFiles 摘要
    const unified = await diffTrees(path.join(this.snapRoot, id), this.workspace, this.excludes);
    if (unified !== null) return unified;
    const before = await walkFiles(path.join(this.snapRoot, id));
    const after = await walkFiles(this.workspace);
    const lines: string[] = [];
    for (const relative of [...new Set([...before.keys(), ...after.keys()])].sort()) {
      const snap = before.get(relative);
      const work = after.get(relative);
      if (snap && !work) lines.push(`D ${relative}`);
      else if (!snap && work) lines.push(`A ${relative}`);
      else if (snap && work && (snap.size !== work.size || snap.mtimeMs !== work.mtimeMs)) lines.push(`M ${relative}`);
    }
    return truncateLines(lines.join("\n"));
  }

  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    await this.runScript("restore", path.join(this.snapRoot, id));
  }

  async delete(id: string): Promise<void> {
    validateSnapshotId(id);
    await this.runScript("delete", path.join(this.snapRoot, id));
    await writeCheckpoints(this.metadataPath, (await this.list()).filter((item) => item.id !== id));
  }

  private async runScript(mode: "create" | "restore" | "delete", snapDir: string): Promise<void> {
    const result = await this.runner.run(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", refsScriptPath(), "-Mode", mode, "-Workspace", this.workspace, "-SnapDir", snapDir],
      { timeoutMs: 600_000 },
    );
    if (result.code !== 0) throw new Error(`refs-clone ${mode} failed (${result.code})`);
  }
}

/** 递归收集 相对路径 → {size, mtimeMs}；目录不存在视为空。 */
async function walkFiles(root: string): Promise<Map<string, { size: number; mtimeMs: number }>> {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  const visit = async (relative: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(path.join(root, relative), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(path.join(root, child));
      files.set(child, { size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  await visit("");
  return files;
}
