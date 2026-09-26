import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { api } from "../lib/api";
import { FilesView } from "../workbench/sidebar/FilesView";

/**
 * 文件树：目录优先 + 名称排序（排序结果按 entries 记忆化）、目录条目截断提示、
 * 目录读查询带 staleTime（切回视图/展开折叠不再每次重拉）。
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <FilesView sessionId="s1" />
    </QueryClientProvider>,
  );
}

describe("FilesView", () => {
  it("条目按「目录在前、名称升序」渲染", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({
      truncated: false,
      entries: [
        { name: "b.txt", type: "file", size: 12 },
        { name: "zz", type: "directory", size: 0 },
        { name: "a.txt", type: "file", size: 3 },
        { name: "aa", type: "directory", size: 0 },
      ],
    });
    const { container } = renderView();
    await waitFor(() => expect(container.querySelectorAll(".file-row")).toHaveLength(4));
    const names = [...container.querySelectorAll(".file-name")].map((node) => node.textContent);
    expect(names).toEqual(["aa", "zz", "a.txt", "b.txt"]);
  });

  it("命中目录条目上限时给出提示（此前静默丢弃剩余条目）", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({
      truncated: true,
      entries: [{ name: "only.txt", type: "file", size: 1 }],
    });
    renderView();
    await waitFor(() => expect(screen.getByText(/仅列出前一部分/)).toBeInTheDocument());
  });

  it("未截断时不显示提示；空目录显示空态", async () => {
    vi.spyOn(api, "listFiles").mockResolvedValue({ truncated: false, entries: [] });
    renderView();
    await waitFor(() => expect(screen.getByText("（空目录）")).toBeInTheDocument());
    expect(screen.queryByText(/仅列出前一部分/)).not.toBeInTheDocument();
  });

  it("目录读查询带 staleTime：重复挂载不重新拉取", async () => {
    const listFiles = vi.spyOn(api, "listFiles").mockResolvedValue({
      truncated: false,
      entries: [{ name: "a.txt", type: "file", size: 1 }],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const view = render(
      <QueryClientProvider client={client}>
        <FilesView sessionId="s1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(listFiles).toHaveBeenCalledTimes(1));
    view.unmount();
    render(
      <QueryClientProvider client={client}>
        <FilesView sessionId="s1" />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText("a.txt")).toBeInTheDocument());
    // 缓存仍新鲜（staleTime > 0），重挂载不再重复请求
    expect(listFiles).toHaveBeenCalledTimes(1);
  });
});
