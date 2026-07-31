import * as axeCore from "axe-core";
import { describe, expect, it } from "vitest";
import type { Checkpoint } from "../lib/contracts";
import { installAppFetchMock } from "./helpers/app-fetch-mock";
import { makeContextView, makeModelProfile, makeSession } from "./helpers/fixtures";
import { setupStubWebSocket } from "./helpers/stub-websocket";
import { renderApp } from "./helpers/with-client";

// 固定的会话/上下文/模型数据，避免依赖网络
const session = makeSession({
  thinking: "adaptive",
  effort: "high",
  permissionMode: "ask",
  title: "无障碍测试作业",
  sandbox: { enabled: true, readRoots: ["/workspace/project"], writeRoots: ["/workspace/project"], denyPaths: ["/workspace/project/.env"], network: "deny" },
  messages: [
    { id: "m1", role: "user", createdAt: "2026-07-17T00:00:00.000Z", content: [{ type: "text", text: "请创建 src/result.txt" }] },
    { id: "m2", role: "assistant", createdAt: "2026-07-17T00:00:01.000Z", content: [{ type: "text", text: "我来创建该文件。" }] },
  ],
});

const models = [
  makeModelProfile({ contextWindow: 1_000_000, maxOutput: 128_000, capabilities: { thinking: ["adaptive", "disabled"], effort: ["low", "high", "xhigh"], modalities: ["text", "image"], imageOutput: false, tools: true } }),
  makeModelProfile({ id: "claude-haiku-4-5", displayName: "Claude Haiku 4.5", contextWindow: 200_000, maxOutput: 128_000, capabilities: { thinking: ["disabled"], effort: ["low", "medium"], modalities: ["text", "image"], imageOutput: false, tools: true } }),
];

const context = makeContextView({
  ledger: {
    usage: { inputTokens: 1200, outputTokens: 80, cacheRead: 200, cacheWrite: 40 },
    cost: { usdMicroUnits: "6100", cnyMicroUnits: "44300", unpricedTokens: 0 },
    entries: [{ messageId: "m1", state: "full", artifactId: "artifact-0" }],
    cleared: { uptoIndex: 2, at: "2026-07-17T00:00:02.000Z" },
  },
});

const checkpoints: Checkpoint[] = [
  { id: "c1", label: "初始检查点", createdAt: "2026-07-17T00:00:00.000Z", messageCount: 1 },
];

function installFetchMock(): void {
  installAppFetchMock({
    session,
    models,
    context,
    extra: (url, json) => {
      if (url.includes("/api/sessions/s1/checkpoints") && url.includes("/diff")) return json({ diff: "diff --git a/x b/y\n-line\n+line" });
      if (url.includes("/api/sessions/s1/checkpoints")) return json(checkpoints);
      if (url.includes("/api/sessions/s1/snapshot-capability")) return json({ backend: "git-shadow", costHint: "linear", requiresAdmin: false });
      if (url.includes("/api/sessions/s1/files/content")) return json({ content: "文件内容预览", encoding: "utf-8", truncated: false, revision: "a".repeat(64) });
      if (url.includes("/api/sessions/s1/files")) return json({ entries: [{ name: "src", type: "directory", size: 0 }, { name: "README.md", type: "file", size: 12 }], truncated: false });
      return undefined;
    },
  });
}

setupStubWebSocket();

describe("App accessibility", () => {
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
