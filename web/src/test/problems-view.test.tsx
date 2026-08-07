import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";
import { api, ApiError } from "../lib/api";
import type { DiagnosticSet } from "../lib/contracts";
import { auxViewsStore } from "../workbench/aux-views";
import { ProblemsView } from "../workbench/sidebar/ProblemsView";
import { renderWithClient } from "./helpers/with-client";

const diagnostics: DiagnosticSet = {
  tool: "vitest",
  summary: { passed: 8, failed: 3, skipped: 1, durationMs: 1534 },
  failures: [
    { name: "renders header", file: "src/app.test.ts", line: 12, column: 5, message: "expected true to be false" },
    { name: "parses output", file: "src/parser.test.ts", line: 40, message: "timeout of 2000ms exceeded" },
    { name: "lint style", file: "src/parser.test.ts", message: "warning: prefer const" },
    { name: "suite setup", message: "failed to start worker" },
  ],
};

function renderView(sessionId?: string) {
  return renderWithClient(<ProblemsView sessionId={sessionId} />);
}

describe("ProblemsView", () => {
  beforeEach(() => {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
  });
  afterEach(() => vi.restoreAllMocks());

  it("无会话时显示空态", () => {
    renderView(undefined);
    expect(screen.getByText("选择会话以查看诊断问题。")).toBeInTheDocument();
  });

  it("按文件分组展示 failures，标注来源工具与汇总", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderView("s1");

    expect(await screen.findByText("src/app.test.ts")).toBeInTheDocument();
    expect(screen.getByText("src/parser.test.ts")).toBeInTheDocument();
    expect(screen.getByText("（未定位到文件）")).toBeInTheDocument();
    expect(screen.getByText("vitest")).toBeInTheDocument();
    expect(screen.getByText(/通过 8 · 失败 3 · 跳过 1/)).toBeInTheDocument();
    expect(screen.getByText(":12:5")).toBeInTheDocument();
    // 每个文件组的失败计数
    expect(screen.getByText("src/parser.test.ts").parentElement?.textContent).toContain("2");
  });

  it("404（无诊断记录）按空态处理", async () => {
    vi.spyOn(api, "latestDiagnostics").mockRejectedValue(new ApiError(404, "not found"));
    renderView("s1");
    expect(await screen.findByText(/暂无问题/)).toBeInTheDocument();
  });

  it("非 404 错误显示行内错误（role=alert）", async () => {
    vi.spyOn(api, "latestDiagnostics").mockRejectedValue(new ApiError(500, "服务异常"));
    renderView("s1");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取诊断结果：服务异常");
  });

  it("严重度过滤：错误/警告/全部三档", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderView("s1");

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

  it("点击条目在编辑器分栏打开对应文件行列（auxViews.openEditor）", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderView("s1");

    fireEvent.click(await screen.findByText("renders header"));
    expect(auxViewsStore.get().editor).toEqual({ path: "src/app.test.ts", line: 12, column: 5 });

    fireEvent.click(screen.getByText("parses output"));
    expect(auxViewsStore.get().editor).toEqual({ path: "src/parser.test.ts", line: 40 });
  });

  it("未定位到文件的条目不可点击", async () => {
    vi.spyOn(api, "latestDiagnostics").mockResolvedValue(diagnostics);
    renderView("s1");

    const item = (await screen.findByText("suite setup")).closest("button")!;
    expect(item).toBeDisabled();
    fireEvent.click(item);
    expect(auxViewsStore.get().editor).toBeUndefined();
  });
});
