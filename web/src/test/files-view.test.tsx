import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { api, ApiError } from "../lib/api";
import type { FileEntry } from "../lib/contracts";
import { auxViewsStore } from "../workbench/aux-views";
import { FilesView } from "../workbench/sidebar/FilesView";
import { renderWithClient } from "./helpers/with-client";

const entry = (name: string, type: FileEntry["type"], size = 10): FileEntry => ({ name, type, size });

function renderView(sessionId?: string) {
  return renderWithClient(<FilesView sessionId={sessionId} />);
}

describe("FilesView", () => {
  beforeEach(() => {
    auxViewsStore.set({ editor: undefined, diff: undefined, codeOverlay: undefined });
  });
  afterEach(() => vi.restoreAllMocks());

  it("无会话时显示空态", () => {
    renderView(undefined);
    expect(screen.getByText("选择会话以浏览工作区文件。")).toBeInTheDocument();
  });

  it("目录树：目录优先排序，展开目录加载子级", async () => {
    vi.spyOn(api, "listFiles").mockImplementation((_id, path = ".") => Promise.resolve({
      entries: path === "."
        ? [entry("zeta.txt", "file"), entry("docs", "directory"), entry("alpha.ts", "file", 2048)]
        : [entry("readme.md", "file", 12)],
      truncated: false,
    }));
    renderView("s1");

    const rows = await screen.findAllByRole("button", { name: /zeta\.txt|docs|alpha\.ts/ });
    expect(rows[0]).toHaveTextContent("docs");
    expect(rows[1]).toHaveTextContent("alpha.ts");
    expect(rows[2]).toHaveTextContent("zeta.txt");

    fireEvent.click(screen.getByRole("button", { name: /docs/ }));
    expect(await screen.findByText("readme.md")).toBeInTheDocument();
  });

  it("目录读取失败显示行内错误（role=alert）", async () => {
    vi.spyOn(api, "listFiles").mockRejectedValue(new ApiError(500, "磁盘错误"));
    renderView("s1");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("无法读取目录：磁盘错误");
  });

  it("空目录显示占位提示", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [], truncated: false });
    renderView("s1");
    expect(await screen.findByText("（空目录）")).toBeInTheDocument();
  });

  it("点击文件显示文本预览；「在编辑器中打开」跳编辑器分栏", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("main.ts", "file")], truncated: false });
    vi.spyOn(api, "readFile").mockResolvedValue({ content: "const a = 1;", encoding: "utf-8", truncated: false, revision: "r1" });
    renderView("s1");

    fireEvent.click(await screen.findByText("main.ts"));
    expect(await screen.findByText("const a = 1;")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "在编辑器中打开 main.ts" }));
    expect(auxViewsStore.get().editor).toEqual({ path: "main.ts" });
  });

  it("文本预览读取失败显示错误；非 UTF-8 给出二进制提示", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("bin.dat", "file")], truncated: false });
    vi.spyOn(api, "readFile").mockRejectedValue(new ApiError(422, "not UTF-8 text"));
    renderView("s1");
    fireEvent.click(await screen.findByText("bin.dat"));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("该文件非 UTF-8 文本（可能为二进制），无法预览。");
  });

  it("图片文件走 fileRawUrl 预览，不拉文本内容", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("icon.png", "file")], truncated: false });
    const readFile = vi.spyOn(api, "readFile");
    renderView("s1");
    fireEvent.click(await screen.findByText("icon.png"));
    const img = await screen.findByRole("img", { name: "icon.png" });
    expect(img).toHaveAttribute("src", api.fileRawUrl("s1", "icon.png"));
    expect(readFile).not.toHaveBeenCalled();
  });

  it("截断的长文件显示「加载更多」并追加内容", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("big.log", "file")], truncated: false });
    const readFile = vi.spyOn(api, "readFile")
      .mockResolvedValueOnce({ content: "first\n", encoding: "utf-8", truncated: true, revision: "r1" })
      .mockResolvedValueOnce({ content: "second\n", encoding: "utf-8", truncated: false, revision: "r1" });
    renderView("s1");

    fireEvent.click(await screen.findByText("big.log"));
    fireEvent.click(await screen.findByRole("button", { name: "加载更多" }));
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("s1", "big.log", { offset: 1, limit: 2000 }));
    expect(await screen.findByText(/second/)).toBeInTheDocument();
  });

  it("关闭预览按钮收起预览区", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ entries: [entry("main.ts", "file")], truncated: false });
    vi.spyOn(api, "readFile").mockResolvedValue({ content: "x", encoding: "utf-8", truncated: false, revision: "r1" });
    renderView("s1");
    fireEvent.click(await screen.findByText("main.ts"));
    fireEvent.click(await screen.findByRole("button", { name: "关闭预览" }));
    expect(screen.queryByRole("button", { name: "关闭预览" })).toBeNull();
  });
});
