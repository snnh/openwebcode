import type { SessionStore } from "../sessions/session-store.js";
import type { SessionMeta } from "../sessions/types.js";
import type { SnapshotBackend } from "./backend.js";
import { BtrfsBackend } from "./btrfs.js";
import { GitShadowSnapshots } from "./git-shadow.js";
import { createExecFileRunner, probeSnapshotBackend, type CommandRunner } from "./probe.js";
import { RefsBackend } from "./refs.js";
import { ZfsBackend } from "./zfs.js";

export type { Checkpoint, SnapshotBackend, SnapshotCapabilityInfo } from "./backend.js";
export { probeSnapshotBackend, type CommandRunner } from "./probe.js";

/**
 * 解析会话的快照后端：meta.snapshotBackend 已落盘则按名轻量构造，
 * 否则现场探测并把结果写回 meta（zfs 记为 "zfs:<dataset>" 以保留数据集名）。
 */
export async function getSnapshotBackend(sessions: SessionStore, session: SessionMeta): Promise<SnapshotBackend> {
  const sessionRoot = sessions.contextRoot(session.id);
  if (session.snapshotBackend) {
    const backend = constructByName(session.snapshotBackend, sessionRoot, session.cwd, createExecFileRunner());
    if (backend) return backend;
  }
  const probed = await probeSnapshotBackend(sessionRoot, session.cwd, { runner: createExecFileRunner() });
  try {
    await sessions.updateSnapshotBackend(session.id, probed instanceof ZfsBackend ? `zfs:${probed.dataset}` : probed.name);
  } catch { /* 落盘失败不影响本次使用 */ }
  return probed;
}

function constructByName(stored: string, sessionRoot: string, workspace: string, runner: CommandRunner): SnapshotBackend | undefined {
  const separator = stored.indexOf(":");
  const name = separator === -1 ? stored : stored.slice(0, separator);
  const argument = separator === -1 ? "" : stored.slice(separator + 1);
  switch (name) {
    case "git-shadow": return new GitShadowSnapshots(sessionRoot, workspace);
    case "btrfs": return new BtrfsBackend(workspace, runner);
    case "zfs": return argument ? new ZfsBackend(sessionRoot, workspace, argument, runner) : undefined;
    case "refs": return new RefsBackend(sessionRoot, workspace, runner);
    default: return undefined;
  }
}
