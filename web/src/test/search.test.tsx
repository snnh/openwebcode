import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ConversationSearchBar, findMatches, highlightArticle, unwrapSearchMarks } from "../chat/search";
import type { ChatMessage } from "../lib/contracts";

function msg(id: string, role: ChatMessage["role"], text: string): ChatMessage {
  return { id, role, createdAt: "2026-07-20T00:00:00.000Z", content: [{ type: "text", text }] };
}

describe("findMatches", () => {
  it("counts case-insensitive occurrences with per-message occurrence index", () => {
    const matches = findMatches([msg("m1", "user", "Hello hello HELLO")], "hello");
    expect(matches).toEqual([
      { messageId: "m1", occurrence: 0 },
      { messageId: "m1", occurrence: 1 },
      { messageId: "m1", occurrence: 2 },
    ]);
  });

  it("matches user and assistant text blocks, skips tool messages and empty queries", () => {
    const messages = [
      msg("m1", "user", "目标"),
      msg("m2", "assistant", "回答里有目标"),
      msg("m3", "tool", "目标"),
    ];
    expect(findMatches(messages, "目标")).toEqual([
      { messageId: "m1", occurrence: 0 },
      { messageId: "m2", occurrence: 0 },
    ]);
    expect(findMatches(messages, "")).toEqual([]);
    expect(findMatches(messages, "不存在")).toEqual([]);
  });
});

describe("highlightArticle / unwrapSearchMarks", () => {
  function articleWith(text: string): HTMLElement {
    const article = document.createElement("article");
    const markdown = document.createElement("div");
    markdown.className = "markdown";
    markdown.textContent = text;
    article.appendChild(markdown);
    return article;
  }

  it("wraps every hit in a mark and flags the active occurrence", () => {
    const article = articleWith("foo bar Foo");
    highlightArticle(article, "foo", 1);
    const marks = article.querySelectorAll("mark.conv-search-hit");
    expect(marks).toHaveLength(2);
    expect(marks[0]).not.toHaveClass("active");
    expect(marks[1]).toHaveClass("active");
    expect(article.textContent).toBe("foo bar Foo");
  });

  it("unwrap restores the original text nodes", () => {
    const article = articleWith("foo bar foo");
    highlightArticle(article, "foo", -1);
    expect(article.querySelectorAll("mark")).toHaveLength(2);
    unwrapSearchMarks(article);
    expect(article.querySelectorAll("mark")).toHaveLength(0);
    expect(article.textContent).toBe("foo bar foo");
    // normalize 后被拆分的文本节点合并还原
    expect(article.querySelector(".markdown")!.childNodes).toHaveLength(1);
  });
});

describe("ConversationSearchBar", () => {
  function renderBar(overrides: Partial<Parameters<typeof ConversationSearchBar>[0]> = {}) {
    const props = {
      query: "目标",
      onQueryChange: vi.fn(),
      current: 0,
      total: 3,
      onNext: vi.fn(),
      onPrev: vi.fn(),
      onClose: vi.fn(),
      ...overrides,
    };
    return { ...render(<ConversationSearchBar {...props} />), props };
  }

  it("shows the match counter and loaded-only hint", () => {
    const { getByText } = renderBar({ loadedOnly: true });
    expect(getByText("1/3")).toBeInTheDocument();
    expect(getByText("仅搜索已加载消息")).toBeInTheDocument();
  });

  it("emits query changes and keyboard navigation", () => {
    const { getByLabelText, props } = renderBar();
    const input = getByLabelText("在对话中搜索");
    fireEvent.change(input, { target: { value: "新词" } });
    expect(props.onQueryChange).toHaveBeenCalledWith("新词");
    fireEvent.keyDown(input, { key: "Enter" });
    expect(props.onNext).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(props.onPrev).toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalled();
  });

  it("disables navigation when there are no matches and supports close", () => {
    const { getByLabelText, props } = renderBar({ query: "目标", total: 0 });
    expect(getByLabelText("上一个")).toBeDisabled();
    expect(getByLabelText("下一个")).toBeDisabled();
    expect(props.onClose).not.toHaveBeenCalled();
    fireEvent.click(getByLabelText("关闭"));
    expect(props.onClose).toHaveBeenCalled();
  });

  it("shows 无结果 for a query without matches", () => {
    const { getByText } = renderBar({ query: "目标", total: 0 });
    expect(getByText("无结果")).toBeInTheDocument();
  });

  it("focuses the input on mount / focusSignal bump", () => {
    const { getByLabelText, rerender, props } = renderBar({ focusSignal: 0 });
    const input = getByLabelText("在对话中搜索");
    expect(document.activeElement).toBe(input);
    (document.activeElement as HTMLElement).blur();
    rerender(<ConversationSearchBar {...props} focusSignal={1} />);
    expect(document.activeElement).toBe(input);
  });
});
