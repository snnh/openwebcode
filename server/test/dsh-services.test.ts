/**
 * dsh 兼容层 M3 集成测试：服务缝投影（llm/sessions/storage/dshEvents/timer）+
 * tools/pre-execute、tools/post-execute agent 钩子桥（deny/ask 降级/accept/block）+
 * dshEvents EventBus 白名单事件推送。
 * 真实 fork Extension Host 子进程；server 侧用 mock FastModelClient / SessionStore / EventBus。
 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { dshPluginsRoot, saveDshPluginConfig } from "../src/dsh/loader.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-plugins-m3", import.meta.url));

/** 最小 EventBus：on/removeListener/publish（published 序号供 ExtensionManager 引用）。 */
class FakeEventBus extends EventEmitter {
  published = 0;
  publish(input: { source: string; type: string; sessionId?: string; payload?: unknown }) {
    this.published += 1;
    const event = { seq: this.published, ...input };
    this.emit("event", event, JSON.stringify(event));
    return event;
  }
}

/** 最小 SessionStore：list 返回一条元信息（sessions.list 投影断言 count）。 */
const fakeSessions = {
  list: async () => [{ id: "s1", title: "t", cwd: "/tmp", provider: "p", model: "m", createdAt: "", updatedAt: "" }],
} as never;

const fakeFastModel = {
  configured: true,
  model: "test-fast",
  complete: async ({ prompt }: { prompt: string }) => ({ text: `fast(${prompt})` }),
} as never;

let dataDir: string;
let bus: FakeEventBus;
let manager: ExtensionManager;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "owc-dsh-m3-"));
  await cp(FIXTURES, dshPluginsRoot(dataDir), { recursive: true });
  await saveDshPluginConfig(dataDir, {
    version: 1,
    plugins: {
      "svc-user": { enabled: true, config: {} },
      "hook-prepost": { enabled: true, config: {} },
      "timer-user": { enabled: true, config: {} },
    },
  });
  bus = new FakeEventBus();
  manager = new ExtensionManager(dataDir, bus as never, { fastModel: fakeFastModel, sessions: fakeSessions, events: bus as never });
  await manager.initialize();
});

afterEach(async () => {
  await manager.close();
});

describe("dsh M3 服务缝", () => {
  it("storage 私有存储往返（按伪扩展 id 隔离到 extensions-data/dsh-<pluginId>/）", async () => {
    await manager.syncDsh();
    const result = await manager.invokeTool("ext__dsh-svc-user__svc_storage_roundtrip", { content: "hello-storage" });
    expect(result.isError).not.toBe(true);
    const parsed = JSON.parse(result.content);
    expect(parsed.read).toBe("hello-storage");
    expect(parsed.files).toContain("note.txt");
  });

  it("llm.complete 经模型网关（mock fastModel；不暴露 Key）", async () => {
    await manager.syncDsh();
    const result = await manager.invokeTool("ext__dsh-svc-user__svc_llm_complete", { prompt: "ping" });
    expect(result.content).toBe(JSON.stringify({ text: "fast(ping)" }));
  });

  it("sessions.list 只读投影（mock 返回 1 条）", async () => {
    await manager.syncDsh();
    const result = await manager.invokeTool("ext__dsh-svc-user__svc_sessions_list", {});
    expect(result.content).toBe(JSON.stringify({ count: 1 }));
  });

  it("timer 服务：ctx.timeout 纯延迟等待", async () => {
    await manager.syncDsh();
    const start = Date.now();
    const result = await manager.invokeTool("ext__dsh-timer-user__timer_wait", { ms: 50 });
    expect(JSON.parse(result.content)).toEqual({ waited: 50 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });

  it("dshEvents 订阅：EventBus 白名单事件推送到插件 ctx 并写入 storage", async () => {
    await manager.syncDsh();
    // 白名单事件（agent.state）与非白名单事件（应被 server 过滤，不送达插件）
    bus.publish({ source: "agent", type: "agent.state", sessionId: "sess-1", payload: { state: "thinking" } });
    bus.publish({ source: "server", type: "extension.warning", payload: { message: "nope" } });
    await vi.waitFor(async () => {
      const got = await manager.invokeTool("ext__dsh-svc-user__svc_storage_roundtrip", { content: "probe" });
      const files = JSON.parse(got.content).files as string[];
      expect(files).toContain("events/agent.state.json");
    }, { timeout: 8000, interval: 200 });
    // 非白名单事件未送达（无对应文件）；白名单文件内容正确
    const read = await manager.invokeTool("ext__dsh-svc-user__svc_storage_roundtrip", { content: "probe2" });
    expect(JSON.parse(read.content).files).not.toContain("events/extension.warning.json");
  });
});

describe("dsh M3 agent 钩子桥", () => {
  it("tools/pre-execute deny → blocked + reason（上游落地为 Error: <reason>）", async () => {
    await manager.syncDsh();
    const outcome = await manager.beforeTool({ sessionId: "s", cwd: "/tmp", tool: "deny_tool", input: {} });
    expect(outcome.blocked).toBe(true);
    expect(outcome.reason).toBe("Error: 被 hook-prepost 禁止");
  });

  it("tools/pre-execute ask → 降级放行 + 审计（v1 不接审批，避免与权限链重复审批死锁）", async () => {
    await manager.syncDsh();
    const outcome = await manager.beforeTool({ sessionId: "s", cwd: "/tmp", tool: "ask_tool", input: {} });
    expect(outcome.blocked).not.toBe(true);
  });

  it("tools/pre-execute 无监听工具 → 放行", async () => {
    await manager.syncDsh();
    const outcome = await manager.beforeTool({ sessionId: "s", cwd: "/tmp", tool: "read_file", input: {} });
    expect(outcome.blocked).not.toBe(true);
  });

  it("tools/post-execute accept → 替换 content；block → 转错误结果", async () => {
    await manager.syncDsh();
    const accepted = await manager.afterTool({ sessionId: "s", cwd: "/tmp", tool: "transform_tool", input: {}, result: { content: "原始内容" } });
    expect(accepted.result.content).toBe("已被 post-execute 变换");

    const blocked = await manager.afterTool({ sessionId: "s", cwd: "/tmp", tool: "block_tool", input: {}, result: { content: "原始内容" } });
    expect(blocked.result.content).toBe("结果被 post-execute 否决");
    expect(blocked.result.isError).toBe(true);
  });

  it("tools/post-execute 无监听工具 → 结果保持原样", async () => {
    await manager.syncDsh();
    const outcome = await manager.afterTool({ sessionId: "s", cwd: "/tmp", tool: "write_file", input: {}, result: { content: "原始内容" } });
    expect(outcome.result.content).toBe("原始内容");
    expect(outcome.result.isError).toBeUndefined();
  });

  it("通用扩展链 afterExecute（hook 注册面）保持通知语义", async () => {
    await manager.syncDsh();
    // dsh 插件不注册 owc 扩展 hook；afterTool 回落到通用链后结果不变（无注册者）。
    const outcome = await manager.afterTool({ sessionId: "s", cwd: "/tmp", tool: "anything", input: {}, result: { content: "x" } });
    expect(outcome.result.content).toBe("x");
  });
});
