import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsPanel } from "../panels/SubagentsPanel";
import { api, ApiError } from "../lib/api";
import { liveStore } from "../app/live-store";
import { makeSession } from "./helpers/fixtures";
import { renderWithClient } from "./helpers/with-client";

const AGENTS = {
  agents: [
    { id: "explore", name: "explore", description: "只读探索", builtin: true },
    { id: "general", name: "general", description: "通用", builtin: true },
    { id: "reviewer", name: "reviewer", description: "评审", builtin: false },
  ],
};

beforeEach(() => {
  vi.spyOn(api, "session").mockResolvedValue(makeSession({ id: "s-1" }));
});

afterEach(() => {
  liveStore.set({ subagents: {} });
  vi.restoreAllMocks();
});

describe("SubagentsPanel 手动启动器", () => {
  it("渲染输入框、代理类型选择与启动按钮，代理列表来自 api.agents()（内置在前）", async () => {
    const agentsSpy = vi.spyOn(api, "agents").mockResolvedValue(AGENTS);
    renderWithClient(<SubagentsPanel sessionId="s-1" />);

    expect(screen.getByLabelText("子代理任务描述")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "启动" })).toBeDisabled();
    await waitFor(() => expect(agentsSpy).toHaveBeenCalled());
    const select = screen.getByLabelText("子代理类型");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(3));
    const options = [...select.querySelectorAll("option")].map((option) => option.textContent);
    expect(options).toEqual(["explore（内置）", "general（内置）", "reviewer（自定义）"]);
    // 默认选中通用代理（手动启动意图是干活）
    expect(select).toHaveValue("general");
  });

  it("提交调用 startSubagent 并在成功后清空输入（按钮点击与 Enter 提交）", async () => {
    vi.spyOn(api, "agents").mockResolvedValue(AGENTS);
    const startSpy = vi.spyOn(api, "startSubagent").mockResolvedValue({ taskId: "task-1", toolCallId: "manual-task-1" });
    renderWithClient(<SubagentsPanel sessionId="s-1" />);

    const input = screen.getByLabelText("子代理任务描述");
    const select = await screen.findByLabelText("子代理类型");
    fireEvent.change(input, { target: { value: "  调研登录模块  " } });
    fireEvent.change(select, { target: { value: "explore" } });
    fireEvent.click(screen.getByRole("button", { name: "启动" }));

    await waitFor(() => expect(startSpy).toHaveBeenCalledWith("s-1", { prompt: "调研登录模块", agent: "explore" }));
    await waitFor(() => expect(input).toHaveValue(""));

    // Enter（form submit）走同一提交路径
    fireEvent.change(input, { target: { value: "整理 README" } });
    fireEvent.change(select, { target: { value: "general" } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(startSpy).toHaveBeenCalledWith("s-1", { prompt: "整理 README", agent: "general" }));
  });

  it("429/400 失败时展示错误行，输入保留", async () => {
    vi.spyOn(api, "agents").mockResolvedValue(AGENTS);
    vi.spyOn(api, "startSubagent").mockRejectedValue(new ApiError(429, "子代理并发已满"));
    renderWithClient(<SubagentsPanel sessionId="s-1" />);

    const input = screen.getByLabelText("子代理任务描述");
    fireEvent.change(input, { target: { value: "批量重构" } });
    fireEvent.click(screen.getByRole("button", { name: "启动" }));

    await screen.findByRole("alert");
    expect(screen.getByRole("alert")).toHaveTextContent("子代理并发已满");
    expect(input).toHaveValue("批量重构");
  });

  it("api.agents() 失败时回退到内置两项（启动器仍可用）", async () => {
    vi.spyOn(api, "agents").mockRejectedValue(new Error("not found"));
    renderWithClient(<SubagentsPanel sessionId="s-1" />);

    const select = screen.getByLabelText("子代理类型");
    await waitFor(() => expect(select.querySelectorAll("option")).toHaveLength(2));
    const options = [...select.querySelectorAll("option")].map((option) => option.getAttribute("value"));
    expect(options).toEqual(["explore", "general"]);
  });

  it("无会话时不渲染启动器", () => {
    renderWithClient(<SubagentsPanel />);

    expect(screen.queryByLabelText("子代理任务描述")).toBeNull();
  });
});
