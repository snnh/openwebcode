import { mkdir } from "node:fs/promises";
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

/** Btrfs 只读子卷快照。 */
export class BtrfsBackend implements SnapshotBackend {
  readonly name = "btrfs";
  private readonly snapRoot: string;
  private readonly metadataPath: string;

  constructor(private readonly workspace: string, private readonly runner: CommandRunner, private readonly excludes: SnapshotDiffExcludes = { excludePrefixes: [], excludeGlobs: [] }) {
    // 快照必须与工作区同卷，且不能放在工作区内部（会递归进快照）
    this.snapRoot = path.join(path.dirname(workspace), ".owc-snapshots", path.basename(workspace));
    this.metadataPath = path.join(this.snapRoot, "checkpoints.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.snapRoot, { recursive: true });
  }

  async capability(): Promise<SnapshotCapabilityInfo> {
    return { backend: "btrfs", costHint: "instant", requiresAdmin: false, detail: "子卷只读快照" };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const id = newSnapshotId();
    await this.must("snapshot", ["subvolume", "snapshot", "-r", this.workspace, path.join(this.snapRoot, id)]);
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
    // 完整 unified diff 统一走 git（per-file --no-index）；git 缺失时降级 btrfs 摘要
    const unified = await diffTrees(path.join(this.snapRoot, id), this.workspace, this.excludes);
    if (unified !== null) return unified;
    // diff 退出码 1 表示存在差异，不是错误
    const result = await this.runner.run("diff", ["-rq", path.join(this.snapRoot, id), this.workspace]);
    if (result.code > 1) throw new Error(`diff failed (${result.code})`);
    return truncateLines(result.stdout);
  }

  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    // 先删工作区再从只读快照建可写快照；删除失败则中止，不做第二步
    await this.must("delete", ["subvolume", "delete", this.workspace]);
    await this.must("snapshot", ["subvolume", "snapshot", path.join(this.snapRoot, id), this.workspace]);
  }

  async delete(id: string): Promise<void> {
    validateSnapshotId(id);
    await this.must("delete", ["subvolume", "delete", path.join(this.snapRoot, id)]);
    await writeCheckpoints(this.metadataPath, (await this.list()).filter((item) => item.id !== id));
  }

  private async must(operation: string, args: string[]): Promise<void> {
    const result = await this.runner.run("btrfs", args);
    if (result.code !== 0) throw new Error(`btrfs ${operation} failed (${result.code})`);
  }
}
