import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProblemsPanel } from "../components/panels/ProblemsPanel";
import { ActivityBar } from "../workbench/ActivityBar";
import { api, ApiError } from "../lib/api";
import type { DiagnosticSet } from "../lib/contracts";

const diagnostics: DiagnosticSet = {
  tool: "vitest",
  summary: { passed: 8, failed: 3, skipped: 1, durationMs: 1534 },
  failures: [
    { name: "renders header", file: "src/app.test.ts", line: 12, column: 5, message: "expected true to be false", excerpt: "expect(x).toBe(false)" },
    { name: "parses output", file: "src/parser.test.ts", line: 40, message: "timeout of 2000ms exceeded" },
    { name: "lint style", file: "src/parser.test.ts", message: "warning: prefer const" },
    { name: "suite setup", message: "failed to start worker" },
  ],
};

function renderPanel(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProblemsPanel sessionId="s1" />
    </QueryClientProvider>,
  );
}

describe("ProblemsPanel", () => {
  afterEach(() => vi.restoreAllMocks());

  it("按文件分组展示 failures，标注来源工具与汇总", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderPanel();

    expect(await screen.findByText("src/app.test.ts")).toBeInTheDocument();
    expect(screen.getByText("src/parser.test.ts")).toBeInTheDocument();
    expect(screen.getByText("（未定位到文件）")).toBeInTheDocument();
    expect(screen.getByText("vitest")).toBeInTheDocument();
    expect(screen.getByText(/通过 8 · 失败 3 · 跳过 1/)).toBeInTheDocument();
    expect(screen.getByText("renders header")).toBeInTheDocument();
    expect(screen.getByText(":12:5")).toBeInTheDocument();
    // 每个文件组的失败计数
    expect(screen.getByText("src/parser.test.ts").parentElement?.textContent).toContain("2");
  });

  it("404（无诊断记录）时展示空态", async () => {
    vi.spyOn(api, "latestDiagnostics").mockRejectedValue(new ApiError(404, "not found"));
    renderPanel();
    expect(await screen.findByText(/暂无问题/)).toBeInTheDocument();
  });

  it("严重度过滤：错误/警告两档", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderPanel();

    fireEvent.click(await screen.findByRole("button", { name: /^错误 3$/ }));
    expect(screen.getByText("renders header")).toBeInTheDocument();
    expect(screen.queryByText("lint style")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^警告 1$/ }));
    expect(screen.getByText("lint style")).toBeInTheDocument();
    expect(screen.queryByText("renders header")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^全部 4$/ }));
    expect(screen.getByText("renders header")).toBeInTheDocument();
    expect(screen.getByText("lint style")).toBeInTheDocument();
  });

  it("点击条目在只读代码视图中打开对应文件行列", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    const readFile = vi.spyOn(api, "readFile").mockResolvedValue({ content: "line1\nline2\nline3", encoding: "utf-8", truncated: false, revision: "0".repeat(64) });
    renderPanel();

    fireEvent.click(await screen.findByText("parses output"));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("s1", "src/parser.test.ts"));
    expect(await screen.findByLabelText("查看 src/parser.test.ts")).toBeInTheDocument();
    expect(screen.getByText("src/parser.test.ts:40")).toBeInTheDocument();
  });

  it("未定位到文件的条目不可点击", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    const readFile = vi.spyOn(api, "readFile");
    renderPanel();

    const item = (await screen.findByText("suite setup")).closest("button")!;
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(readFile).not.toHaveBeenCalled();
  });
});

describe("Problems 角标（0.4.0 Phase 5a：角标迁至活动栏）", () => {
  function renderBar(badge: number, activeView: "sessions" | "problems" = "sessions", sidebarVisible = true): { onShowView: ReturnType<typeof vi.fn> } {
    const onShowView = vi.fn();
    render(
      <ActivityBar
        activeView={activeView}
        sidebarVisible={sidebarVisible}
        problemsBadge={badge}
        onShowView={onShowView}
        onShowCommands={() => undefined}
        onShowNotifications={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    return { onShowView };
  }

  it("有未查看失败且未打开问题视图时，活动栏图标显示角标计数，不弹窗", () => {
    renderBar(3);
    expect(screen.getByLabelText("3 个新问题")).toBeInTheDocument();
  });

  it("角标为 0 或问题视图已激活时不显示", () => {
    const first = render(
      <ActivityBar activeView="sessions" sidebarVisible problemsBadge={0} onShowView={() => undefined} onShowCommands={() => undefined} onShowNotifications={() => undefined} onOpenSettings={() => undefined} />,
    );
    expect(screen.queryByLabelText(/个新问题/)).not.toBeInTheDocument();
    first.unmount();
    render(
      <ActivityBar activeView="problems" sidebarVisible problemsBadge={2} onShowView={() => undefined} onShowCommands={() => undefined} onShowNotifications={() => undefined} onOpenSettings={() => undefined} />,
    );
    expect(screen.queryByLabelText(/个新问题/)).not.toBeInTheDocument();
  });

  it("点击问题图标打开问题视图（App 侧清除角标）", () => {
    const { onShowView } = renderBar(2);
    fireEvent.click(screen.getByRole("button", { name: "问题" }));
    expect(onShowView).toHaveBeenCalledWith("problems");
  });
});
