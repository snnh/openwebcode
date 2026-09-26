/**
 * 常驻缓存的空闲逐出策略（进程内唯一口径）。
 *
 * 背景：会话整表缓存、消息文件字节索引、工作区索引这些「打开过的对象」在过去只按条数 / LRU
 * 逐出，进程空转时内存也不会回落（实测 5 分钟驻留堆 679MB）。这里提供统一的「非活跃多久后
 * 释放」时长，由设置项 sessionCacheIdleMinutes 热更新（0 = 不逐出，保持长跑常驻）。
 *
 * 用法：缓存条目记 lastAccess（写入或命中时刷新），逐出时机有两处——
 * 1) 任意一次缓存操作时的惰性清扫（不依赖定时器，测试友好）；
 * 2) index.ts 里 60s 一次、unref 的定时清扫（进程空转时也能回落）。
 */
export const DEFAULT_SESSION_CACHE_IDLE_MINUTES = 10;
/** 上限：24 小时（超过按不逐出处理更快收敛，但保留可配置语义） */
export const MAX_SESSION_CACHE_IDLE_MINUTES = 1440;

let idleTtlMs = DEFAULT_SESSION_CACHE_IDLE_MINUTES * 60_000;

/** 设置项热生效入口（分钟；0 或负数 = 不逐出）。 */
export function setSessionCacheIdleMinutes(minutes: number): void {
  idleTtlMs = Number.isFinite(minutes) && minutes > 0 ? Math.min(minutes, MAX_SESSION_CACHE_IDLE_MINUTES) * 60_000 : 0;
}

/** 当前空闲阈值（毫秒）；0 = 不逐出。 */
export function sessionCacheIdleTtlMs(): number {
  return idleTtlMs;
}

/** 测试用：恢复默认值。 */
export function resetSessionCacheIdleMinutes(): void {
  setSessionCacheIdleMinutes(DEFAULT_SESSION_CACHE_IDLE_MINUTES);
}

/** 该条目是否已空闲过期（ttl 为 0 时恒 false）。 */
export function isCacheEntryIdle(lastAccessMs: number, now: number = Date.now()): boolean {
  return idleTtlMs > 0 && now - lastAccessMs >= idleTtlMs;
}
