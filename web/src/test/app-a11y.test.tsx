import * as axeCore from "axe-core";
import { render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { Checkpoint, ContextView, ModelProfile, SessionDetail } from "../lib/contracts";

// 固定的会话/上下文/模型数据，避免依赖网络
function mockSession(overrides: Partial<SessionDetail> = {}): SessionDetail {
  return {
    id: "s1",
    cwd: "/workspace/project",
    provider: "anthropic",
    model: "claude-opus-4-8",
    thinking: "adaptive",
    effort: "high",
    permissionMode: "ask",
    title: "无障碍测试作业",
    createdAt: "2026-07-17T00:00:00.000Z",
    updatedAt: "2026-07-17T00:00:00.000Z",
    sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: ["/workspace/project/.env"], network: "deny" },
    messages: [
      { id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建 src/result.txt" }] },
      { id: "m2", role: "assistant", createdAt: "2026-07-17T00:00:01.000Z", content: [{ type: "text", text: "我来创建该文件。" }] },
    ],
    ...overrides,
  };
}

const models: ModelProfile[] = [
  { id: "claude-opus-4-8", provider: "anthropic", displayName: "Claude Opus 4.8", contextWindow: 1_000_000, maxOutput: 128_000, capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high", "xhigh"], modalities: ["text", "image"], imageOutput: false, tools: true } },
  { id: "claude-haiku-4-5", provider: "anthropic", displayName: "Claude Haiku 4.5", contextWindow: 200_000, maxOutput: 128_000, capabilities: { thinking: ["disabled"], effort: ["low", "medium"], modalities: ["text", "image"], imageOutput: false, tools: true } },
];

const context: ContextView = {
  ledger: {
    usage: { inputTokens: 1200, outputTokens: 80, cacheRead: 200, cacheWrite: 40 },
    cost: { usdMicroUnits: "6100", cnyMicroUnits: "44300", unpricedTokens: 0 },
    entries: [{ messageId: "m1", state: "full", artifactId: "artifact-0" }],
    cleared: { uptoIndex: 2, at: "2026-07-17T00:00:02.000Z" },
  },
  preferences: { language: "zh-CN", currency: "CNY", currencyLabel: "￥" },
};

const checkpoints: Checkpoint[] = [
  { id: "c1", label: "初始检查点", createdAt: "2026-07-17T00:00:00.000Z", messageCount: 1 },
];

function installFetchMock(overrides: Partial<SessionDetail> = {}): void {
  const session = mockSession(overrides);
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.includes("/api/sessions/s1/context")) return json(context);
    if (url.includes("/api/sessions/s1/checkpoints") && url.includes("/diff")) return json({ diff: "diff --git a/x b/y\n-line\n+line" });
    if (url.includes("/api/sessions/s1/checkpoints")) return json(checkpoints);
    if (url.includes("/api/sessions/s1/snapshot-capability")) return json({ backend: "git-shadow", costHint: "linear", requiresAdmin: false });
    if (url.includes("/api/sessions/s1/files/content")) return json({ content: "文件内容预览", encoding: "utf-8", truncated: false });
    if (url.includes("/api/sessions/s1/files")) return json({ entries: [{ name: "src", type: "directory", size: 0 }, { name: "README.md", type: "file", size: 12 }], truncated: false });
    if (url.endsWith("/api/models")) return json(models);
    if (url.endsWith("/api/providers")) return json(["anthropic"]);
    if (url.endsWith("/api/sandbox/capabilities")) return json({ appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试环境" } });
    if (url.includes("/api/sessions/s1/steering")) return json([]);
    if (url.includes("/api/sessions/s1/permissions")) return json([]);
    if (url.match(/\/api\/sessions\/s1(\?.*)?$/)) return json(session);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}

function renderApp(): ReturnType<typeof render> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <App />
    </QueryClientProvider>,
  );
}

describe("App accessibility", () => {
  // App 的 useEffect 会创建真实 WebSocket；jsdom 下会连接失败并触发 onclose → 重连定时器，
  // 可能在组件卸载后才触发，泄漏到后续测试。这里用一个空壳 WebSocket 替换，避免真实连接与重连。
  let originalWebSocket: typeof WebSocket;
  beforeEach(() => {
    originalWebSocket = globalThis.WebSocket;
    class StubWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      onopen: ((ev: Event) => void) | null = null;
      onmessage: ((ev: MessageEvent) => void) | null = null;
      onclose: ((ev: CloseEvent) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      close(): void { this.readyState = 3; }
      send(): void { /* no-op */ }
      addEventListener(): void { /* no-op */ }
      removeEventListener(): void { /* no-op */ }
    }
    vi.stubGlobal("WebSocket", StubWebSocket);
    // jsdom 不实现 matchMedia；App 未直接使用，但 React 生态测试偶有依赖
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({ matches: false, media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; } })) as unknown as typeof window.matchMedia;
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.WebSocket = originalWebSocket;
  });

  it("empty state has no axe violations", async () => {
    installFetchMock();
    const { container } = renderApp();
    // aria-allowed-role 关闭：Composer 的 textarea 有意使用 role="combobox"（@/斜杠补全），
    // html-aria 尚未允许该组合（w3c/html-aria#543），属有意为之而非违规
    const results = await axeCore.run(container, { rules: { "aria-allowed-role": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });

  it("active session workspace has no axe violations", async () => {
    installFetchMock();
    const { container, findAllByText } = renderApp();
    // 等待会话加载，确保执行轨道、清空边界与检查器渲染
    await findAllByText(/无障碍测试作业/);
    expect(await findAllByText("上下文已清空（历史保留）")).toHaveLength(1);
    const results = await axeCore.run(container, { rules: { "aria-allowed-role": { enabled: false } } });
    expect(results.violations).toEqual([]);
  });
});
