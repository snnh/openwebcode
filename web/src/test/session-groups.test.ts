import { beforeEach, describe, expect, it } from "vitest";
import type { Session } from "../lib/contracts";
import {
  filterSessions, groupNames, groupSessions, orderWithinGroup, readCollapsedGroups,
  SESSION_GROUPS_COLLAPSED_KEY, splitArchived,
} from "../workbench/session-groups";
const makeSession = (id: string, overrides: Partial<Session> = {}): Session =>
  ({ id, title: `会话 ${id}`, cwd: `D:/work/${id}`, provider: "anthropic", model: "claude", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", ...overrides });
beforeEach(() => { window.localStorage.clear(); });
describe("会话分组（纯函数）", () => {
  it("组内排序置顶优先（其余保持服务端顺序）；拆分归档默认列表只看未归档", () => {
    const list = [makeSession("a"), makeSession("b", { pinned: true }), makeSession("c"), makeSession("d", { pinned: true })];
    expect(orderWithinGroup(list).map((session) => session.id)).toEqual(["b", "d", "a", "c"]);
    const { active, archived } = splitArchived([makeSession("a"), makeSession("b", { archived: true }), makeSession("c")]);
    expect(active.map((session) => session.id)).toEqual(["a", "c"]); expect(archived.map((session) => session.id)).toEqual(["b"]);
  });
  it("分组：具名组按最近活动降序，未分组恒在最后；组内同样置顶优先且组名 trim 后归并；空列表返回空", () => {
    const list = [
      makeSession("a", { group: "前端", updatedAt: "2026-01-01T00:00:00Z" }), makeSession("b", { group: "后端", updatedAt: "2026-03-01T00:00:00Z" }),
      makeSession("c", { group: "前端", updatedAt: "2026-02-01T00:00:00Z", pinned: true }), makeSession("d"), makeSession("e", { group: " 前端  " }),
    ];
    const { groups, ungrouped } = groupSessions(list);
    expect(groups.map((group) => group.name)).toEqual(["后端", "前端"]);
    expect(groups[1]!.sessions.map((session) => session.id)).toEqual(["c", "a", "e"]);
    expect(ungrouped.map((session) => session.id)).toEqual(["d"]); expect(groupNames(list)).toEqual(["后端", "前端"]);
    expect(groupSessions([])).toEqual({ groups: [], ungrouped: [] });
  });
  it("搜索命中标题/provider/model/组名；折叠记忆默认只收起已归档区，坏数据回落默认", () => {
    const list = [makeSession("a", { title: "修 bug", group: "前端" }), makeSession("b", { title: "写文档", provider: "openai" })];
    expect(filterSessions(list, "").length).toBe(2); expect(filterSessions(list, "前端").map((session) => session.id)).toEqual(["a"]);
    expect(filterSessions(list, "DOC").length).toBe(0); expect(filterSessions(list, "openai").map((session) => session.id)).toEqual(["b"]);
    expect(readCollapsedGroups()).toEqual(["archived"]);
    window.localStorage.setItem(SESSION_GROUPS_COLLAPSED_KEY, "not json"); expect(readCollapsedGroups()).toEqual(["archived"]);
    // 有记忆时以记忆为准（非字符串项过滤掉）
    window.localStorage.setItem(SESSION_GROUPS_COLLAPSED_KEY, JSON.stringify(["archived", 7])); expect(readCollapsedGroups()).toEqual(["archived"]);
    window.localStorage.setItem(SESSION_GROUPS_COLLAPSED_KEY, JSON.stringify(["前端"])); expect(readCollapsedGroups()).toEqual(["前端"]);
  });
});
