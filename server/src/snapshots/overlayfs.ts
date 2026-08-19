import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import {
  CoreRpcError,
  type CoreClientLike,
  type OverlayMountRequest,
  type OverlayMountResult,
  type OverlayRestoreRequest,
  type OverlayUnmountRequest,
} from "../core-client.js";
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

/** overlay.restore 在 core 侧存在 running job 时的稳定冲突错误码（协议约定）。 */
const OVERLAY_RESTORE_BUSY_CODE = -32005;

/** overlay.* 的最小 core 依赖面（CoreClientLike 子集；测试注入 fake）。 */
export type OverlayfsCore = Pick<CoreClientLike, "ping" | "overlayMount" | "overlayCheckpoint" | "overlayRestore" | "overlayUnmount">;

interface OverlayfsPaths {
  stateRoot: string;
  upper: string;
  work: string;
  merged: string;
  checkpointsDir: string;
  checkpointsFile: string;
}

/** 布局：stateRoot = <sessionRoot>/overlay，其下 upper/ work/ merged/ checkpoints/<id>/，元数据 checkpoints.json。 */
export function overlayfsPaths(sessionRoot: string): OverlayfsPaths {
  const stateRoot = path.join(sessionRoot, "overlay");
  return {
    stateRoot,
    upper: path.join(stateRoot, "upper"),
    work: path.join(stateRoot, "work"),
    merged: path.join(stateRoot, "merged"),
    checkpointsDir: path.join(stateRoot, "checkpoints"),
    checkpointsFile: path.join(stateRoot, "checkpoints.json"),
  };
}

/** core ping 的 features.overlay.supported 探测；任何异常都按不可用处理。 */
export async function probeOverlayfsSupport(core: OverlayfsCore): Promise<boolean> {
  try {
    const info = await core.ping();
    return info.features?.overlay?.supported === true;
  } catch {
    return false;
  }
}

function requireOverlayMethod<K extends "overlayMount" | "overlayCheckpoint" | "overlayRestore" | "overlayUnmount">(
  core: OverlayfsCore,
  method: K,
): NonNullable<OverlayfsCore[K]> {
  const fn = core[method];
  if (!fn) throw new Error("当前 core 不支持 overlay.*（需要 Linux 且 features.overlay.supported 为 true）");
  return fn as NonNullable<OverlayfsCore[K]>;
}

/** 建目录并挂载 overlay（lower=源工作区）；overlay.mount 幂等，重复调用安全。 */
export async function mountOverlayfsWorkspace(
  core: OverlayfsCore,
  sessionRoot: string,
  originCwd: string,
): Promise<{ paths: OverlayfsPaths; method: "kernel" | "fuse" }> {
  const mount = requireOverlayMethod(core, "overlayMount");
  const paths = overlayfsPaths(sessionRoot);
  await mkdir(paths.checkpointsDir, { recursive: true });
  const request: OverlayMountRequest = {
    stateRoot: paths.stateRoot,
    lower: path.resolve(originCwd),
    upper: paths.upper,
    work: paths.work,
    merged: paths.merged,
  };
  const result: OverlayMountResult = await mount(request);
  return { paths, method: result.method };
}

/** 卸载 merged（core 侧未挂载幂等）；无 overlay 能力的 core 直接视为成功。 */
export async function unmountOverlayfsWorkspace(core: OverlayfsCore, sessionRoot: string): Promise<void> {
  if (!core.overlayUnmount) return;
  const paths = overlayfsPaths(sessionRoot);
  const request: OverlayUnmountRequest = { stateRoot: paths.stateRoot, merged: paths.merged };
  await core.overlayUnmount(request);
}

interface UpperEntry {
  size: number;
  mtimeMs: number;
  kind: "file" | "directory" | "other";
  /** overlay 上位层删除标记：fuse 的 .wh.<name> 文件或内核的 0/0 字符设备。 */
  whiteout: boolean;
}

/** 递归收集 upper 层（或检查点副本）的内容清单；whiteout 归一到被删路径上。 */
async function collectUpperEntries(root: string): Promise<Map<string, UpperEntry>> {
  const entries = new Map<string, UpperEntry>();
  const walk = async (relative: string): Promise<void> => {
    const absolute = relative ? path.join(root, relative) : root;
    let children;
    try {
      children = await readdir(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      const rel = relative ? `${relative}/${child.name}` : child.name;
      // fuse-overlayfs 删除标记：.wh.<name>；.wh..wh..opq 是 opaque 目录标记，忽略
      if (child.name.startsWith(".wh.")) {
        if (child.name !== ".wh..wh..opq") {
          entries.set(`${relative ? `${relative}/` : ""}${child.name.slice(4)}`, { size: 0, mtimeMs: 0, kind: "other", whiteout: true });
        }
        continue;
      }
      const info = await lstat(path.join(absolute, child.name)).catch(() => undefined);
      if (!info) continue;
      // 内核 overlayfs 删除标记：rdev 0/0 的字符设备
      if (info.isCharacterDevice?.() === true) {
        entries.set(rel, { size: 0, mtimeMs: 0, kind: "other", whiteout: true });
        continue;
      }
      if (child.isDirectory()) {
        entries.set(rel, { size: 0, mtimeMs: Math.trunc(info.mtimeMs), kind: "directory", whiteout: false });
        await walk(rel);
      } else {
        entries.set(rel, {
          size: info.size,
          mtimeMs: Math.trunc(info.mtimeMs),
          kind: info.isFile() ? "file" : "other",
          whiteout: false,
        });
      }
    }
  };
  await walk("");
  return entries;
}

/**
 * overlayfs 快照后端（Linux）：会话在 merged 视图工作，源目录作为只读 lower。
 * 检查点 = core overlay.checkpoint 把 upper 层 reflink 复制到 checkpoints/<id>；
 * 回滚 = overlay.restore 以检查点副本重建 upper。变更只在用户确认后经
 * managed-sync 回源（与托管工作区同一 plumbing）。
 */
export class OverlayfsBackend implements SnapshotBackend {
  readonly name = "overlayfs";
  private readonly paths: OverlayfsPaths;
  private method: "kernel" | "fuse" | undefined;

  constructor(private readonly options: { sessionRoot: string; originCwd: string; core: OverlayfsCore }) {
    this.paths = overlayfsPaths(options.sessionRoot);
  }

  private get core(): OverlayfsCore { return this.options.core; }
  private get originCwd(): string { return this.options.originCwd; }

  async initialize(): Promise<void> {
    const mounted = await mountOverlayfsWorkspace(this.core, this.options.sessionRoot, this.originCwd);
    this.method = mounted.method;
  }

  async capability(): Promise<SnapshotCapabilityInfo> {
    await this.initialize();
    const mount = this.method === "kernel" ? "内核 overlayfs 挂载" : "fuse-overlayfs 用户态挂载";
    return {
      backend: "overlayfs",
      costHint: "linear",
      requiresAdmin: false,
      detail: `${mount}；源目录只读，需手动同步回源`,
    };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const checkpoint = requireOverlayMethod(this.core, "overlayCheckpoint");
    const id = newSnapshotId();
    const dest = path.join(this.paths.checkpointsDir, id);
    await checkpoint({ stateRoot: this.paths.stateRoot, upper: this.paths.upper, dest });
    const entry: Checkpoint = {
      id,
      label,
      createdAt: new Date().toISOString(),
      messageCount,
      ...(ledger === undefined ? {} : { ledger }),
    };
    const checkpoints = await readCheckpoints(this.paths.checkpointsFile);
    checkpoints.unshift(entry);
    await writeCheckpoints(this.paths.checkpointsFile, checkpoints);
    return entry;
  }

  async list(): Promise<Checkpoint[]> {
    return readCheckpoints(this.paths.checkpointsFile);
  }

  /** 无廉价 CoW diff：对比检查点 upper 副本与当前 upper 层，产出变更清单 + stat 摘要。 */
  async diff(id: string): Promise<string> {
    validateSnapshotId(id);
    const checkpoints = await this.list();
    const checkpoint = checkpoints.find((item) => item.id === id);
    if (!checkpoint) throw new Error("Checkpoint not found");
    const [snapshotEntries, currentEntries] = await Promise.all([
      collectUpperEntries(path.join(this.paths.checkpointsDir, id)),
      collectUpperEntries(this.paths.upper),
    ]);
    const added: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];
    const paths = new Set([...snapshotEntries.keys(), ...currentEntries.keys()]);
    for (const rel of [...paths].sort((left, right) => left.localeCompare(right))) {
      const before = snapshotEntries.get(rel);
      const after = currentEntries.get(rel);
      if (after?.whiteout) {
        // 当前为删除标记：检查点时刻尚未删除（无标记）才算一次删除
        if (!before?.whiteout) deleted.push(rel);
        continue;
      }
      if (before?.whiteout) {
        if (after) added.push(rel);
        continue;
      }
      if (!before && after) added.push(rel);
      else if (before && !after) deleted.push(rel);
      else if (before && after && (before.kind !== after.kind || before.size !== after.size || before.mtimeMs !== after.mtimeMs)) {
        modified.push(rel);
      }
    }
    const format = (marker: string, items: string[]): string[] =>
      items.map((rel) => {
        const entry = currentEntries.get(rel) ?? snapshotEntries.get(rel);
        const size = entry && entry.kind === "file" ? `（${entry.size} 字节）` : "";
        return `${marker} ${rel}${size}`;
      });
    const lines = [
      `检查点 ${checkpoint.id}（${checkpoint.label}）以来的工作区变更：新增 ${added.length}，修改 ${modified.length}，删除 ${deleted.length}`,
      ...format("A", added),
      ...format("M", modified),
      ...format("D", deleted),
    ];
    return truncateLines(lines.join("\n"));
  }

  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    const checkpoints = await this.list();
    if (!checkpoints.some((item) => item.id === id)) throw new Error("Checkpoint not found");
    await this.initialize();
    const restore = requireOverlayMethod(this.core, "overlayRestore");
    const request: OverlayRestoreRequest = {
      stateRoot: this.paths.stateRoot,
      lower: path.resolve(this.originCwd),
      upper: this.paths.upper,
      work: this.paths.work,
      merged: this.paths.merged,
      sourceUpper: path.join(this.paths.checkpointsDir, id),
    };
    try {
      await restore(request);
    } catch (error) {
      if (error instanceof CoreRpcError && error.code === OVERLAY_RESTORE_BUSY_CODE) {
        throw new Error("存在运行中的任务，请先停止再回滚");
      }
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    validateSnapshotId(id);
    const checkpoints = await this.list();
    if (!checkpoints.some((item) => item.id === id)) throw new Error("Checkpoint not found");
    await rm(path.join(this.paths.checkpointsDir, id), { recursive: true, force: true });
    await writeCheckpoints(this.paths.checkpointsFile, checkpoints.filter((item) => item.id !== id));
  }
}
