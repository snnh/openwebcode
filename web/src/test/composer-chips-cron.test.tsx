import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerChips } from "../components/ComposerChips";
import { api } from "../lib/api";
import type { CronJobInfo } from "../lib/contracts";

vi.mock("../lib/api", () => ({
  api: {
    tasks: vi.fn(async () => []),
    todos: vi.fn(async () => []),
    cronJobs: vi.fn(async () => [] as CronJobInfo[]),
    createCronJob: vi.fn(),
    deleteCronJob: vi.fn(async () => undefined),
  },
}));

const apiMock = vi.mocked(api);

function job(overrides: Partial<CronJobInfo>): CronJobInfo {
  return {
    id: "job-1",
    cron: "*/5 * * * *",
    prompt: "检查构建状态",
    recurring: true,
    createdAt: "2026-07-30T00:00:00.000Z",
    nextFireAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    stale: false,
    ...overrides,
  };
}

function renderChips(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node: ReactElement = <ComposerChips sessionId="s1" />;
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("ComposerChips 定时芯片", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMock.cronJobs.mockResolvedValue([]);
    apiMock.deleteCronJob.mockResolvedValue(undefined);
  });

  it("零任务时芯片可点（添加表单可用），列出空态与表单", async () => {
    renderChips();
    const chip = await screen.findByRole("button", { name: /定时/ });
    expect(chip).toBeEnabled();
    expect(chip).toHaveTextContent("(0)");
    fireEvent.click(chip);
    expect(screen.getByText("暂无定时任务")).toBeInTheDocument();
    expect(screen.getByLabelText("cron 表达式")).toBeInTheDocument();
    expect(screen.getByLabelText("提示词")).toBeInTheDocument();
  });

  it("浮层列出任务：人类化简述 + 原文 + 相对触发时间 + stale 标记", async () => {
    apiMock.cronJobs.mockResolvedValue([
      job({}),
      job({ id: "job-2", cron: "0 9 * * *", prompt: "日报", stale: true, nextFireAt: null }),
      job({ id: "job-3", cron: "17 3 2 8 4", prompt: "非常规", nextFireAt: new Date(Date.now() + 26 * 3_600_000).toISOString() }),
    ]);
    renderChips();
    const chip = await screen.findByRole("button", { name: /定时/ });
    await waitFor(() => expect(chip).toHaveTextContent("(3)"));
    fireEvent.click(chip);
    expect(screen.getByText(/每 5 分钟/)).toBeInTheDocument();
    expect(screen.getByText(/· \*\/5 \* \* \* \*/)).toBeInTheDocument();
    expect(screen.getByText("最后一次")).toBeInTheDocument();
    // 未识别形态回退展示原文
    expect(screen.getByText("17 3 2 8 4")).toBeInTheDocument();
  });

  it("删除按钮调用 api 并刷新列表", async () => {
    apiMock.cronJobs.mockResolvedValue([job({})]);
    renderChips();
    fireEvent.click(await screen.findByRole("button", { name: /定时/ }));
    fireEvent.click(await screen.findByRole("button", { name: "删除定时任务" }));
    await waitFor(() => expect(apiMock.deleteCronJob).toHaveBeenCalledWith("s1", "job-1"));
    await waitFor(() => expect(apiMock.cronJobs.mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("手动添加：提交表达式 + 提示词 + 是否重复", async () => {
    apiMock.createCronJob.mockResolvedValue(job({ id: "job-new" }));
    renderChips();
    fireEvent.click(await screen.findByRole("button", { name: /定时/ }));
    fireEvent.change(screen.getByLabelText("cron 表达式"), { target: { value: "0 9 * * 1-5" } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "写日报" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    await waitFor(() =>
      expect(apiMock.createCronJob).toHaveBeenCalledWith("s1", { cron: "0 9 * * 1-5", prompt: "写日报", recurring: true }));
  });

  it("创建失败展示服务端错误", async () => {
    apiMock.createCronJob.mockRejectedValue(new Error("Cron minute value out of range 0-59"));
    renderChips();
    fireEvent.click(await screen.findByRole("button", { name: /定时/ }));
    fireEvent.change(screen.getByLabelText("cron 表达式"), { target: { value: "61 * * * *" } });
    fireEvent.change(screen.getByLabelText("提示词"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "添加" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("out of range");
  });
});
