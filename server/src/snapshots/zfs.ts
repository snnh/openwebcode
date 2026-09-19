import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
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
    /** 会话 deny 路径（绝对）：整卷回退不覆盖/不删除这些文件，见 restore。 */
    private readonly denyPaths: readonly string[] = [],
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

  /**
   * 回退 = 从自动挂载的只读快照目录复制回写（原实现「先清空工作区再复制」在复制失败时
   * 数据全丢）。可回滚流程：
   * 1) 先验证快照源可读（.zfs/snapshot/<id> 是目录），不通过就不动当前工作区；
   * 2) 暂存当前 deny 文件（整卷替换不得覆盖/删除 .env 等）；
   * 3) 当前内容改名进工作区内的暂存目录（同一数据集内 rename，不跨设备、不搬字节），
   *    再从快照目录复制回写；
   * 4) 复制失败 → 清掉复制进来的半成品并把暂存内容改回原位后抛错（工作区数据仍在）；
   * 5) 成功 → 删除暂存目录（best-effort），写回暂存的 deny 文件。
   */
  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    if (!(await this.list()).some((item) => item.id === id)) throw new Error("Checkpoint not found");
    const snapshotDir = path.join(this.workspace, ".zfs", "snapshot", id);
    const source = await stat(snapshotDir).catch(() => undefined);
    if (!source?.isDirectory()) throw new Error(`zfs checkpoint ${id} is not accessible at ${snapshotDir}`);
    const preserved = await captureDenyFiles(this.workspace, this.denyPaths);
    const stashName = `.owc-restore-${randomUUID()}`;
    const stash = path.join(this.workspace, stashName);
    await mkdir(stash);
    const moved: string[] = [];
    try {
      for (const entry of await readdir(this.workspace)) {
        if (entry === ".zfs" || entry === stashName) continue;
        await rename(path.join(this.workspace, entry), path.join(stash, entry));
        moved.push(entry);
      }
      await this.copyFromSnapshot(snapshotDir);
    } catch (error) {
      const rollbackError = await this.rollbackRestore(stashName, stash, moved);
      if (rollbackError) {
        throw new Error(`zfs restore failed (${errorMessage(error)}) and the previous workspace is left at ${stash} (rollback failed: ${rollbackError})`);
      }
      throw error;
    }
    await rm(stash, { recursive: true, force: true }).catch((error: unknown) => {
      // 暂存旧树删不掉不影响回退结果（新工作区已就位）：只记日志，不误报失败
      process.stderr.write(`[snapshots] zfs restore succeeded but the previous workspace could not be deleted at ${stash}: ${errorMessage(error)}\n`);
    });
    await restoreDenyFiles(preserved);
  }

  async delete(id: string): Promise<void> {
    validateSnapshotId(id);
    await this.must("destroy", ["destroy", `${this.dataset}@${id}`]);
    await writeCheckpoints(this.metadataPath, (await this.list()).filter((item) => item.id !== id));
  }

  /** 从只读快照目录复制回写工作区（重建步骤；独立方法便于聚焦测试注入失败）。 */
  protected async copyFromSnapshot(snapshotDir: string): Promise<void> {
    await cp(snapshotDir, this.workspace, { recursive: true });
  }

  /** 回滚：清掉复制进来的半成品，把暂存内容改回原位；返回错误描述（成功返回 undefined）。 */
  private async rollbackRestore(stashName: string, stash: string, moved: readonly string[]): Promise<string | undefined> {
    const failures: string[] = [];
    for (const entry of await readdir(this.workspace).catch(() => [] as string[])) {
      if (entry === ".zfs" || entry === stashName) continue;
      await rm(path.join(this.workspace, entry), { recursive: true, force: true })
        .catch((error: unknown) => failures.push(`remove ${entry}: ${errorMessage(error)}`));
    }
    for (const entry of moved) {
      await rename(path.join(stash, entry), path.join(this.workspace, entry))
        .catch((error: unknown) => failures.push(`restore ${entry}: ${errorMessage(error)}`));
    }
    if (failures.length === 0) {
      await rm(stash, { recursive: true, force: true }).catch(() => undefined);
      return undefined;
    }
    return failures.join("; ");
  }

  private async must(operation: string, args: string[]): Promise<void> {
    const result = await this.runner.run("zfs", args);
    if (result.code !== 0) throw new Error(`zfs ${operation} failed (${result.code})`);
  }
}
