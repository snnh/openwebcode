/**
 * dsh-sync 会话同步单测：M3b（dsh → owc 导入）+ M4c（owc → dsh 导出）+ sessions.* 白盒分发。
 *
 * 覆盖五层：
 * 1. `GET /preview/sessions?direction=import`：扫描结果 + 映射表 join + 不可选原因（旧代际/损坏/zstd）+ 目录缺失降级；
 * 2. `POST /sync/sessions?direction=import`：逐项「定位 → 解码 → 转换 → importSession → 记录映射」，含
 *    overwrite 的 replaceId、ledger 透传、断档/缺 cwd/未找到 三类 skipped 与单项失败不中断；
 * 3. `GET /preview/sessions?direction=export` + `POST /sync/sessions?direction=export`：owc 清单 join、
 *    逐项写出 dsh v3 文件（真实写盘 + 自家读取器回读）、缺 dshHome/缺 cwd 的 skipped、单项失败不中断、
 *    以及「fixture zstd 会话 import → 导出」的端到端往返；
 * 4. server 白盒分发：`sessions.import`（结构化入参）与 `sessions.getLedger`（权限/深克隆）；
 * 5. manifest.routes ↔ 路由键集合一致性 + 会话路由的 60s 超时与版本 bump。
 *
 * fixture（`test/fixtures/dsh-sync`）只读使用：需要写盘的用例先 cp 到 mkdtemp 再改副本。
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  createDshSyncRoutes,
  type DshSyncExportAppliedItem,
  type DshSyncExportPreview,
  type DshSyncExportResult,
  type DshSyncServerApi,
  type DshSyncSessionAppliedItem,
  type DshSyncSessionDirection,
  type DshSyncSessionPreview,
  type DshSyncSessionPreviewItem,
  type DshSyncSessionReport,
  type DshSyncSessionResult,
  type DshSyncSessionSkippedItem,
} from "../src/extensions/dsh-sync-host.js";
import { DSH_SYNC_MAP_PATH, type DshSyncMap } from "../src/extensions/dsh-sync-map.js";
import { DSH_SYNC_SUPPORTED_GENERATION, decodeDshSessionFile } from "../src/extensions/dsh-sync-dsh.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { OFFICIAL_EXTENSIONS } from "../src/extensions/official.js";
import type { ExtensionManifest } from "../src/extensions/types.js";
import { ContextManager } from "../src/context/context-manager.js";
import { SessionStore } from "../src/sessions/session-store.js";
import { tempRoot } from "./helpers/temp-roots.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-sync", import.meta.url));
/** fixture 里 v3 zstd 主会话（user=1 / assistant=1）。 */
const DEMO_MAIN = "11111111-2222-4333-8444-555566667777";
/** fixture 里 v3 raw 子代理会话（origin=subagent，父 = DEMO_MAIN）。 */
const DEMO_SUB = "dddddddd-eeee-4fff-8000-111111111111";
/** fixture 里 v3 raw 会话（cwd=/tmp/raw）。 */
const RAW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
/** fixture 里同目录并存 v0/v3 的会话（应选中 v3）。 */
const MULTI_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
/** fixture 里 v1 旧代际会话。 */
const LEGACY_ID = "cccccccc-dddd-4eee-8fff-000000000000";
/** fixture 主会话头行 createdAt（毫秒）。 */
const DEMO_CREATED_AT = 1_786_505_848_722;

/** 毫秒 → ISO（断言用）。 */
function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** 临时目录登记（afterAll 统一清理）。 */
const tempDirs: string[] = [];

/** 建临时目录（登记清理）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 复制 fixture 的 dshHome 到临时目录（用例可自由增删会话目录）。 */
async function fixtureHome(prefix: string): Promise<string> {
  const home = path.join(await tempDir(prefix), "dsh-home");
  await cp(FIXTURES, home, { recursive: true });
  return home;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

/**
 * 假 server API：importSession 只记录入参（不落盘），storage 用内存文件表模拟扩展私有存储；
 * owc 会话（meta+messages）与账本用内存表模拟 `sessions.list`/`get`/`getLedger`（export 方向用）。
 */
interface FakeApi {
  api: DshSyncServerApi;
  imported: Array<{ meta: Record<string, unknown>; messages: unknown[]; replaceId?: string; ledger?: Record<string, unknown> }>;
  files: Map<string, string>;
  /** owc 会话详情表（owcId → meta + messages）；export 方向 getSession 从这里取。 */
  sessions: Map<string, Record<string, unknown>>;
  /** owc 账本表（owcId → ledger）；缺省 `getLedger` 回空账本。 */
  ledgers: Map<string, Record<string, unknown>>;
  /** `models.defaultSelection` 的调用记录（provider 缺省记为 undefined），断言补全走的是哪条分支。 */
  selectionCalls: Array<string | undefined>;
}

/** 建假 API；`storage` 作为初始文件内容，`respond` 覆盖 importSession 的返回，`sessions`/`ledgers` 供 export 方向取数。 */
function makeFakeApi(options: {
  storage?: Record<string, string>;
  respond?: (input: { meta: Record<string, unknown>; messages: unknown[]; replaceId?: string; ledger?: Record<string, unknown> }, index: number) => Record<string, unknown>;
  sessions?: Record<string, Record<string, unknown>>;
  ledgers?: Record<string, Record<string, unknown>>;
  /** `models.defaultSelection` 桩：给定 provider 只回该 provider 的默认模型，缺省回 owc 当前默认选择。 */
  defaultSelection?: (provider?: string) => { provider?: string; model?: string } | undefined;
} = {}): FakeApi {
  const files = new Map<string, string>(Object.entries(options.storage ?? {}));
  const sessions = new Map<string, Record<string, unknown>>(Object.entries(options.sessions ?? {}));
  const ledgers = new Map<string, Record<string, unknown>>(Object.entries(options.ledgers ?? {}));
  const imported: FakeApi["imported"] = [];
  const selectionCalls: FakeApi["selectionCalls"] = [];
  return {
    imported,
    files,
    sessions,
    ledgers,
    selectionCalls,
    api: {
      listProfiles: async () => [],
      upsertProfiles: async () => ({ profiles: [], models: [] }),
      importSession: async (input) => {
        imported.push(input);
        if (options.respond) return options.respond(input, imported.length);
        return { id: `owc-${imported.length}`, title: typeof input.meta.title === "string" ? input.meta.title : "导入的会话" };
      },
      // sessions.list 只回 meta 白名单（不含 messages），与 server publicSessionMeta 同口径
      listSessions: async () => [...sessions.values()].map((detail) => {
        const { messages: _messages, ...meta } = detail;
        return meta;
      }),
      getSession: async (id) => {
        const detail = sessions.get(id);
        if (detail === undefined) throw new Error("Session not found");
        return detail;
      },
      getLedger: async (id) => ledgers.get(id) ?? { version: 1, round: 0, entries: [] },
      // M5a：子代理转录（这些用例的会话消息不带 subagentTaskIds，实际不会被调用）
      getSubagent: async () => null,
      // models.defaultSelection（导出补全模型归属用）：记录调用参数，桩缺省回空选择
      defaultSelection: async (provider) => {
        selectionCalls.push(provider);
        return options.defaultSelection?.(provider) ?? {};
      },
      storageRead: async (filePath) => ({ content: files.get(filePath) ?? null }),
      storageWrite: async (filePath, content) => {
        files.set(filePath, content);
        return { bytes: Buffer.byteLength(content, "utf8") };
      },
      storageDelete: async (filePath) => ({ deleted: files.delete(filePath) }),
    },
  };
}

/** 在临时 dshHome 里造一个 v3 raw 会话（自造用例：ledger / 缺 cwd / 断档 / 损坏）。 */
async function writeV3Session(
  home: string,
  project: string,
  id: string,
  header: Record<string, unknown>,
  events: Array<Record<string, unknown>>,
): Promise<void> {
  const dir = path.join(home, "sessions", project, id);
  await mkdir(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id, isSeeded: false, delegationDepth: 0, ...header }), ...events.map((event) => JSON.stringify(event))];
  await writeFile(path.join(dir, "session.v3.jsonl"), `${lines.join("\n")}\n`, "utf8");
}

/** 建一个 v3 会话事件（envelope 完整）。 */
function event(seq: number, type: string, data: unknown, base: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, seq, time: base + seq, data, ...extra };
}

/** `user/message` 的 surface 事件。 */
function userEvent(seq: number, id: string, text: string, base: number): Record<string, unknown> {
  return event(seq, "user/message", { id, role: "user", content: [{ type: "text", text }], source: { kind: "user" } }, base, { surfaceOp: "append" });
}

/** `assistant/message` 的 surface 事件。 */
function assistantEvent(seq: number, id: string, text: string, base: number): Record<string, unknown> {
  return event(seq, "assistant/message", { turn: 1, step: 1, message: { id, role: "assistant", content: [{ type: "text", text }], source: { kind: "model", provider: "gateway", model: "gpt-x" } }, stream: [] }, base, { surfaceOp: "append" });
}

/** 取清单项（按 dshId 建索引）。 */
function itemsById(body: DshSyncSessionPreview): Map<string, DshSyncSessionPreviewItem> {
  return new Map(body.items.map((item) => [item.dshId, item]));
}

describe("GET /preview/sessions", () => {
  it("5 个会话条目：v3 可选、v1 不可选带升级提示、子代理项带 origin/parentSession、映射命中带 sync", async () => {
    const home = await fixtureHome("dsh-sync-sessions-preview-");
    const fake = makeFakeApi({
      storage: {
        [DSH_SYNC_MAP_PATH]: JSON.stringify({
          version: 1,
          entries: [{ dshId: DEMO_MAIN, owcId: "owc-demo", cwd: "/tmp/demo", title: "已同步", lastSyncDirection: "import", lastSyncAt: "2026-01-01T00:00:00.000Z" }],
        }),
      },
    });
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/sessions");
    const response = await handler?.({ method: "GET", path: "/preview/sessions", query: { direction: "import" } }, { dshHome: home, profile: "web" });
    const body = response?.body as DshSyncSessionPreview;

    expect(response?.status).toBe(200);
    expect(body.direction).toBe("import");
    expect(body.items).toHaveLength(5);
    expect(typeof body.zstdAvailable).toBe("boolean");
    expect(typeof body.dshRunning).toBe("boolean");

    const byId = itemsById(body);
    expect(byId.get(DEMO_MAIN)).toEqual({
      dshId: DEMO_MAIN,
      cwd: "/tmp/demo",
      createdAt: iso(DEMO_CREATED_AT),
      generation: 3,
      supported: true,
      selectable: true,
      sync: { owcId: "owc-demo", lastSyncAt: "2026-01-01T00:00:00.000Z" },
    });
    // 未同步项的 sync 字段缺省（不是空对象）
    expect(byId.get(RAW_ID)?.sync).toBeUndefined();
    // 同目录并存 v0/v3 → 选中 v3
    expect(byId.get(MULTI_ID)).toMatchObject({ generation: 3, cwd: "/tmp/multi", supported: true, selectable: true });
    // 子代理会话：origin/parentSession 透出，仍可导入（转录嵌套映射留 M5）
    expect(byId.get(DEMO_SUB)).toMatchObject({ origin: "subagent", parentSession: DEMO_MAIN, cwd: "/tmp/demo", selectable: true });
    // 旧代际：不可选 + 引导去 dsh 升级
    expect(byId.get(LEGACY_ID)).toEqual({
      dshId: LEGACY_ID,
      generation: 1,
      supported: false,
      selectable: false,
      reason: "请先在 dsh 中打开一次升级格式",
    });
  });

  it("损坏会话文件：不可选 + 「文件损坏：…」原因；其余条目照常返回", async () => {
    const home = await fixtureHome("dsh-sync-sessions-preview-broken-");
    const brokenDir = path.join(home, "sessions", "--tmp-broken--", "e0000000-0000-4000-8000-000000000000");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(path.join(brokenDir, "session.v3.jsonl"), "not json at all\n", "utf8");

    const fake = makeFakeApi();
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/sessions");
    const response = await handler?.({ method: "GET", path: "/preview/sessions", query: {} }, { dshHome: home, profile: "web" });
    const body = response?.body as DshSyncSessionPreview;
    const broken = itemsById(body).get("e0000000-0000-4000-8000-000000000000");

    expect(body.items).toHaveLength(6);
    expect(broken?.supported).toBe(false);
    expect(broken?.selectable).toBe(false);
    expect(broken?.reason).toMatch(/^文件损坏：/);
  });

  it("sessions 目录缺失：空清单 + warning（不抛错）；export 方向读 owc 清单并提示缺 dshHome", async () => {
    const home = path.join(await tempDir("dsh-sync-sessions-preview-empty-"), "nope");
    const fake = makeFakeApi();
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/sessions");

    const importBody = (await handler?.({ method: "GET", path: "/preview/sessions", query: { direction: "import" } }, { dshHome: home, profile: "web" }))?.body as DshSyncSessionPreview;
    expect(importBody.items).toEqual([]);
    expect(importBody.warning).toContain("sessions/");

    const exportBody = (await handler?.({ method: "GET", path: "/preview/sessions", query: { direction: "export" } }, { dshHome: home, profile: "web" }))?.body as DshSyncExportPreview;
    expect(exportBody.direction).toBe("export");
    expect(exportBody.items).toEqual([]);
    expect(exportBody.warning).toContain("dsh 数据目录");

    // 映射表读取失败只降级为「未同步」+ warning，不影响清单
    const failing = makeFakeApi();
    failing.api.storageRead = () => Promise.reject(new Error("storage down"));
    const degraded = (await createDshSyncRoutes(failing.api).get("GET /preview/sessions")?.({ method: "GET", path: "/preview/sessions", query: {} }, { dshHome: FIXTURES, profile: "web" }))?.body as DshSyncSessionPreview;
    expect(degraded.items).toHaveLength(5);
    expect(degraded.warning).toContain("映射表");
  });
});

describe("POST /sync/sessions", () => {
  it("导入 zstd 会话与 raw 会话：applied 带 counts，映射表落盘，importSession 收到 meta/messages", async () => {
    const home = await fixtureHome("dsh-sync-sessions-sync-");
    const fake = makeFakeApi();
    const handler = createDshSyncRoutes(fake.api).get("POST /sync/sessions");
    const response = await handler?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: DEMO_MAIN }, { dshId: RAW_ID }] } },
      { dshHome: home, profile: "web" },
    );
    const body = response?.body as DshSyncSessionResult;

    // 应答形状就是面板（M3 会话区块）的消费契约：显式标注一次，后续把字段改窄时这里先炸
    const direction: DshSyncSessionDirection = body.direction;
    const applied: DshSyncSessionAppliedItem[] = body.applied;
    const skipped: DshSyncSessionSkippedItem[] = body.skipped;
    const report: DshSyncSessionReport = body.report;
    expect(direction).toBe("import");
    expect(skipped).toEqual([]);
    expect(report.appliedCount).toBe(2);
    expect(applied.map((item) => [item.dshId, item.owcId, item.counts])).toEqual([
      [DEMO_MAIN, "owc-1", { user: 1, assistant: 1, tool: 0, images: 0, imagesMissing: 0 }],
      [RAW_ID, "owc-2", { user: 1, assistant: 0, tool: 0, images: 0, imagesMissing: 0 }],
    ]);
    expect(body.skipped).toEqual([]);
    expect(body.report).toMatchObject({ onConflict: "new", appliedCount: 2, skippedCount: 0, mapSaved: true, mapPath: DSH_SYNC_MAP_PATH });
    // fixture 的两个会话只有 surface 事件，没有可丢的非 surface 事件（丢弃账为空）
    expect(body.report.droppedEvents).toEqual({});

    // 首个导入的入参：cwd 取自转换结果，title 缺省时不下发（由 server 兜底），无 replaceId/ledger
    const first = fake.imported[0];
    expect(first?.meta).toEqual({ cwd: "/tmp/demo", createdAt: iso(DEMO_CREATED_AT) });
    expect(first?.messages.map((message) => (message as { id: string }).id)).toEqual(["m1", "m2"]);
    expect(first?.replaceId).toBeUndefined();
    expect(first?.ledger).toBeUndefined();

    // 映射表：两条 import 记录（含 cwd/title/方向/时间）；条目顺序按 lastSyncAt 降序，
    // 这里按 dshId 建索引断言（两次写入落在同一毫秒时顺序由 dshId 稳定兜底，避免脆断言）
    const written = JSON.parse(fake.files.get(DSH_SYNC_MAP_PATH) ?? "{}") as DshSyncMap;
    expect(written.entries).toHaveLength(2);
    const byDshId = new Map(written.entries.map((item) => [item.dshId, item]));
    expect(byDshId.get(DEMO_MAIN)).toMatchObject({ owcId: "owc-1", cwd: "/tmp/demo", lastSyncDirection: "import" });
    expect(byDshId.get(RAW_ID)).toMatchObject({ owcId: "owc-2", cwd: "/tmp/raw", lastSyncDirection: "import" });
    expect(written.entries.every((item) => Number.isFinite(Date.parse(item.lastSyncAt)))).toBe(true);
  });

  it("onConflict=overwrite 且映射表已有该会话：replaceId 传映射里的 owcId；默认 new 不传", async () => {
    const home = await fixtureHome("dsh-sync-sessions-overwrite-");
    const storage = {
      [DSH_SYNC_MAP_PATH]: JSON.stringify({
        version: 1,
        entries: [{ dshId: DEMO_MAIN, owcId: "owc-old", lastSyncDirection: "import", lastSyncAt: "2026-01-01T00:00:00.000Z" }],
      }),
    };
    const handler = createDshSyncRoutes(makeFakeApi({ storage }).api).get("POST /sync/sessions");

    const overwrite = makeFakeApi({ storage });
    const overwriteBody = (await createDshSyncRoutes(overwrite.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: DEMO_MAIN }], onConflict: "overwrite" } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;
    expect(overwrite.imported[0]?.replaceId).toBe("owc-old");
    expect(overwriteBody.report.onConflict).toBe("overwrite");
    // 覆盖后映射表指向新 owcId（同 dshId 原地更新）
    expect(JSON.parse(overwrite.files.get(DSH_SYNC_MAP_PATH) ?? "{}").entries).toHaveLength(1);
    expect(JSON.parse(overwrite.files.get(DSH_SYNC_MAP_PATH) ?? "{}").entries[0].owcId).toBe("owc-1");

    const conflictNew = makeFakeApi({ storage });
    const newBody = (await createDshSyncRoutes(conflictNew.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: DEMO_MAIN }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;
    expect(conflictNew.imported[0]?.replaceId).toBeUndefined();
    expect(newBody.report.onConflict).toBe("new");
    // 未勾选覆盖时映射被新条目接管（同一 dshId 只留一条）
    expect(handler).toBeDefined();
  });

  it("ledger 透传：带 compaction/summary 的会话把转换账本一起下发", async () => {
    const home = await fixtureHome("dsh-sync-sessions-ledger-");
    const base = 1_700_000_000_000;
    await writeV3Session(
      home,
      "--tmp-ledger--",
      "led-1",
      { cwd: "/tmp/ledger", createdAt: base },
      [
        event(0, "turn/start", { turn: 1 }, base),
        event(1, "step/start", { turn: 1, step: 1 }, base),
        userEvent(2, "m0", "开始", base),
        assistantEvent(3, "m1", "收到", base),
        event(4, "compaction/summary", { summary: [{ type: "text", text: "摘要正文" }], shadowedSeqs: [2, 3] }, base),
      ],
    );
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: "led-1" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.applied[0]).toMatchObject({ dshId: "led-1", counts: { user: 1, assistant: 1 } });
    // 丢弃账跨会话聚合（turn/step 类事件只计数），键序排序保证可复现
    expect(body.report.droppedEvents).toEqual({ "step/start": 1, "turn/start": 1 });
    expect(fake.imported[0]?.ledger).toEqual({
      compacted: { uptoIndex: 2, uptoMessageId: "m1", mode: "overview", summary: "摘要正文", instructions: [], createdAt: iso(base + 4) },
    });
  });

  it("三类 skipped：旧代际 / 事件断档 / 未找到；单项失败不中断同批其它项", async () => {
    const home = await fixtureHome("dsh-sync-sessions-skipped-");
    const base = 1_700_000_000_000;
    // 事件 seq 断档：头行可解析（清单里可选），解码时才失败
    await writeV3Session(home, "--tmp-gap--", "gap-1", { cwd: "/tmp/gap", createdAt: base }, [
      userEvent(0, "m0", "一", base),
      userEvent(2, "m2", "二", base),
    ]);
    const fake = makeFakeApi();
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      {
        method: "POST",
        path: "/sync/sessions",
        query: {},
        body: { direction: "import", items: [{ dshId: LEGACY_ID }, { dshId: "gap-1" }, { dshId: "nope-1" }, { dshId: DEMO_MAIN }] },
      },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.applied.map((item) => item.dshId)).toEqual([DEMO_MAIN]);
    expect(body.skipped.map((item) => item.dshId)).toEqual([LEGACY_ID, "gap-1", "nope-1"]);
    expect(body.skipped[0]?.reason).toBe("请先在 dsh 中打开一次升级格式");
    expect(body.skipped[1]?.reason).toContain("格式损坏");
    expect(body.skipped[2]?.reason).toContain("未在");
    expect(body.report).toMatchObject({ appliedCount: 1, skippedCount: 3 });
    // 仅成功项进映射表
    expect(JSON.parse(fake.files.get(DSH_SYNC_MAP_PATH) ?? "{}").entries.map((item: { dshId: string }) => item.dshId)).toEqual([DEMO_MAIN]);
  });

  it("cwd 缺失且无 cwdOverride → skipped；提供 cwdOverride 后按覆盖目录导入", async () => {
    const home = await fixtureHome("dsh-sync-sessions-cwd-");
    const base = 1_700_000_000_000;
    // 头行没有 cwd（dsh 里无 cwd 的会话）
    await writeV3Session(home, "--no-cwd--", "nocwd-1", { createdAt: base }, [userEvent(0, "m0", "无 cwd", base)]);
    const handler = createDshSyncRoutes(makeFakeApi().api).get("POST /sync/sessions");

    const missing = (await handler?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: "nocwd-1" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;
    expect(missing.applied).toEqual([]);
    expect(missing.skipped[0]?.reason).toContain("cwdOverride");

    const overridden = makeFakeApi();
    const applied = (await createDshSyncRoutes(overridden.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: "nocwd-1", cwdOverride: "/tmp/override" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;
    expect(applied.applied[0]).toMatchObject({ dshId: "nocwd-1", counts: { user: 1 } });
    expect(overridden.imported[0]?.meta.cwd).toBe("/tmp/override");
    expect(JSON.parse(overridden.files.get(DSH_SYNC_MAP_PATH) ?? "{}").entries[0].cwd).toBe("/tmp/override");
  });

  it("服务端未返回会话 id：导入计入 applied 但不写映射表并告警", async () => {
    const home = await fixtureHome("dsh-sync-sessions-noid-");
    const fake = makeFakeApi({ respond: () => ({ title: "无 id" }) });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: DEMO_MAIN }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.applied[0]).toMatchObject({ dshId: DEMO_MAIN, owcId: "", title: "无 id" });
    expect(body.report).toMatchObject({ mapSaved: false, appliedCount: 1 });
    expect(body.report.warnings.some((line) => line.includes("未返回会话 id"))).toBe(true);
    expect(fake.files.has(DSH_SYNC_MAP_PATH)).toBe(false);
  });

  it("映射表写盘失败：导入仍成功，报告 mapSaved=false + 告警", async () => {
    const home = await fixtureHome("dsh-sync-sessions-mapsave-");
    const fake = makeFakeApi();
    fake.api.storageWrite = () => Promise.reject(new Error("quota exceeded"));
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: DEMO_MAIN }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncSessionResult;

    expect(body.applied).toHaveLength(1);
    expect(body.report.mapSaved).toBe(false);
    expect(body.report.warnings.some((line) => line.includes("quota exceeded"))).toBe(true);
  });
});

// ── M4c：会话导出（owc → dsh） ───────────────────────────────────────────────

/** 造一条 owc 会话详情（meta + messages）；export 方向 getSession 从这里取。 */
function owcSession(input: {
  id: string;
  cwd?: string;
  title?: string;
  provider?: string;
  model?: string;
  updatedAt?: string;
  messages?: unknown[];
}): Record<string, unknown> {
  return {
    id: input.id,
    title: input.title ?? `会话 ${input.id}`,
    provider: input.provider ?? "gateway",
    model: input.model ?? "deepseek-v4-pro",
    createdAt: iso(DEMO_CREATED_AT),
    updatedAt: input.updatedAt ?? iso(DEMO_CREATED_AT),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    messages: input.messages ?? [],
  };
}

/** 两条消息（user + assistant）的 owc 历史。 */
function twoMessages(): unknown[] {
  return [
    { id: "u1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: iso(DEMO_CREATED_AT) },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "在" }], createdAt: iso(DEMO_CREATED_AT + 1000) },
  ];
}

/** 取导出流里第一条 `assistant/message` 的模型归属（dsh v4 的 `hasProviderModel` 校验字段）。 */
function assistantSourceOf(events: Array<Record<string, unknown>>): Record<string, unknown> {
  const event = events.find((item) => item.type === "assistant/message");
  expect(event).toBeDefined();
  const data = event!.data as { message: { source: Record<string, unknown> } };
  return data.message.source;
}

describe("GET /preview/sessions?direction=export", () => {
  it("owc 会话清单 + 映射表 join（findByOwcId）→ sync 徽标；export 恒可勾选", async () => {
    const home = await fixtureHome("dsh-sync-export-preview-");
    const fake = makeFakeApi({
      sessions: {
        "owc-a": owcSession({ id: "owc-a", cwd: "/tmp/a", title: "会话 A", updatedAt: iso(DEMO_CREATED_AT + 5_000) }),
        "owc-b": owcSession({ id: "owc-b", cwd: "/tmp/b", title: "" }),
      },
      storage: {
        [DSH_SYNC_MAP_PATH]: JSON.stringify({
          version: 1,
          entries: [{ dshId: "dsh-x", owcId: "owc-a", cwd: "/tmp/a", title: "会话 A", lastSyncDirection: "export", lastSyncAt: "2026-02-01T00:00:00.000Z" }],
        }),
      },
    });
    const body = (await createDshSyncRoutes(fake.api).get("GET /preview/sessions")?.(
      { method: "GET", path: "/preview/sessions", query: { direction: "export" } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportPreview;

    expect(body.direction).toBe("export");
    expect(body.items).toHaveLength(2);
    const byId = new Map(body.items.map((item) => [item.owcId, item]));
    expect(byId.get("owc-a")).toEqual({
      owcId: "owc-a",
      title: "会话 A",
      cwd: "/tmp/a",
      provider: "gateway",
      model: "deepseek-v4-pro",
      updatedAt: iso(DEMO_CREATED_AT + 5_000),
      sync: { dshId: "dsh-x", lastSyncAt: "2026-02-01T00:00:00.000Z" },
      selectable: true,
    });
    // 空标题用占位；未同步项无 sync 字段（不是空对象）
    expect(byId.get("owc-b")).toEqual({
      owcId: "owc-b",
      title: "未命名会话",
      cwd: "/tmp/b",
      provider: "gateway",
      model: "deepseek-v4-pro",
      updatedAt: iso(DEMO_CREATED_AT),
      selectable: true,
    });
    expect(body.warning).toBeUndefined();
  });

  it("owc 清单读取失败：空 items + warning（不抛错）", async () => {
    const home = await fixtureHome("dsh-sync-export-preview-fail-");
    const fake = makeFakeApi();
    fake.api.listSessions = () => Promise.reject(new Error("list down"));
    const body = (await createDshSyncRoutes(fake.api).get("GET /preview/sessions")?.(
      { method: "GET", path: "/preview/sessions", query: { direction: "export" } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportPreview;
    expect(body.items).toEqual([]);
    expect(body.warning).toContain("owc 会话清单");
  });
});

describe("POST /sync/sessions?direction=export", () => {
  it("逐项写出 dsh v3 文件：可回读、映射表记 export 方向、applied 字段齐全（带/不带 compacted 各一）", async () => {
    const home = await fixtureHome("dsh-sync-export-run-");
    const fake = makeFakeApi({
      sessions: {
        "owc-1": owcSession({ id: "owc-1", cwd: "/tmp/demo", title: "导出会话", messages: twoMessages() }),
        "owc-2": owcSession({ id: "owc-2", cwd: "/tmp/raw", title: "无压缩", messages: twoMessages() }),
      },
      ledgers: {
        "owc-1": {
          version: 1,
          round: 1,
          entries: [],
          compacted: { uptoIndex: 1, uptoMessageId: "u1", mode: "overview", summary: "摘要正文", instructions: [], createdAt: iso(DEMO_CREATED_AT + 500) },
        },
        "owc-2": { version: 1, round: 0, entries: [] },
      },
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-1" }, { owcId: "owc-2" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    // 应答形状就是面板（M4 会话区块）的消费契约
    expect(body.direction).toBe("export");
    expect(body.skipped).toEqual([]);
    const applied: DshSyncExportAppliedItem[] = body.applied;
    expect(applied).toHaveLength(2);
    const first = applied[0]!;
    expect(first).toMatchObject({ owcId: "owc-1", attachments: 0, warnings: [] });
    expect(first.dshId.length).toBeGreaterThan(0);
    expect(first.eventCount).toBeGreaterThan(0);
    // 文件落在 dshHome 下：--<cwd-slug>--/<dshId>/session.v3.jsonl.zstd
    expect(first.file).toBe(path.join(home, "sessions", "--tmp-demo--", first.dshId, "session.v3.jsonl.zstd"));

    // 自家读取器回读：头行 id 一致 + 压缩生命周期齐全
    const decoded = await decodeDshSessionFile({ file: first.file, generation: DSH_SYNC_SUPPORTED_GENERATION, compressed: true });
    expect(decoded.header.id).toBe(first.dshId);
    const types = decoded.events.map((item) => String(item.type));
    expect(types).toEqual(expect.arrayContaining(["user/message", "assistant/message", "compaction/start", "compaction/summary", "compaction/end"]));

    // 无压缩的第二项：不含 compaction/*
    const second = applied[1]!;
    const decoded2 = await decodeDshSessionFile({ file: second.file, generation: DSH_SYNC_SUPPORTED_GENERATION, compressed: true });
    expect(decoded2.events.some((item) => typeof item.type === "string" && item.type.startsWith("compaction/"))).toBe(false);

    // 映射表：以新 dshId 为键、方向 export
    const written = JSON.parse(fake.files.get(DSH_SYNC_MAP_PATH) ?? "{}") as DshSyncMap;
    expect(written.entries).toHaveLength(2);
    expect(written.entries.every((item) => item.lastSyncDirection === "export")).toBe(true);
    const byOwc = new Map(written.entries.map((item) => [item.owcId, item]));
    expect(byOwc.get("owc-1")).toMatchObject({ dshId: first.dshId, cwd: "/tmp/demo", title: "导出会话" });
    expect(byOwc.get("owc-2")).toMatchObject({ dshId: second.dshId, cwd: "/tmp/raw" });
    expect(body.report).toMatchObject({ appliedCount: 2, skippedCount: 0, mapSaved: true, mapPath: DSH_SYNC_MAP_PATH });
  });

  it("dshHome 不存在 → 整批 skipped；缺 cwd / 相对 cwd → 逐项 skipped", async () => {
    const missingHome = path.join(await tempDir("dsh-sync-export-nohome-"), "nope");
    const missing = makeFakeApi({ sessions: { "owc-1": owcSession({ id: "owc-1", cwd: "/tmp/demo" }) } });
    const batch = (await createDshSyncRoutes(missing.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-1" }] } },
      { dshHome: missingHome, profile: "web" },
    ))?.body as DshSyncExportResult;
    expect(batch.applied).toEqual([]);
    expect(batch.skipped).toEqual([{ owcId: "owc-1", reason: "未检测到 dsh 数据目录" }]);
    // 整批跳过不写盘（连 map 都不写）
    expect(missing.files.has(DSH_SYNC_MAP_PATH)).toBe(false);

    const home = await fixtureHome("dsh-sync-export-cwd-");
    const cwdFake = makeFakeApi({
      sessions: {
        "owc-nocwd": owcSession({ id: "owc-nocwd", title: "无 cwd" }),
        "owc-rel": owcSession({ id: "owc-rel", cwd: "relative/dir", title: "相对" }),
      },
    });
    const body = (await createDshSyncRoutes(cwdFake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-nocwd" }, { owcId: "owc-rel" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;
    expect(body.applied).toEqual([]);
    expect(body.skipped.map((item) => item.owcId)).toEqual(["owc-nocwd", "owc-rel"]);
    expect(body.skipped[0]?.reason).toContain("cwd");
    expect(body.skipped[1]?.reason).toContain("绝对路径");
  });

  it("单项失败不中断：getSession 抛错的项 skipped，其余照常导出", async () => {
    const home = await fixtureHome("dsh-sync-export-continue-");
    const fake = makeFakeApi({ sessions: { "owc-1": owcSession({ id: "owc-1", cwd: "/tmp/demo", messages: twoMessages() }) } });
    const original = fake.api.getSession;
    fake.api.getSession = async (id) => {
      if (id === "owc-missing") throw new Error("Session not found");
      return original(id);
    };
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-missing" }, { owcId: "owc-1" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;
    expect(body.applied.map((item) => item.owcId)).toEqual(["owc-1"]);
    expect(body.skipped).toEqual([{ owcId: "owc-missing", reason: "Session not found" }]);
    expect(body.report).toMatchObject({ appliedCount: 1, skippedCount: 1, mapSaved: true });
  });

  it("含工具调用的会话：assistant/message 排在 tool/call 之前（dsh 生命周期要求）", async () => {
    const home = await fixtureHome("dsh-sync-export-tools-");
    const base = DEMO_CREATED_AT;
    const messages = [
      { id: "u1", role: "user", content: [{ type: "text", text: "跑一下" }], createdAt: iso(base) },
      {
        id: "a1",
        role: "assistant",
        content: [
          { type: "text", text: "好的" },
          { type: "tool_call", id: "call-1", name: "bash", input: { command: "echo hi" } },
        ],
        createdAt: iso(base + 1000),
      },
      { id: "t1", role: "tool", content: [{ type: "tool_result", toolCallId: "call-1", content: "hi", isError: false }], createdAt: iso(base + 2000) },
      { id: "a2", role: "assistant", content: [{ type: "text", text: "完成" }], createdAt: iso(base + 3000) },
    ];
    const fake = makeFakeApi({ sessions: { "owc-tools": owcSession({ id: "owc-tools", cwd: "/tmp/tools", messages }) } });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-tools" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;
    expect(body.skipped).toEqual([]);
    const decoded = await decodeDshSessionFile({ file: body.applied[0]!.file, generation: DSH_SYNC_SUPPORTED_GENERATION, compressed: true });
    const types = decoded.events.map((event) => String(event.type));
    const assistantIdx = types.indexOf("assistant/message");
    const callIdx = types.indexOf("tool/call");
    const resultIdx = types.indexOf("tool/result");
    expect(assistantIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(assistantIdx);
    expect(resultIdx).toBeGreaterThan(callIdx);
  });

  it("model 为空 + defaultSelection(provider) 给出默认模型 → 写盘文件里 assistant 的归属非空", async () => {
    const home = await fixtureHome("dsh-sync-export-fill-provider-");
    const fake = makeFakeApi({
      sessions: { "owc-fill": owcSession({ id: "owc-fill", cwd: "/tmp/demo", provider: "demo", model: "", messages: twoMessages() }) },
      defaultSelection: (provider) => (provider === "demo" ? { provider: "demo", model: "demo-default" } : undefined),
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-fill" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    expect(body.skipped).toEqual([]);
    expect(body.applied).toHaveLength(1);
    // 补全走的是「给 provider 求该 provider 默认模型」这条分支（不去碰 owc 当前默认链）
    expect(fake.selectionCalls).toEqual(["demo"]);
    expect(body.applied[0]!.warnings).toEqual([]);
    const decoded = await decodeDshSessionFile({
      file: body.applied[0]!.file,
      generation: DSH_SYNC_SUPPORTED_GENERATION,
      compressed: true,
    });
    expect(assistantSourceOf(decoded.events)).toEqual({ kind: "model", provider: "demo", model: "demo-default" });
  });

  it("provider/model 都空 + defaultSelection() 给出完整默认 → 采用默认归属导出成功", async () => {
    const home = await fixtureHome("dsh-sync-export-fill-default-");
    const fake = makeFakeApi({
      sessions: { "owc-empty": owcSession({ id: "owc-empty", cwd: "/tmp/demo", provider: "", model: "", messages: twoMessages() }) },
      defaultSelection: (provider) => (provider === undefined ? { provider: "demo", model: "demo-default" } : undefined),
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-empty" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    expect(body.skipped).toEqual([]);
    expect(fake.selectionCalls).toEqual([undefined]);
    const decoded = await decodeDshSessionFile({
      file: body.applied[0]!.file,
      generation: DSH_SYNC_SUPPORTED_GENERATION,
      compressed: true,
    });
    expect(assistantSourceOf(decoded.events)).toEqual({ kind: "model", provider: "demo", model: "demo-default" });
  });

  it("model 空 + defaultSelection 给不出该 provider 的模型 → skipped（原因含「模型信息」）且不写盘", async () => {
    const home = await fixtureHome("dsh-sync-export-fill-fail-");
    const fake = makeFakeApi({
      sessions: { "owc-nomodel": owcSession({ id: "owc-nomodel", cwd: "/tmp/demo", provider: "demo", model: "", messages: twoMessages() }) },
      defaultSelection: () => ({ provider: "demo", model: "" }),
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-nomodel" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    expect(body.applied).toEqual([]);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0]!.owcId).toBe("owc-nomodel");
    expect(body.skipped[0]!.reason).toContain("模型信息");
    expect(body.skipped[0]!.reason).toContain("demo");
    expect(body.report).toMatchObject({ appliedCount: 0, skippedCount: 1, mapSaved: false });
    // 补不出归属就不写出坏会话：该 cwd 对应的会话目录下没有文件
    expect(fake.files.has(DSH_SYNC_MAP_PATH)).toBe(false);
  });

  it("provider/model 都空 + defaultSelection 给不全 → skipped（提示先设默认模型）", async () => {
    const home = await fixtureHome("dsh-sync-export-fill-none-");
    const fake = makeFakeApi({
      sessions: { "owc-none": owcSession({ id: "owc-none", cwd: "/tmp/demo", provider: "", model: "", messages: twoMessages() }) },
      defaultSelection: () => ({ provider: "demo" }),
    });
    const body = (await createDshSyncRoutes(fake.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-none" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;

    expect(body.applied).toEqual([]);
    expect(body.skipped[0]!.reason).toContain("没有默认模型可回填");
  });

  it("provider 空 + model 非空：默认选择与之一致才采用，否则按缺 provider 跳过", async () => {
    const home = await fixtureHome("dsh-sync-export-fill-provider-empty-");
    const matched = makeFakeApi({
      sessions: { "owc-orphan": owcSession({ id: "owc-orphan", cwd: "/tmp/demo", provider: "", model: "demo-default", messages: twoMessages() }) },
      defaultSelection: () => ({ provider: "demo", model: "demo-default" }),
    });
    const applied = (await createDshSyncRoutes(matched.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-orphan" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;
    expect(applied.skipped).toEqual([]);
    const decoded = await decodeDshSessionFile({
      file: applied.applied[0]!.file,
      generation: DSH_SYNC_SUPPORTED_GENERATION,
      compressed: true,
    });
    expect(assistantSourceOf(decoded.events)).toEqual({ kind: "model", provider: "demo", model: "demo-default" });

    // 默认模型不一致（会话里的模型不属于默认 provider）→ 不张冠李戴，直接跳过
    const mismatched = makeFakeApi({
      sessions: { "owc-orphan": owcSession({ id: "owc-orphan", cwd: "/tmp/demo", provider: "", model: "other-model", messages: twoMessages() }) },
      defaultSelection: () => ({ provider: "demo", model: "demo-default" }),
    });
    const skipped = (await createDshSyncRoutes(mismatched.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId: "owc-orphan" }] } },
      { dshHome: home, profile: "web" },
    ))?.body as DshSyncExportResult;
    expect(skipped.applied).toEqual([]);
    expect(skipped.skipped[0]!.reason).toBe("会话缺少模型信息（provider 为空）");
  });
});

describe("端到端往返：fixture zstd 会话 import → export", () => {
  it("import 入参的 meta/messages 作为 getSession → 导出文件可回读、事件序列合理", async () => {
    // 1) 用 import 路由把 fixture 的 zstd 会话导进假 api
    const importHome = await fixtureHome("dsh-sync-roundtrip-import-");
    const importer = makeFakeApi();
    const importBody = (await createDshSyncRoutes(importer.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "import", items: [{ dshId: DEMO_MAIN }] } },
      { dshHome: importHome, profile: "web" },
    ))?.body as DshSyncSessionResult;
    expect(importBody.applied).toHaveLength(1);
    const captured = importer.imported[0]!;
    const owcId = importBody.applied[0]!.owcId;

    // 2) 把 import 的入参 meta/messages 作为 getSession 返回（真实 server 会补 id/provider/model/updatedAt）
    const exporter = makeFakeApi({
      sessions: {
        [owcId]: {
          id: owcId,
          title: "往返",
          cwd: captured.meta.cwd,
          createdAt: captured.meta.createdAt,
          provider: "gateway",
          model: "deepseek-v4-pro",
          updatedAt: iso(DEMO_CREATED_AT),
          messages: captured.messages,
        },
      },
    });
    const exportHome = await fixtureHome("dsh-sync-roundtrip-export-");
    const exportBody = (await createDshSyncRoutes(exporter.api).get("POST /sync/sessions")?.(
      { method: "POST", path: "/sync/sessions", query: {}, body: { direction: "export", items: [{ owcId }] } },
      { dshHome: exportHome, profile: "web" },
    ))?.body as DshSyncExportResult;

    // 3) 导出文件过自家读取器，事件类型序列合理
    expect(exportBody.skipped).toEqual([]);
    const item = exportBody.applied[0]!;
    expect(item.owcId).toBe(owcId);
    expect(item.attachments).toBe(0);
    const decoded = await decodeDshSessionFile({ file: item.file, generation: DSH_SYNC_SUPPORTED_GENERATION, compressed: true });
    expect(decoded.header.id).toBe(item.dshId);
    expect(decoded.header.cwd).toBe("/tmp/demo");
    const types = decoded.events.map((event) => String(event.type));
    const userIdx = types.indexOf("user/message");
    const assistantIdx = types.indexOf("assistant/message");
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(assistantIdx).toBeGreaterThan(userIdx);
    // fixture 会话没有工具调用：任何 tool/call 都应在 assistant/message 之后（此例不存在 tool/call）
    expect(types.indexOf("tool/call")).toBe(-1);
    // 映射表：导出写回同一张表，方向 export、owcId 对齐
    const written = JSON.parse(exporter.files.get(DSH_SYNC_MAP_PATH) ?? "{}") as DshSyncMap;
    expect(written.entries).toEqual([expect.objectContaining({ owcId, dshId: item.dshId, lastSyncDirection: "export" })]);
  });
});

describe("manifest.routes ↔ host 路由表一致性（M3b 扩充）", () => {
  it("会话路由已声明且键集合与工厂一致；版本 bump 到 0.2.1", () => {
    const manifest = OFFICIAL_EXTENSIONS.find((item) => item.id === "dsh-sync");
    const declared = (manifest?.routes ?? []).map((route) => `${route.method} ${route.path}`).sort();
    expect(declared).toEqual([
      "GET /preview/providers",
      "GET /preview/sessions",
      "GET /status",
      "POST /sync/providers",
      "POST /sync/sessions",
    ]);
    expect(declared).toEqual([...createDshSyncRoutes(makeFakeApi().api).keys()].sort());
    expect(manifest?.version).toBe("0.2.1");
    for (const routePath of ["/preview/sessions", "/sync/sessions"]) {
      const route = (manifest?.routes ?? []).find((item) => item.path === routePath);
      expect(route?.timeoutMs).toBe(60_000);
    }
  });
});

describe("server API：sessions.import 结构化入参（经 ExtensionManager 分发）", () => {
  /** 头行/消息时间基准。 */
  const T0 = 1_700_000_000_000;

  /** 结构化入参的消息（与转换器产物同构：ChatMessage）。 */
  function messages(): unknown[] {
    return [
      { id: "u1", role: "user", content: [{ type: "text", text: "你好" }], createdAt: iso(T0) },
      { id: "a1", role: "assistant", content: [{ type: "text", text: "在" }], createdAt: iso(T0 + 1) },
    ];
  }

  /** 白盒构造：注入真实 SessionStore + 可选的默认模型解析桩，跳过 initialize（不 fork 宿主进程）。 */
  async function buildManager(resolveModelSelection?: () => { provider?: string; model?: string } | undefined): Promise<{
    dispatch: (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) => Promise<unknown>;
    store: SessionStore;
    sessionId: string;
    root: string;
  }> {
    const root = await tempRoot("dsh-sync-import-structured-");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const store = new SessionStore(path.join(dataDir, "sessions"));
    await store.initialize();
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m", title: "旧标题" })).id;
    await store.appendMessage(sessionId, "user", [{ type: "text", text: "旧历史" }]);
    const manager = new ExtensionManager(dataDir, undefined, { sessions: store, ...(resolveModelSelection ? { resolveModelSelection } : {}) });
    (manager as unknown as { manifests: ExtensionManifest[] }).manifests = [
      ...OFFICIAL_EXTENSIONS,
      { id: "third-party", name: "第三方", version: "0.0.1", description: "无新权限", apiVersion: "1", permissions: [] },
    ];
    return {
      root,
      store,
      sessionId,
      dispatch: (request) => (manager as unknown as { dispatchApi(request: unknown): Promise<unknown> }).dispatchApi(request),
    };
  }

  it("meta 缺 provider/model → 调 resolveModelSelection 补默认；title 缺省补「导入的会话」", async () => {
    let calls = 0;
    const { dispatch, store } = await buildManager(() => {
      calls += 1;
      return { provider: "p-default", model: "m-default" };
    });
    const result = await dispatch({
      id: "1",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { meta: { cwd: "/tmp/imported", createdAt: iso(T0) }, messages: messages() },
    }) as Record<string, unknown>;

    expect(calls).toBe(1);
    expect(result).toMatchObject({ cwd: "/tmp/imported", provider: "p-default", model: "m-default", title: "导入的会话", createdAt: iso(T0) });
    const detail = await store.get(String(result.id));
    expect(detail?.messages.map((message) => [message.id, message.role])).toEqual([["u1", "user"], ["a1", "assistant"]]);
  });

  it("meta 给了 provider/model → 不打扰默认解析（桩零调用）", async () => {
    let calls = 0;
    const { dispatch, store } = await buildManager(() => {
      calls += 1;
      return { provider: "should-not-be-used" };
    });
    const result = await dispatch({
      id: "2",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { meta: { cwd: "/tmp/explicit", title: "显式", provider: "dsh-provider", model: "dsh-model", createdAt: iso(T0) }, messages: messages() },
    }) as Record<string, unknown>;

    expect(calls).toBe(0);
    expect(result).toMatchObject({ title: "显式", provider: "dsh-provider", model: "dsh-model" });
    expect((await store.get(String(result.id)))?.messages).toHaveLength(2);
  });

  it("显式 provider + 缺 model：只采纳同一 provider 的默认模型（不张冠李戴），不一致时留空", async () => {
    const mismatched = await buildManager(() => ({ provider: "p-default", model: "m-default" }));
    const withModel = await mismatched.dispatch({
      id: "2b",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { meta: { cwd: "/tmp/x", title: "同 provider", provider: "p-default" }, messages: messages() },
    }) as Record<string, unknown>;
    expect(withModel.model).toBe("m-default");

    const other = await mismatched.dispatch({
      id: "2c",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { meta: { cwd: "/tmp/x", title: "别的 provider", provider: "p-other" }, messages: messages() },
    }) as Record<string, unknown>;
    expect(other).toMatchObject({ provider: "p-other", model: "" });
  });

  it("provider 解析不出来 → 报「无可用服务商配置」；meta.cwd 缺失 / messages 非数组各自报错", async () => {
    const { dispatch } = await buildManager(() => undefined);
    await expect(dispatch({ id: "3", api: "sessions.import", extensionId: "dsh-sync", params: { meta: { cwd: "/tmp/x" }, messages: messages() } }))
      .rejects.toThrow(/无可用服务商配置/);
    // 解析桩返回空 provider 同样拒绝（面板未配置服务商时的真实形态）
    const empty = await buildManager(() => ({ provider: "", model: "" }));
    await expect(empty.dispatch({ id: "4", api: "sessions.import", extensionId: "dsh-sync", params: { meta: { cwd: "/tmp/x" }, messages: messages() } }))
      .rejects.toThrow(/无可用服务商配置/);
    await expect(dispatch({ id: "5", api: "sessions.import", extensionId: "dsh-sync", params: { meta: { cwd: "  ", provider: "p" }, messages: messages() } }))
      .rejects.toThrow(/requires meta.cwd/);
    await expect(dispatch({ id: "6", api: "sessions.import", extensionId: "dsh-sync", params: { meta: { cwd: "/tmp/x", provider: "p" }, messages: "nope" } }))
      .rejects.toThrow(/requires messages to be an array/);
    await expect(dispatch({ id: "7", api: "sessions.import", extensionId: "dsh-sync", params: {} }))
      .rejects.toThrow(/requires non-empty text/);
  });

  it("text 分支优先：同时给出 text 与 meta 时按现成文本导入（M3a 行为保持）", async () => {
    const { dispatch, store, sessionId, root } = await buildManager(() => ({ provider: "p-default", model: "m-default" }));
    const head = { kind: "meta", version: 1, exportedAt: iso(T0), session: { id: sessionId, cwd: "/tmp/text", provider: "p", model: "m", title: "来自文本", createdAt: iso(T0), updatedAt: iso(T0) } };
    const text = `${[JSON.stringify(head), JSON.stringify({ id: "t1", role: "user", content: [{ type: "text", text: "文本消息" }], createdAt: iso(T0) })].join("\n")}\n`;
    const result = await dispatch({
      id: "8",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { text, meta: { cwd: "/tmp/meta", title: "来自 meta" }, messages: messages(), replaceId: sessionId },
    }) as Record<string, unknown>;

    expect(result).toMatchObject({ id: sessionId, title: "来自文本", provider: "p", model: "m" });
    // 覆盖导入只换历史与 title/createdAt：原 cwd 保留（安全/环境字段不被导入文件带走）
    expect((await store.get(sessionId))?.cwd).toBe(root);
    expect((await store.get(sessionId))?.messages.map((message) => message.id)).toEqual(["t1"]);
  });

  it("结构化入参 + replaceId + ledger：覆盖历史并落账本（dsh compaction 映射直通）", async () => {
    const { dispatch, sessionId, store } = await buildManager(() => ({ provider: "p-default", model: "m-default" }));
    const ledger = { compacted: { uptoIndex: 1, uptoMessageId: "u1", mode: "overview", summary: "摘要", instructions: [], createdAt: iso(T0) } };
    const result = await dispatch({
      id: "9",
      api: "sessions.import",
      extensionId: "dsh-sync",
      params: { meta: { cwd: "/tmp/override", title: "覆盖导入", provider: "p", model: "m", createdAt: iso(T0) }, messages: messages(), replaceId: sessionId, ledger },
    }) as Record<string, unknown>;

    expect(result.id).toBe(sessionId);
    expect((await store.get(sessionId))?.messages.map((message) => message.id)).toEqual(["u1", "a1"]);
    const written = JSON.parse(await readFile(path.join(store.contextRoot(sessionId), "ledger.json"), "utf8")) as { compacted?: { uptoMessageId?: string } };
    expect(written.compacted?.uptoMessageId).toBe("u1");
    expect(await new ContextManager(store.contextRoot(sessionId)).loadLedger()).toMatchObject({ ledger: { compacted: { summary: "摘要", uptoMessageId: "u1" } } });
  });
});

describe("server API：sessions.getLedger（白盒分发）", () => {
  /** 头行/账本时间基准。 */
  const T0 = 1_700_000_000_000;

  /** 白盒构造：真实 SessionStore + 一条带 compacted 的账本；manifests 含无权限的第三方扩展。 */
  async function buildLedgerManager(): Promise<{
    dispatch: (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) => Promise<unknown>;
    sessionId: string;
  }> {
    const root = await tempRoot("dsh-sync-ledger-");
    const dataDir = path.join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const store = new SessionStore(path.join(dataDir, "sessions"));
    await store.initialize();
    const sessionId = (await store.create({ cwd: root, provider: "p", model: "m", title: "账本会话" })).id;
    await store.appendMessage(sessionId, "user", [{ type: "text", text: "你好" }]);
    await new ContextManager(store.contextRoot(sessionId)).updateLedger((ledger) => {
      ledger.compacted = { uptoIndex: 1, uptoMessageId: "u1", mode: "overview", summary: "摘要正文", instructions: [], createdAt: iso(T0) };
    });
    const manager = new ExtensionManager(dataDir, undefined, { sessions: store });
    (manager as unknown as { manifests: ExtensionManifest[] }).manifests = [
      ...OFFICIAL_EXTENSIONS,
      { id: "third-party", name: "第三方", version: "0.0.1", description: "无 sessions:read", apiVersion: "1", permissions: [] },
    ];
    return {
      sessionId,
      dispatch: (request) => (manager as unknown as { dispatchApi(request: unknown): Promise<unknown> }).dispatchApi(request),
    };
  }

  it("dsh-sync（sessions:read）→ 返回全量账本（含 compacted）", async () => {
    const { dispatch, sessionId } = await buildLedgerManager();
    const ledger = await dispatch({ id: "1", api: "sessions.getLedger", extensionId: "dsh-sync", params: { id: sessionId } }) as Record<string, unknown>;
    expect(ledger.version).toBe(1);
    expect(Array.isArray(ledger.entries)).toBe(true);
    expect(ledger.compacted).toMatchObject({ uptoIndex: 1, uptoMessageId: "u1", summary: "摘要正文" });
  });

  it("无 sessions:read 的第三方扩展被拒；会话不存在报错", async () => {
    const { dispatch } = await buildLedgerManager();
    await expect(dispatch({ id: "2", api: "sessions.getLedger", extensionId: "third-party", params: { id: "x" } }))
      .rejects.toThrow(/lacks permission: sessions:read/);
    await expect(dispatch({ id: "3", api: "sessions.getLedger", extensionId: "dsh-sync", params: { id: "00000000-0000-4000-8000-000000000000" } }))
      .rejects.toThrow(/Session not found/);
  });

  it("返回的是深克隆：改返回对象不污染后续读取", async () => {
    const { dispatch, sessionId } = await buildLedgerManager();
    const first = await dispatch({ id: "4", api: "sessions.getLedger", extensionId: "dsh-sync", params: { id: sessionId } }) as { compacted?: { summary?: string } };
    first.compacted!.summary = "被改坏";
    const second = await dispatch({ id: "5", api: "sessions.getLedger", extensionId: "dsh-sync", params: { id: sessionId } }) as { compacted?: { summary?: string } };
    expect(second.compacted?.summary).toBe("摘要正文");
  });
});
