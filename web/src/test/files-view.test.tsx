import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { FilesView } from "../workbench/sidebar/FilesView";
import { renderWithClient } from "./helpers/with-client";
// 文件树：目录优先 + 名称排序、目录条目截断提示、目录读查询 staleTime（切回视图不重拉）。
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("FilesView", () => {
  it("条目按「目录在前、名称升序」渲染；截断提示与空目录空态；目录读查询带 staleTime（重复挂载不重拉）", async () => {
    const listFiles = vi.spyOn(api, "listFiles").mockResolvedValue({
      truncated: false,
      entries: [{ name: "b.txt", type: "file", size: 12 }, { name: "zz", type: "directory", size: 0 }, { name: "a.txt", type: "file", size: 3 }, { name: "aa", type: "directory", size: 0 }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = renderWithClient(<FilesView sessionId="s1" />, client);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeInTheDocument());
    const text = view.container.textContent ?? "";
    expect(text.indexOf("aa")).toBeLessThan(text.indexOf("zz"));
    expect(text.indexOf("zz")).toBeLessThan(text.indexOf("a.txt")); expect(text.indexOf("a.txt")).toBeLessThan(text.indexOf("b.txt"));
    view.unmount();
    renderWithClient(<FilesView sessionId="s1" />, client);
    await waitFor(() => expect(screen.getByText("a.txt")).toBeInTheDocument());
    expect(listFiles.mock.calls.length).toBe(1);
    cleanup();
    vi.spyOn(api, "listFiles").mockResolvedValue({ truncated: true, entries: [{ name: "only.txt", type: "file", size: 1 }] });
    renderWithClient(<FilesView sessionId="s1" />);
    await waitFor(() => expect(screen.getByText(/仅列出前一部分/)).toBeInTheDocument());
    cleanup();
    vi.spyOn(api, "listFiles").mockResolvedValue({ truncated: false, entries: [] });
    renderWithClient(<FilesView sessionId="s1" />);
    await waitFor(() => expect(screen.getByText("（空目录）")).toBeInTheDocument());
  });
});
