import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProducedFilesRow } from "../chat/cards/ProducedFilesRow";
import { ChatActionsContext, type ChatActions } from "../chat/types";

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

describe("ProducedFilesRow", () => {
  it("渲染产出汇总与文件 chip（write/edit 徽标），点击经 onOpenFile 打开", () => {
    const onOpenFile = vi.fn();
    const { getByText } = render(
      <ChatActionsContext.Provider value={makeChatActions({ onOpenFile })}>
        <ProducedFilesRow files={[{ path: "src/a.ts", action: "write" }, { path: "src/b.ts", action: "edit" }]} />
      </ChatActionsContext.Provider>,
    );
    expect(getByText("本轮产出 2 个文件")).toBeTruthy();
    const chip = getByText("src/b.ts");
    expect(chip.closest("button")!.querySelector(".produced-file-edit")).toBeTruthy();
    fireEvent.click(chip);
    expect(onOpenFile).toHaveBeenCalledWith("src/b.ts");
  });

  it("未提供 onOpenFile 时 chip 降级为静态文本", () => {
    const { getByText, container } = render(
      <ChatActionsContext.Provider value={makeChatActions()}>
        <ProducedFilesRow files={[{ path: "src/a.ts", action: "write" }]} />
      </ChatActionsContext.Provider>,
    );
    expect(getByText("src/a.ts").closest("button")).toBeNull();
    expect(container.querySelector(".produced-file-static")).toBeTruthy();
  });
});
