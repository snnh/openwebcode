import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanApprovalCard } from "../components/PlanApprovalCard";
import type { InteractionRequest, PlanApprovalAnswer } from "../lib/contracts";

const PLAN = "# 实施计划\n\n1. 改 A\n2. 改 B";

function makeItem(): InteractionRequest {
  return {
    id: "int-1",
    sessionId: "s1",
    runId: "r1",
    toolCallId: "epm-1",
    kind: "plan_approval",
    title: "计划批准",
    prompt: PLAN,
    status: "pending",
    createdAt: new Date().toISOString(),
  };
}

function renderCard(onRespond = vi.fn()) {
  render(<PlanApprovalCard item={makeItem()} onRespond={onRespond} />);
  return onRespond;
}

describe("PlanApprovalCard", () => {
  it("渲染计划全文与三个操作入口", async () => {
    renderCard();
    // Markdown 按需加载：Suspense 回落为纯文本，懒加载完成后为渲染结果，两者都含计划正文
    expect(await screen.findByText(/实施计划/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "批准执行" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "编辑后批准" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "拒绝" })).toBeInTheDocument();
  });

  it("批准执行：提交 { decision: approve }", async () => {
    const onRespond = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "批准执行" }));
    expect(onRespond).toHaveBeenCalledWith({ decision: "approve" } satisfies PlanApprovalAnswer);
  });

  it("编辑后批准：内联文本域改计划正文后提交 edit 决定", async () => {
    const onRespond = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "编辑后批准" }));
    const textarea = screen.getByLabelText("编辑计划");
    expect((textarea as HTMLTextAreaElement).value).toBe(PLAN);
    fireEvent.change(textarea, { target: { value: "# 改后计划\n\n1. 先改 C" } });
    fireEvent.click(screen.getByRole("button", { name: "提交修改并批准" }));
    expect(onRespond).toHaveBeenCalledWith({ decision: "edit", plan: "# 改后计划\n\n1. 先改 C" } satisfies PlanApprovalAnswer);
  });

  it("编辑取消：回到查看态且不提交", async () => {
    const onRespond = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "编辑后批准" }));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(onRespond).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "批准执行" })).toBeInTheDocument();
  });

  it("拒绝：附意见提交 reject 决定", async () => {
    const onRespond = renderCard();
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    fireEvent.change(screen.getByLabelText("拒绝意见"), { target: { value: "先调研替代方案" } });
    fireEvent.click(screen.getByRole("button", { name: "确认拒绝" }));
    expect(onRespond).toHaveBeenCalledWith({ decision: "reject", feedback: "先调研替代方案" } satisfies PlanApprovalAnswer);
  });

  it("Markdown 容器不带按钮行的 interaction-actions 类（防 .interaction-card > div flex 规则误伤）", async () => {
    renderCard();
    await screen.findByText(/实施计划/);
    const card = document.querySelector(".plan-approval-card");
    expect(card).not.toBeNull();
    const markdownRoot = card!.querySelector(":scope > .markdown");
    expect(markdownRoot).not.toBeNull();
    expect(markdownRoot!.classList.contains("interaction-actions")).toBe(false);
    // 按钮行才是唯一带 interaction-actions 的直接子元素
    const actionRows = card!.querySelectorAll(":scope > .interaction-actions");
    expect(actionRows).toHaveLength(1);
  });
});
