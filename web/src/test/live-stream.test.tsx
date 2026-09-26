import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { LiveStream } from "../chat/LiveStream";
import { ChatActionsContext, type ChatActions, type StreamBlock } from "../chat/types";
import { renderWithClient } from "./helpers/with-client";
function renderStream(node: ReactElement) {
  const actions = { sessionId: "s1", running: true, onNotice: vi.fn() } as unknown as ChatActions;
  return renderWithClient(<ChatActionsContext.Provider value={actions}>{node}</ChatActionsContext.Provider>);
}
const block = (kind: StreamBlock["kind"], id: string, text: string, name?: string): StreamBlock => ({ id, kind, parts: [text], ...(name !== undefined ? { name } : {}) });
describe("LiveStream", () => {
  it("无块时不渲染；text/thinking/tool 块按到达顺序渲染在流式回答内", () => {
    expect(renderStream(<LiveStream blocks={[]} turn={1} />).container.firstChild).toBeNull();
    const { container } = renderStream(<LiveStream blocks={[
      block("text", "text:0", "先给结论"), block("thinking", "thinking:1", "推理过程"),
      block("tool", "t1", '{"command":"ls"}', "bash"), block("text", "text:2", "再看结果"),
    ]} turn={1} />);
    expect(screen.getByText("OpenWebCode")).toBeInTheDocument();
    const text = container.textContent ?? ""; let cursor = 0;
    for (const fragment of ["先给结论", "正在思考", "bash", "再看结果"]) { const at = text.indexOf(fragment); expect(at).toBeGreaterThan(cursor); cursor = at; }
  });
  it("相邻 ≥2 个工具块聚合成组（默认展开），孤立工具块渲染为单行", () => {
    renderStream(<LiveStream blocks={[block("tool", "t1", '{"command":"ls"}', "bash"), block("tool", "t2", '{"path":"a.ts"}', "read_file"), block("text", "text:0", "收尾")]} turn={2} />);
    expect(screen.getByText("2 个工具调用")).toBeInTheDocument();
    const lone = renderStream(<LiveStream blocks={[block("tool", "t1", '{"comm', "bash")]} turn={0} />).container;
    expect(lone.textContent).not.toContain("个工具调用");
    expect(within(lone as HTMLElement).getByText("bash")).toBeInTheDocument();
  });
});
