import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
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

/** ZFS 数据集快照。restore 不能用 zfs rollback（会销毁更新的快照），改为复制回写。 */
export class ZfsBackend implements SnapshotBackend {
  readonly name = "zfs";
  private readonly metadataPath: string;

  constructor(
    private readonly sessionRoot: string,
    private readonly workspace: string,
    readonly dataset: string,
    private readonly runner: CommandRunner,
    private readonly excludes: SnapshotDiffExcludes = { excludePrefixes: [], excludeGlobs: [] },
  ) {
    this.metadataPath = path.join(sessionRoot, "checkpoints.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.sessionRoot, { recursive: true });
  }

  async capability(): Promise<SnapshotCapabilityInfo> {
    return { backend: "zfs", costHint: "instant", requiresAdmin: false, detail: "数据集快照（restore 为复制回写）" };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const id = newSnapshotId();
    await this.must("snapshot", ["snapshot", `${this.dataset}@${id}`]);
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
    // 完整 unified diff 统一走 git：旧树 = workspace/.zfs/snapshot/<id>（snapdir 可见时）。
    // snapdir 不可见或 git 缺失时如实降级为 zfs diff 摘要。
    const snapshotDir = path.join(this.workspace, ".zfs", "snapshot", id);
    try {
      const info = await stat(snapshotDir);
      if (info.isDirectory()) {
        const unified = await diffTrees(snapshotDir, this.workspace, {
          ...this.excludes,
          excludePrefixes: [".zfs", ...this.excludes.excludePrefixes],
        });
        if (unified !== null) return unified;
      }
    } catch {
      // 快照目录不可访问：走摘要降级
    }
    const result = await this.runner.run("zfs", ["diff", `${this.dataset}@${id}`]);
    if (result.code !== 0) throw new Error(`zfs diff failed (${result.code})`);
    return truncateLines(result.stdout);
  }

  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    // 清空工作区后从自动挂载的只读快照目录复制回写
    const snapshotDir = path.join(this.workspace, ".zfs", "snapshot", id);
    for (const entry of await readdir(this.workspace)) {
      if (entry === ".zfs") continue;
      await rm(path.join(this.workspace, entry), { recursive: true, force: true });
    }
    await cp(snapshotDir, this.workspace, { recursive: true });
  }

  async delete(id: string): Promise<void> {
    validateSnapshotId(id);
    await this.must("destroy", ["destroy", `${this.dataset}@${id}`]);
    await writeCheckpoints(this.metadataPath, (await this.list()).filter((item) => item.id !== id));
  }

  private async must(operation: string, args: string[]): Promise<void> {
    const result = await this.runner.run("zfs", args);
    if (result.code !== 0) throw new Error(`zfs ${operation} failed (${result.code})`);
  }
}
