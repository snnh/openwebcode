import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextPanel } from "../components/panels/ContextPanel";
import { api } from "../lib/api";
import type { ContextView, SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "s-1",
  cwd: "D:\\work",
  provider: "test",
  model: "test-model",
  title: "上下文会话",
  createdAt: "2026-07-24T00:00:00.000Z",
  updatedAt: "2026-07-24T00:00:00.000Z",
  messages: [],
};

function contextView(selection: { pins: string[]; excludes: string[] }): ContextView {
  return {
    selection,
    stats: {
      totalTokens: 1200,
      segments: { system: 0, compactionSummary: 100, toolResults: 700, messages: 400, repoMap: 0, other: 0 },
      pinnedTokens: 50,
      buildMs: 1.5,
      incremental: true,
    },
    ledger: {
      usage: { inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0 },
      cost: { usdMicroUnits: "0", cnyMicroUnits: "0", unpricedTokens: 0 },
      entries: [],
    },
    preferences: { language: "zh", currency: "CNY", currencyLabel: "RMB" },
  };
}

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ContextPanel sessionId={session.id} session={session} running={false} onNotice={() => undefined} />
    </QueryClientProvider>,
  );
}

describe("ContextPanel 选择性上下文", () => {
  afterEach(() => vi.restoreAllMocks());

  it("展示按段归因、pin/排除清单，并支持添加与移除", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: ["m-1"], excludes: ["**/*.log"] }));
    const update = vi.spyOn(api, "updateContextSelection").mockResolvedValue({ pins: ["m-1", "src/a.ts"], excludes: ["**/*.log"] });

    renderPanel();

    // 按段 token 归因与构建诊断
    expect(await screen.findByText("按段 token 归因")).toBeInTheDocument();
    expect(screen.getByText("工具结果")).toBeInTheDocument();
    expect(screen.getByText(/增量复用/)).toBeInTheDocument();
    // 排除不是安全边界的提示
    expect(screen.getByText(/排除不是安全边界/)).toBeInTheDocument();
    // 现有清单
    expect(screen.getByText("m-1")).toBeInTheDocument();
    expect(screen.getByText("**/*.log")).toBeInTheDocument();

    // 添加 pin
    fireEvent.change(screen.getByLabelText("新增 pin"), { target: { value: "src/a.ts" } });
    fireEvent.click(screen.getByRole("button", { name: "添加 pin" }));
    await waitFor(() => expect(update).toHaveBeenCalledWith(session.id, { pins: ["m-1", "src/a.ts"], excludes: ["**/*.log"] }));
  });

  it("移除排除路径", async () => {
    vi.spyOn(api, "context").mockResolvedValue(contextView({ pins: [], excludes: ["**/*.log", "docs/**"] }));
    const update = vi.spyOn(api, "updateContextSelection").mockResolvedValue({ pins: [], excludes: ["docs/**"] });

    renderPanel();
    expect(await screen.findByText("**/*.log")).toBeInTheDocument();
    const row = screen.getByText("**/*.log").closest(".context-entry")!;
    fireEvent.click(row.querySelector("button")!);
    await waitFor(() => expect(update).toHaveBeenCalledWith(session.id, { pins: [], excludes: ["docs/**"] }));
  });
});
