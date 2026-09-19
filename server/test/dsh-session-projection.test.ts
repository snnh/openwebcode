/**
 * dsh 会话投影单测（M4 步骤 14b）。
 *
 * 第二部分是**契约校验**：若本地已 vendor dsh UI（`server/assets/dsh-web/`，gitignored），
 * 就用 dsh 客户端自己的生成 codec（zod strict schema）parse 我方投影值——
 * 即「客户端一定会接受」的直接证据。未 vendor 时整组跳过（CI 无网络也能跑门禁）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  imageDimensions,
  mapPromptContent,
  projectSessionAttachment,
  projectSessionControlBaseline,
  projectSessionCreate,
  projectSessionList,
  projectSessionPrompt,
  projectSessionUpdateQueue,
  projectWorkspaceBaseline,
  type DshProjectionDeps,
} from "../src/dsh/web-protocol/session-projection.js";
import type { ChatMessage, SessionDetail, SessionMeta } from "../src/sessions/types.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_PLUGINS = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins");
const CODEC_PACKAGES = [
  "@deepseek-ai/dsh-api-session-controller",
  "@deepseek-ai/dsh-api-workspace-controller",
];
const SESSION_CONTROLLER = path.join(VENDOR_PLUGINS, "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js");
const VENDOR_SKIP = existsSync(SESSION_CONTROLLER) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id,
    cwd: "/work/proj",
    provider: "p",
    model: "m",
    title: `会话 ${id}`,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:10:00.000Z",
    ...extra,
  } as SessionMeta;
}

function message(id: string, role: ChatMessage["role"], content: ChatMessage["content"], createdAt = "2026-01-01T00:05:00.000Z"): ChatMessage {
  return { id, role, content, createdAt };
}

function detail(id: string, messages: ChatMessage[], hasMoreMessages = false): SessionDetail {
  return { ...meta(id), messages, hasMoreMessages } as SessionDetail;
}

/** 假依赖：只实现投影用到的面（不做真实 IO）；mock 同时挂在顶层便于断言。 */
function deps(overrides: {
  metas?: SessionMeta[];
  details?: Record<string, SessionDetail>;
  running?: string[];
  queue?: Array<{ id: string; content: string }>;
} = {}) {
  const metas = overrides.metas ?? [meta("s1")];
  const details = overrides.details ?? { s1: detail("s1", [message("m1", "user", [{ type: "text", text: "你好" }])]) };
  const running = new Set(overrides.running ?? []);
  const queue = overrides.queue ?? [{ id: "q1", content: "排队消息" }];
  const run = vi.fn(async () => {});
  const abort = vi.fn(() => true);
  const enqueueSteering = vi.fn(async () => ({ id: "st", position: 1, reused: false }));
  const enqueueFollowUp = vi.fn(async () => ({ id: "q", position: 1, reused: false }));
  const updateQueue = vi.fn(async (_sessionId: string, itemId: string) => (itemId === "q1" ? { id: "q1" } : undefined));
  const removeQueue = vi.fn(async (_sessionId: string, itemId: string) => itemId === "q1");
  const create = vi.fn(async (input: { cwd: string; id?: string }) => meta(input.id ?? "new-session", { cwd: input.cwd }));
  const projection: DshProjectionDeps = {
    sessions: {
      list: async () => metas,
      getMeta: async (id: string) => metas.find((entry) => entry.id === id),
      getTail: async (id: string) => details[id],
      get: async (id: string) => details[id],
      create: create as never,
    },
    agent: {
      run: run as never,
      isRunning: (id: string) => running.has(id),
      abort: abort as never,
      enqueueSteering: enqueueSteering as never,
      enqueueFollowUp: enqueueFollowUp as never,
      listQueue: (async () => queue) as never,
      updateQueue: updateQueue as never,
      removeQueue: removeQueue as never,
    },
    defaultCwd: "/work/default",
  };
  return { projection, run, abort, enqueueSteering, enqueueFollowUp, updateQueue, removeQueue, create };
}

describe("dsh 会话投影", () => {
  it("session/list：摘要含 title/blank/running/cwd 投影，尾部截断时保守判非空白", async () => {
    const withUser = detail("s1", [message("m1", "user", [{ type: "text", text: "hi" }])]);
    const blank = detail("s2", [message("m2", "assistant", [{ type: "text", text: "自述" }])]);
    const truncated = detail("s3", [message("m3", "assistant", [{ type: "text", text: "尾部" }])], true);
    const fake = deps({
      metas: [meta("s1"), meta("s2"), meta("s3")],
      details: { s1: withUser, s2: blank, s3: truncated },
      running: ["s2"],
    });
    const projected = await projectSessionList(fake.projection);
    expect("value" in projected).toBe(true);
    const items = ("value" in projected ? projected.value.items : []) as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    const [first, second, third] = items;
    expect(first).toMatchObject({ sessionId: "s1", running: false, blank: false, cwd: "/work/proj" });
    expect((first?.projections as { values: { title: unknown } }).values.title).toBe("会话 s1");
    expect(second).toMatchObject({ sessionId: "s2", running: true, blank: true });
    expect(third).toMatchObject({ sessionId: "s3", blank: false });
    expect(typeof first?.updatedAt).toBe("number");
  });

  it("session/create：已存在幂等；新建用请求 cwd，缺省回落默认工作目录", async () => {
    const fake = deps({ metas: [meta("s1")] });
    expect(await projectSessionCreate(fake.projection, { request: { sessionId: "s1" } })).toEqual({ value: { sessionId: "s1" } });
    expect(await projectSessionCreate(fake.projection, { request: { cwd: "/tmp/x" } })).toEqual({ value: { sessionId: "new-session" } });
    expect(fake.create).toHaveBeenCalledWith({ cwd: "/tmp/x" });
    await projectSessionCreate(fake.projection, { request: {} });
    expect(fake.create).toHaveBeenLastCalledWith({ cwd: "/work/default" });
  });

  it("prompt：空闲起一轮（带图片），运行中按 mode 入队/插话；file 块如实报未实现", async () => {
    const fake = deps();
    expect(await projectSessionPrompt(fake.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "text", text: "嗨" }] } })).toEqual({ value: { accepted: true } });
    expect(fake.run).toHaveBeenCalledWith("s1", "嗨", {});

    const image = { type: "image", mediaType: "image/png", data: "AAAA" };
    await projectSessionPrompt(fake.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "text", text: "看图" }, image] } });
    expect(fake.run).toHaveBeenLastCalledWith("s1", "看图", { images: [{ mediaType: "image/png", data: "AAAA" }] });

    const busy = deps({ running: ["s1"] });
    await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "steer", content: [{ type: "text", text: "插话" }] } });
    expect(busy.enqueueSteering).toHaveBeenCalledWith("s1", "插话");
    await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "text", text: "排队" }] } });
    expect(busy.enqueueFollowUp).toHaveBeenCalledWith("s1", "排队");
    expect(busy.run).not.toHaveBeenCalled();

    const file = await projectSessionPrompt(fake.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "file", receiptId: "f1" }] } });
    expect(file).toMatchObject({ error: { code: "session/unsupported" } });
    const missing = await projectSessionPrompt(fake.projection, { request: { sessionId: "nope", content: [{ type: "text", text: "x" }] } });
    expect(missing).toMatchObject({ error: { code: "session/not-found" } });
    const empty = await projectSessionPrompt(fake.projection, { request: { sessionId: "s1", content: [{ type: "text", text: "   " }] } });
    expect(empty).toMatchObject({ error: { code: "session/arguments-invalid" } });
  });

  it("content 映射与 updateQueue（edit/remove/steer）", () => {
    expect(mapPromptContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toEqual({ text: "a\n\nb", images: [] });
    expect(mapPromptContent("nope")).toMatchObject({ error: { code: "session/arguments-invalid" } });
    expect(mapPromptContent([{ type: "wat" }])).toMatchObject({ error: { code: "session/arguments-invalid" } });
  });

  it("updateQueue：edit 改内容、remove 删除、steer 移出队列并插话", async () => {
    const fake = deps();
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "edit", content: [{ type: "text", text: "改了" }] } } })).toEqual({ value: { accepted: true } });
    expect(fake.updateQueue).toHaveBeenCalledWith("s1", "q1", { content: "改了" });
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "remove" } } })).toEqual({ value: { accepted: true } });
    expect(fake.removeQueue).toHaveBeenCalledWith("s1", "q1");
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "steer" } } })).toEqual({ value: { accepted: true } });
    expect(fake.enqueueSteering).toHaveBeenCalledWith("s1", "排队消息");
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "nope", action: { kind: "remove" } } })).toMatchObject({ error: { code: "session/queue-item-not-found" } });
  });

  it("control 基线含投影；workspace 基线按 cwd 派生分组且 workspaceId 稳定", async () => {
    const fake = deps({ metas: [meta("s1", { cwd: "/work/a" }), meta("s2", { cwd: "/work/a" }), meta("s3", { cwd: "/work/b" })] });
    const control = await projectSessionControlBaseline(fake.projection, "s1");
    expect(control).toMatchObject({ value: { type: "baseline", value: { jobs: {} } } });
    const workspace = await projectWorkspaceBaseline(fake.projection) as { type: string; value: { items: Array<{ workspaceId: string; title: string; sessionIds: string[] }>; archivedSessionIds: string[] } };
    expect(workspace.type).toBe("baseline");
    expect(workspace.value.items).toHaveLength(2);
    const groupA = workspace.value.items.find((item) => item.title === "a");
    expect(groupA?.sessionIds.sort()).toEqual(["s1", "s2"]);
    const again = await projectWorkspaceBaseline(fake.projection) as { value: { items: Array<{ workspaceId: string }> } };
    expect(again.value.items.map((item) => item.workspaceId).sort()).toEqual(workspace.value.items.map((item) => item.workspaceId).sort());
  });

  it("附件回读：按 <messageId>#<index> 找到内联图片并读出真实尺寸；未知 id 报 not-found", async () => {
    // 1x1 PNG（真实字节）
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    expect(imageDimensions("image/png", png)).toEqual({ width: 1, height: 1 });
    const fake = deps({ details: { s1: detail("s1", [message("m1", "user", [{ type: "image", mediaType: "image/png", data: png.toString("base64") }])]) } });
    const projected = await projectSessionAttachment(fake.projection, { request: { sessionId: "s1", attachmentId: "m1#0" } });
    expect(projected).toMatchObject({ value: { attachment: { attachmentId: "m1#0", mediaType: "image/png", bytes: png.byteLength, width: 1, height: 1 } } });
    expect(await projectSessionAttachment(fake.projection, { request: { sessionId: "s1", attachmentId: "m1#9" } })).toMatchObject({ error: { code: "session/attachment-not-found" } });
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("dsh wire 契约校验（用客户端自己的生成 codec）", () => {
  async function loadCodecs(): Promise<Map<string, { result: { create: () => { parse: (value: unknown) => unknown } } }>> {
    const map = new Map<string, { result: { create: () => { parse: (value: unknown) => unknown } } }>();
    for (const name of CODEC_PACKAGES) {
      const mod = (await import(`file://${path.join(VENDOR_PLUGINS, name, "typert.remote-client.js")}`)) as {
        default: { descriptors: Array<{ namespace: string; method: string }> };
      };
      for (const descriptor of mod.default.descriptors) map.set(`${descriptor.namespace}/${descriptor.method}`, descriptor as never);
    }
    return map;
  }

  it("session/list、session/create、session/prompt、session/cancel、session/updateQueue、session/control、workspace/follow 的投影值均通过 strict schema", async () => {
    const codecs = await loadCodecs();
    const check = (endpoint: string, value: unknown): void => {
      const descriptor = codecs.get(endpoint);
      expect(descriptor, `vendor 缺少端点 ${endpoint}`).toBeDefined();
      const parsed = descriptor?.result.create().parse(value);
      expect(parsed).toBeDefined();
    };
    const fake = deps({ metas: [meta("s1")], queue: [{ id: "q1", content: "排队消息" }] });
    const list = await projectSessionList(fake.projection);
    expect("value" in list).toBe(true);
    check("session/list", "value" in list ? list.value : undefined);
    check("session/create", { sessionId: "s1" });
    check("session/prompt", { accepted: true });
    check("session/cancel", { accepted: true });
    check("session/updateQueue", { accepted: true });
    const control = await projectSessionControlBaseline(fake.projection, "s1");
    check("session/control", "value" in control ? control.value : undefined);
    check("workspace/follow", await projectWorkspaceBaseline(fake.projection));
  });

  it("附件值通过 schema（真实 PNG 尺寸）", async () => {
    const codecs = await loadCodecs();
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
    const fake = deps({ details: { s1: detail("s1", [message("m1", "user", [{ type: "image", mediaType: "image/png", data: png.toString("base64") }])]) } });
    const projected = await projectSessionAttachment(fake.projection, { request: { sessionId: "s1", attachmentId: "m1#0" } });
    const descriptor = codecs.get("session/attachment");
    expect(descriptor).toBeDefined();
    const value = "value" in projected ? projected.value : undefined;
    expect(descriptor?.result.create().parse(value)).toBeDefined();
  });

  it("vendor 清单里的插件 bundle 都是自注册形态（window.__ModuleLoader__.load）", async () => {
    const manifest = JSON.parse(await readFile(path.join(SERVER_ROOT, "assets", "dsh-web", "manifest.json"), "utf8")) as {
      plugins: Array<{ id: string; entry: string }>;
    };
    expect(manifest.plugins.length).toBeGreaterThan(0);
    for (const plugin of manifest.plugins.slice(0, 5)) {
      const source = await readFile(path.join(VENDOR_PLUGINS, plugin.id, plugin.entry), "utf8");
      expect(source, plugin.id).toContain("__ModuleLoader__.load(");
    }
  });
});
