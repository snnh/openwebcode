export type SandboxCapability = "advisory" | "partial" | "enforced";
/** landlock/bubblewrap 为 POSIX 专用真值；存量 Linux 会话 meta 可能是 jobobject，显示时按 landlock 处理。 */
export type SandboxMode = "appcontainer" | "wsb" | "jobobject" | "landlock" | "bubblewrap" | "off";
/** 沙盒网络策略：filtered = 经代理过滤出网（仅 Windows；Linux 创建/更新会被 server 400）。 */
export type SandboxNetwork = "allow" | "deny" | "filtered";
export type ShellBackend = "default" | "pwsh" | "bash" | "cmd";
/** Python 运行环境：global = 本机环境；uv-workspace/uv-config = uv 临时虚拟环境（工作区/配置目录）。 */
export type PythonEnv = "global" | "uv-workspace" | "uv-config";
/** Node 运行环境：global = 本机环境；project = 工作区 node_modules/.bin 前置 PATH；fnm/nvm = 版本管理器激活。 */
export type NodeEnv = "global" | "project" | "fnm" | "nvm";

export interface SandboxCapabilities {
  /** server 运行平台（process.platform）；web 端平台相关 UI 统一以此为准。 */
  platform: string;
  appcontainer: boolean;
  jobobject: boolean;
  off: boolean;
  wsb: { available: boolean; reason?: string };
  /** Bind Link 目录绑定能力（Windows 11 24H2+；创建绑定还需管理员权限）。 */
  bindLink: { available: boolean; reason?: string };
  /** bubblewrap 可用性（POSIX；旧 core 二进制不上报时 server 按不可用返回）。 */
  bwrap?: { available: boolean; reason?: string };
}

/** GET /api/sessions/:id/sandbox-status：最近一次 configureSession 时 core 上报的执行级别；无记录返回 {}。 */
export interface SessionSandboxStatus {
  sandboxCapability?: SandboxCapability;
  sandboxReason?: string;
}

/** 托管工作区平台能力（GET /api/managed-workspace/capability） */
export interface ManagedWorkspaceCapability {
  platform: string;
  backends: Array<{ backend: "vhdx" | "qcow2"; available: boolean; requiresAdmin: boolean; detail?: string }>;
}

/** 会话的隔离视图工作区元数据；源目录只会在用户确认手动同步时被写回。 */
export interface ManagedWorkspace {
  mode: "managed";
  /** vhdx/qcow2 = 稀疏镜像盘挂载点；overlayfs = Linux merged 视图（lower=源目录只读） */
  backend: "vhdx" | "qcow2" | "overlayfs";
  originCwd: string;
  image: string;
  mountPoint: string;
}

/** 单个工作区条目的可比较状态；不向浏览器暴露绝对路径。 */
interface ManagedWorkspaceSyncNode {
  kind: "file" | "directory" | "symlink" | "other";
  sha256?: string;
  size?: number;
  mode?: number;
}

type ManagedWorkspaceSyncAction = "create" | "update" | "delete" | "none" | "conflict" | "unsupported";

/** 基线、源目录和镜像盘三方比较得到的一项变更。 */
export interface ManagedWorkspaceSyncChange {
  path: string;
  action: ManagedWorkspaceSyncAction;
  reason: string;
  baseline: ManagedWorkspaceSyncNode | null;
  origin: ManagedWorkspaceSyncNode | null;
  managed: ManagedWorkspaceSyncNode | null;
  originChanged: boolean;
  managedChanged: boolean;
}

export interface ManagedWorkspaceSyncPreview {
  baseline: { available: boolean; reason?: "missing" | "invalid"; createdAt?: string; version?: number };
  /** 预览为空基线时仍可由显式覆盖流程提供校验指纹。 */
  fingerprint: string | null;
  changes: ManagedWorkspaceSyncChange[];
  summary: { create: number; update: number; delete: number; conflicts: number; unsupported: number; unchanged: number };
}

export interface ManagedWorkspaceSyncResult {
  applied: Array<{ path: string; action: "create" | "update" | "delete" | "overwrite" }>;
  conflicts: ManagedWorkspaceSyncChange[];
  unsupported: ManagedWorkspaceSyncChange[];
  nextPreview: ManagedWorkspaceSyncPreview;
}
