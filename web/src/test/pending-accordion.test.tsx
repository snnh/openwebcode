import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  nextPendingSession, parsePendingCards, PENDING_CHROME_FALLBACK, pendingZoneMaxHeight, pendingCards, pendingCardsStore,
  resolveExpandedId, usePendingAccordion,
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
describe("pendingZoneMaxHeight 与 sessionStorage 反序列化", () => {
  it("未折叠时铺满整个信息流区域：会话区高度扣掉实测 chrome，兜底 120px", () => {
    const zone = (workbenchHeight: number, viewportHeight: number, chromeHeight = 0, mobile = false): number =>
      pendingZoneMaxHeight({ workbenchHeight, viewportHeight, chromeHeight, mobile });
    // chrome 实测：铺满扣掉 chrome 之后的全部空间，不再给消息列表留保底
    expect(zone(1000, 1200, 200)).toBe(800);
    // 明显高于旧的「一半高度 / 留 120px 列表保底 + 180px 预留」口径（旧值 500）
    expect(zone(1000, 1200, 200)).toBeGreaterThan(500 + 180);
    // 视口比会话区矮（移动端软键盘弹出）时按视口算
    expect(zone(1000, 640, 140)).toBe(500);
    // chrome 未量到：用保守预留兜底，避免把 Composer 挤出可视区
    expect(zone(1000, 1200)).toBe(1000 - PENDING_CHROME_FALLBACK);
    // 兜底下限
    for (const [available, vh] of [[0, 0], [200, 800], [400, 900]]) expect(zone(available!, vh!, 300)).toBe(120);
    // 移动端下限更小、chrome 预留更紧
    expect(zone(600, 700, 0, true)).toBe(600 - 150);
    expect(zone(600, 700, 120, true)).toBe(480);
    expect(zone(0, 0, 0, true)).toBe(168);
  });
  it("正常数据按会话读回；坏数据/旧格式按「无记忆」处理（不抛错）", () => {
    expect(parsePendingCards('{"cards":{"s1":{"open":"p2","closed":{"p1":true}}}}')).toEqual({ cards: { s1: { open: "p2", closed: { p1: true } } } });
    for (const raw of [null, "", "not json", "[]", '"s1"', '{"cards":[]}']) expect(parsePendingCards(raw)).toEqual({ cards: {} });
  });
});
