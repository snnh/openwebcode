import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoMessageCard } from "../components/MessageCard";
import { clearHighlightCache, highlightCode } from "../highlight";
import type { ChatMessage } from "../lib/contracts";

// 用计数替身替换 Markdown 组件（react-markdown/katex 重，且本测试只关心渲染次数）。
// 注意：mock 整个 Markdown 模块而非懒加载的 MarkdownImpl——已 resolve 的 Suspense 边界
// 在父树重渲染时会被 React 重放一次，属于渲染器内部行为，与消息卡片缓存无关。
const markdownSpy = vi.hoisted(() => ({ renders: 0 }));
vi.mock("../components/Markdown", () => ({
  Markdown: ({ children }: { children: string }) => {
    markdownSpy.renders += 1;
    return <div className="markdown">{children}</div>;
  },
  CodeBlock: () => <pre className="code-block" />,
}));

// 高亮器替身：codeToHtml 计数，验证相同代码块不重复高亮
const highlighterSpy = vi.hoisted(() => ({ codeToHtml: vi.fn(async () => "<code>highlighted</code>") }));
vi.mock("../shiki-highlighter", () => ({
  createOwcHighlighter: async () => ({
    loadLanguage: async () => undefined,
    codeToHtml: highlighterSpy.codeToHtml,
  }),
}));

function message(id: string, text: string): ChatMessage {
  return {
    id,
    role: "assistant",
    createdAt: "2026-07-24T00:00:00.000Z",
    content: [{ type: "text", text }],
  };
}

describe("Markdown 渲染缓存", () => {
  beforeEach(() => {
    markdownSpy.renders = 0;
  });

  it("相同 messageId + content 的消息对象重建时不重复渲染 Markdown", async () => {
    const view = render(<MemoMessageCard message={message("m1", "你好")} sessionId="s1" />);
    // Markdown 已 mock 为同步渲染，直接计数
    await waitFor(() => expect(screen.getByText("你好")).toBeInTheDocument());
    const afterFirst = markdownSpy.renders;
    expect(afterFirst).toBeGreaterThan(0);

    // 事件重放/会话刷新会重建消息对象：id 与内容相同，引用不同
    view.rerender(<MemoMessageCard message={message("m1", "你好")} sessionId="s1" />);
    expect(markdownSpy.renders).toBe(afterFirst);

    // 内容变化则重新渲染
    view.rerender(<MemoMessageCard message={message("m1", "你好，世界")} sessionId="s1" />);
    await waitFor(() => expect(markdownSpy.renders).toBeGreaterThan(afterFirst));
  });
});

describe("代码高亮缓存", () => {
  beforeEach(() => {
    clearHighlightCache();
    highlighterSpy.codeToHtml.mockClear();
  });

  it("相同语言与内容的代码块只高亮一次（语言别名归一化）", async () => {
    const first = await highlightCode("const a = 1", "ts");
    const second = await highlightCode("const a = 1", "typescript");
    expect(highlighterSpy.codeToHtml).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
  });

  it("流式代码块内容变化时只对变化后的内容重算", async () => {
    await highlightCode("const a = 1", "ts");
    await highlightCode("const a = 12", "ts");
    expect(highlighterSpy.codeToHtml).toHaveBeenCalledTimes(2);
    // 已完成的块再次挂载命中缓存，不重算
    await highlightCode("const a = 1", "ts");
    expect(highlighterSpy.codeToHtml).toHaveBeenCalledTimes(2);
  });

  it("不支持的语言直接返回 undefined 且不进入缓存", async () => {
    expect(await highlightCode("plain text", "brainfuck")).toBeUndefined();
    expect(highlighterSpy.codeToHtml).not.toHaveBeenCalled();
  });
});
