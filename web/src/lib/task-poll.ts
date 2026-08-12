/**
 * 后台任务查询的轮询间隔：有运行中任务或弹层打开时 5s；空闲 30s 兜底。
 * 即时性由 WS 事件保证（task.started / task.finished invalidate 任务查询），
 * 轮询只作事件缺口（断连重连间隙）的兜底——空闲会话不再 5s 盲轮询。
 */
export const TASKS_POLL_ACTIVE_MS = 5_000;
export const TASKS_POLL_IDLE_MS = 30_000;

export function tasksPollInterval(hasRunning: boolean, open: boolean): number {
  return hasRunning || open ? TASKS_POLL_ACTIVE_MS : TASKS_POLL_IDLE_MS;
}
