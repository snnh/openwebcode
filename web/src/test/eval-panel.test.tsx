import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvalPanel } from "../components/panels/EvalPanel";
import { BottomPanel } from "../components/BottomPanel";
import { I18nProvider } from "../i18n";
import { api } from "../lib/api";
import { renderWithClient } from "./helpers/with-client";

const { report } = vi.hoisted(() => ({ report: {
  runId: "eval-11111111-1111-4111-8111-111111111111",
  schemaVersion: 1 as const, taskSetId: "owc-smoke-v1" as const, provider: "eval-mock" as const, model: "eval-model" as const,
  startedAt: "2026-07-26T00:00:00Z",
  finishedAt: "2026-07-26T00:00:01Z",
  summary: {
    total: 1, passed: 1, failed: 0, errored: 0, durationMs: 25,
    usage: { inputTokens: 2, outputTokens: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
  },
  taskResults: [{
    taskId: "create-file", taskName: "创建文件", status: "pass" as const,
    assertions: [{ name: "fileExists", passed: true, detail: "exists" }],
    durationMs: 25, turns: 2, toolsUsed: ["write_file"], toolCalls: ["write_file"],
    usage: { inputTokens: 2, outputTokens: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 4 },
  }],
} }));

vi.mock("../lib/api", () => ({
  api: {
    evalTasks: vi.fn().mockResolvedValue({ tasks: [{
      id: "create-file", name: "创建文件", description: "创建示例文件", workspace: "create-file", instruction: "create", assertions: {},
    }] }),
    evalRuns: vi.fn().mockResolvedValue({ runs: [] }),
    evalRun: vi.fn().mockResolvedValue(report),
    evalRunReport: vi.fn().mockResolvedValue(report),
    evalComparisons: vi.fn().mockResolvedValue({ comparisons: [] }),
    evalCompare: vi.fn(),
  },
}));

function wrapper(children: React.ReactNode) {
  return renderWithClient(<I18nProvider>{children}</I18nProvider>);
}

describe("EvalPanel（0.5.0 Phase 3）", () => {
  it("选择任务、运行并展示 token/工具报告", async () => {
    wrapper(<EvalPanel onNotice={vi.fn()} />);
    expect(await screen.findByText("创建文件")).toBeDefined();
    const runButton = screen.getByRole("button", { name: /运行所选任务|Run selected/ });
    await waitFor(() => expect(runButton).not.toBeDisabled());
    fireEvent.click(screen.getByRole("checkbox"));
    expect(runButton).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(runButton);
    await waitFor(() => expect(api.evalRun).toHaveBeenCalledWith(["create-file"]));
    expect((await screen.findAllByText(/4 tokens/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/write_file/)).toBeDefined();
  });

  it("只有扩展启用时注册评测标签", () => {
    const props = { running: false, onNotice: vi.fn(), open: false, onOpenChange: vi.fn() };
    const disabled = wrapper(<BottomPanel {...props} evalEnabled={false} />);
    expect(screen.queryByRole("button", { name: /^评测$|^Eval$/ })).toBeNull();
    disabled.unmount();
    wrapper(<BottomPanel {...props} evalEnabled />);
    expect(screen.getByRole("button", { name: /^评测$|^Eval$/ })).toBeDefined();
  });

  it("选择历史基线后生成并显示可归档回归对比", async () => {
    const baselineRunId = "eval-22222222-2222-4222-8222-222222222222";
    vi.mocked(api.evalRuns).mockResolvedValue({ runs: [{
      runId: baselineRunId,
      startedAt: "2026-07-25T00:00:00Z",
      finishedAt: "2026-07-25T00:00:01Z",
      summary: report.summary,
      taskCount: 1,
    }] });
    vi.mocked(api.evalCompare).mockResolvedValue({
      schemaVersion: 1,
      comparisonId: "comparison-11111111-1111-4111-8111-111111111111",
      baselineRunId,
      candidateRunId: report.runId,
      createdAt: "2026-07-26T00:00:02Z",
      baseline: { ...report, runId: baselineRunId },
      candidate: report,
      summary: { passedDelta: -1, failedDelta: 1, erroredDelta: 0, durationMsDelta: 5, totalTokensDelta: 2, regressions: 1, improvements: 0 },
      tasks: [{
        taskId: "create-file", taskName: "创建文件", baselineStatus: "pass", candidateStatus: "fail",
        regressed: true, improved: false, durationMsDelta: 5, totalTokensDelta: 2, toolCallsChanged: false,
        baselineToolCalls: ["write_file"], candidateToolCalls: ["write_file"],
      }],
    });
    wrapper(<EvalPanel onNotice={vi.fn()} />);
    await screen.findByText("创建文件");
    fireEvent.click(screen.getByRole("button", { name: /运行所选任务|Run selected/ }));
    const baseline = await screen.findByLabelText(/对比基线|Comparison baseline/);
    fireEvent.change(baseline, { target: { value: baselineRunId } });
    fireEvent.click(screen.getByRole("button", { name: /^对比$|^Compare$/ }));
    await waitFor(() => expect(api.evalCompare).toHaveBeenCalledWith(baselineRunId, report.runId));
    expect((await screen.findAllByText(/回归|Regression/)).length).toBeGreaterThan(0);
  });
});
