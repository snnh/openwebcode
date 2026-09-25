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
import { deriveSessionRecords, pageWindow, sessionRecordsCount, snapshotWindow } from "../src/dsh/web-protocol/session-events.js";

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
    const fake = deps({ metas: [meta("9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f")] });
    expect(await projectSessionCreate(fake.projection, { request: { sessionId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f" } })).toEqual({ value: { sessionId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f" } });
    // 非 UUID 的 sessionId 提前按参数错误回（owc 会话目录名是 UUID 白名单，不当内部错误外泄）
    expect(await projectSessionCreate(fake.projection, { request: { sessionId: "s1" } })).toMatchObject({ error: { code: "gateway/bad-request" } });
    expect(await projectSessionCreate(fake.projection, { request: { cwd: "/tmp/x" } })).toEqual({ value: { sessionId: "new-session" } });
    expect(fake.create).toHaveBeenCalledWith({ cwd: "/tmp/x" });
    await projectSessionCreate(fake.projection, { request: {} });
    expect(fake.create).toHaveBeenLastCalledWith({ cwd: "/work/default" });
  });

  it("prompt 幂等：同一 requestId 重发不重复起轮（上游 hasPromptRequest 同语义）", async () => {
    const fake = deps();
    const request = { requestId: "req-1", sessionId: "s1", mode: "queue", content: [{ type: "text", text: "只发一次" }] };
    expect(await projectSessionPrompt(fake.projection, { request })).toEqual({ value: { accepted: true } });
    expect(await projectSessionPrompt(fake.projection, { request })).toEqual({ value: { accepted: true } });
    expect(fake.run).toHaveBeenCalledTimes(1);
    // 不同 requestId 是新的提交，照常起轮
    await projectSessionPrompt(fake.projection, { request: { ...request, requestId: "req-2" } });
    expect(fake.run).toHaveBeenCalledTimes(2);
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
    expect(file).toMatchObject({ error: { code: "session/attachment-invalid" } });
    const missing = await projectSessionPrompt(fake.projection, { request: { sessionId: "nope", content: [{ type: "text", text: "x" }] } });
    expect(missing).toMatchObject({ error: { code: "session/not-found" } });
    const empty = await projectSessionPrompt(fake.projection, { request: { sessionId: "s1", content: [{ type: "text", text: "   " }] } });
    expect(empty).toMatchObject({ error: { code: "gateway/bad-request" } });
  });

  it("D7：运行中带图 prompt 明确失败（不静默丢图）；纯文本仍按 mode 入队", async () => {
    const busy = deps({ running: ["s1"] });
    const image = { type: "image", mediaType: "image/png", data: "AAAA" };
    const queued = await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "text", text: "看图" }, image] } });
    expect(queued).toMatchObject({ error: { code: "session/attachment-invalid" } });
    expect((queued as { error: { message: string } }).error.message).toContain("运行中消息不支持图片附件");
    expect(busy.enqueueFollowUp).not.toHaveBeenCalled();
    const steered = await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "steer", content: [image] } });
    expect(steered).toMatchObject({ error: { code: "session/attachment-invalid" } });
    expect(busy.enqueueSteering).not.toHaveBeenCalled();

    expect(await projectSessionPrompt(busy.projection, { request: { sessionId: "s1", mode: "queue", content: [{ type: "text", text: "纯文本" }] } })).toEqual({ value: { accepted: true } });
    expect(busy.enqueueFollowUp).toHaveBeenCalledWith("s1", "纯文本");
    // 空闲态仍支持图片（走 agent.run 的 images 入参）
    const idle = deps();
    await projectSessionPrompt(idle.projection, { request: { sessionId: "s1", content: [image] } });
    expect(idle.run).toHaveBeenCalledWith("s1", "", { images: [{ mediaType: "image/png", data: "AAAA" }] });
  });

  it("D12：session/create 走 REST 同款可见性链路（补发 session.created，幂等命中不补发）", async () => {
    const published: Array<{ type: string; sessionId: string }> = [];
    const fake = deps({ metas: [meta("9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f")] });
    const projection: DshProjectionDeps = {
      ...fake.projection,
      publishSessionCreated: (session: SessionMeta) => published.push({ type: "session.created", sessionId: session.id }),
    };
    expect(await projectSessionCreate(projection, { request: { cwd: "/tmp/x" } })).toEqual({ value: { sessionId: "new-session" } });
    expect(published).toEqual([{ type: "session.created", sessionId: "new-session" }]);
    expect(await projectSessionCreate(projection, { request: { sessionId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f" } })).toEqual({ value: { sessionId: "9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f" } });
    expect(published).toHaveLength(1);
  });

  it("session/create 与 REST 同链路：共用默认套用（snapshotMode 等）并触发 SessionStart 钩子", async () => {
    const calls: string[] = [];
    const fake = deps();
    const projection: DshProjectionDeps = {
      ...fake.projection,
      defaultSelection: () => ({ provider: "deepseek", model: "deepseek-chat" }),
      applySessionDefaults: async (session, provider, model) => {
        calls.push(`defaults:${session.id}:${provider}:${model}`);
        return { ...session, snapshotMode: "manual" };
      },
      runSessionStartHook: async (info) => {
        calls.push(`hook:${info.sessionId}:${info.cwd}`);
      },
    };
    expect(await projectSessionCreate(projection, { request: { cwd: "/tmp/x" } })).toEqual({ value: { sessionId: "new-session" } });
    expect(calls).toEqual(["defaults:new-session:deepseek:deepseek-chat", "hook:new-session:/tmp/x"]);
  });

  it("D9：列表摘要的 asOfSeq 与记录 seq 同口径（水位 = 末条记录 seq，非消息条数）", async () => {
    const messages = [
      message("m1", "user", [{ type: "text", text: "hi" }]),
      message("m2", "assistant", [{ type: "tool_call", id: "c1", name: "bash", input: {} }, { type: "text", text: "yo" }]),
    ];
    const fake = deps({ metas: [meta("s1")], details: { s1: detail("s1", messages) } });
    const projected = await projectSessionList(fake.projection);
    const items = ("value" in projected ? projected.value.items : []) as Array<{ projections: { asOfSeq: number } }>;
    const expected = deriveSessionRecords(messages).records.length - 1; // 水位 = 末条记录 seq（0 基）
    expect(expected).toBe(sessionRecordsCount(messages) - 1);
    expect(items[0]?.projections.asOfSeq).toBe(expected);
  });

  /**
   * vendor 分页不变量（真实缺陷回归）：客户端 RemoteJournalStream
   * （dsh-api-gateway/client.js）要求
   *   - 空窗口 cursor === emptyCursor(-1)；
   *   - `assertPageThrough`：分页返回记录的最后一条 seq **严格等于**请求的 throughSeq
   *     （replaceThrough 修复路径），差一即抛 "page did not end at its requested cursor"；
   *   - `prepend`（loadOlder）：返回页的连续性与 `follows(tail, beforeSeq)`（tail + 1 === beforeSeq）；
   *   - 记录 seq 从 0 起连续（compare/follows 是纯差值比较）。
   * 这些不变量此前被 1 基 seq + 非对称窗口违反，表现为 dsh 界面「历史加载失败」。
   */
  it("分页/快照游标满足 vendor 不变量（0 基连续 seq、through 严格相等、空窗口 -1、prepend 衔接）", () => {
    const messages = [
      message("m1", "user", [{ type: "text", text: "u1" }]),
      message("m2", "assistant", [{ type: "tool_call", id: "c1", name: "bash", input: {} }, { type: "text", text: "a1" }]),
      message("m3", "tool", [{ type: "tool_result", toolCallId: "c1", content: "ok" }]),
      message("m4", "user", [{ type: "text", text: "u2" }]),
      message("m5", "assistant", [{ type: "text", text: "a2" }]),
    ];
    const { records } = deriveSessionRecords(messages);
    // 0 基连续
    expect(records.map((record) => record.event.seq)).toEqual(records.map((_, index) => index));

    // 空会话：cursor = -1（vendor emptyCursor），记录为空
    const empty = snapshotWindow([], 50);
    expect(empty.records).toEqual([]);
    expect(empty.cursor).toBe(-1);
    expect(empty.hasMore).toBe(false);

    // 快照 cursor 恒等于窗口内末条记录 seq
    const full = snapshotWindow(messages, 50);
    expect(full.cursor).toBe(records[records.length - 1]?.event.seq);
    expect(full.totalRecords).toBe(records.length);
    expect(full.hasMore).toBe(false);

    // 截断窗口：cursor 仍是末条记录 seq，hasMore 置位
    const truncated = snapshotWindow(messages, 2);
    expect(truncated.cursor).toBe(records[records.length - 1]?.event.seq);
    expect(truncated.hasMore).toBe(true);

    // through 语义（断流修复）：分页必须**恰好止于** throughSeq（含），含消息内部截断
    for (const through of [0, 3, records[records.length - 1]?.event.seq ?? 0]) {
      const page = pageWindow(messages, through, undefined, 50);
      if (page.records.length > 0) {
        expect(page.records[page.records.length - 1]?.event.seq).toBe(through);
        // 连续（vendor assertPage: follows(previous.last, range.first)）
        const seqs = page.records.map((record) => record.event.seq);
        expect(seqs).toEqual(seqs.map((_, index) => (seqs[0] ?? 0) + index));
      }
    }

    // beforeSeq 语义（loadOlder 前置）：tail + 1 === beforeSeq
    const before = 4;
    const older = pageWindow(messages, records[records.length - 1]?.event.seq ?? 0, before, 50);
    if (older.records.length > 0) {
      expect(older.records[older.records.length - 1]?.event.seq).toBe(before - 1);
    }
  });

  it("content 映射与 updateQueue（edit/remove/steer）", () => {
    expect(mapPromptContent([{ type: "text", text: "a" }, { type: "text", text: "b" }])).toEqual({ text: "a\n\nb", images: [] });
    expect(mapPromptContent("nope")).toMatchObject({ error: { code: "gateway/bad-request" } });
    expect(mapPromptContent([{ type: "wat" }])).toMatchObject({ error: { code: "gateway/bad-request" } });
  });

  it("updateQueue：edit 改内容、remove 删除、steer 移出队列并插话", async () => {
    const fake = deps();
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "edit", content: [{ type: "text", text: "改了" }] } } })).toEqual({ value: { accepted: true } });
    expect(fake.updateQueue).toHaveBeenCalledWith("s1", "q1", { content: "改了" });
    // 队列项内容只有文本：编辑带图必须明确失败（与运行中发图同一处理，不静默丢）
    const withImage = await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "edit", content: [{ type: "image", mediaType: "image/png", data: "AAAA" }] } } });
    expect(withImage).toMatchObject({ error: { code: "session/attachment-invalid" } });
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "remove" } } })).toEqual({ value: { accepted: true } });
    expect(fake.removeQueue).toHaveBeenCalledWith("s1", "q1");
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "q1", action: { kind: "steer" } } })).toEqual({ value: { accepted: true } });
    expect(fake.enqueueSteering).toHaveBeenCalledWith("s1", "排队消息");
    expect(await projectSessionUpdateQueue(fake.projection, { request: { sessionId: "s1", itemId: "nope", action: { kind: "remove" } } })).toMatchObject({ error: { code: "session/queue-item-not-found" } });
  });

  it("control 基线含投影（Host 级：覆盖全部会话）；workspace 基线按 cwd 派生分组且 workspaceId 稳定", async () => {
    const fake = deps({
      metas: [meta("s1", { cwd: "/work/a" }), meta("s2", { cwd: "/work/a" }), meta("s3", { cwd: "/work/b" })],
      details: { s1: detail("s1", []), s2: detail("s2", []), s3: detail("s3", []) },
    });
    const control = await projectSessionControlBaseline(fake.projection);
    expect(control).toMatchObject({ value: { type: "baseline", value: { jobs: {} } } });
    // 该端点无参数（vendor parameters: []）：基线必须是 Host 级的，键覆盖全部会话
    const controlValue = ("value" in control ? control.value : {}) as { value: { projections: Record<string, { asOfSeq: number }> } };
    expect(Object.keys(controlValue.value.projections).sort()).toEqual(["s1", "s2", "s3"]);
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
    expect(await projectSessionAttachment(fake.projection, { request: { sessionId: "s1", attachmentId: "m1#9" } })).toMatchObject({ error: { code: "session/attachment-invalid" } });
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
    const control = await projectSessionControlBaseline(fake.projection);
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
