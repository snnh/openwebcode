/**
 * dsh 会话投影单测。第二部分是**契约校验**：本地已 vendor dsh UI 时用客户端自己的生成 codec
 * （zod strict schema）parse 我方投影值——「客户端一定会接受」的直接证据；未 vendor 时整组跳过。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  imageDimensions, mapPromptContent, projectSessionAttachment, projectSessionControlBaseline, projectSessionCreate,
  projectSessionList, projectSessionPrompt, projectSessionUpdateQueue, projectWorkspaceBaseline, type DshProjectionDeps,
} from "../src/dsh/web-protocol/session-projection.js";
import type { ChatMessage, SessionDetail, SessionMeta } from "../src/sessions/types.js";
import { deriveSessionRecords, pageWindow, sessionRecordsCount, snapshotWindow } from "../src/dsh/web-protocol/session-events.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR_PLUGINS = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const VENDOR_SKIP = existsSync(path.join(VENDOR_PLUGINS, "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js")) ? undefined : "未 vendor dsh UI（先跑 scripts/fetch-dsh-web.mjs）";

function meta(id: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return { id, cwd: "/work/proj", provider: "p", model: "m", title: `会话 ${id}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z", ...extra } as SessionMeta;
}
function message(id: string, role: ChatMessage["role"], content: ChatMessage["content"]): ChatMessage { return { id, role, content, createdAt: "2026-01-01T00:05:00.000Z" }; }
function detail(id: string, messages: ChatMessage[], hasMoreMessages = false): SessionDetail { return { ...meta(id), messages, hasMoreMessages } as SessionDetail; }

/** 假依赖：只实现投影用到的面。宿主侧接缝调用记录成序列，便于断言可观测结果而非 spy 计数。 */
function deps(overrides: { metas?: SessionMeta[]; details?: Record<string, SessionDetail>; running?: string[]; queue?: Array<{ id: string; content: string }> } = {}) {
  const metas = overrides.metas ?? [meta("s1")];
  const details = overrides.details ?? { s1: detail("s1", [message("m1", "user", [{ type: "text", text: "你好" }])]) };
  const running = new Set(overrides.running ?? []);
  const queue = overrides.queue ?? [{ id: "q1", content: "排队消息" }];
  const seam: unknown[][] = [];
  const record = (name: string, result?: unknown) => async (...args: unknown[]) => { seam.push([name, ...args]); return result; };
  const projection: DshProjectionDeps = {
    sessions: {
      list: async () => metas, getMeta: async (id: string) => metas.find((entry) => entry.id === id), getTail: async (id: string) => details[id], get: async (id: string) => details[id],
      create: (async (input: { cwd: string; id?: string }) => { seam.push(["create", input]); return meta(input.id ?? "new-session", { cwd: input.cwd }); }) as never,
    },
    agent: {
      run: record("run") as never, isRunning: (id: string) => running.has(id), abort: () => true,
      enqueueSteering: record("steer") as never, enqueueFollowUp: record("queue") as never,
      listQueue: (async () => queue) as never,
      updateQueue: (async (sessionId: string, itemId: string, patch: unknown) => { seam.push(["updateQueue", sessionId, itemId, patch]); return itemId === "q1" ? { id: "q1" } : undefined; }) as never,
      removeQueue: (async (sessionId: string, itemId: string) => { seam.push(["removeQueue", sessionId, itemId]); return itemId === "q1"; }) as never,
    },
    defaultCwd: "/work/default",
  };
  return { projection, seam };
}

/** 取投影成功的 value（失败时打印投影错误，便于定位）。 */
function valueOf<T>(projected: unknown): T { expect(projected, JSON.stringify(projected)).toMatchObject({ value: expect.anything() }); return (projected as { value: T }).value; }

describe("dsh 会话投影", () => {
  it("session/list：title/blank/running/cwd 摘要投影，asOfSeq 与记录 seq 同口径（水位 = 末条记录 seq）", async () => {
    const fake = deps({
      metas: [meta("s1"), meta("s2"), meta("s3")],
      details: {
        s1: detail("s1", [message("m1", "user", [{ type: "text", text: "hi" }])]),
        s2: detail("s2", [message("m2", "assistant", [{ type: "text", text: "自述" }])]),
        // 尾部截断：拿不到最早的用户消息，必须保守判「非空白」
        s3: detail("s3", [message("m3", "assistant", [{ type: "text", text: "尾部" }])], true),
      },
      running: ["s2"],
    });
    const items = valueOf<{ items: Array<Record<string, unknown>> }>(await projectSessionList(fake.projection)).items; expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ sessionId: "s1", running: false, blank: false, cwd: "/work/proj" }); expect(items[1]).toMatchObject({ sessionId: "s2", running: true, blank: true });
    expect(items[2]).toMatchObject({ sessionId: "s3", blank: false });
    expect([(items[0]?.projections as { values: { title: unknown } }).values.title, typeof items[0]?.updatedAt]).toEqual(["会话 s1", "number"]);
    // 水位口径：两条消息 → 8 条记录（含 turn/step 包围），asOfSeq = 末条记录 seq
    const rich = [message("m1", "user", [{ type: "text", text: "hi" }]), message("m2", "assistant", [{ type: "tool_call", id: "c1", name: "bash", input: {} }, { type: "text", text: "yo" }])];
    const richItems = valueOf<{ items: Array<{ projections: { asOfSeq: number } }> }>(await projectSessionList(deps({ details: { s1: detail("s1", rich) } }).projection)).items;
    expect(richItems[0]?.projections.asOfSeq).toBe(sessionRecordsCount(rich) - 1);
  });
  it("session/create：已存在幂等、非 UUID 参数错误、cwd 回落默认；走 REST 同链路（可见性补发 + 默认套用 + SessionStart 钩子）", async () => {
    const uuid = "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f";
    const fake = deps({ metas: [meta(uuid)] });
    const created: string[] = [];
    const hooks: string[] = [];
    const projection: DshProjectionDeps = {
      ...fake.projection,
      publishSessionCreated: (session: SessionMeta) => created.push(session.id),
      defaultSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }),
      applySessionDefaults: async (session, provider, model) => { hooks.push(`defaults:${session.id}:${provider}:${model}`); return session; },
      runSessionStartHook: async (info) => { hooks.push(`hook:${info.sessionId}:${info.cwd}`); },
    };
    expect(await projectSessionCreate(projection, { request: { sessionId: uuid } })).toEqual({ value: { sessionId: uuid } }); expect(created).toHaveLength(0); // 幂等命中不补发 session.created
    // 非 UUID 的 sessionId 属参数错误，不当内部错误外泄（owc 会话目录名是 UUID 白名单）
    expect(await projectSessionCreate(projection, { request: { sessionId: "s1" } })).toMatchObject({ error: { code: "gateway/bad-request" } });
    expect(await projectSessionCreate(projection, { request: { cwd: "/tmp/x" } })).toEqual({ value: { sessionId: "new-session" } });
    expect(await projectSessionCreate(projection, { request: {} })).toEqual({ value: { sessionId: "new-session" } }); expect(created).toEqual(["new-session", "new-session"]);
    expect(hooks).toEqual(["defaults:new-session:deepseek:deepseek-chat", "hook:new-session:/tmp/x", "defaults:new-session:deepseek:deepseek-chat", "hook:new-session:/work/default"]);
  });
  it("prompt：空闲起一轮（带图）、运行中按 mode 入队/插话、requestId 幂等；空内容/未知会话/file 块/运行中带图如实报错", async () => {
    const idle = deps();
    const request = { requestId: "req-1", sessionId: "s1", mode: "queue", content: [{ type: "text", text: "只发一次" }] };
    expect(await projectSessionPrompt(idle.projection, { request })).toEqual({ value: { accepted: true } });
    expect(await projectSessionPrompt(idle.projection, { request })).toEqual({ value: { accepted: true } });
    expect(idle.seam).toEqual([["run", "s1", "只发一次", {}]]); // 同一 requestId 重发不重复起轮（上游 hasPromptRequest 同语义）
    await projectSessionPrompt(idle.projection, { request: { ...request, requestId: "req-2", content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", data: PNG }] } });
    expect(idle.seam.at(-1)).toEqual(["run", "s1", "看图", { images: [{ mediaType: "image/png", data: PNG }] }]);
    // 纯图片（无文本）也照常起轮
    const imageOnly = deps();
    await projectSessionPrompt(imageOnly.projection, { request: { sessionId: "s1", content: [{ type: "image", mediaType: "image/png", data: PNG }] } });
    expect(imageOnly.seam).toEqual([["run", "s1", "", { images: [{ mediaType: "image/png", data: PNG }] }]]);
    const busy = deps({ running: ["s1"] });
    await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "steer", content: [{ type: "text", text: "插话" }] } });
    await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "text", text: "排队" }] } });
    expect(busy.seam).toEqual([["steer", "s1", "插话"], ["queue", "s1", "排队"]]); // 运行中不起新轮，按 mode 入队/插话
    // 运行中带图无法如实送达（enqueue* 只收文本）：明确失败而不是静默丢图
    for (const mode of ["queue", "steer"]) {
      const failed = await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode, content: [{ type: "text", text: "看图" }, { type: "image", mediaType: "image/png", data: PNG }] } });
      expect(failed, mode).toMatchObject({ error: { code: "session/attachment-invalid" } });
    }
    expect(busy.seam).toHaveLength(2); // 失败尝试没有污染宿主侧接缝
    const errors: Array<[Record<string, unknown>, string]> = [
      [{ sessionId: "s1", content: [{ type: "file", receiptId: "f1" }] }, "session/attachment-invalid"],
      [{ sessionId: "nope", content: [{ type: "text", text: "x" }] }, "session/not-found"],
      [{ sessionId: "s1", content: [{ type: "text", text: "   " }] }, "gateway/bad-request"]];
    for (const [req, code] of errors) expect(await projectSessionPrompt(idle.projection, { request: req }), code).toMatchObject({ error: { code } });
  });
  it("分页/快照游标满足 vendor 不变量：0 基连续 seq、through 严格相等、空窗口 -1、prepend 衔接", () => {
    const messages = [
      message("m1", "user", [{ type: "text", text: "u1" }]),
      message("m2", "assistant", [{ type: "tool_call", id: "c1", name: "bash", input: {} }, { type: "text", text: "a1" }]),
      message("m3", "tool", [{ type: "tool_result", toolCallId: "c1", content: "ok" }]), message("m4", "user", [{ type: "text", text: "u2" }])];
    const { records } = deriveSessionRecords(messages);
    const last = records[records.length - 1]?.event.seq ?? 0; expect(records.map((record) => record.event.seq)).toEqual(records.map((_, index) => index));
    const empty = snapshotWindow([], 50); expect([empty.records, empty.cursor, empty.hasMore]).toEqual([[], -1, false]); // 空窗口 cursor 用 vendor 的 emptyCursor(-1)
    const full = snapshotWindow(messages, 50); expect([full.cursor, full.totalRecords, full.hasMore]).toEqual([last, records.length, false]); expect(snapshotWindow(messages, 2).hasMore).toBe(true);
    for (const through of [0, 3, last]) {
      const seqs = pageWindow(messages, through, undefined, 50).records.map((record) => record.event.seq);
      // vendor assertPageThrough：页尾必须**恰好**止于请求的 throughSeq，且 seq 连续
      expect([through, seqs[seqs.length - 1]]).toEqual([through, through]); expect(seqs).toEqual(seqs.map((_, index) => (seqs[0] ?? 0) + index));
    }
    const before = 4; expect(pageWindow(messages, last, before, 50).records.at(-1)?.event.seq).toBe(before - 1); // loadOlder: tail + 1 === beforeSeq
    expect(pageWindow(messages, -1, undefined, 2).records).toEqual([]);
  });
  it("updateQueue：edit 改内容、remove 删除、steer 移出队列并插话；带图编辑与非队列项如实报错", async () => {
    const fake = deps(); expect(mapPromptContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toEqual({ text: "a\n\nb", images: [] });
    expect(mapPromptContent("nope")).toMatchObject({ error: { code: "gateway/bad-request" } }); expect(mapPromptContent([{ type: "wat" }])).toMatchObject({ error: { code: "gateway/bad-request" } });
    const call = (action: Record<string, unknown>) => projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action } });
    expect(await call({ kind: "edit", content: [{ type: "text", text: "改了" }] })).toEqual({ value: { accepted: true } });
    // 队列项只有文本：编辑带图必须明确失败（与运行中发图同一处理，不静默丢）
    expect(await call({ kind: "edit", content: [{ type: "image", mediaType: "image/png", data: PNG }] })).toMatchObject({ error: { code: "session/attachment-invalid" } });
    expect(await call({ kind: "remove" })).toEqual({ value: { accepted: true } }); expect(await call({ kind: "steer" })).toEqual({ value: { accepted: true } }); expect(fake.seam).toEqual([
      ["updateQueue", "s1", "q1", { content: "改了" }], ["removeQueue", "s1", "q1"], // remove 动作
      ["removeQueue", "s1", "q1"], ["steer", "s1", "排队消息"]]); // steer：先移出队列再插话
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "nope", action: { kind: "remove" } } }))
      .toMatchObject({ error: { code: "session/queue-item-not-found" } });
  });
  it("control 基线覆盖全部会话（该端点无参数）；workspace 基线按 cwd 派生分组且 workspaceId 稳定", async () => {
    const fake = deps({
      metas: [meta("s1", { cwd: "/work/a" }), meta("s2", { cwd: "/work/a" }), meta("s3", { cwd: "/work/b" })],
      details: { s1: detail("s1", []), s2: detail("s2", []), s3: detail("s3", []) },
    });
    const control = await projectSessionControlBaseline(fake.projection); expect(control).toMatchObject({ value: { type: "baseline", value: { jobs: {} } } });
    const projections = valueOf<{ value: { projections: Record<string, unknown> } }>(control).value.projections; expect(Object.keys(projections).sort()).toEqual(["s1", "s2", "s3"]);
    const workspace = (await projectWorkspaceBaseline(fake.projection)) as { type: string; value: { items: Array<{ workspaceId: string; title: string; sessionIds: string[] }> } };
    const again = (await projectWorkspaceBaseline(fake.projection)) as { value: { items: Array<{ workspaceId: string }> } }; expect(workspace.type).toBe("baseline");
    expect(workspace.value.items.find((item) => item.title === "a")?.sessionIds.sort()).toEqual(["s1", "s2"]);
    expect(again.value.items.map((item) => item.workspaceId).sort()).toEqual(workspace.value.items.map((item) => item.workspaceId).sort());
  });
  it("附件回读：按 <messageId>#<index> 找到内联图片并读出真实尺寸，未知 id 报 attachment-invalid", async () => {
    const png = Buffer.from(PNG, "base64"); expect(imageDimensions("image/png", png)).toEqual({ width: 1, height: 1 });
    const fake = deps({ details: { s1: detail("s1", [message("m1", "user", [{ type: "image", mediaType: "image/png", data: png.toString("base64") }])]) } });
    expect(await projectSessionAttachment(fake.projection, { request: { sessionId: "s1", attachmentId: "m1#0" } }))
      .toMatchObject({ value: { attachment: { attachmentId: "m1#0", mediaType: "image/png", bytes: png.byteLength, width: 1, height: 1 } } });
    expect(await projectSessionAttachment(fake.projection, { request: { sessionId: "s1", attachmentId: "m1#9" } }))
      .toMatchObject({ error: { code: "session/attachment-invalid" } });
  });
});

describe.skipIf(VENDOR_SKIP !== undefined)("dsh wire 契约校验（用客户端自己的生成 codec）", () => {
  async function loadCodecs(): Promise<Map<string, { result: { create: () => { parse: (value: unknown) => unknown } } }>> {
    const map = new Map<string, { result: { create: () => { parse: (value: unknown) => unknown } } }>();
    for (const name of ["@deepseek-ai/dsh-api-session-controller", "@deepseek-ai/dsh-api-workspace-controller"]) {
      const mod = (await import(`file://${path.join(VENDOR_PLUGINS, name, "typert.remote-client.js")}`)) as { default: { descriptors: Array<{ namespace: string; method: string }> } };
      for (const descriptor of mod.default.descriptors) map.set(`${descriptor.namespace}/${descriptor.method}`, descriptor as never);
    }
    return map;
  }
  it("端点投影值全部通过 strict schema；vendor 清单里的插件 bundle 都是自注册形态", async () => {
    const codecs = await loadCodecs();
    const check = (endpoint: string, value: unknown): void => {
      const descriptor = codecs.get(endpoint); expect(descriptor, `vendor 缺少端点 ${endpoint}`).toBeDefined(); expect(descriptor?.result.create().parse(value), endpoint).toBeDefined();
    };
    const fake = deps();
    const png = Buffer.from(PNG, "base64");
    const withImage = deps({ details: { s1: detail("s1", [message("m1", "user", [{ type: "image", mediaType: "image/png", data: png.toString("base64") }])]) } });
    check("session/list", valueOf(await projectSessionList(fake.projection)));
    check("session/create", { sessionId: "s1" });
    check("session/prompt", { accepted: true });
    check("session/cancel", { accepted: true });
    check("session/updateQueue", { accepted: true });
    check("session/control", valueOf(await projectSessionControlBaseline(fake.projection)));
    check("workspace/follow", await projectWorkspaceBaseline(fake.projection));
    check("session/attachment", valueOf(await projectSessionAttachment(withImage.projection, { request: { sessionId: "s1", attachmentId: "m1#0" } })));
    const manifest = JSON.parse(await readFile(path.join(SERVER_ROOT, "assets", "dsh-web", "manifest.json"), "utf8")) as { plugins: Array<{ id: string; entry: string }> };
    expect(manifest.plugins.length).toBeGreaterThan(0);
    for (const plugin of manifest.plugins.slice(0, 5)) {
      // 非自注册形态的 bundle 在浏览器里静默不注册（服务端 200 也查不出来）
      expect(await readFile(path.join(VENDOR_PLUGINS, plugin.id, plugin.entry), "utf8"), plugin.id).toContain("__ModuleLoader__.load(");
    }
  });
});
