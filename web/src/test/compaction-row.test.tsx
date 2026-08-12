import { fireEvent, render } from "@testing-library/react";
import * as axeCore from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompactionRow } from "../chat/cards/CompactionRow";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import { live, liveStore } from "../app/live-store";
import type { CompactionMarker } from "../lib/compaction";

// Markdown 走懒加载实现，测试换桩同步渲染
vi.mock("../components/MarkdownImpl", () => ({
  MarkdownBlock: ({ children }: { children: string }) => <div data-testid="md-block">{children}</div>,
}));

function makeChatActions(overrides: Partial<ChatActions> = {}): ChatActions {
  return {
    sessionId: "s1",
    running: false,
    onNotice: vi.fn(),
    onOpenDiff: vi.fn(),
    onSendToAgent: vi.fn(),
    onEditMessage: vi.fn(),
    onRegenerate: vi.fn(),
    onFork: vi.fn(),
    ...overrides,
  };
}

function renderRow(marker: CompactionMarker) {
  return render(
    <ChatActionsContext.Provider value={makeChatActions()}>
      <CompactionRow marker={marker} />
    </ChatActionsContext.Provider>,
  );
}

function marker(overrides: Partial<CompactionMarker>): CompactionMarker {
  return {
    id: "compaction:2026-08-01T00:00:00.000Z",
    uptoIndex: 12,
    mode: "overview",
    forced: false,
    createdAt: "2026-08-01T00:00:00.000Z",
    status: "settled",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  liveStore.set({ subagents: {}, activities: {}, compactions: {} });
});

describe("CompactionRow", () => {
  it("运行中：spinner + 模式标注 + 强制徽标", () => {
    const { getByRole, getByText } = renderRow(marker({ id: "compaction:live", uptoIndex: -1, status: "running", forced: true, mode: "vault" }));
    expect(getByRole("status")).toBeTruthy();
    expect(getByText(/正在压缩上下文/)).toBeTruthy();
    expect(getByText(/档案库/)).toBeTruthy();
    expect(getByText("强制 85%")).toBeTruthy();
  });

  it("沉降：徽标 + 被替换条数与 token 估算；无摘要不可展开", () => {
    const { getByText, getByRole } = renderRow(marker({ replacedTokens: 1532 }));
    expect(getByText("上下文已压缩")).toBeTruthy();
    expect(getByText("手动")).toBeTruthy();
    expect(getByText("概览")).toBeTruthy();
    expect(getByText("压缩前 12 条消息 · 约 1.5k tokens")).toBeTruthy();
    const head = getByRole("button");
    expect(head.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBeNull();
  });

  it("带摘要可展开：指令清单 + 摘要 + 时间", async () => {
    const { getByRole, getByText, findByTestId, queryByText } = renderRow(marker({
      summary: "目标：完成压缩检查点",
      instructions: ["用中文回复"],
    }));
    const head = getByRole("button");
    expect(queryByText("目标：完成压缩检查点")).toBeNull();
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("用中文回复")).toBeTruthy();
    expect((await findByTestId("md-block")).textContent).toContain("目标：完成压缩检查点");
    fireEvent.click(head);
    expect(head.getAttribute("aria-expanded")).toBe("false");
  });

  it("失败：role=alert 常驻行，可关闭", () => {
    live.applyCompactionEvent({ source: "agent", type: "context.compacting", sessionId: "s1", payload: { mode: "overview" } } as never);
    live.applyCompactionEvent({ source: "agent", type: "context.compact_failed", sessionId: "s1", payload: { message: "快速模型超时" } } as never);
    const failed = liveStore.get().compactions["s1"]![0]!;
    const { getByRole, getByText } = renderRow(failed);
    expect(getByRole("alert")).toBeTruthy();
    expect(getByText(/快速模型超时/)).toBeTruthy();
    fireEvent.click(getByRole("button", { name: "关闭" }));
    expect(liveStore.get().compactions["s1"]).toEqual([]);
  });

  it("沉降行无 axe 违规", async () => {
    const { container } = renderRow(marker({ summary: "摘要", replacedTokens: 800 }));
    const results = await axeCore.run(container);
    expect(results.violations).toEqual([]);
  });
});
