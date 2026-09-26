import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { InteractionCard } from "../chat/cards/InteractionCard";
import { PlanApprovalCard } from "../chat/cards/PlanApprovalCard";
import { PermissionCard } from "../chat/cards/PermissionCard";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import type { InteractionRequest, PendingPermission } from "../lib/contracts";
function interaction(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    id: "q1", sessionId: "s1", runId: "r1", kind: "single_select", title: "执行顺序", prompt: "开工顺序定哪个？",
    options: [{ id: "a", label: "A 按上表易→难（推荐）" }, { id: "b", label: "B 加载速度整块提前" }],
    status: "pending", createdAt: "2026-08-01T00:00:00.000Z", ...overrides,
  };
}
const chatActions = { sessionId: "s1", running: false, onNotice: () => undefined } as unknown as ChatActions;
const renderPermission = (permission: PendingPermission, collapsed: boolean): ReturnType<typeof render> =>
  render(
    <ChatActionsContext.Provider value={chatActions}>
      <PermissionCard permission={permission} onDone={() => undefined} collapsed={collapsed} onToggleCollapse={() => undefined} />
    </ChatActionsContext.Provider>,
  );
describe("待回答卡收起态（手风琴非展开项）", () => {
  it("交互卡收起：只留卡头 + 提交按钮，选项正文不渲染且未选中不可提交；点击卡头回调切换；展开后选项可见、选择后提交把选项 id 作为回答", () => {
    const onRespond = vi.fn();
    const onToggleCollapse = vi.fn();
    const collapsed = render(<InteractionCard item={interaction()} onRespond={onRespond} collapsed onToggleCollapse={onToggleCollapse} />);
    expect(screen.getByText("执行顺序")).toBeInTheDocument(); expect(screen.getByText("待回答")).toBeInTheDocument();
    expect(screen.queryByText("A 按上表易→难（推荐）")).not.toBeInTheDocument();
    const submit = screen.getByRole("button", { name: "提交回答" });
    expect(submit).toBeDisabled(); fireEvent.click(submit); expect(onRespond).not.toHaveBeenCalled();
    const header = screen.getByRole("button", { name: /收起\/展开「执行顺序」/ });
    expect(header).toHaveAttribute("aria-expanded", "false"); fireEvent.click(header); expect(onToggleCollapse).toHaveBeenCalled();
    collapsed.unmount();
    render(<InteractionCard item={interaction()} onRespond={onRespond} collapsed={false} onToggleCollapse={() => undefined} />);
    expect(screen.getByRole("button", { name: /收起\/展开/ })).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(screen.getByLabelText(/A 按上表易→难/)); fireEvent.click(screen.getByRole("button", { name: "提交回答" }));
    expect(onRespond).toHaveBeenCalledWith("a");
  });
  it("权限卡收起：操作按钮可见、参数预览与拒绝理由折叠；展开时都在；计划批准卡收起只剩卡头与「批准执行」", () => {
    renderPermission({ requestId: "perm-1", tool: "bash", input: { command: "rm -rf build" } }, true);
    expect(screen.getByRole("button", { name: "允许一次" })).toBeInTheDocument(); expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /收起\/展开权限确认卡/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("完整参数")).not.toBeInTheDocument(); expect(screen.queryByLabelText("拒绝理由（可选）")).not.toBeInTheDocument();
    renderPermission({ requestId: "perm-2", tool: "bash", input: { command: "ls" } }, false);
    expect(screen.getByText("完整参数")).toBeInTheDocument(); expect(screen.getByLabelText("拒绝理由（可选）")).toBeInTheDocument();
    const onRespond = vi.fn();
    render(<PlanApprovalCard item={interaction({ kind: "plan_approval", title: "计划待批准", prompt: "## 步骤\n1. 先改 A" })} onRespond={onRespond} collapsed onToggleCollapse={() => undefined} />);
    expect(screen.queryByText(/先改 A/)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "编辑后批准" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "批准执行" })); expect(onRespond).toHaveBeenCalledWith({ decision: "approve" });
  });
});
