/**
 * 检查点改写操作的 per-session 互斥（所有后端，不只托管会话）。
 *
 * 为什么需要：`acquireManagedWorkspaceExclusive` 对非托管会话是 no-op。git-shadow
 * 等后端并发执行同一会话的检查点时，会撞 git index.lock，而 `checkpoints.json`
 * 是「读整表 → push → 写回」的读改写，并发下会丢条目。
 * 本锁把同一会话的快照改写操作（create/restore/delete）串行化。
 *
 * 与托管闸门的关系：两层锁互补，互不替代——托管会话先取 `acquireManagedWorkspaceExclusive`
 * （保持既有 VHDX/qcow2 语义与 409 文案不变），再取本锁；非托管会话的托管闸门是 no-op，
 * 只由本锁覆盖。
 *
 * 进程内锁：快照操作由本进程独占管理自己的工作区与元数据；跨进程并发不在支持范围
 * （服务端本就单实例持有这些目录）。
 */
const held = new Set<string>();
/**
 * 正在执行 pty.open 的会话：终端从「通过快照锁检查」到「pty 真正登记」之间有
 * await 窗口。快照锁必须把这批 pending 终端也视为占用，否则换层/卸载会与正在
 * 打开的终端 cwd 竞态。
 */
const openingTerminals = new Set<string>();
/**
 * 正在改动消息/工作区的普通请求（shell、编辑器保存、checkout、retry、clear、
 * compact、上传、删除）。快照锁必须避开这些请求，否则快照可能读到半写文件或
 * 在 restore 后又被并发追加/改写。
 */
const activeMutations = new Map<string, number>();

/** 当前会话是否持有快照改写锁（终端 WS 打开前据此拒绝，避免换层/卸载竞态）。 */
export function isSnapshotSessionLocked(sessionId: string): boolean {
  return held.has(sessionId);
}

/** 会话是否有终端正在 pty.open 中（尚未登记到 core 的 ptySessions）。 */
export function isTerminalOpening(sessionId: string): boolean {
  return openingTerminals.has(sessionId);
}

/** 当前是否有普通消息/工作区变更正在执行（用于 409 文案与快照锁互斥）。 */
export function isSessionMutationActive(sessionId: string): boolean {
  return (activeMutations.get(sessionId) ?? 0) > 0;
}

/**
 * 标记一次普通会话变更。快照持锁或已有另一个变更时返回 undefined；否则登记并
 * 在释放函数中撤销。必须在真正写消息/工作区之前同步获取，不能放在 await 之后。
 *
 * 采用排他语义（而不是计数）：shell、编辑器保存、checkout、retry、clear、compact、
 * 上传、删除本来就应互斥；排他能避免 compact 与 shell 同时改账本/工作区。
 */
export function beginSessionMutation(sessionId: string): (() => void) | undefined {
  if (held.has(sessionId) || isSessionMutationActive(sessionId)) return undefined;
  activeMutations.set(sessionId, 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeMutations.delete(sessionId);
  };
}

/**
 * 预留一次终端打开：必须在 await `core.openPty` 之前同步调用。
 * 返回释放函数；快照锁已被占用或同一会话已有 pending 打开时返回 undefined。
 */
export function beginTerminalOpen(sessionId: string): (() => void) | undefined {
  if (held.has(sessionId) || openingTerminals.has(sessionId)) return undefined;
  openingTerminals.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openingTerminals.delete(sessionId);
  };
}

/** 尝试获取会话的快照改写锁；已被占用（或被 pending 终端占用）返回 undefined。 */
export function acquireSnapshotSessionLock(sessionId: string): (() => void) | undefined {
  if (held.has(sessionId) || openingTerminals.has(sessionId) || isSessionMutationActive(sessionId)) return undefined;
  held.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(sessionId);
  };
}
