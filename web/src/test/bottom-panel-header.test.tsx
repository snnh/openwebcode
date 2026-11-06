import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { BottomPanel } from "../workbench/BottomPanel";
import { layoutStore } from "../workbench/layout";

vi.mock("../app/queries", () => ({
  useSessionsQuery: () => ({ data: undefined }),
  useContextViewQuery: () => ({ data: undefined }),
  useModelsQuery: () => ({ data: undefined }),
  useExtensionsQuery: () => ({ data: undefined, isSuccess: false }),
}));

const originalMatchMedia = window.matchMedia;

function stubMatchMedia(matches: (query: string) => boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: matches(query),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

describe("BottomPanel 移动端标签条", () => {
  beforeEach(() => {
    window.localStorage.clear();
    layoutStore.set({ bottomOpen: false, bottomTab: "context", bottomHeight: 260 });
  });

  afterEach(() => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
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

  it("≤560px 展开更多后，第二行标签排在状态行之前", () => {
    stubMatchMedia((query) => query.includes("560"));
    const { container } = render(<BottomPanel sessionId="s1" mobile />);

    fireEvent.click(screen.getByRole("button", { name: "更多面板标签" }));

    const tabs = container.querySelector(".panel-tabs");
    const secondary = container.querySelector(".panel-tabs-secondary-inline");
    const status = container.querySelector(".panel-status");
    expect(tabs).not.toBeNull();
    expect(secondary).not.toBeNull();
    expect(status).not.toBeNull();
    expect(secondary!.parentElement).toBe(tabs);
    expect(status!.parentElement).toBe(tabs);
    // Node.DOCUMENT_POSITION_FOLLOWING = 4
    expect(secondary!.compareDocumentPosition(status!) & 4).toBe(4);
  });
});
