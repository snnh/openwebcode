/**
 * dsh-sync M5a 单测：子代理会话的**转录嵌套映射**（双向）。
 *
 * 覆盖四层：
 * 1. `SessionStore.importSubagentTranscripts`：落盘形状（JSON + 尾换行）、权限（目录 0700/文件 0600）、
 *    覆盖重写、UUID 防穿越校验、必填字段校验、会话不存在；
 * 2. server 白盒：`sessions.import` 带 `subagents` 的落盘（含 replaceId 覆盖路径重写转录、单项坏数据只告警）
 *    与新增 `sessions.getSubagent`（权限拒绝 / 读取 / 不存在 null / taskId 校验）；
 * 3. host 导入方向：父会话事件流（2 个 subagent `tool/call` + 对应 `tool/result`）+ 2 个子会话目录 →
 *    `importSession` 入参 messages 带 `subagentTaskIds`、subagents 数组 2 条（时序配对启发式：子会话按
 *    createdAt 升序，与目录扫描顺序无关）；多一个未配对子会话 → 警告；单选子会话 → 普通会话 + 注明父 id；
 * 4. host 导出方向：假 `getSession`（带 subagentTaskIds 的 tool_result）+ 假 `getSubagent` → 子会话文件落盘
 *    且头行含 origin/parentSession/delegationDepth/agentPreset；`getSubagent` 返回 null → subagentsFailed。
 *
 * fixture 全部用「代码写 raw v3 会话」自造（`writeV3Session`）：M5a 的输入就是 dsh 目录结构，
 * 自造比二进制 fixture 更好读，也免得把 zstd 依赖写进用例。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDshSyncRoutes,
  type DshSyncExportResult,
  type DshSyncServerApi,
  type DshSyncSessionPreview,
  type DshSyncSessionResult,
} from "../src/extensions/dsh-sync-host.js";
import { dshSessionDir, DSH_SYNC_WRITE_GENERATION, decodeDshSessionFile } from "../src/extensions/dsh-sync-dsh.js";
import { DSH_SYNC_MAP_PATH } from "../src/extensions/dsh-sync-map.js";
import {
  attachSubagentTasks,
  pairSubagentSessions,
  subagentCallIds,
  transcriptTaskIdsOf,
} from "../src/extensions/dsh-sync-subagents.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { OFFICIAL_EXTENSIONS } from "../src/extensions/official.js";
import type { ExtensionManifest } from "../src/extensions/types.js";
import { SessionStore } from "../src/sessions/session-store.js";
import type { ChatMessage } from "../src/sessions/types.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 时间基准（毫秒）。 */
const T0 = 1_700_000_000_000;

/** 毫秒 → ISO（断言用）。 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 会话 id（自造 fixture：父 + 两个子 + 一个未配对子）。 */
const PARENT = "aaaaaaaa-0000-4000-8000-000000000000";
const CHILD_LATE = "bbbbbbbb-0000-4000-8000-000000000002";
const CHILD_EARLY = "cccccccc-0000-4000-8000-000000000003";
const CHILD_EXTRA = "dddddddd-0000-4000-8000-000000000004";

/** 临时目录登记（afterAll 统一清理）。 */
const tempDirs: string[] = [];

/** 建临时目录（登记清理）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/** 造一个 v3 raw 会话（把会话目录写进 dshHome/sessions/<project>/<id>/session.v3.jsonl）。 */
async function writeV3Session(
  home: string,
  project: string,
  id: string,
  header: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = path.join(home, "sessions", project, id);
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: DSH_SYNC_WRITE_GENERATION, id, isSeeded: false, delegationDepth: 0, ...header }),
    ...events.map((event) => JSON.stringify(event)),
  ];
  await writeFile(path.join(dir, `session.v${DSH_SYNC_WRITE_GENERATION}.jsonl`), `${lines.join("\n")}\n`, "utf8");
}

/** 造一个 v4 raw 会话（同目录并存 v3/v4 时扫描会选更高代际的 v4）。 */
async function writeV4Session(
  home: string,
  project: string,
  id: string,
  header: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = path.join(home, "sessions", project, id);
  await mkdir(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 4, id, isSeeded: false, delegationDepth: 0, ...header }),
    ...events.map((event) => JSON.stringify(event)),
  ];
  await writeFile(path.join(dir, "session.v4.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/** v4 一等 tool 角色消息的 `tool/result` 事件（结果块直挂，无 tool-result 包装）。 */
function v4ToolResultEvent(seq: number, id: string, toolCallId: string, text: string): Record<string, unknown> {
  return event(seq, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      id,
      role: "tool",
      toolCallId,
      content: [{ type: "text", text }],
      isError: false,
      source: { kind: "tool", callId: toolCallId },
    },
  }, { surfaceOp: "append" });
}

/** 事件信封。 */
function event(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq, time: T0 + seq, data, ...extra };
}

/** `user/message`（surface）。 */
function userEvent(seq: number, id: string, text: string): Record<string, unknown> {
  return event(seq, "user/message", { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } }, { surfaceOp: "append" });
}

/** `assistant/message`（surface；可选带 tool-call 块）。 */
function assistantEvent(seq: number, id: string, text: string, calls: Array<{ id: string; name: string; args: string }> = []): Record<string, unknown> {
  return event(seq, "assistant/message", {
    turn: 1,
    step: 1,
    message: {
      id,
      role: "assistant",
      content: [
        ...(text.length === 0 ? [] : [{ type: "text", text }]),
        ...calls.map((call) => ({ type: "tool-call", id: call.id, name: call.name, arguments: call.args })),
      ],
      source: { kind: "model", provider: "gateway", model: "deepseek-v4-pro" },
    },
    stream: [],
  }, { surfaceOp: "append" });
}

/** `tool/call`（非 surface；子代理调用的识别依据）。 */
function toolCallEvent(seq: number, callId: string, name: string, args: string): Record<string, unknown> {
  return event(seq, "tool/call", { turn: 1, step: 1, callId, name, arguments: args });
}

/** `tool/result`（surface；v3 规范形态 = 单个 tool-result 块）。 */
function toolResultEvent(seq: number, id: string, callId: string, text: string): Record<string, unknown> {
  return event(seq, "tool/result", {
    turn: 1,
    step: 1,
    message: {
      id,
      role: "tool",
      content: [{ type: "tool-result", toolCallId: callId, content: [{ type: "text", text }] }],
      source: { kind: "tool", callId },
    },
  }, { surfaceOp: "append" });
}

/**
 * 造 M5a 的 dshHome：父会话含 2 个 subagent 调用 + 2 个结果，另有 3 个子会话
 * （createdAt 升序为 CHILD_EARLY → CHILD_LATE → CHILD_EXTRA，而目录扫描顺序是
 * CHILD_LATE(b…) → CHILD_EARLY(c…) → CHILD_EXTRA(d…)，用来验证配对按 createdAt 而非扫描顺序）。
 */
async function subagentHome(prefix: string): Promise<string> {
  const home = path.join(await tempDir(prefix), "dsh-home");
  await mkdir(path.join(home, "sessions"), { recursive: true });
  await writeV3Session(home, "--tmp-sub--", PARENT, { createdAt: T0 - 1000, cwd: "/tmp/sub" }, [
    userEvent(0, "pu1", "跑两个子代理"),
    assistantEvent(1, "pa1", "好的", [
      { id: "call-1", name: "subagent", args: JSON.stringify({ prompt: "任务 A", agent: "explore" }) },
      { id: "call-2", name: "subagent", args: JSON.stringify({ prompt: "任务 B", agent: "general" }) },
    ]),
    toolCallEvent(2, "call-1", "subagent", JSON.stringify({ prompt: "任务 A", agent: "explore" })),
    toolCallEvent(3, "call-2", "subagent", JSON.stringify({ prompt: "任务 B", agent: "general" })),
    toolResultEvent(4, "pt1", "call-1", "任务 A 完成"),
    toolResultEvent(5, "pt2", "call-2", "任务 B 完成"),
  ]);
  // 子会话（头行 origin/parentSession/agentPreset + 一条 user/assistant + 一次工具调用）
  await writeV3Session(home, "--tmp-sub--", CHILD_EARLY, {
    createdAt: T0 + 1000,
    cwd: "/tmp/sub",
    delegationDepth: 1,
    parentSession: PARENT,
    origin: "subagent",
    agentPreset: "explore",
  }, [
    userEvent(0, "cu1", "任务 A"),
    assistantEvent(1, "ca1", "A 的结论", [{ id: "cc1", name: "read_file", args: JSON.stringify({ path: "a.txt" }) }]),
    toolCallEvent(2, "cc1", "read_file", JSON.stringify({ path: "a.txt" })),
  ]);
  await writeV3Session(home, "--tmp-sub--", CHILD_LATE, {
    createdAt: T0 + 2000,
    cwd: "/tmp/sub",
    delegationDepth: 1,
    parentSession: PARENT,
    origin: "subagent",
    agentPreset: "general",
  }, [
    userEvent(0, "cu2", "任务 B"),
    assistantEvent(1, "ca2", "B 的结论"),
  ]);
  await writeV3Session(home, "--tmp-sub--", CHILD_EXTRA, {
    createdAt: T0 + 3000,
    cwd: "/tmp/sub",
    delegationDepth: 1,
    parentSession: PARENT,
    origin: "subagent",
  }, [
    userEvent(0, "cu3", "任务 C"),
    assistantEvent(1, "ca3", "C 的结论"),
  ]);
  return home;
}

/** 假 server API：importSession/存储/owc 会话与转录都用内存表模拟。 */
interface FakeApi {
  api: DshSyncServerApi;
  imported: Array<{ meta: Record<string, unknown>; messages: unknown[]; replaceId?: string; subagents?: Array<{ taskId: string; data: Record<string, unknown> }> }>;
  files: Map<string, string>;
  sessions: Map<string, Record<string, unknown>>;
  transcripts: Map<string, Record<string, unknown>>;
}

/** 建假 API（sessions/transcripts 为初始 deps；importSession 恒回 `owc-N`）。 */
function makeFakeApi(options: {
  sessions?: Record<string, Record<string, unknown>>;
  transcripts?: Record<string, Record<string, unknown>>;
} = {}): FakeApi {
  const files = new Map<string, string>();
  const sessions = new Map(Object.entries(options.sessions ?? {}));
  const transcripts = new Map(Object.entries(options.transcripts ?? {}));
  const imported: FakeApi["imported"] = [];
  return {
    files,
    sessions,
    transcripts,
    imported,
    api: {
      listProfiles: async () => [],
      upsertProfiles: async () => ({ profiles: [], models: [] }),
      importSession: async (input) => {
        imported.push(input);
        return { id: `owc-${imported.length}`, title: typeof input.meta.title === "string" ? input.meta.title : "导入的会话" };
      },
      listSessions: async () => [...sessions.values()].map((detail) => {
        const { messages: _messages, ...meta } = detail;
        return meta;
      }),
      getSession: async (id) => {
        const detail = sessions.get(id);
        if (detail === undefined) throw new Error("Session not found");
        return detail;
      },
      getLedger: async () => ({ version: 1, round: 0, entries: [] }),
      getSubagent: async (sessionId, taskId) => transcripts.get(`${sessionId}/${taskId}`) ?? null,
      storageRead: async (filePath) => ({ content: files.get(filePath) ?? null }),
      storageWrite: async (filePath, content) => {
        files.set(filePath, content);
        return { bytes: Buffer.byteLength(content, "utf8") };
      },
      storageDelete: async (filePath) => ({ deleted: files.delete(filePath) }),
    },
  };
}

// ── 1. SessionStore.importSubagentTranscripts ────────────────────────────────

describe("SessionStore.importSubagentTranscripts", () => {
  /** 建 store + 一个会话。 */
  async function seeded(prefix: string): Promise<{ store: SessionStore; root: string; sessionId: string }> {
    const root = await tempRoot(prefix);
    const store = new SessionStore(path.join(root, "sessions"));
    await store.initialize();
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m", title: "主会话" })).id;
    return { store, root, sessionId };
  }

  /** 合法转录（宽松形状，与 `sub-agent.ts` 落盘一致）。 */
  function transcript(id: string): { taskId: string; data: Record<string, unknown> } {
    return {
      taskId: id,
      data: {
        id,
        prompt: "任务",
        startedAt: iso(T0),
        turns: 1,
        toolsUsed: ["read_file"],
        conclusion: "结论",
        messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "任务" }], createdAt: iso(T0) }],
      },
    };
  }

  it("逐条落盘 <sessionDir>/subagents/<taskId>.json：0600 文件 / 0700 目录 / JSON + 尾换行", async () => {
    const { store, sessionId } = await seeded("dsh-sync-m5a-store-");
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    const written = await store.importSubagentTranscripts(sessionId, [transcript(first), transcript(second)]);

    expect(written).toBe(2);
    const dir = path.join(store.contextRoot(sessionId), "subagents");
    expect((await readdir(dir)).sort()).toEqual([`${first}.json`, `${second}.json`]);
    const raw = await readFile(path.join(dir, `${first}.json`), "utf8");
    expect(raw.endsWith("}\n")).toBe(true);
    expect(JSON.parse(raw)).toMatchObject({ id: first, prompt: "任务", conclusion: "结论" });
    if (process.platform !== "win32") {
      expect((await stat(path.join(dir, `${first}.json`))).mode & 0o777).toBe(0o600);
      expect((await stat(dir)).mode & 0o777).toBe(0o700);
    }
  });

  it("同一 taskId 重复导入 = 覆盖重写（不追加、不残留旧内容）", async () => {
    const { store, sessionId } = await seeded("dsh-sync-m5a-store-overwrite-");
    const taskId = "33333333-3333-4333-8333-333333333333";
    await store.importSubagentTranscripts(sessionId, [transcript(taskId)]);
    const second = transcript(taskId);
    second.data.conclusion = "第二次结论";
    await store.importSubagentTranscripts(sessionId, [second]);
    const raw = await readFile(path.join(store.contextRoot(sessionId), "subagents", `${taskId}.json`), "utf8");
    expect(raw).not.toContain("结论\n");            // 旧内容已被整体替换
    expect(JSON.parse(raw)).toMatchObject({ conclusion: "第二次结论" });
  });

  it("taskId 非 uuid（含路径穿越）与坏 data 逐条抛错；会话不存在同样抛错", async () => {
    const { store, sessionId } = await seeded("dsh-sync-m5a-store-bad-");
    await expect(store.importSubagentTranscripts(sessionId, [{ taskId: "../../evil", data: transcript("x").data }]))
      .rejects.toThrow(/taskId 必须是 uuid/);
    await expect(store.importSubagentTranscripts(sessionId, [{ taskId: "task-1", data: transcript("x").data }]))
      .rejects.toThrow(/taskId 必须是 uuid/);
    const missingPrompt = transcript("44444444-4444-4444-8444-444444444444");
    delete missingPrompt.data.prompt;
    await expect(store.importSubagentTranscripts(sessionId, [missingPrompt])).rejects.toThrow(/缺少字段 prompt/);
    const badMessages = transcript("55555555-5555-4555-8555-555555555555");
    badMessages.data.messages = "nope";
    await expect(store.importSubagentTranscripts(sessionId, [badMessages])).rejects.toThrow(/messages 必须是数组/);
    await expect(store.importSubagentTranscripts("66666666-6666-4666-8666-666666666666", [transcript("77777777-7777-4777-8777-777777777777")]))
      .rejects.toThrow("会话不存在");
  });
});

// ── 2. server 白盒：sessions.import 的 subagents / sessions.getSubagent ──────

describe("server API：sessions.import 的 subagents 与 sessions.getSubagent", () => {
  /** 白盒构造：真实 SessionStore + 无权限的第三方扩展。 */
  async function buildManager(): Promise<{
    dispatch: (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) => Promise<unknown>;
    store: SessionStore;
    sessionId: string;
    root: string;
  }> {
    const root = await tempRoot("dsh-sync-m5a-api-");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const store = new SessionStore(path.join(dataDir, "sessions"));
    await store.initialize();
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m", title: "旧标题" })).id;
    await store.appendMessage(sessionId, "user", [{ type: "text", text: "旧历史" }]);
    const manager = new ExtensionManager(dataDir, undefined, { sessions: store });
    (manager as unknown as { manifests: ExtensionManifest[] }).manifests = [
      ...OFFICIAL_EXTENSIONS,
      { id: "third-party", name: "第三方", version: "0.0.1", description: "无权限", apiVersion: "1", permissions: [] },
    ];
    return {
      root,
      store,
      sessionId,
      dispatch: (request) => (manager as unknown as { dispatchApi(request: unknown): Promise<unknown> }).dispatchApi(request),
    };
  }

  /** 结构化导入入参（meta + messages）。 */
  function importParams(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      meta: { cwd: "/tmp/imported", title: "导入的会话", provider: "p", model: "m", createdAt: iso(T0) },
      messages: [{ id: "u1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: iso(T0) }],
      ...extra,
    };
  }

  /** 转录数据（宽松形状）。 */
  function transcriptData(taskId: string, conclusion = "结论"): Record<string, unknown> {
    return { id: taskId, prompt: "任务", startedAt: iso(T0), turns: 1, toolsUsed: [], conclusion, messages: [] };
  }

  const TASK_A = "aaaaaaaa-1111-4111-8111-111111111111";
  const TASK_B = "bbbbbbbb-2222-4222-8222-222222222222";

  it("subagents 逐条落盘并回 subagentsWritten；坏条目只进 subagentsFailed，导入仍成功", async () => {
    const { dispatch, store, sessionId } = await buildManager();
    const result = await dispatch({
      id: "1",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: importParams({
        replaceId: sessionId,
        subagents: [
          { taskId: TASK_A, data: transcriptData(TASK_A) },
          { taskId: "not-a-uuid", data: transcriptData("x") },
        ],
      }),
    }) as Record<string, unknown>;

    expect(result.subagentsWritten).toBe(1);
    expect(result.subagentsFailed).toEqual([{ taskId: "not-a-uuid", reason: expect.stringContaining("uuid") }]);
    const written = JSON.parse(await readFile(path.join(store.contextRoot(sessionId), "subagents", `${TASK_A}.json`), "utf8")) as { id: string };
    expect(written.id).toBe(TASK_A);
    // 坏条目不落盘
    await expect(stat(path.join(store.contextRoot(sessionId), "subagents", "not-a-uuid.json"))).rejects.toThrow();
  });

  it("replaceId 覆盖路径同样重写转录（旧内容被整体替换）", async () => {
    const { dispatch, store, sessionId } = await buildManager();
    await dispatch({
      id: "2",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: importParams({ replaceId: sessionId, subagents: [{ taskId: TASK_A, data: transcriptData(TASK_A, "第一次") }] }),
    });
    const second = await dispatch({
      id: "3",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: importParams({
        replaceId: sessionId,
        subagents: [{ taskId: TASK_A, data: transcriptData(TASK_A, "第二次") }, { taskId: TASK_B, data: transcriptData(TASK_B) }],
      }),
    }) as Record<string, unknown>;

    expect(second.subagentsWritten).toBe(2);
    const raw = await readFile(path.join(store.contextRoot(sessionId), "subagents", `${TASK_A}.json`), "utf8");
    expect(raw).not.toContain("第一次");
    expect(JSON.parse(raw)).toMatchObject({ conclusion: "第二次" });
  });

  it("端到端落盘：tool_result 的 subagentTaskIds/subagentTasks 经 importJsonl 净化后原样保留", async () => {
    const { dispatch, store } = await buildManager();
    const taskId = "99999999-9999-4999-8999-999999999999";
    const result = await dispatch({
      id: "3b",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: {
        meta: { cwd: "/tmp/imported", title: "带子代理的会话", provider: "p", model: "m", createdAt: iso(T0) },
        messages: [
          { id: "a1", role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "subagent", input: { prompt: "任务" } }], createdAt: iso(T0) },
          {
            id: "t1",
            role: "tool",
            content: [{ type: "tool_result", toolCallId: "call-1", content: "完成", isError: false, subagentTaskIds: [taskId], subagentTasks: [{ taskId, index: 0, status: "done" }] }],
            createdAt: iso(T0 + 1),
          },
        ],
        subagents: [{ taskId, data: transcriptData(taskId) }],
      },
    }) as Record<string, unknown>;

    expect(result.subagentsWritten).toBe(1);
    const detail = await store.get(String(result.id));
    const block = detail!.messages[1]!.content[0]!;
    expect(block).toMatchObject({ type: "tool_result", subagentTaskIds: [taskId], subagentTasks: [{ taskId, index: 0, status: "done" }] });
    // 转录与 messages 落在同一会话目录下（web 面板按 taskId 就能读到）
    expect(await readFile(path.join(store.contextRoot(String(result.id)), "subagents", `${taskId}.json`), "utf8")).toContain(taskId);
  });

  it("无 sessions:mutate 权限的扩展被拒（subagents 也走同一权限门）", async () => {
    const { dispatch } = await buildManager();
    await expect(dispatch({
      id: "4",
      api: "sessions.import",
      extensionId: "third-party",
      params: importParams({ subagents: [{ taskId: TASK_A, data: transcriptData(TASK_A) }] }),
    })).rejects.toThrow("lacks permission: sessions:mutate");
  });

  it("sessions.getSubagent：读回转录 JSON；不存在返回 null；taskId 非法报错", async () => {
    const { dispatch, sessionId } = await buildManager();
    await dispatch({
      id: "5",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: importParams({ replaceId: sessionId, subagents: [{ taskId: TASK_A, data: transcriptData(TASK_A) }] }),
    });

    const read = await dispatch({ id: "6", api: "sessions.getSubagent", extensionId: "dsh-sync", params: { sessionId, taskId: TASK_A } }) as Record<string, unknown>;
    expect(read).toMatchObject({ id: TASK_A, prompt: "任务", conclusion: "结论" });
    // 不存在的转录 → null（面板显示「无转录」而不是报错）
    expect(await dispatch({ id: "7", api: "sessions.getSubagent", extensionId: "dsh-sync", params: { sessionId, taskId: TASK_B } })).toBeNull();
    // taskId 必须是 uuid（防路径穿越）
    await expect(dispatch({ id: "8", api: "sessions.getSubagent", extensionId: "dsh-sync", params: { sessionId, taskId: "../../meta.json" } }))
      .rejects.toThrow("taskId must be a uuid");
    // 权限门：sessions.getSubagent 挂 sessions:read
    await expect(dispatch({ id: "9", api: "sessions.getSubagent", extensionId: "third-party", params: { sessionId, taskId: TASK_A } }))
      .rejects.toThrow(/lacks permission: sessions:read/);
    await expect(dispatch({ id: "10", api: "sessions.getSubagent", extensionId: "dsh-sync", params: { sessionId: "11111111-1111-4111-8111-111111111111", taskId: TASK_A } }))
      .rejects.toThrow("Session not found");
  });
});

// ── 3. host 导入方向：子代理嵌套映射 ─────────────────────────────────────────

describe("POST /sync/sessions（import）：子代理会话嵌套映射", () => {
  it("父会话导入时：2 个子会话转成转录（时序配对）、tool_result 挂 subagentTaskIds/subagentTasks、未配对的进警告", async () => {
    const home = await subagentHome("dsh-sync-m5a-import-");
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: PARENT }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.skipped).toEqual([]);
    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]).toMatchObject({ dshId: PARENT, owcId: "owc-1", subagents: 2 });

    const captured = fake.imported[0]!;
    // 1) subagents 入参：2 条，形状与 owc 自己的转录一致
    expect(captured.subagents).toHaveLength(2);
    const byPrompt = new Map(captured.subagents!.map((item) => [item.data.prompt as string, item]));
    const early = byPrompt.get("任务 A")!;
    const late = byPrompt.get("任务 B")!;
    expect(early.data).toMatchObject({
      prompt: "任务 A",
      agent: "explore",
      startedAt: iso(T0 + 1000),
      turns: 1,
      conclusion: "A 的结论",
    });
    expect(late.data).toMatchObject({ prompt: "任务 B", agent: "general", startedAt: iso(T0 + 2000), conclusion: "B 的结论" });
    // 配对按头行 createdAt 升序（与目录扫描顺序 b…/c… 相反）
    expect(early.taskId).toBe(early.data.id);
    expect(early.data.toolsUsed).toEqual(["read_file"]);
    expect((early.data.messages as ChatMessage[]).map((message) => message.id)).toEqual(["cu1", "ca1"]);
    expect(late.data.toolsUsed).toEqual([]);

    // 2) tool_result 挂载：call-1 ↔ CHILD_EARLY、call-2 ↔ CHILD_LATE
    const messages = captured.messages as ChatMessage[];
    const results = messages.flatMap((message) => message.content.filter((block) => block.type === "tool_result"));
    expect(results).toHaveLength(2);
    const byCall = new Map(results.map((block) => [block.type === "tool_result" ? block.toolCallId : "", block]));
    expect(byCall.get("call-1")?.subagentTaskIds).toEqual([early.taskId]);
    expect(byCall.get("call-1")?.subagentTasks).toEqual([{ taskId: early.taskId, index: 0, status: "done" }]);
    expect(byCall.get("call-2")?.subagentTaskIds).toEqual([late.taskId]);
    expect(byCall.get("call-2")?.subagentTasks).toEqual([{ taskId: late.taskId, index: 0, status: "done" }]);
    // tool_call 块本身不受影响
    expect(messages.flatMap((message) => message.content).filter((block) => block.type === "tool_call").map((block) => block.id)).toEqual(["call-1", "call-2"]);

    // 3) 未配对的子会话 + 配对启发式说明
    expect(body.applied[0]!.warnings.join("\n")).toContain(`1 个子代理会话未配对，可作为独立会话导入（${CHILD_EXTRA}）`);
    expect(body.report.notes.join("\n")).toContain("时序配对启发式");
    expect(body.report.warnings).toEqual([]);
  });

  it("预览清单仍列出子会话（未配对的也照常可选）", async () => {
    const home = await subagentHome("dsh-sync-m5a-preview-");
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("GET /preview/sessions")?.(
      { method: "GET", path: "/preview/sessions", query: { direction: "import" } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionPreview;
    const byId = new Map(body.items.map((item) => [item.dshId, item]));
    expect(body.items).toHaveLength(4);
    expect(byId.get(CHILD_EXTRA)).toMatchObject({ origin: "subagent", parentSession: PARENT, selectable: true });
  });

  it("单独勾选子代理会话：按普通会话导入（无 subagents）并在警告里注明父会话 id", async () => {
    const home = await subagentHome("dsh-sync-m5a-single-");
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: CHILD_EARLY }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]!.subagents).toBeUndefined();
    expect(fake.imported[0]!.subagents).toBeUndefined();
    expect(fake.imported[0]!.meta).toMatchObject({ cwd: "/tmp/sub", createdAt: iso(T0 + 1000) });
    expect(body.applied[0]!.warnings.join("\n")).toContain(`这是子代理会话（父会话 ${PARENT}）`);
    // 单独导入子会话不触发配对说明（没有嵌套任何东西）
    expect(body.report.notes.join("\n")).not.toContain("时序配对启发式");
  });

  it("v4 子会话（一等 tool 角色消息）同样可嵌套：同目录并存时选最高代际 v4", async () => {
    const home = await subagentHome("dsh-sync-m5a-v4-child-");
    // CHILD_EARLY 目录里并存 session.v3.jsonl（subagentHome 写的）与 session.v4.jsonl → 扫描选 v4
    await writeV4Session(home, "--tmp-sub--", CHILD_EARLY, {
      createdAt: T0 + 1000,
      cwd: "/tmp/sub",
      delegationDepth: 1,
      parentSession: PARENT,
      origin: "subagent",
      agentPreset: "explore",
    }, [
      userEvent(0, "cu1", "任务 A"),
      assistantEvent(1, "ca1", "A 的结论", [{ id: "cc1", name: "read_file", args: JSON.stringify({ path: "a.txt" }) }]),
      toolCallEvent(2, "cc1", "read_file", JSON.stringify({ path: "a.txt" })),
      v4ToolResultEvent(3, "ct1", "cc1", "file body"),
    ]);
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: PARENT }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.skipped).toEqual([]);
    expect(body.applied[0]).toMatchObject({ dshId: PARENT, subagents: 2 });
    const early = fake.imported[0]!.subagents!.find((item) => item.data.prompt === "任务 A")!;
    expect(early.data).toMatchObject({ agent: "explore", turns: 1, toolsUsed: ["read_file"] });
    // v4 结果块直挂 → 转录里的 tool 消息仍是 owc 的 tool_result（含 toolsUsed 之外的正文）
    const toolMessage = early.data.messages.find((message) => message.role === "tool")!;
    expect(toolMessage.content).toEqual([
      { type: "tool_result", toolCallId: "cc1", content: "file body", isError: false },
    ]);
  });

  it("子会话头行可读但事件断档（完整解码失败）：不 nested，其后的配对顺延，父会话照常导入", async () => {
    const home = await subagentHome("dsh-sync-m5a-broken-child-");
    // CHILD_EARLY 头行合法（扫描期 supported），但事件 seq 断档 → 完整解码抛「格式损坏」
    const header = { type: "session", version: DSH_SYNC_WRITE_GENERATION, id: CHILD_EARLY, createdAt: T0 + 1000, isSeeded: false, delegationDepth: 1, parentSession: PARENT, origin: "subagent", cwd: "/tmp/sub" };
    const broken = `${JSON.stringify(header)}\n${JSON.stringify(event(3, "user/message", { id: "cu1", role: "user", content: [{ type: "text", text: "任务 A" }] }, { surfaceOp: "append" }))}\n`;
    await writeFile(path.join(home, "sessions", "--tmp-sub--", CHILD_EARLY, `session.v${DSH_SYNC_WRITE_GENERATION}.jsonl`), broken, "utf8");
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: PARENT }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.applied).toHaveLength(1);
    // call-1 ↔ CHILD_EARLY（解码失败 → 未嵌套）、call-2 ↔ CHILD_LATE（成功）、CHILD_EXTRA 未配对
    expect(body.applied[0]!.subagents).toBe(1);
    expect(fake.imported[0]!.subagents).toHaveLength(1);
    expect(fake.imported[0]!.subagents![0]!.data.prompt).toBe("任务 B");
    expect(body.report.warnings.join("\n")).toContain(`子代理会话 ${CHILD_EARLY} 转换失败（未嵌套）`);
    expect(body.applied[0]!.warnings.join("\n")).toContain("2 个子代理会话未配对");
  });
});

// ── 4. host 导出方向：转录 → dsh 子会话 ──────────────────────────────────────

describe("POST /sync/sessions（export）：子代理转录写出 dsh 子会话", () => {
  /** 父会话消息：一次 subagent 调用 + 结果（带 taskId）+ 一次结果指向缺失的转录。 */
  function parentMessages(): ChatMessage[] {
    return [
      { id: "u1", role: "user", content: [{ type: "text", text: "跑子代理" }], createdAt: iso(T0) },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "好" },
          { type: "tool_call", id: "call-1", name: "subagent", input: { prompt: "任务 A" } },
          { type: "tool_call", id: "call-2", name: "subagent", input: { prompt: "任务 B" } },
        ],
        createdAt: iso(T0 + 1000),
      },
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", content: "A 完成", isError: false, subagentTaskIds: ["11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb"], subagentTasks: [{ taskId: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa", index: 0, status: "done" }] }],
        createdAt: iso(T0 + 2000),
      },
      {
        id: "t2",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-2", content: "B 完成", isError: false, subagentTaskIds: ["33333333-cccc-4ccc-8ccc-cccccccccccc"] }],
        createdAt: iso(T0 + 3000),
      },
    ];
  }

  const EXISTING_TASK = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const SECOND_TASK = "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const MISSING_TASK = "33333333-cccc-4ccc-8ccc-cccccccccccc";

  /** 造一次导出（父会话 + 一个可读转录）。 */
  async function exportOnce(prefix: string): Promise<{ body: DshSyncExportResult; home: string }> {
    const home = path.join(await tempDir(prefix), "dsh-home");
    await mkdir(home, { recursive: true });
    const fake = makeFakeApi({
      sessions: {
        "owc-1": { id: "owc-1", title: "父会话", cwd: "/tmp/exp", provider: "gateway", model: "deepseek-v4-pro", createdAt: iso(T0), updatedAt: iso(T0), messages: parentMessages() },
      },
      transcripts: {
        [`owc-1/${SECOND_TASK}`]: {
          id: SECOND_TASK,
          prompt: "任务 A2",
          startedAt: iso(T0 + 700),
          turns: 1,
          toolsUsed: [],
          conclusion: "第二个结论",
          messages: [
            { id: "su2", role: "user", content: [{ type: "text", text: "任务 A2" }], createdAt: iso(T0 + 700) },
            { id: "sa2", role: "assistant", content: [{ type: "text", text: "第二个结论" }], createdAt: iso(T0 + 800) },
          ],
        },
        [`owc-1/${EXISTING_TASK}`]: {
          id: EXISTING_TASK,
          prompt: "任务 A",
          agent: "explore",
          startedAt: iso(T0 + 500),
          turns: 1,
          toolsUsed: [],
          conclusion: "子代理结论",
          messages: [
            { id: "su1", role: "user", content: [{ type: "text", text: "任务 A" }], createdAt: iso(T0 + 500) },
            { id: "sa1", role: "assistant", content: [{ type: "text", text: "子代理结论" }], createdAt: iso(T0 + 600) },
          ],
        },
      },
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-1" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;
    return { body, home };
  }

  it("转录写出为子会话（头行 origin/parentSession/delegationDepth/agentPreset）；缺失转录进 subagentsFailed", async () => {
    const { body, home } = await exportOnce("dsh-sync-m5a-export-");
    expect(body.skipped).toEqual([]);
    const item = body.applied[0]!;
    expect(item.owcId).toBe("owc-1");
    // applied：同一块上的两个 taskId 各写一个子会话（顺序 = subagentTaskIds 顺序），
    // 另一个 taskId（t2 上的）转录缺失 → 只进 subagentsFailed
    expect(item.subagents?.map((child) => child.taskId)).toEqual([EXISTING_TASK, SECOND_TASK]);
    const child = item.subagents![0]!;
    expect(child.dshId).not.toBe(item.dshId);
    expect(item.subagents![1]!.dshId).not.toBe(child.dshId);
    expect(item.subagentsFailed).toEqual([{ taskId: MISSING_TASK, reason: expect.stringContaining("不存在") }]);
    expect(body.report.warnings.join("\n")).toContain(`子代理转录 ${MISSING_TASK} 未导出`);

    // 落盘的子会话文件：头行三件套 + agentPreset，createdAt=转录 startedAt，cwd 同父会话
    const dir = dshSessionDir(home, "/tmp/exp", child.dshId);
    const names = await readdir(dir);
    const decoded = await decodeDshSessionFile({
      file: path.join(dir, names[0]!),
      generation: DSH_SYNC_WRITE_GENERATION,
      compressed: true,
    });
    expect(decoded.header).toMatchObject({
      id: child.dshId,
      origin: "subagent",
      parentSession: item.dshId,
      delegationDepth: 1,
      agentPreset: "explore",
      cwd: "/tmp/exp",
      createdAt: T0 + 500,
    });
    expect(decoded.events.map((event) => String(event.type))).toEqual([
      "turn/start", "step/start", "user/message", "assistant/message", "step/end", "turn/end",
    ]);
    // 父会话与子会话是两个目录（子会话不会覆盖父会话）
    expect(dshSessionDir(home, "/tmp/exp", item.dshId)).not.toBe(dir);
  });

  it("嵌套子代理：子转录里的 subagentTaskIds 递归导出（parentSession 逐层指向、delegationDepth 递增）", async () => {
    const home = path.join(await tempDir("dsh-sync-m5a-nested-"), "dsh-home");
    await mkdir(home, { recursive: true });
    /**
     * 造一条「带下一次子代理调用」的转录：user + assistant(广告 tool_call) + tool(结果带 taskId)。
     * 结果必须有先行广告，否则会被导出前的孤儿结果清洗丢掉（delegationDepth 的递归就断在这里）。
     */
    const chain = (taskId: string, nextTaskId: string | undefined): Record<string, unknown> => ({
      id: taskId,
      prompt: `任务 ${taskId}`,
      startedAt: iso(T0 + 500),
      turns: 1,
      toolsUsed: ["subagent"],
      conclusion: "完成",
      messages: [
        { id: `${taskId}-u`, role: "user", content: [{ type: "text", text: `任务 ${taskId}` }], createdAt: iso(T0 + 500) },
        { id: `${taskId}-a`, role: "assistant", content: [{ type: "tool_call", id: `${taskId}-call`, name: "subagent", input: {} }], createdAt: iso(T0 + 600) },
        {
          id: `${taskId}-t`,
          role: "tool",
          content: [{
            type: "tool_result",
            toolCallId: `${taskId}-call`,
            content: "子任务完成",
            isError: false,
            ...(nextTaskId === undefined ? {} : { subagentTaskIds: [nextTaskId] }),
          }],
          createdAt: iso(T0 + 700),
        },
      ],
    });
    // 6 层链：T1 → T2 → T3 → T4 → T5 → T6（上限 5 层，T6 不导出）
    const tasks = ["T1", "T2", "T3", "T4", "T5", "T6"];
    const transcripts: Record<string, Record<string, unknown>> = {};
    tasks.forEach((taskId, index) => {
      transcripts[`owc-1/${taskId}`] = chain(taskId, tasks[index + 1]);
    });
    // 父会话只引用 T1（链的第 1 层）
    const parent: ChatMessage[] = [
      { id: "pu1", role: "user", content: [{ type: "text", text: "跑链" }], createdAt: iso(T0) },
      { id: "pa1", role: "assistant", content: [{ type: "tool_call", id: "call-1", name: "subagent", input: {} }], createdAt: iso(T0 + 1000) },
      {
        id: "pt1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "call-1", content: "完成", isError: false, subagentTaskIds: ["T1"] }],
        createdAt: iso(T0 + 2000),
      },
    ] as ChatMessage[];
    const fake = makeFakeApi({
      sessions: {
        "owc-1": { id: "owc-1", title: "父会话", cwd: "/tmp/nest", provider: "gateway", model: "deepseek-v4-pro", createdAt: iso(T0), updatedAt: iso(T0), messages: parent },
      },
      transcripts,
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-1" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    expect(body.skipped).toEqual([]);
    const item = body.applied[0]!;
    // 父会话的两个 taskId 是既有用例的（EXISTING_TASK 转录缺失 → failed），这里只关心链上的 5 层
    const exported = (item.subagents ?? []).filter((child) => tasks.includes(child.taskId));
    expect(exported.map((child) => child.taskId)).toEqual(["T1", "T2", "T3", "T4", "T5"]);
    // 逐层头部：parentSession 指回上一层刚写出的 dshId，delegationDepth 递增
    const headers = await Promise.all(exported.map(async (child) => {
      const dir = dshSessionDir(home, "/tmp/nest", child.dshId);
      const names = await readdir(dir);
      const decoded = await decodeDshSessionFile({ file: path.join(dir, names[0]!), generation: DSH_SYNC_WRITE_GENERATION, compressed: true });
      return decoded.header;
    }));
    expect(headers.map((header) => header.delegationDepth)).toEqual([1, 2, 3, 4, 5]);
    expect(headers[0]!.parentSession).toBe(item.dshId);
    expect(headers[1]!.parentSession).toBe(exported[0]!.dshId);
    expect(headers[4]!.parentSession).toBe(exported[3]!.dshId);
    // 超限如实告警并列出未导出的层级（T6），且不写盘
    expect(body.report.warnings.some((warning) => warning.includes("嵌套超过 5 层") && warning.includes("T6"))).toBe(true);
    expect((item.subagents ?? []).some((child) => child.taskId === "T6")).toBe(false);
  });

  it("getSubagent 抛错（服务端读失败）同样只进 subagentsFailed，不影响父会话导出", async () => {
    const home = path.join(await tempDir("dsh-sync-m5a-export-error-"), "dsh-home");
    await mkdir(home, { recursive: true });
    const fake = makeFakeApi({
      sessions: {
        "owc-1": { id: "owc-1", title: "父会话", cwd: "/tmp/exp", provider: "gateway", model: "deepseek-v4-pro", createdAt: iso(T0), updatedAt: iso(T0), messages: parentMessages() },
      },
    });
    fake.api.getSubagent = async () => {
      throw new Error("storage down");
    };
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-1" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    expect(body.applied).toHaveLength(1);
    expect(body.applied[0]!.subagents).toBeUndefined();
    expect(body.applied[0]!.subagentsFailed?.map((failed) => failed.reason)).toEqual(["storage down", "storage down", "storage down"]);
  });
});

// ── 5. 纯函数：配对与挂载（不需要 IO 的边界） ────────────────────────────────

describe("dsh-sync-subagents 纯函数", () => {
  it("subagentCallIds：只收 name === 'subagent' 的 tool/call，按出现顺序", () => {
    const events = [
      event(0, "tool/call", { callId: "c1", name: "bash", arguments: "{}" }),
      event(1, "tool/call", { callId: "c2", name: "subagent", arguments: "{}" }),
      event(2, "tool/result", { message: {} }, { surfaceOp: "append" }),
      event(3, "tool/call", { callId: "c3", name: "subagent", arguments: "{}" }),
      event(4, "tool/call", { name: "subagent", arguments: "{}" }),
    ];
    expect(subagentCallIds(events)).toEqual(["c2", "c3"]);
  });

  it("pairSubagentSessions：调用数多于子会话时，多出来的进 unpaired", () => {
    const entries = [
      { sessionId: "s-b", header: { createdAt: T0 + 2000 }, dir: "/x", file: "/x/f", generation: 3, compressed: false },
      { sessionId: "s-a", header: { createdAt: T0 + 1000 }, dir: "/y", file: "/y/f", generation: 3, compressed: false },
    ];
    const parentEvents = [
      event(0, "tool/call", { callId: "c1", name: "subagent", arguments: "{}" }),
      event(1, "tool/call", { callId: "c2", name: "subagent", arguments: "{}" }),
      event(2, "tool/call", { callId: "c3", name: "subagent", arguments: "{}" }),
    ];
    const pairing = pairSubagentSessions(parentEvents, entries);
    expect(pairing.pairs.map((pair) => [pair.callId, pair.entry.sessionId])).toEqual([["c1", "s-a"], ["c2", "s-b"]]);
    expect(pairing.unpaired).toEqual([]);
    // 调用多于子会话
    const surplus = pairSubagentSessions([event(0, "tool/call", { callId: "c1", name: "subagent", arguments: "{}" })], entries);
    expect(surplus.pairs.map((pair) => pair.entry.sessionId)).toEqual(["s-a"]);
    expect(surplus.unpaired.map((entry) => entry.sessionId)).toEqual(["s-b"]);
  });

  it("attachSubagentTasks：合并既有 subagentTaskIds/subagentTasks，孤立 tool_result 不动", () => {
    const messages: ChatMessage[] = [
      { id: "a1", role: "assistant", content: [{ type: "tool_call", id: "c1", name: "subagent", input: {} }], createdAt: iso(T0) },
      {
        id: "t1",
        role: "tool",
        content: [{ type: "tool_result", toolCallId: "c1", content: "x", isError: false, subagentTaskIds: ["old"], subagentTasks: [{ taskId: "old", index: 0, status: "failed", error: "e" }] }],
        createdAt: iso(T0),
      },
      { id: "t2", role: "tool", content: [{ type: "tool_result", toolCallId: "orphan", content: "y", isError: false }], createdAt: iso(T0) },
    ];
    expect(attachSubagentTasks(messages, [{ callId: "c1", taskId: "new" }, { callId: "orphan", taskId: "nope" }])).toBe(1);
    const patched = messages[1]!.content[0]!;
    expect(patched.type === "tool_result" && patched.subagentTaskIds).toEqual(["old", "new"]);
    expect(patched.type === "tool_result" && patched.subagentTasks).toEqual([
      { taskId: "old", index: 0, status: "failed", error: "e" },
      { taskId: "new", index: 0, status: "done" },
    ]);
    // 孤立 tool_result（messages 里没有同名 tool_call）不挂字段
    expect(messages[2]!.content[0]).not.toHaveProperty("subagentTaskIds");
    // 无配对时不改任何东西
    expect(attachSubagentTasks(messages, [])).toBe(0);
  });

  it("transcriptTaskIdsOf：去重、保持首次出现顺序", () => {
    const messages: ChatMessage[] = [
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "c1", content: "", isError: false, subagentTaskIds: ["a", "b"] }], createdAt: iso(T0) },
      { id: "t2", role: "tool", content: [{ type: "tool_result", toolCallId: "c2", content: "", isError: false, subagentTaskIds: ["b", "c"], subagentTasks: [] }], createdAt: iso(T0) },
    ];
    expect(transcriptTaskIdsOf(messages)).toEqual(["a", "b", "c"]);
    expect(transcriptTaskIdsOf([])).toEqual([]);
  });
});

/** 映射表路径占位断言（避免未使用 import 告警的同时固定常量口径）。 */
describe("M5a 常量口径", () => {
  it("映射表路径未变（子代理转录不写扩展私有 storage）", () => {
    expect(DSH_SYNC_MAP_PATH).toBe("map.json");
  });
});
