import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  nextPendingSession, parsePendingCards, pendingBodyMaxHeight, pendingCards, pendingCardsStore,
  PENDING_CHROME_RESERVE, PENDING_LIST_FLOOR, resolveExpandedId, usePendingAccordion,
} from "../chat/cards/pending-accordion";
beforeEach(() => { window.sessionStorage.clear(); pendingCardsStore.set({ cards: {} }); });
const ids = ["p1", "p2", "p3"];
describe("待回答卡手风琴（resolveExpandedId / nextPendingSession）", () => {
  it("无记忆展开最早一张；显式展开优先，被收起/已消失则回落最早的未收起卡；全部收起过则不展开", () => {
    expect(resolveExpandedId(undefined, ids)).toBe("p1"); expect(resolveExpandedId({ open: "p2", closed: {} }, ids)).toBe("p2");
    expect(resolveExpandedId({ open: "p2", closed: { p2: true } }, ids)).toBe("p1");
    // 显式展开的卡已不在待回答列表里（已答/取消）：回落最早的未收起卡
    expect(resolveExpandedId({ open: "gone", closed: {} }, ids)).toBe("p1");
    expect(resolveExpandedId({ closed: { p1: true, p2: true, p3: true } }, ids)).toBeUndefined();
  });
  it("展开某张卡只展开它并清掉收起标记；收起当前展开卡则整批收起且新卡默认展开", () => {
    expect(nextPendingSession({ closed: { p2: true } }, ids, "p2")).toEqual({ open: "p2", closed: {} });
    const collapsed = nextPendingSession({ open: "p1", closed: {} }, ids, "p1");
    expect(collapsed).toEqual({ closed: { p1: true, p2: true, p3: true } }); expect(resolveExpandedId(collapsed, ids)).toBeUndefined();
    expect(resolveExpandedId(collapsed, [...ids, "p4"])).toBe("p4");
  });
});
describe("usePendingAccordion", () => {
  it("按会话记忆展开状态并写入 sessionStorage；整批收起后为摘要态；forgetSession 清掉会话记忆", () => {
    const { result } = renderHook(({ list }) => usePendingAccordion("s1", list), { initialProps: { list: ids } });
    expect(result.current.expandedId).toBe("p1");
    act(() => result.current.toggle("p2")); expect(result.current.expandedId).toBe("p2");
    expect(JSON.parse(window.sessionStorage.getItem("owc-pending-cards") ?? "{}")).toEqual({ cards: { s1: { open: "p2", closed: {} } } });
    act(() => result.current.toggle("p2"));
    expect(result.current.expandedId).toBeUndefined(); expect(result.current.isExpanded("p2")).toBe(false);
    pendingCards.forgetSession("s1"); expect(pendingCardsStore.get().cards).toEqual({});
  });
});
describe("pendingBodyMaxHeight 与 sessionStorage 反序列化", () => {
  it("取「可用高度一半 / 60vh / 扣掉列表保底与顶栏输入栏」三者最小值，兜底 120px", () => {
    expect(pendingBodyMaxHeight(1000, 1200)).toBe(500); expect(pendingBodyMaxHeight(1000, 600)).toBe(360);
    expect(pendingBodyMaxHeight(560, 2000)).toBe(560 - PENDING_LIST_FLOOR - PENDING_CHROME_RESERVE);
    for (const [available, vh] of [[0, 0], [200, 800], [400, 900]]) expect(pendingBodyMaxHeight(available!, vh!)).toBe(120);
  });
  it("正常数据按会话读回；坏数据/旧格式按「无记忆」处理（不抛错）", () => {
    expect(parsePendingCards('{"cards":{"s1":{"open":"p2","closed":{"p1":true}}}}')).toEqual({ cards: { s1: { open: "p2", closed: { p1: true } } } });
    for (const raw of [null, "", "not json", "[]", '"s1"', '{"cards":[]}']) expect(parsePendingCards(raw)).toEqual({ cards: {} });
  });
});
