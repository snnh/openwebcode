import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { PermissionCard } from "../chat/cards/PermissionCard";
import { InteractionCard } from "../chat/cards/InteractionCard";
import { PlanApprovalCard } from "../chat/cards/PlanApprovalCard";
import { RunErrorCard } from "../chat/cards/RunErrorCard";
import { LiveActivityBar } from "../chat/cards/LiveActivityBar";
import { SteeringQueue } from "../chat/cards/SteeringQueue";
import { ChatActionsContext, type ChatActions } from "../chat/types";
import { api } from "../lib/api";
import { ui, uiStore } from "../app/ui-store";
import type { InteractionRequest, QueueItem } from "../lib/contracts";

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

function renderWithActions(node: ReactElement, actions: ChatActions = makeChatActions()) {
  return render(<ChatActionsContext.Provider value={actions}>{node}</ChatActionsContext.Provider>);
}

function interaction(overrides: Partial<InteractionRequest>): InteractionRequest {
  return {
    id: "i1",
    sessionId: "s1",
    runId: "r1",
    kind: "confirm",
    title: "标题",
    prompt: "提示",
    status: "pending",
    createdAt: "2026-07-20T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  ui.closeSettings();
});

describe("PermissionCard", () => {
  const permission = { requestId: "req-1", tool: "bash", input: { command: "npm test" } };

  it("允许一次：先完成 HTTP 响应再 onDone", async () => {
    const respond = vi.spyOn(api, "respondPermission").mockResolvedValue({ accepted: true });
    const onDone = vi.fn();
    const { getByText } = renderWithActions(<PermissionCard permission={permission} onDone={onDone} />);
    fireEvent.click(getByText("允许一次"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("req-1"));
    expect(respond).toHaveBeenCalledWith("s1", { requestId: "req-1", decision: "allow" });
  });

  it("总是允许需要 3 秒内二次确认", async () => {
    const respond = vi.spyOn(api, "respondPermission").mockResolvedValue({ accepted: true });
    const onDone = vi.fn();
    const { getByText } = renderWithActions(<PermissionCard permission={permission} onDone={onDone} />);
    fireEvent.click(getByText("总是允许"));
    expect(respond).not.toHaveBeenCalled();
    fireEvent.click(getByText("确认总是允许？"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("req-1"));
    expect(respond).toHaveBeenCalledWith("s1", { requestId: "req-1", decision: "allow_always" });
  });

  it("拒绝可附理由；HTTP 失败时走 onError 且不 onDone", async () => {
    const respond = vi.spyOn(api, "respondPermission").mockResolvedValue({ accepted: true });
    const onDone = vi.fn();
    const first = renderWithActions(<PermissionCard permission={permission} onDone={onDone} />);
    fireEvent.change(first.getByLabelText("拒绝理由（可选）"), { target: { value: "太危险" } });
    fireEvent.click(first.getByText("拒绝"));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith("req-1"));
    expect(respond).toHaveBeenCalledWith("s1", { requestId: "req-1", decision: "deny", reason: "太危险" });
    first.unmount();

    respond.mockRejectedValue(new Error("network"));
    const onError = vi.fn();
    const failed = renderWithActions(<PermissionCard permission={permission} onDone={onDone} onError={onError} />);
    fireEvent.click(failed.getByText("允许一次"));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("权限响应失败，请重试"));
    expect(onDone).toHaveBeenCalledTimes(1);
  });
});

describe("InteractionCard", () => {
  it("single_select：提交选项 id；allowOther 的渲染、提交 other:<文本> 与空输入禁用", () => {
    // single_select：选中后提交选项 id；未设 allowOther 不渲染「其他」
    const plain = vi.fn();
    const plainView = render(
      <InteractionCard
        item={interaction({ kind: "single_select", options: [{ id: "a", label: "方案 A" }, { id: "b", label: "方案 B", description: "推荐" }] })}
        onRespond={plain}
      />,
    );
    expect(plainView.getByText("提交回答")).toBeDisabled();
    // allowOther 未设置：不渲染「其他」入口
    expect(plainView.queryByText("其他")).toBeNull();
    fireEvent.click(plainView.getByLabelText(/方案 B/));
    fireEvent.click(plainView.getByText("提交回答"));
    expect(plain).toHaveBeenCalledWith("b");
    plainView.unmount();

    // allowOther：single_select 渲染「其他」选项，选中并输入后提交 other:<文本>
    const other = vi.fn();
    const otherView = render(
      <InteractionCard
        item={interaction({ kind: "single_select", allowOther: true, options: [{ id: "a", label: "方案 A" }] })}
        onRespond={other}
      />,
    );
    // 未选中「其他」时输入框禁用
    expect(otherView.getByLabelText("其他回答")).toBeDisabled();
    fireEvent.click(otherView.getByLabelText("其他"));
    fireEvent.change(otherView.getByLabelText("其他回答"), { target: { value: "自定义方案" } });
    fireEvent.click(otherView.getByText("提交回答"));
    expect(other).toHaveBeenCalledWith("other:自定义方案");
    otherView.unmount();

    // allowOther：选中「其他」但未输入时不可提交；取消选中后输入框恢复禁用
    const empty = vi.fn();
    const emptyView = render(
      <InteractionCard
        item={interaction({ kind: "multi_select", allowOther: true, options: [{ id: "a", label: "方案 A" }] })}
        onRespond={empty}
      />,
    );
    fireEvent.click(emptyView.getByLabelText("其他"));
    expect(emptyView.getByText("提交回答")).toBeDisabled();
    // 另有常规选项被选即可提交（空 other 项由服务端忽略）
    fireEvent.click(emptyView.getByLabelText(/方案 A/));
    expect(emptyView.getByText("提交回答")).toBeEnabled();
    // 取消「其他」后输入框禁用，提交仅含常规选项
    fireEvent.click(emptyView.getByLabelText("其他"));
    expect(emptyView.getByLabelText("其他回答")).toBeDisabled();
    fireEvent.click(emptyView.getByText("提交回答"));
    expect(empty).toHaveBeenCalledWith(["a"]);
  });

  it("text：输入后提交文本；空文本不可提交", () => {
    const onRespond = vi.fn();
    const { getByText, getByLabelText } = render(
      <InteractionCard item={interaction({ kind: "text" })} onRespond={onRespond} />,
    );
    expect(getByText("提交回答")).toBeDisabled();
    fireEvent.change(getByLabelText("回答"), { target: { value: "我的回答" } });
    fireEvent.click(getByText("提交回答"));
    expect(onRespond).toHaveBeenCalledWith("我的回答");
  });

  it("confirm：确认/取消分别回 true/false", () => {
    const onRespond = vi.fn();
    const { getByText } = render(<InteractionCard item={interaction({ kind: "confirm" })} onRespond={onRespond} />);
    fireEvent.click(getByText("确认"));
    expect(onRespond).toHaveBeenCalledWith(true);
    fireEvent.click(getByText("取消"));
    expect(onRespond).toHaveBeenCalledWith(false);
  });
});

describe("PlanApprovalCard", () => {
  const item = interaction({ kind: "plan_approval", prompt: "1. 第一步\n2. 第二步" });

  it("批准执行/编辑后批准/拒绝分别回对应 decision", () => {
    // 批准执行
    const approve = vi.fn();
    const approveView = render(<PlanApprovalCard item={item} onRespond={approve} />);
    fireEvent.click(approveView.getByText("批准执行"));
    expect(approve).toHaveBeenCalledWith({ decision: "approve" });
    approveView.unmount();

    // 编辑后批准
    const edit = vi.fn();
    const editView = render(<PlanApprovalCard item={item} onRespond={edit} />);
    fireEvent.click(editView.getByText("编辑后批准"));
    fireEvent.change(editView.getByLabelText("编辑计划"), { target: { value: "改过的计划" } });
    fireEvent.click(editView.getByText("提交修改并批准"));
    expect(edit).toHaveBeenCalledWith({ decision: "edit", plan: "改过的计划" });
    editView.unmount();

    // 拒绝
    const reject = vi.fn();
    const rejectView = render(<PlanApprovalCard item={item} onRespond={reject} />);
    fireEvent.click(rejectView.getByText("拒绝"));
    fireEvent.change(rejectView.getByLabelText("拒绝意见"), { target: { value: "再想想" } });
    fireEvent.click(rejectView.getByText("确认拒绝"));
    expect(reject).toHaveBeenCalledWith({ decision: "reject", feedback: "再想想" });
  });
});

describe("RunErrorCard", () => {
  it("按错误分类给出提示与「打开模型设置」深链", () => {
    const { getByText } = render(<RunErrorCard error={{ message: "401 unauthorized", kind: "authentication", retryable: false }} />);
    expect(getByText("认证失败：请检查 设置 → 模型目录 中的 API Key")).toBeInTheDocument();
    fireEvent.click(getByText("打开模型设置"));
    expect(uiStore.get().settingsOpen).toBe(true);
    expect(uiStore.get().settingsTab?.tab).toBe("models");
  });

  it("retryable 时展示重试按钮，retryPending 禁用；超长错误折叠", () => {
    const onRetryRun = vi.fn();
    const first = render(
      <RunErrorCard error={{ message: "rate limited", kind: "rate_limit", retryable: true }} onRetryRun={onRetryRun} />,
    );
    fireEvent.click(first.getByText("重试"));
    expect(onRetryRun).toHaveBeenCalled();
    first.unmount();

    const pending = render(
      <RunErrorCard error={{ message: "rate limited", kind: "rate_limit", retryable: true }} onRetryRun={onRetryRun} retryPending />,
    );
    expect(pending.getByText("重试")).toBeDisabled();
    pending.unmount();

    const long = render(<RunErrorCard error={{ message: "x".repeat(300) }} />);
    expect(long.getByText("原始错误信息")).toBeInTheDocument();
    expect(long.container.querySelector("details.run-error-details")).not.toBeNull();
  });
});

describe("LiveActivityBar", () => {
  it("执行中渲染状态文案与并行计数；空闲/终态不渲染", () => {
    const { getByText, container } = render(
      <LiveActivityBar activity={{ state: "executing_tools", currentTool: "bash", toolCount: 2 }} />,
    );
    expect(container.querySelector(".live-activity")).not.toBeNull();
    expect(getByText("执行工具")).toBeInTheDocument();
    expect(getByText("bash 等 2 项")).toBeInTheDocument();

    const idle = render(<LiveActivityBar activity={{ state: "completed", toolCount: 0 }} />);
    expect(idle.container.firstChild).toBeNull();
  });
});

describe("SteeringQueue", () => {
  function item(id: string, kind: QueueItem["kind"], status: QueueItem["status"] = "queued"): QueueItem {
    return { id, sessionId: "s1", kind, content: `内容-${id}`, status, createdAt: "2026-07-20T00:00:00.000Z", updatedAt: "2026-07-20T00:00:00.000Z" };
  }

  it("按 kind 分组渲染 queued 条目并可撤销", () => {
    const onRemove = vi.fn();
    const { getByText, getAllByText, queryByText } = render(
      <SteeringQueue items={[item("q1", "steer"), item("q2", "follow_up"), item("q3", "steer", "applied")]} onRemove={onRemove} />,
    );
    expect(getByText("运行队列")).toBeInTheDocument();
    expect(getByText("下一轮纠偏")).toBeInTheDocument();
    expect(getByText("完成后续跑")).toBeInTheDocument();
    expect(getByText("内容-q1")).toBeInTheDocument();
    expect(getByText("内容-q2")).toBeInTheDocument();
    // 非 queued 条目不展示
    expect(queryByText("内容-q3")).toBeNull();
    fireEvent.click(getAllByText("撤销")[0]!);
    expect(onRemove).toHaveBeenCalledWith("q1");
  });
});
