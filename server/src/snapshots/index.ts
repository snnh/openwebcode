import path from "node:path";
import type { CoreClientLike } from "../core-client.js";
import type { SessionStore } from "../sessions/session-store.js";
import type { SessionMeta } from "../sessions/types.js";
import type { SnapshotBackend } from "./backend.js";
import { BtrfsBackend } from "./btrfs.js";
import { GitShadowSnapshots } from "./git-shadow.js";
import { ManagedDiskBackend, managedWorkspacePaths } from "./managed-disk.js";
import { OverlayfsBackend } from "./overlayfs.js";
import { createExecFileRunner, probeSnapshotBackend, type CommandRunner } from "./probe.js";
import { RefsBackend } from "./refs.js";
import { ZfsBackend } from "./zfs.js";

export type { Checkpoint, SnapshotBackend, SnapshotCapabilityInfo } from "./backend.js";
export { probeSnapshotBackend, type CommandRunner } from "./probe.js";

export interface SnapshotBackendDeps {
  /** overlayfs 后端与探测需要（core.ping features.overlay + overlay.* 调用）。 */
  core?: CoreClientLike;
  /** 平台覆盖（测试注入用）；缺省 process.platform。 */
  platform?: NodeJS.Platform;
}

/**
 * 解析会话的快照后端：meta.snapshotBackend 已落盘则按名轻量构造，
 * 否则现场探测并把结果写回 meta（zfs 记为 "zfs:<dataset>" 以保留数据集名）。
 */
export async function getSnapshotBackend(sessions: SessionStore, session: SessionMeta, deps: SnapshotBackendDeps = {}): Promise<SnapshotBackend> {
  const sessionRoot = sessions.contextRoot(session.id);
  if (session.snapshotBackend) {
    const backend = constructByName(session.snapshotBackend, session, sessionRoot, createExecFileRunner(), deps.core);
    if (backend) return backend;
  }
  let probed = await probeSnapshotBackend(sessionRoot, session.cwd, {
    runner: createExecFileRunner(),
    ...(deps.core ? { core: deps.core } : {}),
    ...(deps.platform ? { platform: deps.platform } : {}),
  });
  // overlayfs 的正确语义要求创建期挂接（cwd=merged 托管视图）；存量直接会话懒探测到
  // overlayfs 时无法安全切换 cwd，回落 git-shadow 保持检查点语义正确
  if (probed.name === "overlayfs" && session.workspace?.backend !== "overlayfs") {
    probed = new GitShadowSnapshots(sessionRoot, session.cwd);
  }
  try {
    await sessions.updateSnapshotBackend(session.id, probed instanceof ZfsBackend ? `zfs:${probed.dataset}` : probed.name);
  } catch (persistError) { process.stderr.write(`[snapshots] failed to persist probed backend: ${persistError instanceof Error ? persistError.message : String(persistError)}\n`); }
  return probed;
}

function constructByName(stored: string, session: SessionMeta, sessionRoot: string, runner: CommandRunner, core: CoreClientLike | undefined): SnapshotBackend | undefined {
  const separator = stored.indexOf(":");
  const name = separator === -1 ? stored : stored.slice(0, separator);
  const argument = separator === -1 ? "" : stored.slice(separator + 1);
  const workspace = session.cwd;
  switch (name) {
    case "git-shadow": return new GitShadowSnapshots(sessionRoot, workspace);
    case "btrfs": return new BtrfsBackend(workspace, runner);
    case "zfs": return argument ? new ZfsBackend(sessionRoot, workspace, argument, runner) : undefined;
    case "refs": return new RefsBackend(sessionRoot, workspace, runner);
    // 托管工作区（vhdx-chain/qcow2-chain）：创建时预设，免探测；路径按 sessions store 布局推导
    // （sessionRoot = <dataDir>/sessions/<id>，挂载点即会话 cwd）
    case "vhdx-chain":
    case "qcow2-chain": {
      const dataDir = path.dirname(path.dirname(sessionRoot));
      const { workspaceRoot } = managedWorkspacePaths(dataDir, path.basename(sessionRoot));
      return new ManagedDiskBackend({ kind: name === "vhdx-chain" ? "vhdx" : "qcow2", workspaceRoot, mountPoint: workspace, runner });
    }
    // overlayfs：创建期挂接的托管会话预设；lower 取 meta 里的源目录（cwd 是 merged 视图）
    case "overlayfs": {
      const meta = session.workspace;
      if (!core || meta?.mode !== "managed" || meta.backend !== "overlayfs") return undefined;
      return new OverlayfsBackend({ sessionRoot, originCwd: meta.originCwd, core });
    }
    default: return undefined;
  }
}
