import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExecutionTrack } from "../components/ExecutionTrack";
import type { ChatMessage, SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "session-1",
  cwd: "C:\\workspace",
  provider: "openai",
  model: "test-model",
  title: "运行失败展示",
  createdAt: "2026-07-21T00:00:00.000Z",
  updatedAt: "2026-07-21T00:00:00.000Z",
  sandbox: { enabled: true, readRoots: ["C:\\workspace"], writeRoots: ["C:\\workspace"], denyPaths: [], network: "allow" },
  messages: [{ id: "user-1", role: "user", createdAt: "2026-07-21T00:00:00.000Z", content: [{ type: "text", text: "请处理这个任务" }] }],
};

describe("ExecutionTrack failures", () => {
  it("keeps an agent failure visible in the conversation track", () => {
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError={{ message: "Core sandbox configuration failed" }}
        permissions={[]}
        onPermissionDone={() => undefined}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("本轮执行失败");
    expect(screen.getByRole("alert")).toHaveTextContent("Core sandbox configuration failed");
  });

  it("shows an actionable hint and a settings deep-link for an authentication failure", () => {
    const onOpenSettings = vi.fn();
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError={{ message: "invalid api key", kind: "authentication", retryable: false }}
        permissions={[]}
        onPermissionDone={() => undefined}
        onOpenSettings={onOpenSettings}
      />,
    );

    const card = screen.getByRole("alert");
    expect(card).toHaveTextContent("认证失败：请检查 设置 → 模型目录 中的 API Key");
    expect(card).toHaveTextContent("invalid api key");
    fireEvent.click(screen.getByRole("button", { name: "打开模型设置" }));
    expect(onOpenSettings).toHaveBeenCalledWith("models");
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("deep-links invalid_request failures to the models tab", () => {
    const onOpenSettings = vi.fn();
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError={{ message: "unsupported parameter", kind: "invalid_request", retryable: false }}
        permissions={[]}
        onPermissionDone={() => undefined}
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("请求被拒绝：请检查模型 ID 与参数配置");
    fireEvent.click(screen.getByRole("button", { name: "打开模型设置" }));
    expect(onOpenSettings).toHaveBeenCalledWith("models");
  });

  it("offers a retry button for rate-limit failures", () => {
    const onRetryRun = vi.fn();
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError={{ message: "rate limited", kind: "rate_limit", retryable: true }}
        permissions={[]}
        onPermissionDone={() => undefined}
        onRetryRun={onRetryRun}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("服务限流/过载，稍后重试");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetryRun).toHaveBeenCalledTimes(1);
  });

  it("offers a retry button for retryable errors without a kind (e.g. server_restarted)", () => {
    const onRetryRun = vi.fn();
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError={{ message: "The server restarted before this run reached a terminal state", retryable: true }}
        permissions={[]}
        onPermissionDone={() => undefined}
        onRetryRun={onRetryRun}
      />,
    );

    expect(screen.getByRole("alert").querySelector(".run-error-hint")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(onRetryRun).toHaveBeenCalledTimes(1);
  });

  it("collapses long raw provider blobs behind a details toggle", () => {
    const blob = JSON.stringify({ error: { message: "x".repeat(600) } });
    render(
      <ExecutionTrack
        session={session}
        streamText=""
        runError={{ message: blob, kind: "authentication", retryable: false }}
        permissions={[]}
        onPermissionDone={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );

    const details = screen.getByRole("alert").querySelector("details.run-error-details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent(blob);
  });

  it("virtualizes long message histories instead of mounting every card", () => {
    const longSession: SessionDetail = {
      ...session,
      messages: Array.from({ length: 200 }, (_, index) => ({
        id: `message-${index}`,
        role: "user" as const,
        createdAt: session.createdAt,
        content: [{ type: "text" as const, text: `message ${index}` }],
      })),
    };
    const { container } = render(<ExecutionTrack session={longSession} streamText="" permissions={[]} onPermissionDone={() => undefined} />);
    expect(container.querySelectorAll(".virtual-message-item").length).toBeLessThan(longSession.messages.length);
    expect(container.querySelectorAll(".message").length).toBeLessThan(longSession.messages.length);
  });
});

function makeMessages(count: number): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${index}`,
    role: index % 2 === 0 ? "user" as const : "assistant" as const,
    createdAt: session.createdAt,
    content: [{ type: "text" as const, text: `第 ${index} 条消息` }],
  }));
}

function renderTrack(messages: ChatMessage[]) {
  return render(
    <ExecutionTrack
      session={{ ...session, messages }}
      streamText=""
      permissions={[]}
      onPermissionDone={() => undefined}
    />,
  );
}

/** jsdom 无布局，用可配置 getter 模拟滚动尺寸 */
function stubScrollGeometry(track: HTMLElement, state: { scrollHeight: number; clientHeight: number }): void {
  Object.defineProperty(track, "scrollHeight", { configurable: true, get: () => state.scrollHeight });
  Object.defineProperty(track, "clientHeight", { configurable: true, get: () => state.clientHeight });
}

describe("ExecutionTrack virtualization", () => {
  it("5000 条消息时渲染的 DOM 节点数有界", () => {
    const messages = makeMessages(5000);
    const { container } = renderTrack(messages);
    const rendered = container.querySelectorAll(".virtual-message-item").length;
    expect(rendered).toBeGreaterThan(0);
    // 视口 + overscan 只应渲染几十条，远小于全量 5000
    expect(rendered).toBeLessThan(200);
    expect(container.querySelectorAll("article.message").length).toBeLessThan(200);
  });

  it("停留在底部时新消息到达自动吸底", () => {
    const messages = makeMessages(6);
    const { container, rerender } = renderTrack(messages);
    const track = container.querySelector<HTMLElement>(".execution-track")!;
    const geometry = { scrollHeight: 10_000, clientHeight: 500 };
    stubScrollGeometry(track, geometry);

    // 用户位于底部（距底 < 80px）
    track.scrollTop = 9_600;
    fireEvent.scroll(track);

    // 新消息到达，滚动高度增长
    geometry.scrollHeight = 10_500;
    rerender(
      <ExecutionTrack
        session={{ ...session, messages: [...messages, ...makeMessages(1).map((m) => ({ ...m, id: "new" }))] }}
        streamText=""
        permissions={[]}
        onPermissionDone={() => undefined}
      />,
    );
    expect(track.scrollTop).toBe(10_500);
  });

  it("上翻阅读时不抢滚动，并给出回到底部入口", () => {
    const messages = makeMessages(6);
    const { container, rerender } = renderTrack(messages);
    const track = container.querySelector<HTMLElement>(".execution-track")!;
    const geometry = { scrollHeight: 10_000, clientHeight: 500 };
    stubScrollGeometry(track, geometry);

    // 用户上翻到中部
    track.scrollTop = 100;
    fireEvent.scroll(track);

    geometry.scrollHeight = 10_500;
    rerender(
      <ExecutionTrack
        session={{ ...session, messages: [...messages, ...makeMessages(1).map((m) => ({ ...m, id: "new" }))] }}
        streamText=""
        permissions={[]}
        onPermissionDone={() => undefined}
      />,
    );
    expect(track.scrollTop).toBe(100);
    expect(screen.getByText("回到底部")).toBeInTheDocument();
  });
});
