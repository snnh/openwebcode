// ChatModeView 空态建议：每屏 3 条，「换一批」按步长确定性轮转。
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatModeView } from "../ChatModeView";

function mockFetchEmpty(): void {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body: unknown = url.includes("/models") ? [] : [];
    return { ok: true, status: 200, json: async () => body } as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("空态建议轮换", () => {
  it("默认展示前三条；换一批切到后三条，再换一次回到首批", async () => {
    mockFetchEmpty();
    render(<ChatModeView />);
    // 首批
    expect(await screen.findByText("生成图片")).toBeTruthy();
    expect(screen.getByText("撰写或编辑")).toBeTruthy();
    expect(screen.getByText("搜索网页")).toBeTruthy();
    expect(screen.queryByText("写点代码")).toBeNull();
    // 换一批 → 第二批
    fireEvent.click(screen.getByRole("button", { name: "换一批建议" }));
    expect(screen.queryByText("生成图片")).toBeNull();
    expect(screen.getByText("写点代码")).toBeTruthy();
    expect(screen.getByText("总结要点")).toBeTruthy();
    expect(screen.getByText("制定计划")).toBeTruthy();
    // 再换 → 回到首批
    fireEvent.click(screen.getByRole("button", { name: "换一批建议" }));
    expect(screen.getByText("生成图片")).toBeTruthy();
    expect(screen.queryByText("写点代码")).toBeNull();
  });
});
