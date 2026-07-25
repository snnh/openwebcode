import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MessageCard } from "../components/MessageCard";
import type { ChatMessage } from "../lib/contracts";

function message(role: ChatMessage["role"], texts: string[]): ChatMessage {
  return {
    id: "message-1",
    role,
    createdAt: "2026-07-20T00:00:00.000Z",
    content: texts.map((text) => ({ type: "text", text })),
  };
}

describe("MessageCard", () => {
  it("renders persisted assistant stream fragments as one markdown block", () => {
    const { container } = render(<MessageCard message={message("assistant", ["探索", "代码", "库", "，", "我都可以", "帮忙。"])} />);

    expect(container.querySelectorAll(".markdown")).toHaveLength(1);
    expect(container.querySelector(".markdown")).toHaveTextContent("探索代码库，我都可以帮忙。");
  });

  it("keeps separate user text blocks separate", () => {
    const { container } = render(<MessageCard message={message("user", ["引用文件内容", "用户问题"])} />);

    expect(container.querySelectorAll(".markdown")).toHaveLength(2);
  });

  it("shows markdown-capable thinking in a collapsed, separate block", async () => {
    const thinkingMessage: ChatMessage = {
      ...message("assistant", ["最终答案"]),
      content: [
        { type: "thinking", text: "先计算 $x^2$" },
        { type: "text", text: "最终答案" },
      ],
    };
    const { container, getByText } = render(<MessageCard message={thinkingMessage} />);
    const details = container.querySelector("details.thinking");

    expect(details).toBeInTheDocument();
    expect(details).not.toHaveAttribute("open");
    expect(getByText("思考过程")).toBeInTheDocument();
    // Markdown 懒加载，等待 KaTeX 渲染完成
    await waitFor(() => expect(details?.querySelector(".katex")).toBeInTheDocument());
  });
});
