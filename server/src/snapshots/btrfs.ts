import { randomUUID } from "node:crypto";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { errorMessage } from "../error-utils.js";
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
import { captureDenyFiles, restoreDenyFiles } from "./deny-preserve.js";
import type { CommandRunner } from "./probe.js";
import { diffTrees, type SnapshotDiffExcludes } from "./tree-diff.js";

/** Btrfs 只读子卷快照。 */
export class BtrfsBackend implements SnapshotBackend {
  readonly name = "btrfs";
  private readonly snapRoot: string;
  private readonly metadataPath: string;

  constructor(
    private readonly workspace: string,
    private readonly runner: CommandRunner,
    private readonly excludes: SnapshotDiffExcludes = { excludePrefixes: [], excludeGlobs: [] },
    /** 会话 deny 路径（绝对）：整卷回退不覆盖/不删除这些文件，见 restore。 */
    private readonly denyPaths: readonly string[] = [],
  ) {
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

  /**
   * 回退 = 用只读快照重建工作区子卷（原实现「先删工作区再重建」在重建失败时数据全丢）。
   * 可回滚流程：
   * 1) 先验证快照源本身可用（btrfs subvolume show）——快照损坏/被删时在动工作区之前就失败；
   * 2) 暂存当前 deny 文件（整卷替换不得覆盖/删除 .env 等）；
   * 3) 旧工作区子卷改名到同父目录的临时名（btrfs 的 rename 约束是「同父目录/同一父子卷」，
   *    这里两个路径同父，故可行；rename 是元数据操作，不搬数据）；
   * 4) 从只读快照重建到工作区路径；失败则把旧子卷改名回原位（工作区数据仍在）后抛错；
   * 5) 成功后删除旧子卷（best-effort：新工作区已就位，删不掉只是多留一份旧树，记 stderr）。
   */
  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    const snapshotPath = path.join(this.snapRoot, id);
    await this.must("subvolume show", ["subvolume", "show", snapshotPath]);
    const preserved = await captureDenyFiles(this.workspace, this.denyPaths);
    const previous = path.join(path.dirname(this.workspace), `${path.basename(this.workspace)}.owc-restore-${randomUUID()}`);
    await rename(this.workspace, previous);
    try {
      await this.must("snapshot", ["subvolume", "snapshot", snapshotPath, this.workspace]);
    } catch (error) {
      try {
        await rename(previous, this.workspace);
      } catch (rollbackError) {
        throw new Error(`btrfs restore failed (${errorMessage(error)}) and the previous workspace is left at ${previous} (rollback failed: ${errorMessage(rollbackError)})`);
      }
      throw error;
    }
    try {
      await this.must("subvolume delete", ["subvolume", "delete", previous]);
    } catch (error) {
      process.stderr.write(`[snapshots] btrfs restore succeeded but the previous workspace could not be deleted at ${previous}: ${errorMessage(error)}\n`);
    }
    await restoreDenyFiles(preserved);
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
