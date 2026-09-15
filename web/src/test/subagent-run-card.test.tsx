import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { SubagentRunCard } from "../chat/SubagentRunCard";
import type { AppEvent, LiveSubagentRun } from "../lib/contracts";
import { live, liveStore } from "../app/live-store";

beforeEach(() => {
  liveStore.set({ syntheses: {}, subagents: {} });
});

function renderCard(element: ReactElement): ReturnType<typeof render> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

function makeRun(overrides: Partial<LiveSubagentRun>): LiveSubagentRun {
  return {
    taskId: "t1",
    toolCallId: "call-1",
    prompt: "审查 a.ts",
    status: "running",
    turns: 3,
    toolsUsed: [],
    ...overrides,
  };
}

describe("SubagentRunCard role 徽标与模型名", () => {
  it("swarm 逐项行显示 role 徽标（四档着色 data-role）与模型名", () => {
    const { container } = renderCard(
      <SubagentRunCard
        name="spawn_swarm"
        input={{ prompt_template: "审查 {{item}}", items: ["a.ts", { task: "b.ts", role: "cheap" }] }}
        toolCallId="call-1"
        live={[
          makeRun({ taskId: "t1", swarm: { index: 1, total: 2 }, role: "balanced", model: "main-model" }),
          makeRun({ taskId: "t2", swarm: { index: 2, total: 2 }, role: "cheap", model: "cheap-model" }),
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
    const badges = container.querySelectorAll(".subagent-run-role");
    expect(badges).toHaveLength(2);
    expect(badges[0]?.getAttribute("data-role")).toBe("balanced");
    expect(badges[1]?.getAttribute("data-role")).toBe("cheap");
    expect(badges[1]?.textContent).toBe("廉价");
    const models = [...container.querySelectorAll(".subagent-run-model")].map((node) => node.textContent);
    expect(models).toEqual(["main-model", "cheap-model"]);
  });

  it("无 live 运行时用 item.role 兜底显示徽标", () => {
    const { container } = renderCard(
      <SubagentRunCard
        name="spawn_swarm"
        input={{ prompt_template: "审查 {{item}}", items: [{ task: "a.ts", role: "fast" }, "b.ts"] }}
        toolCallId="call-1"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
    const badges = container.querySelectorAll(".subagent-run-role");
    expect(badges).toHaveLength(1);
    expect(badges[0]?.getAttribute("data-role")).toBe("fast");
  });

  it("单个 subagent 卡片显示 role 徽标", () => {
    const { container } = renderCard(
      <SubagentRunCard
        name="subagent"
        input={{ prompt: "评审" }}
        toolCallId="call-1"
        live={[makeRun({ role: "premium", model: "opu-model" })]}
      />,
    );
    const badge = container.querySelector(".subagent-run-role");
    expect(badge?.getAttribute("data-role")).toBe("premium");
    expect(badge?.textContent).toBe("极致");
  });
});

describe("SubagentRunCard 汇总行（subagent.synthesis）", () => {
  function publishSynthesis(phase: "started" | "finished", extra: Record<string, unknown> = {}): void {
    const event: AppEvent = {
      source: "agent",
      type: "subagent.synthesis",
      sessionId: "s1",
      eventId: `e-${phase}-${Math.random()}`,
      seq: 1,
      createdAt: new Date().toISOString(),
      payload: { toolCallId: "call-1", phase, model: "cheap-model", ...extra },
    };
    act(() => live.applySubagentEvent(event));
  }

  it("started → 运行中汇总行；finished(done) → 完成", () => {
    renderCard(
      <SubagentRunCard
        name="spawn_swarm"
        sessionId="s1"
        input={{ prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] }}
        toolCallId="call-1"
        live={[makeRun({ swarm: { index: 1, total: 2 } }), makeRun({ taskId: "t2", swarm: { index: 2, total: 2 } })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
    publishSynthesis("started");
    const row = document.querySelector(".subagent-run-synthesis");
    expect(row?.getAttribute("data-status")).toBe("running");
    expect(row?.textContent).toContain("汇总");
    expect(row?.textContent).toContain("cheap-model");
    publishSynthesis("finished", { status: "done" });
    expect(document.querySelector(".subagent-run-synthesis")?.getAttribute("data-status")).toBe("done");
  });

  it("finished(failed) → 失败回落提示", () => {
    renderCard(
      <SubagentRunCard
        name="spawn_swarm"
        sessionId="s1"
        input={{ prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] }}
        toolCallId="call-1"
        live={[makeRun({ swarm: { index: 1, total: 2 } })]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
    publishSynthesis("started");
    publishSynthesis("finished", { status: "failed", error: "boom" });
    const row = document.querySelector(".subagent-run-synthesis");
    expect(row?.getAttribute("data-status")).toBe("failed");
    expect(row?.textContent).toContain("合成失败");
    expect(row?.textContent).toContain("boom");
  });

  it("无合成事件时不渲染汇总行", () => {
    renderCard(
      <SubagentRunCard
        name="spawn_swarm"
        sessionId="s-none"
        input={{ prompt_template: "审查 {{item}}", items: ["a.ts", "b.ts"] }}
        toolCallId="call-none"
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /spawn_swarm/ }));
    expect(document.querySelector(".subagent-run-synthesis")).toBeNull();
  });
});
