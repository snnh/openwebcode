/**
 * 最近使用的模型列表（localStorage 持久化，最新在前，上限 5 条）。
 * 供 Composer 的 Ctrl+P 模型循环使用；localStorage 不可用时静默降级为内存行为。
 */

const STORAGE_KEY = "owc-recent-models";
const MAX_RECENT = 5;

interface RecentModel {
  provider: string;
  model: string;
}

function isRecentModel(value: unknown): value is RecentModel {
  return typeof value === "object" && value !== null
    && typeof (value as RecentModel).provider === "string"
    && typeof (value as RecentModel).model === "string";
}

function readRecentModels(): RecentModel[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentModel).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function sameModel(a: RecentModel, b: RecentModel): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/** 记录一次模型选择：去重置前、截断到上限，返回更新后的列表。 */
export function recordRecentModel(provider: string, model: string): RecentModel[] {
  const entry: RecentModel = { provider, model };
  const next = [entry, ...readRecentModels().filter((item) => !sameModel(item, entry))].slice(0, MAX_RECENT);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 隐私模式等 localStorage 写入失败：仅本次循环不可用，不影响模型切换本身
  }
  return next;
}

/**
 * 计算 Ctrl+P 循环的下一个模型：列表按最新在前排序，从 current 的下一条取；
 * current 不在列表时从头开始。列表不足 2 条时返回 null（调用方不拦截按键）。
 */
export function nextRecentModel(current: RecentModel): RecentModel | null {
  const list = readRecentModels();
  if (list.length < 2) return null;
  const index = list.findIndex((item) => sameModel(item, current));
  return list[(index + 1) % list.length] ?? null;
}
