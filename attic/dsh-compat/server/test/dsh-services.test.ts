/**
 * dsh M3 集成：服务缝投影（llm/sessions/storage/dshEvents/timer）+ tools/pre|post-execute 钩子桥
 * （deny/ask 降级/accept/block）+ dshEvents 白名单推送。真实 fork Extension Host；server 侧全 mock。
 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { dshPluginsRoot, saveDshPluginConfig } from "../src/dsh/loader.js";
import { projectSettingsDescribe } from "../src/dsh/web-protocol/settings-face.js";

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
const fakeSessions = { list: async () => [{ id: "s1", title: "t", cwd: "/tmp", provider: "p", model: "m", createdAt: "", updatedAt: "" }] } as never;
const fakeFastModel = { configured: true, model: "test-fast", complete: async ({ prompt }: { prompt: string }) => ({ text: `fast(${prompt})` }) } as never;

describe("dsh M3 服务缝与钩子桥", () => {
  it("设置面脱敏：baseURL 内联凭据被剥除，普通端点原样保留", () => {
    const value = projectSettingsDescribe({
      profiles: () => [
        { id: "a", enabled: true, interfaceType: "openai", baseURL: "https://user:secret@internal.example/v1", hasApiKey: true },
        { id: "b", enabled: true, interfaceType: "openai", baseURL: "https://api.example/v1", hasApiKey: false },
      ],
    }) as { namespaces: Array<{ value: Record<string, { baseURL?: string }> }> };
    const projected = value.namespaces[0]?.value ?? {};
    expect(projected.a?.baseURL).toBe("https://internal.example/v1");
    expect(projected.b?.baseURL).toBe("https://api.example/v1");
    expect(JSON.stringify(projected)).not.toContain("secret");
  });
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
    await manager.syncDsh();
  });
  afterEach(async () => {
    await manager.close();
  });
  it("服务缝：storage 私有存储往返、llm.complete 经模型网关、sessions.list 只读投影", async () => {
    const storage = await manager.invokeTool("ext__dsh-svc-user__svc_storage_roundtrip", { content: "hello-storage" });
    expect(storage.isError).not.toBe(true);
    expect(JSON.parse(storage.content)).toMatchObject({ read: "hello-storage" });
    expect(JSON.parse(storage.content).files).toContain("note.txt");
    const llm = await manager.invokeTool("ext__dsh-svc-user__svc_llm_complete", { prompt: "ping" });
    expect(llm.content).toBe(JSON.stringify({ text: "fast(ping)" })); // 走模型网关，不暴露 Key
    const sessions = await manager.invokeTool("ext__dsh-svc-user__svc_sessions_list", {});
    expect(sessions.content).toBe(JSON.stringify({ count: 1 }));
  });
  it("timer 服务：ctx.timeout 纯延迟等待", async () => {
    const start = Date.now();
    const result = await manager.invokeTool("ext__dsh-timer-user__timer_wait", { ms: 50 });
    expect([JSON.parse(result.content), Date.now() - start >= 45]).toEqual([{ waited: 50 }, true]);
  });
  it("dshEvents 订阅：白名单事件送达插件并写入 storage，非白名单被过滤", async () => {
    bus.publish({ source: "agent", type: "agent.state", sessionId: "sess-1", payload: { state: "thinking" } });
    bus.publish({ source: "server", type: "extension.warning", payload: { message: "nope" } });
    await vi.waitFor(async () => {
      const got = await manager.invokeTool("ext__dsh-svc-user__svc_storage_roundtrip", { content: "probe" });
      expect(JSON.parse(got.content).files).toContain("events/agent.state.json");
    }, { timeout: 8000, interval: 200 });
    const read = await manager.invokeTool("ext__dsh-svc-user__svc_storage_roundtrip", { content: "probe2" });
    expect(JSON.parse(read.content).files).not.toContain("events/extension.warning.json");
  });
  it("tools/pre-execute：deny 转 blocked+reason，ask 降级放行，无监听工具放行", async () => {
    const pre = (tool: string) => manager.beforeTool({ sessionId: "s", cwd: "/tmp", tool, input: {} });
    const denied = await pre("deny_tool");
    expect(denied).toMatchObject({ blocked: true, reason: "Error: 被 hook-prepost 禁止" });
    // ask 降级放行（v1 不接审批，避免与权限链重复审批死锁）
    expect((await pre("ask_tool")).blocked).not.toBe(true);
    expect((await pre("read_file")).blocked).not.toBe(true);
  });
  it("tools/post-execute：accept 替换 content、block 转错误结果，无监听/通用链保持原样", async () => {
    const post = (tool: string) => manager.afterTool({ sessionId: "s", cwd: "/tmp", tool, input: {}, result: { content: "原始内容" } });
    expect((await post("transform_tool")).result.content).toBe("已被 post-execute 变换");
    expect((await post("block_tool")).result).toMatchObject({ content: "结果被 post-execute 否决", isError: true });
    const untouched = (await post("write_file")).result;
    expect([untouched.content, untouched.isError]).toEqual(["原始内容", undefined]);
    // dsh 插件不注册 owc 扩展 hook：afterTool 回落通用链后结果不变
    expect((await post("anything")).result.content).toBe("原始内容");
  });
});
