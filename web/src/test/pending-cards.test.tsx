import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InteractionCard } from "../chat/cards/InteractionCard";
import { PlanApprovalCard } from "../chat/cards/PlanApprovalCard";
import { PermissionCard } from "../chat/cards/PermissionCard";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import type { InteractionRequest, PendingPermission } from "../lib/contracts";

function interaction(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "q1",
    sessionId: "s1",
    runId: "r1",
    kind: "single_select",
    title: "执行顺序",
    prompt: "开工顺序定哪个？",
    options: [
      { id: "a", label: "A 按上表易→难（推荐）" },
      { id: "b", label: "B 加载速度整块提前" },
    ],
    status: "pending",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const chatActions = { sessionId: "s1", running: false, onNotice: () => undefined } as unknown as ChatActions;

function renderPermission(permission: PendingPermission, props: { collapsed?: boolean; onToggleCollapse?: () => void }): ReturnType<typeof render> {
  return render(
    <ChatActionsContext.Provider value={chatActions}>
      <PermissionCard permission={permission} onDone={() => undefined} {...props} />
    </ChatActionsContext.Provider>,
  );
}

describe("待回答卡收起态（手风琴非展开项）", () => {
  it("交互卡收起：只留卡头 + 提交按钮，选项正文不渲染", () => {
    const onRespond = vi.fn();
    const onToggleCollapse = vi.fn();
    const { container } = render(
      <InteractionCard item={interaction()} onRespond={onRespond} collapsed onToggleCollapse={onToggleCollapse} />,
    );
    expect(screen.getByText("执行顺序")).toBeInTheDocument();
    expect(screen.getByText("待回答")).toBeInTheDocument();
    expect(screen.queryByText("A 按上表易→难（推荐）")).not.toBeInTheDocument();
    expect(container.querySelector(".pending-body")).toBeNull();
    // 未选择任何选项时提交置灰（收起态可直接回答的前提是已选）
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    expect(onRespond).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /收起\/展开「执行顺序」/ }));
    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
  });

  it("交互卡展开：选项可见，选择后提交把选项 id 作为回答", () => {
    const onRespond = vi.fn();
    render(<InteractionCard item={interaction()} onRespond={onRespond} collapsed={false} onToggleCollapse={() => undefined} />);
    const toggle = screen.getByRole("button", { name: /收起\/展开/ });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByLabelText(/A 按上表易→难/));
    fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(onRespond).toHaveBeenCalledWith("a");
  });

  it("权限卡收起：操作按钮可见、参数预览与拒绝理由输入框折叠", () => {
    const { container } = renderPermission(
      { requestId: "perm-1", tool: "bash", input: { command: "rm -rf build" } },
      { collapsed: true, onToggleCollapse: () => undefined },
    );
    expect(container.querySelector(".tool-detail")).toBeNull();
    expect(screen.getByRole("button", { name: "允许一次" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /收起\/展开权限确认卡/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("权限卡展开：参数预览与拒绝理由输入框都在", () => {
    const { container } = renderPermission({ requestId: "perm-2", tool: "bash", input: { command: "ls" } }, { collapsed: false });
    expect(container.querySelector(".tool-detail")).not.toBeNull();
    expect(screen.getByLabelText("拒绝理由（可选）")).toBeInTheDocument();
  });

  it("计划批准卡收起：只剩卡头与「批准执行」", () => {
    const onRespond = vi.fn();
    render(
      <PlanApprovalCard item={interaction({ kind: "plan_approval", title: "计划待批准", prompt: "## 步骤\n1. 先改 A" })}
        onRespond={onRespond} collapsed onToggleCollapse={() => undefined} />,
    );
    expect(screen.getByText("待批准")).toBeInTheDocument();
    expect(screen.queryByText(/先改 A/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑后批准" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    expect(onRespond).toHaveBeenCalledWith({ decision: "approve" });
  });
});
