import { existsSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ManagedWorkspaceMeta } from "../sessions/types.js";
import {
  newSnapshotId,
  truncateLines,
  validateSnapshotId,
  type Checkpoint,
  type SnapshotBackend,
  type SnapshotCapabilityInfo,
} from "./backend.js";
import {
  applyManagedWorkspaceSync,
  createManagedWorkspaceSyncBaseline,
  MANAGED_WORKSPACE_COPY_EXCLUDES,
  ManagedWorkspaceSyncError,
  previewManagedWorkspaceSync,
  type ManagedWorkspaceSyncApplyInput,
  type ManagedWorkspaceSyncApplyResult,
  type ManagedWorkspaceSyncPreview,
} from "./managed-sync.js";
import { createExecFileRunner, type CommandRunner } from "./probe.js";

/** 稀疏基盘大小：20GB */
export const MANAGED_IMAGE_SIZE_BYTES = 20 * 1024 * 1024 * 1024;
/** 链长上限：超过即在 create 后自动合并最老段 */
export const MANAGED_MAX_CHAIN = 32;
/** 复制进托管工作区时按目录名排除（任意深度；参考 git-shadow 的排除思路） */
const COPY_EXCLUDES = MANAGED_WORKSPACE_COPY_EXCLUDES;

export type ManagedBackendKind = "vhdx" | "qcow2";

export interface ManagedBackendCapability {
  backend: ManagedBackendKind;
  available: boolean;
  requiresAdmin: true;
  detail?: string;
}

export interface ManagedWorkspaceCapability {
  platform: string;
  backends: ManagedBackendCapability[];
}

/** chain.json 中的一段：检查点 id ↔ 冻结的盘文件一一对应，parentFile 为其 backing（base 为链尾，parentFile null）。 */
interface ChainEntry {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
  ledger?: unknown;
  file: string;
  parentFile: string | null;
}

/** chain.json：checkpoints 新→旧排列；active 指当前可写叶子及其 backing；device 仅 qcow2（nbd 设备）。 */
interface ChainState {
  active: { file: string; parentFile: string | null };
  device?: string;
  checkpoints: ChainEntry[];
}

/** managed-disk.ps1 的资产路径（与 refs-clone.ps1 同目录约定）。 */
export function managedDiskScriptPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", "managed-disk.ps1");
}

/** 会话的托管工作区路径约定：<dataDir>/workspaces/<id>（镜像+chain.json）与 <dataDir>/mnt/<id>（挂载点）。 */
export function managedWorkspacePaths(dataDir: string, sessionId: string): { workspaceRoot: string; mountPoint: string } {
  return {
    workspaceRoot: path.join(dataDir, "workspaces", sessionId),
    mountPoint: path.join(dataDir, "mnt", sessionId),
  };
}

/** 能力检测：win32 → VHDX（Hyper-V PS 模块 + 当前进程 Hyper-V 访问权）；linux → qcow2（qemu-img + qemu-nbd + 免密 sudo）。REST 与创建流程共用。 */
export async function detectManagedWorkspace(platform: NodeJS.Platform, runner: CommandRunner): Promise<ManagedWorkspaceCapability> {
  if (platform === "win32") {
    const module = await runner.run("powershell", ["-NoProfile", "-Command", "Get-Command New-VHD"]).catch(() => ({ stdout: "", code: 1 }));
    const hasModule = module.code === 0 && module.stdout.trim().length > 0;
    // Get-Command 只能说明 cmdlet 已安装；Get-VMHost 会经 Hyper-V 服务校验当前进程
    // 的有效 token（管理员 / Hyper-V Administrators）。不通过时，创建 VHDX 必然会失败。
    const access = hasModule
      ? await runner.run("powershell", ["-NoProfile", "-Command", "Get-VMHost -ErrorAction Stop | Out-Null"]).catch(() => ({ stdout: "", code: 1 }))
      : { stdout: "", code: 1 };
    const available = hasModule && access.code === 0;
    return {
      platform,
      backends: [{
        backend: "vhdx",
        available,
        requiresAdmin: true,
        detail: available
          ? "Hyper-V PowerShell 模块可用；镜像操作需管理员或 Hyper-V Administrators 组成员身份"
          : !hasModule
            ? "未找到 Hyper-V PowerShell 模块（New-VHD）；需安装/启用 Hyper-V 管理工具"
            : "Hyper-V PowerShell 模块可用，但当前进程无 Hyper-V 管理权限或服务不可访问；请以管理员身份运行，或加入 Hyper-V Administrators 组后重新登录",
      }],
    };
  }
  if (platform === "linux") {
    const missing: string[] = [];
    const img = await runner.run("qemu-img", ["--version"]).catch(() => ({ stdout: "", code: 1 }));
    if (img.code !== 0) missing.push("qemu-img");
    const nbd = await runner.run("qemu-nbd", ["--version"]).catch(() => ({ stdout: "", code: 1 }));
    if (nbd.code !== 0) missing.push("qemu-nbd");
    const sudo = await runner.run("sudo", ["-n", "true"]).catch(() => ({ stdout: "", code: 1 }));
    if (sudo.code !== 0) missing.push("免密 sudo（sudo -n true）");
    const available = missing.length === 0;
    return {
      platform,
      backends: [{
        backend: "qcow2",
        available,
        requiresAdmin: true,
        detail: available
          ? "qemu-img/qemu-nbd 与免密 sudo 可用；nbd 连接、格式化与挂载需 root"
          : `不可用：缺少 ${missing.join("、")}`,
      }],
    };
  }
  return { platform, backends: [] };
}

/** 外部命令失败：错误信息带原始 stderr（缺失时回退 stdout）。 */
function commandError(label: string, result: { stdout: string; code: number; stderr?: string }): Error {
  const output = (result.stderr ?? "").trim() || result.stdout.trim();
  return new Error(`${label} failed (${result.code})${output ? `: ${output}` : ""}`);
}

function ensureOk(label: string, result: { stdout: string; code: number; stderr?: string }): void {
  if (result.code !== 0) throw commandError(label, result);
}

/** 调 managed-disk.ps1（离散参数经 execFile 传递，无需手工引号）；非零退出带 stderr 抛错。 */
async function runScript(runner: CommandRunner, mode: string, args: string[]): Promise<void> {
  const result = await runner.run(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", managedDiskScriptPath(), "-Mode", mode, ...args],
    { timeoutMs: 600_000 },
  );
  ensureOk(`managed-disk.ps1 ${mode}`, result);
}

/**
 * 托管工作区快照后端：会话项目目录活在稀疏镜像盘挂载点上，
 * 快照 = 差分链新叶子（旧叶子冻结为检查点），回滚 = 从任一检查点盘文件拉新分支叶子。
 * 检查点本体永不覆写；delete 不支持逐段删除（链长超 32 自动合并最老段）。
 */
export class ManagedDiskBackend implements SnapshotBackend {
  readonly name: string;
  private readonly statePath: string;

  constructor(
    private readonly options: { kind: ManagedBackendKind; workspaceRoot: string; mountPoint: string; runner: CommandRunner },
  ) {
    this.name = `${options.kind}-chain`;
    this.statePath = path.join(options.workspaceRoot, "chain.json");
  }

  private get kind(): ManagedBackendKind { return this.options.kind; }
  private get workspaceRoot(): string { return this.options.workspaceRoot; }
  private get mountPoint(): string { return this.options.mountPoint; }
  private get runner(): CommandRunner { return this.options.runner; }

  async initialize(): Promise<void> {
    await mkdir(this.workspaceRoot, { recursive: true });
    if (!existsSync(this.statePath)) await this.writeState(this.defaultState());
  }

  async capability(): Promise<SnapshotCapabilityInfo> {
    const detail = this.kind === "vhdx"
      ? "VHDX 差分链（Hyper-V）：需管理员或 Hyper-V Administrators 组；不支持删除单个检查点，链长超 32 自动合并最老段"
      : "qcow2 差分链（qemu-nbd）：需 root/免密 sudo；不支持删除单个检查点，链长超 32 自动合并最老段";
    return { backend: this.name, costHint: "instant", requiresAdmin: true, detail };
  }

  async create(label: string, messageCount: number, ledger?: unknown): Promise<Checkpoint> {
    await this.initialize();
    const state = await this.readState();
    const id = newSnapshotId();
    const child = path.join(this.workspaceRoot, `leaf-${id}.${this.kind}`);
    // 以当前叶子为 backing 建新差分盘并换叶；旧叶子（= 检查点载体）自此冻结
    await this.createDiff(state.active.file, child);
    await this.swapMount(state.active.file, child, state.device);
    const entry: ChainEntry = {
      id,
      label,
      createdAt: new Date().toISOString(),
      messageCount,
      ...(ledger === undefined ? {} : { ledger }),
      file: state.active.file,
      parentFile: state.active.parentFile,
    };
    state.checkpoints.unshift(entry);
    state.active = { file: child, parentFile: entry.file };
    if (state.checkpoints.length > MANAGED_MAX_CHAIN) await this.mergeOldest(state);
    await this.writeState(state);
    const checkpoint: Checkpoint = { id, label, createdAt: entry.createdAt, messageCount, ...(ledger === undefined ? {} : { ledger }) };
    return checkpoint;
  }

  async list(): Promise<Checkpoint[]> {
    await this.initialize();
    const state = await this.readState();
    return state.checkpoints.map(({ id, label, createdAt, messageCount, ledger }) => ({
      id,
      label,
      createdAt,
      messageCount,
      ...(ledger === undefined ? {} : { ledger }),
    }));
  }

  /** 镜像盘无廉价内容 diff：如实报告检查点在链中的位置、载体文件大小与前后段关系。 */
  async diff(id: string): Promise<string> {
    validateSnapshotId(id);
    await this.initialize();
    const state = await this.readState();
    const index = state.checkpoints.findIndex((item) => item.id === id);
    if (index === -1) throw new Error("Checkpoint not found");
    const entry = state.checkpoints[index]!;
    const size = await stat(entry.file).then((info) => `${info.size} 字节（稀疏文件，实际占用更小）`).catch(() => "文件缺失");
    const lines = [
      `检查点 ${entry.id}（${entry.label}），创建于 ${entry.createdAt}，消息数 ${entry.messageCount}`,
      `链中位置：第 ${index + 1} / 共 ${state.checkpoints.length} 段（新→旧）`,
      `载体文件：${entry.file}（${size}）`,
      `父段：${entry.parentFile ?? "无（基盘，链尾）"}`,
      index === 0 ? "该检查点是链上最新段。" : `前一（更新）段：${state.checkpoints[index - 1]!.file}`,
      index === state.checkpoints.length - 1 ? "该检查点是链上最老段。" : `后一（更老）段：${state.checkpoints[index + 1]!.file}`,
      "镜像盘快照无廉价内容 diff：差异以整段为单位；恢复 = 以该检查点盘文件为 backing 拉新分支叶子。",
    ];
    return truncateLines(lines.join("\n"));
  }

  async restore(id: string): Promise<void> {
    validateSnapshotId(id);
    await this.initialize();
    const state = await this.readState();
    const entry = state.checkpoints.find((item) => item.id === id);
    if (!entry) throw new Error("Checkpoint not found");
    // 分支语义：从检查点盘文件拉新差分叶子并换叶，检查点本体永不覆写
    const child = path.join(this.workspaceRoot, `leaf-${newSnapshotId()}.${this.kind}`);
    const previousLeaf = state.active.file;
    await this.createDiff(entry.file, child);
    await this.swapMount(previousLeaf, child, state.device);
    state.active = { file: child, parentFile: entry.file };
    // 被回滚抛弃的旧叶子不是任何检查点的载体（active 恒为无子新叶），删除避免磁盘泄漏
    if (!state.checkpoints.some((item) => item.file === previousLeaf)) {
      await rm(previousLeaf, { force: true }).catch(() => undefined);
    }
    await this.writeState(state);
  }

  async delete(id: string): Promise<void> {
    validateSnapshotId(id);
    throw new Error("managed-disk 链式后端不支持删除单个检查点；链长超 32 自动合并最老段");
  }

  /**
   * 合并最老段：最老检查点（链尾）的恢复点被并入次老段。
   * 序列（qcow2）：commit 次老段（写入其 backing=最老段文件）→ 若有第三段 rebase -u -b 最老段文件 → 删次老段文件。
   * 序列（vhdx）：Merge-VHD 次老段（并入其 parent）→ 若有第三段 Set-VHD -ParentPath 最老段文件 -IgnoreIdentifierMismatch → 删次老段文件。
   * chain.json：移除最老检查点条目，次老检查点接管最老段的文件（成为新链尾）。
   */
  private async mergeOldest(state: ChainState): Promise<void> {
    const oldest = state.checkpoints.at(-1);
    const next = state.checkpoints.at(-2);
    if (!oldest || !next) return;
    const third = state.checkpoints.at(-3);
    if (this.kind === "qcow2") {
      ensureOk("qemu-img commit", await this.runner.run("qemu-img", ["commit", next.file], { timeoutMs: 600_000 }));
      if (third) {
        ensureOk("qemu-img rebase", await this.runner.run("qemu-img", ["rebase", "-u", "-b", oldest.file, third.file], { timeoutMs: 600_000 }));
        third.parentFile = oldest.file;
      }
    } else {
      await runScript(this.runner, "merge", ["-Path", next.file]);
      if (third) {
        await runScript(this.runner, "reparent", ["-Path", third.file, "-ParentPath", oldest.file]);
        third.parentFile = oldest.file;
      }
    }
    await rm(next.file, { force: true });
    next.file = oldest.file;
    next.parentFile = oldest.parentFile;
    state.checkpoints.pop();
  }

  private async createDiff(parent: string, child: string): Promise<void> {
    if (this.kind === "qcow2") {
      ensureOk("qemu-img create", await this.runner.run("qemu-img", ["create", "-f", "qcow2", "-b", parent, child], { timeoutMs: 60_000 }));
    } else {
      await runScript(this.runner, "new-diff", ["-Parent", parent, "-Child", child]);
    }
  }

  /** 换叶：卸载当前叶子并挂载新叶子（qcow2 复用同一 nbd 设备重连新文件）。 */
  private async swapMount(oldFile: string, newFile: string, device: string | undefined): Promise<void> {
    if (this.kind === "vhdx") {
      await runScript(this.runner, "swap", ["-OldImage", oldFile, "-NewImage", newFile, "-MountPoint", this.mountPoint]);
      return;
    }
    const nbd = device ?? "/dev/nbd0";
    ensureOk("umount", await this.runner.run("sudo", ["umount", this.mountPoint], { timeoutMs: 60_000 }));
    ensureOk("qemu-nbd -d", await this.runner.run("sudo", ["qemu-nbd", "-d", nbd], { timeoutMs: 60_000 }));
    ensureOk("qemu-nbd -c", await this.runner.run("sudo", ["qemu-nbd", "-c", nbd, newFile], { timeoutMs: 60_000 }));
    ensureOk("mount", await this.runner.run("sudo", ["mount", nbd, this.mountPoint], { timeoutMs: 60_000 }));
  }

  private defaultState(): ChainState {
    return {
      active: { file: path.join(this.workspaceRoot, `base.${this.kind}`), parentFile: null },
      ...(this.kind === "qcow2" ? { device: "/dev/nbd0" } : {}),
      checkpoints: [],
    };
  }

  private async readState(): Promise<ChainState> {
    const value = JSON.parse(await readFile(this.statePath, "utf8")) as ChainState;
    if (!value || typeof value !== "object" || !Array.isArray(value.checkpoints) || !value.active?.file) {
      throw new Error(`chain.json 损坏：${this.statePath}`);
    }
    return value;
  }

  private async writeState(state: ChainState): Promise<void> {
    await writeFile(this.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
}

export interface ManagedProvisionInput {
  sessionId: string;
  originCwd: string;
  backend: ManagedBackendKind;
}

export interface ManagedProvisionResult {
  backend: ManagedBackendKind;
  image: string;
  mountPoint: string;
}

/** REST 注入面：fake 实现供测试替换外部命令。 */
export interface ManagedWorkspaceLike {
  capability(): Promise<ManagedWorkspaceCapability>;
  provision(input: ManagedProvisionInput): Promise<ManagedProvisionResult>;
  previewSync(session: { id: string; workspace?: ManagedWorkspaceMeta }): Promise<ManagedWorkspaceSyncPreview>;
  applySync(session: { id: string; workspace?: ManagedWorkspaceMeta }, input: ManagedWorkspaceSyncApplyInput): Promise<ManagedWorkspaceSyncApplyResult>;
  teardown(session: { id: string; workspace?: ManagedWorkspaceMeta }): Promise<void>;
}

/** 托管工作区管理器：建盘/格式化/挂载/复制源目录/卸载清理，以及启动时的孤儿挂载扫描。 */
export class ManagedWorkspaceManager implements ManagedWorkspaceLike {
  private readonly runner: CommandRunner;
  private readonly platform: NodeJS.Platform;
  private readonly syncingSessions = new Set<string>();

  constructor(private readonly options: { dataDir: string; runner?: CommandRunner; platform?: NodeJS.Platform }) {
    this.runner = options.runner ?? createExecFileRunner();
    this.platform = options.platform ?? process.platform;
  }

  private get dataDir(): string { return this.options.dataDir; }

  capability(): Promise<ManagedWorkspaceCapability> {
    return detectManagedWorkspace(this.platform, this.runner);
  }

  async previewSync(session: { id: string; workspace?: ManagedWorkspaceMeta }): Promise<ManagedWorkspaceSyncPreview> {
    return previewManagedWorkspaceSync(this.syncRoots(session));
  }

  async applySync(session: { id: string; workspace?: ManagedWorkspaceMeta }, input: ManagedWorkspaceSyncApplyInput): Promise<ManagedWorkspaceSyncApplyResult> {
    if (this.syncingSessions.has(session.id)) throw new ManagedWorkspaceSyncError("sync_in_progress", "A managed workspace sync is already in progress for this session");
    this.syncingSessions.add(session.id);
    try {
      return await applyManagedWorkspaceSync(this.syncRoots(session), input);
    } finally {
      this.syncingSessions.delete(session.id);
    }
  }

  /** 建 20GB 稀疏基盘 → 格式化挂载 → 复制源 cwd 内容（排除 node_modules/.owc/.openwebcode）。失败清理半成品。 */
  async provision(input: ManagedProvisionInput): Promise<ManagedProvisionResult> {
    const { workspaceRoot, mountPoint } = managedWorkspacePaths(this.dataDir, input.sessionId);
    const image = path.join(workspaceRoot, `base.${input.backend}`);
    await mkdir(workspaceRoot, { recursive: true });
    await mkdir(mountPoint, { recursive: true });
    try {
      if (input.backend === "vhdx") await this.provisionVhdx(image, mountPoint);
      else await this.provisionQcow2(image, mountPoint);
      await cp(input.originCwd, mountPoint, {
        recursive: true,
        filter: (source) => !COPY_EXCLUDES.has(path.basename(source)),
      });
      // 基线取复制后的挂载树，确保三方比较的共同版本就是实际隔离副本的起点；sidecar 位于私有 workspaceRoot。
      await createManagedWorkspaceSyncBaseline({ sessionId: input.sessionId, workspaceRoot, mountPoint, originCwd: input.originCwd });
      return { backend: input.backend, image, mountPoint };
    } catch (error) {
      await this.unmountBestEffort(input.sessionId).catch(() => undefined);
      await rm(workspaceRoot, { recursive: true, force: true }).catch(() => undefined);
      await rm(mountPoint, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** 删除 managed 会话：先卸载再删镜像目录与挂载点。 */
  async teardown(session: { id: string; workspace?: ManagedWorkspaceMeta }): Promise<void> {
    const { workspaceRoot, mountPoint } = managedWorkspacePaths(this.dataDir, session.id);
    await this.unmountBestEffort(session.id, session.workspace);
    await rm(workspaceRoot, { recursive: true, force: true });
    await rm(session.workspace?.mountPoint ?? mountPoint, { recursive: true, force: true });
  }

  /**
   * 启动孤儿清理：扫 <dataDir>/mnt/*。
   * meta 不存在 → 按 workspaces/<id>/ 下镜像类型卸载该挂载并删空目录；
   * meta 在但镜像不在 → 只删空目录；两者俱在（正常）跳过。单目录失败不阻断。
   */
  async sweepOrphans(): Promise<void> {
    const mntRoot = path.join(this.dataDir, "mnt");
    let entries;
    try {
      entries = await readdir(mntRoot, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const id = entry.name;
      try {
        const hasMeta = existsSync(path.join(this.dataDir, "sessions", id, "meta.json"));
        const hasImage = (await this.detectImageBackend(path.join(this.dataDir, "workspaces", id))) !== undefined;
        if (hasMeta && hasImage) continue;
        if (!hasMeta && hasImage) await this.unmountBestEffort(id);
        await rmdir(path.join(mntRoot, id)).catch(() => undefined);
      } catch { /* 继续下一个 */ }
    }
  }

  private async provisionVhdx(image: string, mountPoint: string): Promise<void> {
    await runScript(this.runner, "new-base", ["-Image", image, "-MountPoint", mountPoint, "-SizeBytes", String(MANAGED_IMAGE_SIZE_BYTES)]);
    await this.writeInitialState(image, undefined);
  }

  private async provisionQcow2(image: string, mountPoint: string): Promise<void> {
    let device: string | undefined;
    let mounted = false;
    try {
      ensureOk("qemu-img create", await this.runner.run("qemu-img", ["create", "-f", "qcow2", image, "20G"], { timeoutMs: 60_000 }));
      // 探测空闲 nbd 设备：/dev/nbd0..15 轮询，连接成功即用
      for (let index = 0; index < 16; index += 1) {
        const candidate = `/dev/nbd${index}`;
        const connected = await this.runner.run("sudo", ["qemu-nbd", "-c", candidate, image], { timeoutMs: 60_000 });
        if (connected.code === 0) {
          device = candidate;
          break;
        }
      }
      if (!device) throw new Error("qemu-nbd 连接失败：/dev/nbd0..15 均不可用（nbd 内核模块未加载或设备耗尽）");
      ensureOk("mkfs.ext4", await this.runner.run("sudo", ["mkfs.ext4", device], { timeoutMs: 600_000 }));
      ensureOk("mount", await this.runner.run("sudo", ["mount", device, mountPoint], { timeoutMs: 60_000 }));
      mounted = true;
      await this.writeInitialState(image, device);
    } catch (error) {
      if (mounted) await this.runner.run("sudo", ["umount", mountPoint]).catch(() => undefined);
      if (device) await this.runner.run("sudo", ["qemu-nbd", "-d", device]).catch(() => undefined);
      throw error;
    }
  }

  private async writeInitialState(image: string, device: string | undefined): Promise<void> {
    const state: ChainState = {
      active: { file: image, parentFile: null },
      ...(device === undefined ? {} : { device }),
      checkpoints: [],
    };
    await writeFile(path.join(path.dirname(image), "chain.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }

  /** 尽力卸载：镜像类型按 meta.workspace 或 workspaces/<id>/ 下实际镜像推断；命令失败忽略。 */
  private async unmountBestEffort(sessionId: string, workspace?: ManagedWorkspaceMeta): Promise<void> {
    const { workspaceRoot, mountPoint } = managedWorkspacePaths(this.dataDir, sessionId);
    const backend = workspace?.backend ?? (await this.detectImageBackend(workspaceRoot));
    if (backend === "vhdx") {
      const image = workspace?.image ?? path.join(workspaceRoot, "base.vhdx");
      await this.runner.run("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", managedDiskScriptPath(), "-Mode", "dismount", "-Image", image], { timeoutMs: 60_000 }).catch(() => undefined);
      return;
    }
    if (backend === "qcow2") {
      const device = await this.readDevice(workspaceRoot) ?? "/dev/nbd0";
      await this.runner.run("sudo", ["umount", workspace?.mountPoint ?? mountPoint], { timeoutMs: 60_000 }).catch(() => undefined);
      await this.runner.run("sudo", ["qemu-nbd", "-d", device], { timeoutMs: 60_000 }).catch(() => undefined);
    }
  }

  private async detectImageBackend(workspaceRoot: string): Promise<ManagedBackendKind | undefined> {
    if (existsSync(path.join(workspaceRoot, "base.vhdx"))) return "vhdx";
    if (existsSync(path.join(workspaceRoot, "base.qcow2"))) return "qcow2";
    return undefined;
  }

  private async readDevice(workspaceRoot: string): Promise<string | undefined> {
    try {
      const state = JSON.parse(await readFile(path.join(workspaceRoot, "chain.json"), "utf8")) as ChainState;
      return typeof state.device === "string" ? state.device : undefined;
    } catch {
      return undefined;
    }
  }

  /** 同步的目标与 sidecar 均从服务端 dataDir/session id 推导，绝不信任可导入的 mountPoint/image 元数据。 */
  private syncRoots(session: { id: string; workspace?: ManagedWorkspaceMeta }): { sessionId: string; workspaceRoot: string; mountPoint: string; originCwd: string } {
    const workspace = session.workspace;
    if (!workspace || workspace.mode !== "managed") throw new ManagedWorkspaceSyncError("unsafe_path", "Session does not use a managed workspace");
    const derived = managedWorkspacePaths(this.dataDir, session.id);
    const workspaceRoot = path.resolve(derived.workspaceRoot);
    const mountPoint = path.resolve(derived.mountPoint);
    if (path.resolve(workspace.mountPoint) !== mountPoint) throw new ManagedWorkspaceSyncError("unsafe_path", "Managed workspace metadata mount point does not match this server");
    if (!existsSync(path.join(workspaceRoot, `base.${workspace.backend}`))) throw new ManagedWorkspaceSyncError("unsafe_path", "Managed workspace image is not owned by this server");
    return { sessionId: session.id, workspaceRoot, mountPoint, originCwd: workspace.originCwd };
  }
}
