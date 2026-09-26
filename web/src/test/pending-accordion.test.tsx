import { beforeEach, describe, expect, it } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  nextPendingSession, parsePendingCards, PENDING_CHROME_RESERVE, PENDING_LIST_FLOOR, pendingBodyMaxHeight, pendingCards, pendingCardsStore,
  resolveExpandedId, usePendingAccordion,
} from "../chat/cards/pending-accordion";

beforeEach(() => {
  window.sessionStorage.clear();
  pendingCardsStore.set({ cards: {} });
});

const ids = ["p1", "p2", "p3"];

describe("待回答卡手风琴（resolveExpandedId / nextPendingSession）", () => {
  it("无记忆时展开队列最早的一张", () => {
    expect(resolveExpandedId(undefined, ids)).toBe("p1");
  });

  it("显式展开优先；该卡被收起过后回落到最早的未收起卡", () => {
    expect(resolveExpandedId({ open: "p2", closed: {} }, ids)).toBe("p2");
    expect(resolveExpandedId({ open: "p2", closed: { p2: true } }, ids)).toBe("p1");
    // 显式展开的卡已不在待回答列表里（已答/取消）：回落到最早的未收起卡
    expect(resolveExpandedId({ open: "gone", closed: {} }, ids)).toBe("p1");
  });

  it("全部收起过 → 不展开任何卡", () => {
    expect(resolveExpandedId({ closed: { p1: true, p2: true, p3: true } }, ids)).toBeUndefined();
  });

  it("展开某张卡：只展开它并清掉它的收起标记", () => {
    expect(nextPendingSession({ closed: { p2: true } }, ids, "p2")).toEqual({ open: "p2", closed: {} });
  });

  it("收起当前展开卡：整批收起（手风琴语义下不会自动弹开下一张）", () => {
    expect(nextPendingSession({ open: "p1", closed: {} }, ids, "p1")).toEqual({
      closed: { p1: true, p2: true, p3: true },
    });
    const collapsed = nextPendingSession({ open: "p1", closed: {} }, ids, "p1");
    expect(resolveExpandedId(collapsed, ids)).toBeUndefined();
  });

  it("收起整批后新卡出现：新卡默认展开（从未被收起过的 id）", () => {
    const collapsed = nextPendingSession({ open: "p1", closed: {} }, ids, "p1");
    expect(resolveExpandedId(collapsed, [...ids, "p4"])).toBe("p4");
  });
});

describe("usePendingAccordion", () => {
  it("按会话记忆展开状态，并写入 sessionStorage（切标签/刷新不丢）", () => {
    const { result, rerender } = renderHook(({ list }) => usePendingAccordion("s1", list), { initialProps: { list: ids } });
    expect(result.current.expandedId).toBe("p1");

    act(() => result.current.toggle("p2"));
    expect(result.current.expandedId).toBe("p2");
    expect(JSON.parse(window.sessionStorage.getItem("owc-pending-cards") ?? "{}")).toEqual({
      cards: { s1: { open: "p2", closed: {} } },
    });

    // 换一个会话实例（模拟切标签/刷新后重新挂载）：记忆仍在
    rerender({ list: ids });
    expect(result.current.expandedId).toBe("p2");
  });

  it("收起后整批为摘要态；问答结束后该卡消失不影响其余卡", () => {
    const { result } = renderHook(() => usePendingAccordion("s1", ids));
    act(() => result.current.toggle("p1"));
    expect(result.current.expandedId).toBeUndefined();
    expect(result.current.isExpanded("p1")).toBe(false);
  });

  it("forgetSession 清掉会话记忆（会话删除）", () => {
    const { result } = renderHook(() => usePendingAccordion("s1", ids));
    act(() => result.current.toggle("p3"));
    expect(result.current.expandedId).toBe("p3");
    pendingCards.forgetSession("s1");
    expect(pendingCardsStore.get().cards).toEqual({});
  });
});

describe("pendingBodyMaxHeight", () => {
  it("取「可用高度一半 / 60vh / 扣掉列表保底与顶栏输入栏」三者最小值", () => {
    // 高视口：1000×0.5 = 500 最小
    expect(pendingBodyMaxHeight(1000, 1200)).toBe(500);
    // 矮视口：60vh 主导（600×0.6 = 360）
    expect(pendingBodyMaxHeight(1000, 600)).toBe(360);
    // 可用高度不够高时：「扣掉列表保底与顶栏输入栏」主导（560-120-180 = 260 < 560/2）
    expect(pendingBodyMaxHeight(560, 2000)).toBe(560 - PENDING_LIST_FLOOR - PENDING_CHROME_RESERVE);
  });

  it("兜底 120px：可用高度不足以容纳保底与顶栏时也不会把卡片压成 0 高", () => {
    expect(pendingBodyMaxHeight(0, 0)).toBe(120);
    expect(pendingBodyMaxHeight(200, 800)).toBe(120);
    expect(pendingBodyMaxHeight(400, 900)).toBe(120);
  });
});

describe("sessionStorage 反序列化", () => {
  it("正常数据按会话读回", () => {
    expect(parsePendingCards('{"cards":{"s1":{"open":"p2","closed":{"p1":true}}}}')).toEqual({
      cards: { s1: { open: "p2", closed: { p1: true } } },
    });
  });

  it("坏数据/旧格式按「无记忆」处理（不抛错）", () => {
    for (const raw of [null, "", "not json", "[]", '"s1"', '{"cards":[]}']) {
      expect(parsePendingCards(raw)).toEqual({ cards: {} });
    }
    expect(resolveExpandedId(undefined, ids)).toBe("p1");
  });
});
