// ChatSessionList 搜索：按标题大小写不敏感过滤，保持日期分组。
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatSessionList } from "../ChatSessionList";
import type { ChatSessionMeta } from "../types";

function makeSession(id: string, title: string): ChatSessionMeta {
  return {
    id,
    title,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: new Date().toISOString(),
  } as ChatSessionMeta;
}

describe("ChatSessionList 搜索", () => {
  it("输入查询按标题过滤（大小写不敏感），清空恢复全量", () => {
    render(
      <ChatSessionList
        sessions={[makeSession("s1", "重构登录模块"), makeSession("s2", "Debug API Gateway"), makeSession("s3", "周报润色")]}
        onSelect={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );
    const search = screen.getByRole("searchbox", { name: "搜索对话" });
    fireEvent.change(search, { target: { value: "api" } });
    expect(screen.queryByText("重构登录模块")).toBeNull();
    expect(screen.getByText("Debug API Gateway")).toBeTruthy();
    expect(screen.queryByText("周报润色")).toBeNull();
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getByText("重构登录模块")).toBeTruthy();
    expect(screen.getByText("周报润色")).toBeTruthy();
  });

  it("无匹配时显示空态提示，全部会话为空时保持原有空态", () => {
    const { rerender } = render(
      <ChatSessionList sessions={[makeSession("s1", "重构登录模块")]} onSelect={vi.fn()} onRefresh={vi.fn()} />,
    );
    fireEvent.change(screen.getByRole("searchbox", { name: "搜索对话" }), { target: { value: "不存在" } });
    expect(screen.getByText("没有匹配的对话")).toBeTruthy();
    rerender(<ChatSessionList sessions={[]} onSelect={vi.fn()} onRefresh={vi.fn()} />);
    expect(screen.getByText("暂无对话")).toBeTruthy();
  });
});
