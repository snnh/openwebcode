/**
 * 检查点改写操作的 per-session 互斥（所有后端，不只托管会话）。
 *
 * 为什么需要：`acquireManagedWorkspaceExclusive` 对非托管会话是 no-op。git-shadow
 * 等后端并发执行同一会话的检查点时会撞 git index.lock（并发 `git add`/`commit`），
 * 而 `checkpoints.json` 是「读整表 → push → 写回」的读改写，并发下会丢条目。
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

/** 尝试获取会话的快照改写锁；已被占用返回 undefined（调用方回 409）。返回值幂等释放。 */
export function acquireSnapshotSessionLock(sessionId: string): (() => void) | undefined {
  if (held.has(sessionId)) return undefined;
  held.add(sessionId);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.delete(sessionId);
  };
}
