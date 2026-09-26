/**
 * 会话列表的组织规则（纯函数，便于单测）：手工标签组、归档分区、组内排序。
 *
 * 语义（与 help/usage.md「会话组织」一致）：
 * - 一个会话属于一个组（`session.group`，存服务端 meta）；没有 group 的进「未分组」区。
 * - 组顺序按组内最近活动时间降序（最近用过的组排前面），未分组恒在最后。
 * - 组内顺序：置顶优先，其余保持服务端顺序（updatedAt 降序；稳定排序）。
 * - 归档会话单独进「已归档」区，不参与分组；未归档会话里也不会出现它们。
 */
import type { Session } from "../lib/contracts";
import { compareText } from "../lib/collator.js";

/** 组内排序：置顶优先，其余保持服务端顺序（稳定） */
export function orderWithinGroup(sessions: Session[]): Session[] {
  return [...sessions].sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false));
}

/** 最近活动时间（ISO 字符串比较即可，服务端统一写 ISO） */
function lastActivity(sessions: Session[]): string {
  return sessions.reduce((latest, session) => (session.updatedAt > latest ? session.updatedAt : latest), "");
}

/** 拆分归档：默认列表只看未归档，归档的进单独一区 */
export function splitArchived(sessions: Session[]): { active: Session[]; archived: Session[] } {
  const active: Session[] = [];
  const archived: Session[] = [];
  for (const session of sessions) (session.archived === true ? archived : active).push(session);
  return { active, archived };
}

/** 已有分组名（去重，按最近活动降序） */
export function groupNames(sessions: Session[]): string[] {
  return groupSessions(sessions).groups.map((group) => group.name!);
}

/** 分组：具名组（最近活动降序）+ 未分组（恒在最后，无会话时返回空数组） */
export function groupSessions(sessions: Session[]): { groups: Array<{ name: string; sessions: Session[] }>; ungrouped: Session[] } {
  const buckets = new Map<string, Session[]>();
  const ungrouped: Session[] = [];
  for (const session of sessions) {
    const name = session.group?.trim();
    if (!name) {
      ungrouped.push(session);
      continue;
    }
    const bucket = buckets.get(name);
    if (bucket) bucket.push(session);
    else buckets.set(name, [session]);
  }
  const groups = [...buckets.entries()]
    .map(([name, list]) => ({ name, sessions: orderWithinGroup(list), activity: lastActivity(list) }))
    .sort((a, b) => (a.activity === b.activity ? compareText(a.name, b.name) : b.activity.localeCompare(a.activity)))
    .map(({ name, sessions: list }) => ({ name, sessions: list }));
  return { groups, ungrouped: orderWithinGroup(ungrouped) };
}

/** 搜索过滤：标题 / provider / model / 组名 都能命中 */
export function filterSessions(sessions: Session[], keyword: string): Session[] {
  const needle = keyword.trim().toLowerCase();
  if (!needle) return sessions;
  return sessions.filter((session) =>
    `${session.title} ${session.provider} ${session.model} ${session.group ?? ""}`.toLowerCase().includes(needle));
}

/** 折叠记忆（localStorage）：默认只有「已归档」区是收起的 */
export const SESSION_GROUPS_COLLAPSED_KEY = "owc-session-groups-collapsed";

export function readCollapsedGroups(): string[] {
  try {
    const raw = window.localStorage.getItem(SESSION_GROUPS_COLLAPSED_KEY);
    // 无记忆时默认只收起「已归档」区（归档是低频回看内容，不该占据默认视野）
    if (!raw) return ["archived"];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : ["archived"];
  } catch {
    return ["archived"];
  }
}
