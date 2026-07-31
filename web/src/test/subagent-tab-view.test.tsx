import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SubagentTabView } from "../components/SubagentTabView";
import { api } from "../lib/api";
import type { ChatMessage, SubagentTranscript } from "../lib/contracts";
import { makeSubagentRun } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const run = makeSubagentRun;

function transcriptOf(taskId: string, text: string): SubagentTranscript {
  const messages: ChatMessage[] = [
    { id: `${taskId}-m1`, role: "user", createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text: "调查代码结构" }] },
    { id: `${taskId}-m2`, role: "assistant", createdAt: "2026-07-20T00:00:01.000Z", content: [{ type: "text", text }] },
  ];
  return { id: taskId, prompt: "调查代码结构", startedAt: "2026-07-20T00:00:00.000Z", turns: 2, toolsUsed: ["read_file"], conclusion: text, messages };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SubagentTabView", () => {
  it("终态子代理标签拉取转录并用主对话同款 MessageCard 渲染消息", async () => {
    const spy = vi.spyOn(api, "subagentTranscript").mockResolvedValue(transcriptOf("task-1", "这是子代理的回答"));
    const { container } = renderWithClient(
      <SubagentTabView sessionId="s-1" toolCallId="call-1" runs={{ "task-1": run({ status: "done", turns: 2, toolsUsed: ["read_file"] }) }} />,
    );

    await waitFor(() => expect(spy).toHaveBeenCalledWith("s-1", "task-1"));
    // 头部：状态徽标 + 轮次
    expect(container.querySelector(".subagent-tab-run-header .subagent-run-status")).toHaveTextContent("完成");
    expect(container.querySelector(".subagent-tab-run-header .subagent-run-stats")).toHaveTextContent("2 轮");
    // 消息经主对话渲染器（article.message），不再是紧凑的 details.subagent-transcript
    await waitFor(() => expect(container.querySelectorAll(".subagent-tab-view article.message")).toHaveLength(2));
    expect(container.querySelector(".subagent-tab-view article.message.assistant")).toHaveTextContent("这是子代理的回答");
    expect(container.querySelector(".subagent-tab-view details.subagent-transcript")).toBeNull();
  });

  it("运行中的标签显示实时状态行与提示，不拉取转录", () => {
    const spy = vi.spyOn(api, "subagentTranscript");
    const { container } = renderWithClient(
      <SubagentTabView sessionId="s-1" toolCallId="call-1" runs={{ "task-1": run({ status: "running", turns: 1 }) }} />,
    );

    expect(container.querySelector(".subagent-run-task")).toHaveTextContent("调查代码结构");
    expect(container.querySelector(".subagent-run-status")).toHaveTextContent("运行中");
    expect(container.querySelector(".subagent-tab-hint")).toHaveTextContent("运行结束后显示完整对话");
    expect(spy).not.toHaveBeenCalled();
  });

  it("swarm 标签逐项渲染：每项「任务 N」头部 + 各自转录", async () => {
    const spy = vi.spyOn(api, "subagentTranscript").mockImplementation((_sessionId: string, taskId: string) =>
      Promise.resolve(transcriptOf(taskId, `回答 ${taskId}`)),
    );
    const { container } = renderWithClient(
      <SubagentTabView
        sessionId="s-1"
        toolCallId="call-9"
        runs={{
          "t-1": run({ taskId: "t-1", toolCallId: "call-9", status: "done", turns: 1, swarm: { index: 1, total: 2 } }),
          "t-2": run({ taskId: "t-2", toolCallId: "call-9", status: "done", turns: 3, swarm: { index: 2, total: 2 } }),
        }}
      />,
    );

    expect(container.querySelector(".subagents-group-header")).toHaveTextContent("群 2 项 · 完成 2 / 失败 0 / 运行中 0");
    await waitFor(() => expect(container.querySelectorAll(".subagent-tab-run")).toHaveLength(2));
    const sections = container.querySelectorAll(".subagent-tab-run");
    expect(sections[0]!.querySelector(".subagent-tab-run-header")).toHaveTextContent("任务 1");
    expect(sections[1]!.querySelector(".subagent-tab-run-header")).toHaveTextContent("任务 2");
    await waitFor(() => {
      expect(sections[0]!.querySelector("article.message.assistant")).toHaveTextContent("回答 t-1");
      expect(sections[1]!.querySelector("article.message.assistant")).toHaveTextContent("回答 t-2");
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("转录加载失败时显示错误提示", async () => {
    vi.spyOn(api, "subagentTranscript").mockRejectedValue(new Error("boom"));
    const { container } = renderWithClient(
      <SubagentTabView sessionId="s-1" toolCallId="call-1" runs={{ "task-1": run({ status: "done" }) }} />,
    );

    await waitFor(() => expect(container.querySelector(".subagent-transcript-status")).toHaveTextContent("转录加载失败"));
  });

  it("标签对应的运行不在记录中时显示空态", () => {
    const { container } = renderWithClient(<SubagentTabView sessionId="s-1" toolCallId="call-x" runs={{}} />);

    expect(container.querySelector(".subagent-tab-empty")).toHaveTextContent("该标签对应的子代理运行已不在记录中。");
  });
});
