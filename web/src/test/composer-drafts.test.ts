import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearComposerState, getAttachments, getDraft, setDraftValue, useAttachments, useDraft,
  type PendingImage,
} from "../composer/drafts";

/** 每个用例使用独立会话 id，避免模块级 store 在用例间串状态。 */
beforeEach(() => {
  window.localStorage.clear();
});

function image(name: string): PendingImage {
  return { mediaType: "image/png", data: name, previewUrl: `data:image/png;base64,${name}` };
}

describe("composer/drafts 草稿", () => {
  it("草稿按会话隔离并镜像 localStorage（写入/空串清除/刷新恢复/损坏容错）", () => {
    setDraftValue("d1", "会话一的内容");
    setDraftValue("d2", "会话二的内容");
    expect(getDraft("d1")).toBe("会话一的内容");
    expect(getDraft("d2")).toBe("会话二的内容");
    setDraftValue("d1", "改写");
    expect(getDraft("d1")).toBe("改写");
    expect(getDraft("d2")).toBe("会话二的内容");

    // 写入时镜像到 localStorage，空串等价清除
    setDraftValue("d3", "持久化我");
    expect(window.localStorage.getItem("owc-draft-d3")).toBe(JSON.stringify("持久化我"));
    setDraftValue("d3", "");
    expect(getDraft("d3")).toBe("");
    expect(window.localStorage.getItem("owc-draft-d3")).toBeNull();

    // 首次访问从 localStorage 镜像恢复（模拟刷新）
    window.localStorage.setItem("owc-draft-d4", JSON.stringify("刷新前的草稿"));
    expect(getDraft("d4")).toBe("刷新前的草稿");

    // localStorage 损坏内容按无草稿处理
    window.localStorage.setItem("owc-draft-d5", "{broken");
    expect(getDraft("d5")).toBe("");
  });

  it("useDraft：返回当前值支持更新；undefined 会话为空且写入静默忽略", () => {
    const { result } = renderHook(() => useDraft("d6"));
    expect(result.current[0]).toBe("");
    act(() => result.current[1]("hook 写入"));
    expect(result.current[0]).toBe("hook 写入");
    expect(getDraft("d6")).toBe("hook 写入");
    expect(window.localStorage.getItem("owc-draft-d6")).toBe(JSON.stringify("hook 写入"));

    const undef = renderHook(() => useDraft(undefined));
    expect(undef.result.current[0]).toBe("");
    act(() => undef.result.current[1]("无处可写"));
    expect(undef.result.current[0]).toBe("");
  });
});

describe("composer/drafts 附件", () => {
  it("附件按会话隔离（仅内存）并支持函数式更新", () => {
    const first = renderHook(() => useAttachments("a1"));
    const second = renderHook(() => useAttachments("a2"));
    act(() => first.result.current[1]([image("one")]));
    expect(first.result.current[0]).toHaveLength(1);
    expect(second.result.current[0]).toHaveLength(0);
    expect(getAttachments("a1")).toHaveLength(1);
    expect(getAttachments("a2")).toHaveLength(0);
    expect(window.localStorage.getItem("owc-draft-a1")).toBeNull();

    const third = renderHook(() => useAttachments("a3"));
    act(() => third.result.current[1]([image("x"), image("y")]));
    act(() => third.result.current[1]((prev) => prev.filter((_, index) => index !== 0)));
    expect(third.result.current[0]).toEqual([image("y")]);
  });
});

describe("composer/drafts clearComposerState", () => {
  it("清空草稿（含 localStorage 镜像）与附件", () => {
    setDraftValue("c1", "待清空");
    const { result } = renderHook(() => useAttachments("c1"));
    act(() => result.current[1]([image("z")]));
    expect(window.localStorage.getItem("owc-draft-c1")).not.toBeNull();

    act(() => clearComposerState("c1"));
    expect(getDraft("c1")).toBe("");
    expect(getAttachments("c1")).toEqual([]);
    expect(result.current[0]).toEqual([]);
    expect(window.localStorage.getItem("owc-draft-c1")).toBeNull();
  });
});
