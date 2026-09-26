import { beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { SubagentRunCard } from "../chat/SubagentRunCard";
import type { AppEvent, LiveSubagentRun } from "../lib/contracts";
import { live, liveStore } from "../app/live-store";
import { renderWithClient } from "./helpers/with-client";
beforeEach(() => { liveStore.set({ syntheses: {}, subagents: {} }); });
const makeRun = (overrides: Partial<LiveSubagentRun>): LiveSubagentRun =>
  ({ taskId: "t1", toolCallId: "call-1", prompt: "审查 a.ts", status: "running", turns: 3, toolsUsed: [], ...overrides });
/** swarm 卡展开后逐项行。 */
function expandSwarm(props: Partial<Parameters<typeof SubagentRunCard>[0]> = {}): ReturnType<typeof renderWithClient> {
  const view = renderWithClient(<SubagentRunCard name="spawn_swarm" input={{ prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] }} toolCallId="call-1" {...props} />);
  fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
  return view;
}
describe("SubagentRunCard role 徽标与模型名", () => {
  it("swarm 逐项行显示 role 徽标（data-role）与生效模型", () => {
    const { container } = expandSwarm({ live: [
      makeRun({ taskId: "t1", swarm: { index: 1, total: 2 }, role: "balanced", model: "main-model" }),
      makeRun({ taskId: "t2", swarm: { index: 2, total: 2 }, role: "cheap", model: "cheap-model" }),
    ] });
    const badges = container.querySelectorAll(".subagent-run-role");
    expect(badges).toHaveLength(2); expect(badges[0]?.getAttribute("data-role")).toBe("balanced"); expect(badges[1]?.textContent).toBe("廉价");
    expect([...container.querySelectorAll(".subagent-run-model")].map((node) => node.textContent)).toEqual(["main-model", "cheap-model"]);
  });
  it("无 live 运行时用 item.role 兜底；单个 subagent 也显示 role 徽标", () => {
    let view = renderWithClient(<SubagentRunCard name="spawn_swarm" input={{ prompt_template: "审查 {{item}}", items: [{ task: "a.ts", role: "fast" }, "b.ts"] }} toolCallId="call-1" />);
    fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
    let badge = view.container.querySelector(".subagent-run-role");
    expect(badge?.getAttribute("data-role")).toBe("fast");
    view = renderWithClient(<SubagentRunCard name="subagent" input={{ prompt: "评审" }} toolCallId="call-1" live={[makeRun({ role: "premium" })]} />);
    badge = view.container.querySelector(".subagent-run-role");
    expect(badge?.getAttribute("data-role")).toBe("premium"); expect(badge?.textContent).toBe("极致");
  });
});
describe("SubagentRunCard 汇总行（subagent.synthesis）", () => {
  const publishSynthesis = (phase: "started" | "finished", extra: Record<string, unknown> = {}): void => {
    act(() => live.applySubagentEvent({
      source: "agent", type: "subagent.synthesis", sessionId: "s1", seq: 1,
      payload: { toolCallId: "call-1", phase, model: "cheap-model", ...extra },
    } as AppEvent));
  };
  it("started → 运行中汇总行（含模型），finished(done) → 完成；finished(failed) → 失败回落提示；无合成事件时不渲染汇总行", () => {
    expandSwarm({ sessionId: "s-none" });
    expect(document.querySelector(".subagent-run-synthesis")).toBeNull();
    cleanup();
    expandSwarm({ sessionId: "s1", live: [makeRun({ swarm: { index: 1, total: 2 } })] });
    publishSynthesis("started");
    let row = document.querySelector(".subagent-run-synthesis");
    expect(row?.getAttribute("data-status")).toBe("running"); expect(row?.textContent).toContain("cheap-model");
    publishSynthesis("finished", { status: "done" });
    row = document.querySelector(".subagent-run-synthesis"); expect(row?.getAttribute("data-status")).toBe("done");
    liveStore.set({ syntheses: {}, subagents: {} });
    publishSynthesis("started"); publishSynthesis("finished", { status: "failed", error: "boom" });
    row = document.querySelector(".subagent-run-synthesis");
    expect(row?.getAttribute("data-status")).toBe("failed"); expect(row?.textContent).toContain("合成失败"); expect(row?.textContent).toContain("boom");
  });
});
