import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BottomPanel } from "../workbench/BottomPanel";
import { layoutStore } from "../workbench/layout";

vi.mock("../app/queries", () => ({
  useSessionsQuery: () => ({ data: undefined }),
  useContextViewQuery: () => ({ data: undefined }),
  useModelsQuery: () => ({ data: undefined }),
  useExtensionsQuery: () => ({ data: undefined, isSuccess: false }),
}));

describe("BottomPanel 移动端标签条", () => {
  beforeEach(() => {
    window.localStorage.clear();
    layoutStore.set({ bottomOpen: false, bottomTab: "context", bottomHeight: 260 });
  });

  it("「更多标签」用省略号，与面板开合的 chevron 区分", () => {
    render(<BottomPanel sessionId="s1" mobile />);

    const more = screen.getByRole("button", { name: "更多面板标签" });
    expect(more.querySelector("use")?.getAttribute("href")).toBe("#owc-i-more");

    const fold = screen.getByRole("button", { name: "展开面板" });
    expect(fold.querySelector("use")?.getAttribute("href")).toBe("#owc-i-chevron-up");

    fireEvent.click(more);
    const collapseMore = screen.getByRole("button", { name: "收起更多面板标签" });
    expect(collapseMore.querySelector("use")?.getAttribute("href")).toBe("#owc-i-more");
    expect(screen.getByText("子代理")).toBeInTheDocument();
  });
});
