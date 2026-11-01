import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { api } from "../lib/api";
import {
  changeLine,
  credentialBadge,
  defaultExportSelection,
  defaultSelection,
  defaultSessionSelection,
  DshSyncPanel,
  droppedEventsLine,
  isFutureGeneration,
  exportCountsBadge,
  exportSubagentsBadge,
  exportSubagentsFailedLine,
  groupSessions,
  hasSyncedSelection,
  isLegacyGeneration,
  isSelectable,
  providerModelLabel,
  selectedExportIds,
  selectedKeys,
  selectedSessionIds,
  selectableExportSelection,
  selectableSessionSelection,
  sessionExportPayload,
  sessionSyncPayload,
  shortDshId,
  statusBadge,
  type DshProviderPreviewItem,
  type DshSessionExportItem,
  type DshSessionPreviewItem,
  type DshSyncStatus,
} from "../panels/DshSyncPanel";
import { renderWithClient } from "./helpers/with-client";

afterEach(() => vi.unstubAllGlobals());

/** fetch 打桩：记录调用并回 JSON。 */
function stubJson(body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  vi.stubGlobal("fetch", mock);
  return mock;
}

function calls(mock: ReturnType<typeof vi.fn>): Array<[string, RequestInit]> {
  return mock.mock.calls as unknown as Array<[string, RequestInit]>;
}

describe("api.extRoute 私有路由封装", () => {
  it("默认 GET：拼 /api/ext/<id><path>，query 走 URLSearchParams（空格/& 编码），无 body", async () => {
    const mock = stubJson({ items: [] });
    await expect(api.extRoute("dsh-sync", "/preview/providers", { query: { direction: "import", extra: "a b&c" } })).resolves.toEqual({ items: [] });
    const [path, init] = calls(mock)[0]!;
    expect(path).toBe("/api/ext/dsh-sync/preview/providers?direction=import&extra=a+b%26c");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  it("POST：body JSON 序列化 + request 自动补 content-type；path 无前导 / 亦可；id 转义", async () => {
    const mock = stubJson({ applied: [], skipped: [] });
    await api.extRoute("a b", "sync/providers", { method: "POST", body: { direction: "export", keys: ["deepseek"] } });
    const [path, init] = calls(mock)[0]!;
    expect(path).toBe("/api/ext/a%20b/sync/providers");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({ direction: "export", keys: ["deepseek"] });
  });

  it("无 init 时只有 path（status 探测）；DELETE 走同一封装", async () => {
    const mock = stubJson({ dshHome: "/home/u/.dsh" });
    await api.extRoute<{ dshHome: string }>("dsh-sync", "/status");
    expect(calls(mock)[0]![0]).toBe("/api/ext/dsh-sync/status");
    await api.extRoute("dsh-sync", "/sync/providers", { method: "DELETE" });
    expect(calls(mock)[1]![1].method).toBe("DELETE");
  });

  it("拒绝可疑 path（.. 段/空段/查询与片段符）：不发出请求", async () => {
    const mock = stubJson({});
    for (const bad of ["/../extensions", "/preview//providers", "/status?a=b", "/status#frag", "/.."]) {
      await expect(api.extRoute("dsh-sync", bad)).rejects.toThrow(/extRoute path is invalid/);
    }
    expect(mock).not.toHaveBeenCalled();
    // 合法的 `..` 子串（文件名而非路径段）不算穿越
    stubJson({ ok: true });
    await expect(api.extRoute("dsh-sync", "/preview/a..b")).resolves.toEqual({ ok: true });
  });
});

const previewItems: DshProviderPreviewItem[] = [
  { key: "alpha", status: "new" },
  { key: "beta", status: "changed", changes: [{ field: "baseURL", source: "https://b.example/v1", target: undefined }] },
  { key: "gamma", status: "same" },
];

describe("DshSyncPanel 纯逻辑", () => {
  it("勾选默认：new 默认勾、changed/same 默认不勾；same 不可勾且不参与执行 keys", () => {
    const selection = defaultSelection(previewItems);
    expect(selection).toEqual({ alpha: true });
    expect(isSelectable(previewItems[2]!)).toBe(false);
    expect(selectedKeys(previewItems, selection)).toEqual(["alpha"]);
    // 已勾选的 same 项在执行时被过滤（视图层禁用 + 纯函数双保险）
    expect(selectedKeys(previewItems, { alpha: true, beta: true, gamma: true })).toEqual(["alpha", "beta"]);
    // 顺序跟随预览列表（输出稳定）
    expect(selectedKeys(previewItems, { beta: true, gamma: true })).toEqual(["beta"]);
  });

  it("same 条目带模型目录条目（models > 0）时可勾选：只补模型、不重写 provider", () => {
    const sameWithModels: DshProviderPreviewItem = { key: "same-models", status: "same", models: 3 };
    expect(isSelectable(sameWithModels)).toBe(true);
    expect(isSelectable({ key: "same-empty", status: "same", models: 0 })).toBe(false);
    expect(isSelectable({ key: "same-none", status: "same" })).toBe(false);
    // 默认仍不勾（same 不进默认集合），但可被显式勾选并进入执行 keys
    expect(defaultSelection([sameWithModels])).toEqual({});
    expect(selectedKeys([sameWithModels], { "same-models": true })).toEqual(["same-models"]);
  });

  it("徽标映射：新增=绿、变更=黄、相同=灰；凭据缺失=红、其余弱化、未提供不渲染", () => {
    expect(statusBadge("new")).toEqual({ zh: "新增", en: "New", tone: "ok" });
    expect(statusBadge("changed")).toEqual({ zh: "变更", en: "Changed", tone: "amber" });
    expect(statusBadge("same")).toEqual({ zh: "相同", en: "In sync", tone: "muted" });
    expect(credentialBadge("missing")).toEqual({ zh: "环境变量缺失", en: "Missing env var", tone: "danger" });
    expect(credentialBadge("resolved")?.tone).toBe("ok");
    expect(credentialBadge("inline")?.tone).toBe("muted");
    expect(credentialBadge("env")?.zh).toBe("环境变量引用");
    expect(credentialBadge("none")?.tone).toBe("muted");
    expect(credentialBadge(undefined)).toBeUndefined();
  });

  it("差异行：目标现值 → 将被写入的源值；对象序列化、缺失为 —、超长截断", () => {
    expect(changeLine({ field: "baseURL", target: "https://a", source: "https://b" })).toBe("baseURL: https://a → https://b");
    expect(changeLine({ field: "extraBody", source: { a: 1 } })).toBe('extraBody: — → {"a":1}');
    expect(changeLine({ field: "displayName", source: "x".repeat(200) }).endsWith("…")).toBe(true);
  });
});

/** 面板级 fetch 打桩：extensions 列表 + status + provider 预览 + 会话预览/导入（按方向分派；其余 404）。 */
function stubDshFetch(
  extensions: unknown[],
  status: DshSyncStatus,
  preview?: unknown,
  sessions?: unknown,
  sessionSync?: unknown,
  exportSessions?: unknown,
  exportSync?: unknown,
): ReturnType<typeof vi.fn> {
  const handler = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const direction = new URL(url, "http://localhost").searchParams.get("direction");
    const json = (body: unknown, code = 200): Response => new Response(JSON.stringify(body), { status: code, headers: { "content-type": "application/json" } });
    if (url.endsWith("/api/extensions")) return json(extensions);
    if (url.includes("/api/ext/dsh-sync/status")) return json(status);
    // 会话路由先于 provider 预览判定：两者路径不重叠，顺序只为可读性
    if (url.includes("/api/ext/dsh-sync/preview/sessions")) {
      if (direction === "export") return json(exportSessions ?? { direction: "export", items: [], zstdAvailable: true, dshRunning: false });
      return json(sessions ?? { direction: "import", items: [], zstdAvailable: true, dshRunning: false });
    }
    if (url.includes("/api/ext/dsh-sync/sync/sessions")) {
      // 执行请求的方向在 body 里（GET 预览才走 query）
      const body = init?.body ? JSON.parse(String(init.body)) as { direction?: string } : undefined;
      if (body?.direction === "export") return json(exportSync ?? { direction: "export", applied: [], skipped: [], report: {} });
      return json(sessionSync ?? { direction: "import", applied: [], skipped: [], report: {} });
    }
    if (preview && url.includes("/api/ext/dsh-sync/preview/providers")) return json(preview);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
  return handler;
}

const statusPayload: DshSyncStatus = {
  dshHome: "/home/u/.dsh",
  dshHomeExists: false,
  profile: "web",
  profileExists: false,
  zstdAvailable: true,
  dshRunning: true,
  nodeVersion: "v24.22.1",
};

/** dsh 数据目录/profile 就绪的状态（导出方向的执行门禁要求 dshHomeExists）。 */
const statusPayloadReady: DshSyncStatus = {
  ...statusPayload,
  dshHomeExists: true,
  profileExists: true,
};

describe("DshSyncPanel 渲染", () => {
  it("启用后展示环境状态条：路径/profile 缺失警示 + dsh 运行中提示 + 会话区块待预览提示", async () => {
    stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload);
    renderWithClient(<DshSyncPanel />);
    expect(await screen.findByText("未检测到 dsh 数据目录")).toBeInTheDocument();
    expect(screen.getByText("/home/u/.dsh")).toBeInTheDocument();
    expect(screen.getByText("未检测到模型配置文件（cordis.patch.yml）")).toBeInTheDocument();
    expect(screen.getByText(/dsh 正在运行：配置写回需重启 dsh 生效/)).toBeInTheDocument();
    expect(screen.queryByText(/zstd 不可用/)).toBeNull();
    expect(screen.getByText("点击「预览会话」列出 dsh 侧的会话。")).toBeInTheDocument();
  });

  it("未启用时只显示设置入口提示（不发私有路由请求）", async () => {
    const handler = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify([{ id: "dsh-sync", enabled: false }]), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", handler);
    renderWithClient(<DshSyncPanel />);
    expect(await screen.findByText("请在 设置 → 扩展 启用 dsh 同步。")).toBeInTheDocument();
    expect(handler.mock.calls.every(([input]) => String(input).endsWith("/api/extensions"))).toBe(true);
  });

  it("点「预览差异」才拉取：列表出现且勾选默认（new 勾、changed/same 不勾、same 禁用）", async () => {
    stubDshFetch(
      [{ id: "dsh-sync", enabled: true }],
      statusPayload,
      { direction: "import", items: previewItems, unmappedFields: ["alpha.displayName"], warnings: ["w"], dshRunning: true },
    );
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    expect(screen.queryByText("alpha")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "预览差异" }));
    expect(await screen.findByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText(/未映射字段（不会同步）/)).toBeInTheDocument();
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.map((box) => box.checked)).toEqual([true, false, false]);
    expect(checkboxes.map((box) => box.disabled)).toEqual([false, false, true]);
    // 勾选后计数与执行按钮随之变化（same 项即使被强制勾选也不计入）
    fireEvent.click(screen.getByRole("checkbox", { name: "beta" }));
    expect(screen.getByText(/已勾选 2 \/ 3/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行同步" })).toBeEnabled();
  });
});

// ── 会话同步（M3c）：导入方向完整功能 + 导出占位 ──────────────────────────────

const SESSION_ALPHA = "11111111-2222-4333-8444-555566667777";
const SESSION_SUB = "dddddddd-eeee-4fff-8000-111111111111";
/** 头行缺 cwd 的会话（需用户填 cwdOverride）。 */
const SESSION_NO_CWD = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
/** v1 旧代际（不可导入：需先在 dsh 里升级格式）。 */
const SESSION_LEGACY = "cccccccc-dddd-4eee-8fff-000000000000";
/** v4（dsh 当前代际，可导入）。 */
const SESSION_V4 = "eeeeeeee-ffff-4000-8111-222222222222";
/** v5 高代际（不可导入：需升级 dsh-sync 扩展）。 */
const SESSION_FUTURE = "ffffffff-0000-4111-8222-333333333333";

const sessionItems: DshSessionPreviewItem[] = [
  { dshId: SESSION_ALPHA, cwd: "/work/alpha", createdAt: "2026-08-13T02:30:00.000Z", generation: 3, supported: true, selectable: true },
  {
    dshId: SESSION_SUB,
    cwd: "/work/alpha",
    createdAt: "2026-08-13T02:40:00.000Z",
    generation: 3,
    supported: true,
    origin: "subagent",
    parentSession: SESSION_ALPHA,
    sync: { owcId: "owc-1", lastSyncAt: "2026-08-13T06:30:00.000Z" },
    selectable: true,
  },
  { dshId: SESSION_NO_CWD, generation: 3, supported: true, selectable: true },
  { dshId: SESSION_LEGACY, generation: 1, supported: false, selectable: false, reason: "旧代际 v1：请先在 dsh 中打开一次升级格式" },
];

const sessionPreviewPayload = { direction: "import", items: sessionItems, zstdAvailable: true, dshRunning: false };

/** 代际提示用例：v3/v4（读支持区间内，无提示）与 v1/v5（各给一条提示）。 */
const generationItems: DshSessionPreviewItem[] = [
  { dshId: SESSION_ALPHA, cwd: "/work/alpha", generation: 3, supported: true, selectable: true },
  { dshId: SESSION_V4, cwd: "/work/alpha", generation: 4, supported: true, selectable: true },
  { dshId: SESSION_LEGACY, generation: 1, supported: false, selectable: false, reason: "旧代际 v1：请先在 dsh 中打开一次升级格式" },
  { dshId: SESSION_FUTURE, generation: 5, supported: false, selectable: false, reason: "dsh 代际 v5 暂不支持：请升级 dsh-sync 扩展" },
];

const generationPreviewPayload = { direction: "import", items: generationItems, zstdAvailable: true, dshRunning: false };

const sessionSyncPayloadResult = {
  direction: "import",
  applied: [{
    dshId: SESSION_ALPHA,
    owcId: "owc-new-1",
    title: "导入的会话 A",
    counts: { user: 2, assistant: 1, tool: 3, images: 2, imagesMissing: 1 },
    warnings: [],
  }],
  skipped: [{ dshId: SESSION_LEGACY, reason: "旧代际 v1：请先在 dsh 中打开一次升级格式" }],
  report: {
    dshHome: "/home/u/.dsh",
    dshRunning: false,
    onConflict: "new",
    appliedCount: 1,
    skippedCount: 1,
    droppedEvents: { "compaction/prune": 2, "message/delta": 1 },
    warnings: [`${SESSION_LEGACY}：格式损坏`],
    notes: ["onConflict=new（缺省）时重复导入会新建副本。"],
    mapSaved: false,
    mapPath: "map.json",
  },
};

// ── 会话导出（M4d）：owc 会话清单 + 逐项导出 ──────────────────────────────────

const EXPORT_A = "owc-export-a";
const EXPORT_B = "owc-export-b";

const exportItems: DshSessionExportItem[] = [
  {
    owcId: EXPORT_A,
    title: "导出的会话 A",
    cwd: "/work/alpha",
    provider: "gateway",
    model: "deepseek-v4-pro",
    updatedAt: "2026-08-13T06:00:00.000Z",
    // 已导出过：带 sync 徽标（仅提示上次导出时间，仍可再次勾选导出为新副本）
    sync: { dshId: "99999999-8888-4777-8666-555555555555", lastSyncAt: "2026-08-13T06:30:00.000Z" },
    selectable: true,
  },
  {
    owcId: EXPORT_B,
    title: "未命名会话",
    cwd: "/work/beta",
    provider: "gateway",
    model: "deepseek-chat",
    updatedAt: "2026-08-13T07:00:00.000Z",
    selectable: true,
  },
];

const exportPreviewPayload = { direction: "export", items: exportItems, zstdAvailable: true, dshRunning: false };

const exportSyncPayloadResult = {
  direction: "export",
  applied: [{
    owcId: EXPORT_A,
    dshId: "77777777-6666-4555-8444-333333333333",
    file: "/home/u/.dsh/sessions/--work-alpha--/77777777-6666-4555-8444-333333333333/session.v3.jsonl.zstd",
    eventCount: 12,
    attachments: 2,
    warnings: ["图片附件缺失，已降级为占位文本"],
    // M5a：父会话一并导出的子代理会话 + 一条导出失败的转录
    subagents: [
      { taskId: "aaaaaaaa-1111-4111-8111-111111111111", dshId: "child-dsh-1" },
      { taskId: "bbbbbbbb-2222-4222-8222-222222222222", dshId: "child-dsh-2" },
    ],
    subagentsFailed: [{ taskId: "cccccccc-3333-4333-8333-333333333333", reason: "子代理转录不存在（subagents/<taskId>.json 缺失）" }],
  }],
  skipped: [{ owcId: EXPORT_B, reason: "会话 cwd 不是绝对路径（relative），无法导出到 dsh" }],
  report: {
    dshHome: "/home/u/.dsh",
    dshRunning: false,
    appliedCount: 1,
    skippedCount: 1,
    warnings: [`${EXPORT_A}：title 为空，已用占位标题`],
    notes: ["export 方向只新增 dsh 会话目录，永不覆盖已有会话。"],
    mapSaved: false,
    mapPath: "map.json",
  },
};

describe("DshSyncPanel 会话导出纯逻辑", () => {
  it("默认勾选为空（导出是写操作，交由用户显式选择）；全选只勾可勾选项；已勾列表跟随清单顺序", () => {
    expect(defaultExportSelection(exportItems)).toEqual({});
    expect(selectableExportSelection(exportItems)).toEqual({ [EXPORT_A]: true, [EXPORT_B]: true });
    expect(selectedExportIds(exportItems, { [EXPORT_B]: true })).toEqual([EXPORT_B]);
    expect(selectedExportIds(exportItems, { [EXPORT_A]: true, [EXPORT_B]: true })).toEqual([EXPORT_A, EXPORT_B]);
    // 不可勾选项即使被勾选也过滤（与导入方向一致的视图层双保险）
    expect(selectedExportIds([{ ...exportItems[0]!, selectable: false as unknown as true }], { [EXPORT_A]: true })).toEqual([]);
  });

  it("sessionExportPayload：只发勾选的 owcId，方向固定 export", () => {
    expect(sessionExportPayload(exportItems, { [EXPORT_A]: true })).toEqual({ direction: "export", items: [{ owcId: EXPORT_A }] });
    expect(sessionExportPayload(exportItems, {}).items).toEqual([]);
  });

  it("provider/model 文案与事件/附件计数：缺项收敛、附件为 0 省略附件段", () => {
    expect(providerModelLabel({ provider: "gateway", model: "deepseek-v4-pro" })).toBe("gateway/deepseek-v4-pro");
    expect(providerModelLabel({ provider: "gateway" })).toBe("gateway");
    expect(providerModelLabel({})).toBeUndefined();
    expect(exportCountsBadge({ eventCount: 12, attachments: 2 })).toEqual({ zh: "12 事件 · 2 附件", en: "12 event(s) · 2 attachment(s)" });
    expect(exportCountsBadge({ eventCount: 3, attachments: 0 })).toEqual({ zh: "3 事件", en: "3 event(s)" });
  });

  it("子会话徽标与失败警示：无子会话/无失败收敛为 undefined，有条目时给计数与逐条原因", () => {
    expect(exportSubagentsBadge({})).toBeUndefined();
    expect(exportSubagentsBadge({ subagents: [] })).toBeUndefined();
    expect(exportSubagentsBadge({ subagents: [{ taskId: "t1", dshId: "d1" }, { taskId: "t2", dshId: "d2" }] }))
      .toEqual({ zh: "子会话 2 个", en: "2 subagent session(s)" });
    expect(exportSubagentsFailedLine({})).toBeUndefined();
    expect(exportSubagentsFailedLine({ subagentsFailed: [] })).toBeUndefined();
    expect(exportSubagentsFailedLine({ subagentsFailed: [{ taskId: "cccccccc-3333-4333-8333-333333333333", reason: "转录缺失" }] }))
      .toBe("cccccccc-3333-4333-8333-333333333333：转录缺失");
  });
});

describe("DshSyncPanel 会话纯逻辑", () => {
  it("分组：有 cwd 的组按 cwd 升序，缺 cwd 的组排在最后", () => {
    const groups = groupSessions([
      { dshId: "z", cwd: "/z", supported: true, selectable: true },
      { dshId: "none", supported: true, selectable: true },
      { dshId: "a", cwd: "/a", supported: true, selectable: true },
      { dshId: "a2", cwd: "/a", supported: true, selectable: true },
    ]);
    expect(groups.map((group) => group.cwd)).toEqual(["/a", "/z", undefined]);
    expect(groups[0]!.items.map((item) => item.dshId)).toEqual(["a", "a2"]);
    expect(groups[2]!.items.map((item) => item.dshId)).toEqual(["none"]);
  });

  it("默认勾选：可导入且未同步过的默认勾；全选只勾可导入项；已勾计数跳过不可导入项", () => {
    expect(defaultSessionSelection(sessionItems)).toEqual({ [SESSION_ALPHA]: true, [SESSION_NO_CWD]: true });
    expect(selectableSessionSelection(sessionItems)).toEqual({ [SESSION_ALPHA]: true, [SESSION_SUB]: true, [SESSION_NO_CWD]: true });
    expect(selectedSessionIds(sessionItems, { [SESSION_ALPHA]: true, [SESSION_SUB]: true, [SESSION_LEGACY]: true }))
      .toEqual([SESSION_ALPHA, SESSION_SUB]);
    // 顺序跟随清单（输出稳定）
    expect(selectedSessionIds(sessionItems, { [SESSION_SUB]: true })).toEqual([SESSION_SUB]);
    // v4（dsh 当前代际）同样可选；v1/v5 不进可选项
    expect(selectableSessionSelection(generationItems)).toEqual({ [SESSION_ALPHA]: true, [SESSION_V4]: true });
  });

  it("冲突单选可见性只看「已勾选且已同步」；短 id/旧代际/丢弃汇总各自收敛", () => {
    expect(hasSyncedSelection(sessionItems, { [SESSION_ALPHA]: true })).toBe(false);
    expect(hasSyncedSelection(sessionItems, { [SESSION_SUB]: true })).toBe(true);
    // 已同步但未勾选不算；不可导入项即使被勾选也不算
    expect(hasSyncedSelection(sessionItems, {})).toBe(false);
    expect(hasSyncedSelection([{ dshId: "x", supported: false, selectable: false, sync: { owcId: "o", lastSyncAt: "2026-01-01T00:00:00.000Z" } }], { x: true })).toBe(false);
    expect(shortDshId(SESSION_ALPHA)).toBe("11111111");
    expect(isLegacyGeneration(undefined)).toBe(false);
    expect(isLegacyGeneration(3)).toBe(false);
    expect(isLegacyGeneration(2)).toBe(true);
    // 读支持 v3/v4：两个上界内的代际都不给提示，>v4 走「升级扩展」提示
    expect(isLegacyGeneration(4)).toBe(false);
    expect(isFutureGeneration(undefined)).toBe(false);
    expect(isFutureGeneration(4)).toBe(false);
    expect(isFutureGeneration(5)).toBe(true);
    expect(droppedEventsLine({})).toBeUndefined();
    expect(droppedEventsLine({ "compaction/prune": 2, "message/delta": 1 })).toBe("compaction/prune×2；message/delta×1");
  });

  it("sessionSyncPayload：cwdOverride 只随缺 cwd 的勾选项发送，未勾选/不可导入项不进 payload", () => {
    const payload = sessionSyncPayload(
      sessionItems,
      { [SESSION_ALPHA]: true, [SESSION_SUB]: true, [SESSION_NO_CWD]: true, [SESSION_LEGACY]: true },
      // /work/alpha 的会话已有 cwd：即便残留输入值也不发（避免误改导入目标目录）
      { [SESSION_ALPHA]: "/tmp/ignored", [SESSION_NO_CWD]: "  /home/me/project  " },
      "overwrite",
    );
    expect(payload).toEqual({
      direction: "import",
      items: [
        { dshId: SESSION_ALPHA },
        { dshId: SESSION_SUB },
        { dshId: SESSION_NO_CWD, cwdOverride: "/home/me/project" },
      ],
      onConflict: "overwrite",
    });
    // 缺 cwd 但没填：照常发送（由服务端给出可读的 skipped 原因）
    expect(sessionSyncPayload([sessionItems[2]!], { [SESSION_NO_CWD]: true }, {}, "new").items).toEqual([{ dshId: SESSION_NO_CWD }]);
    expect(sessionSyncPayload(sessionItems, {}, {}, "new").items).toEqual([]);
  });
});

describe("DshSyncPanel 会话区块渲染", () => {
  it("预览会话：按 cwd 分组（缺 cwd 组最后）、子代理/已同步徽标、不可选项禁用并显示原因", async () => {
    stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload, undefined, sessionPreviewPayload);
    const { container } = renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    expect(screen.queryByText("11111111")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    expect(await screen.findByText("11111111")).toBeInTheDocument();
    // 短 id（前 8 位）+ 本地化时间 + 徽标
    expect(screen.getByText("dddddddd")).toBeInTheDocument();
    expect(screen.getByText("aaaaaaaa")).toBeInTheDocument();
    expect(screen.getByText("子代理")).toBeInTheDocument();
    expect(screen.getByText(/^已同步 \d{2}:\d{2}$/)).toBeInTheDocument();
    expect(screen.getByText(/^旧代际 v1：需先在 dsh 中打开一次升级格式$/)).toBeInTheDocument();
    expect(screen.getByText("旧代际 v1：请先在 dsh 中打开一次升级格式")).toBeInTheDocument();
    // 分组头按 cwd 升序，缺 cwd 的组在最后
    const headers = [...container.querySelectorAll(".dsh-sync-session-group > summary code")].map((node) => node.textContent);
    expect(headers).toEqual(["/work/alpha", "无工作目录"]);
    // 不可导入项禁用（完整 id 在 checkbox 的 aria-label 上）
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.map((box) => box.disabled)).toEqual([false, false, false, true]);
    expect((screen.getByRole("checkbox", { name: SESSION_ALPHA }) as HTMLInputElement).checked).toBe(true);
  });

  it("代际提示按区间收敛：v3/v4 无提示、v1 提示升级格式、v5 提示升级扩展", async () => {
    stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload, undefined, generationPreviewPayload);
    const { container } = renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    expect(await screen.findByText("11111111")).toBeInTheDocument();
    expect(screen.getByText("eeeeeeee")).toBeInTheDocument();
    // 只有 v1 / v5 两行给代际提示（v3/v4 在读支持区间内，不渲染提示块）
    const notices = [...container.querySelectorAll(".dsh-sync-session-gen")].map((node) => node.textContent);
    expect(notices).toEqual([
      "旧代际 v1：需先在 dsh 中打开一次升级格式",
      "dsh 代际 v5 暂不支持：请升级 dsh-sync 扩展",
    ]);
    // 不可导入的仍是 v1/v5 两行
    const checkboxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(checkboxes.map((box) => box.disabled)).toEqual([false, false, true, true]);
  });

  it("勾选默认（未同步的勾、已同步的不勾）与冲突单选：仅在勾选含已同步会话时出现，全选/清空只作用于可导入项", async () => {
    stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload, undefined, sessionPreviewPayload);
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("11111111");

    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked)).toEqual([true, false, true, false]);
    expect(screen.getByText(/已选 2 \/ 3 个会话/)).toBeInTheDocument();
    // 没有已同步勾选：冲突单选不出现
    expect(screen.queryByRole("radiogroup")).toBeNull();

    fireEvent.click(screen.getByRole("checkbox", { name: SESSION_SUB }));
    const conflict = screen.getByRole("radiogroup", { name: "冲突处理" });
    expect(within(conflict).getByText("覆盖更新已导入的会话")).toBeInTheDocument();
    expect((within(conflict).getByRole("radio", { name: "新建副本" }) as HTMLInputElement).checked).toBe(true);
    fireEvent.click(within(conflict).getByRole("radio", { name: "覆盖更新已导入的会话" }));
    expect((within(conflict).getByRole("radio", { name: "覆盖更新已导入的会话" }) as HTMLInputElement).checked).toBe(true);

    // 全选：旧代际仍不可勾（disabled 且 checked=false）
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked)).toEqual([true, true, true, false]);
    expect(screen.getByText(/已选 3 \/ 3 个会话/)).toBeInTheDocument();

    // 清空后冲突单选与执行按钮一起收敛
    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect((screen.getAllByRole("checkbox") as HTMLInputElement[]).map((box) => box.checked)).toEqual([false, false, false, false]);
    expect(screen.getByRole("button", { name: "执行导入" })).toBeDisabled();
  });

  it("cwdOverride 只发给缺 cwd 的勾选项；执行后渲染报告卡（计数徽标/跳过原因/丢弃汇总/映射表失败警示）", async () => {
    const handler = stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload, undefined, sessionPreviewPayload, sessionSyncPayloadResult);
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("11111111");

    // 只有一个输入框：缺 cwd 且已勾选的那一行
    const inputs = screen.getAllByLabelText("选择本机工作目录") as HTMLInputElement[];
    expect(inputs).toHaveLength(1);
    fireEvent.change(inputs[0]!, { target: { value: "  /home/me/project  " } });

    fireEvent.click(screen.getByRole("button", { name: "执行导入" }));
    await waitFor(() => expect(handler.mock.calls.some(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/sessions"))).toBe(true));
    const [, init] = handler.mock.calls.find(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/sessions"))!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      direction: "import",
      items: [{ dshId: SESSION_ALPHA }, { dshId: SESSION_NO_CWD, cwdOverride: "/home/me/project" }],
      onConflict: "new",
    });

    expect(await screen.findByText("导入的会话 A")).toBeInTheDocument();
    expect(screen.getByText("u 2")).toBeInTheDocument();
    expect(screen.getByText("a 1")).toBeInTheDocument();
    expect(screen.getByText("t 3")).toBeInTheDocument();
    expect(screen.getByText(/1 张图片降级为占位文本/)).toBeInTheDocument();
    expect(screen.getByText("compaction/prune×2；message/delta×1")).toBeInTheDocument();
    expect(screen.getByText(/映射表保存失败，重复导入可能产生副本/)).toBeInTheDocument();
    expect(screen.getByText(/格式损坏/)).toBeInTheDocument();
  });

  it("导出预览：标题/provider-model/更新时间/已导出徽标/cwd；默认不勾、执行 POST body 只带勾选的 owcId", async () => {
    const handler = stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayloadReady, undefined, sessionPreviewPayload, undefined, exportPreviewPayload, exportSyncPayloadResult);
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("/home/u/.dsh");
    const sessionDir = screen.getByRole("group", { name: "会话同步方向" });

    // 切到导出方向：未点「预览会话」前不发任何会话请求
    fireEvent.click(within(sessionDir).getByRole("button", { name: "导出到 dsh" }));
    expect(handler.mock.calls.some(([url]) => String(url).includes("/preview/sessions"))).toBe(false);
    expect(screen.getByText("点击「预览会话」列出 owc 侧的会话。")).toBeInTheDocument();
    // 导入方向的执行按钮不在导出视图里
    expect(screen.queryByRole("button", { name: "执行导入" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    expect(await screen.findByText("导出的会话 A")).toBeInTheDocument();
    expect(screen.getByText("gateway/deepseek-v4-pro")).toBeInTheDocument();
    expect(screen.getByText("gateway/deepseek-chat")).toBeInTheDocument();
    expect(screen.getByText("未命名会话")).toBeInTheDocument();
    // 已导出徽标只在带 sync 的条目上（HH:MM 本地化）
    expect(screen.getByText(/^已导出 \d{2}:\d{2}$/)).toBeInTheDocument();
    // cwd 灰字
    expect(screen.getByText("/work/alpha")).toBeInTheDocument();
    expect(screen.getByText("/work/beta")).toBeInTheDocument();

    // 默认不勾：两个勾选框都未选中，计数 0，执行按钮禁用
    const boxes = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(boxes.map((box) => box.checked)).toEqual([false, false]);
    expect(screen.getByText(/已选 0 \/ 2 个会话/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "执行导出" })).toBeDisabled();

    // 勾选 A 后执行：POST body 只含勾选项
    fireEvent.click(screen.getByRole("checkbox", { name: EXPORT_A }));
    expect(screen.getByText(/已选 1 \/ 2 个会话/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "执行导出" }));
    await waitFor(() => expect(handler.mock.calls.some(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/sessions"))).toBe(true));
    const [, init] = handler.mock.calls.find(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/sessions"))!;
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ direction: "export", items: [{ owcId: EXPORT_A }] });
  });

  it("导出报告卡：标题 + dsh 短 id + 事件/附件数 + skipped 原因 + mapSaved=false 警告", async () => {
    stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayloadReady, undefined, sessionPreviewPayload, undefined, exportPreviewPayload, exportSyncPayloadResult);
    const { container } = renderWithClient(<DshSyncPanel />);
    await screen.findByText("/home/u/.dsh");
    fireEvent.click(within(screen.getByRole("group", { name: "会话同步方向" })).getByRole("button", { name: "导出到 dsh" }));
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("导出的会话 A");

    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "执行导出" }));

    await screen.findByText("导出结果");
    const report = container.querySelector(".dsh-sync-report") as HTMLElement;
    // applied：标题（按 owcId 反查）+ dsh 侧短 id + 事件/附件数 + 单项警告
    expect(within(report).getByText("导出的会话 A")).toBeInTheDocument();
    expect(within(report).getByText("77777777")).toBeInTheDocument();
    expect(within(report).getByText("12 事件 · 2 附件")).toBeInTheDocument();
    // M5a：子会话徽标「子会话 2 个」+ 子会话导出失败的黄色警示行
    expect(within(report).getByText("子会话 2 个")).toBeInTheDocument();
    expect(within(report).getByText(/子会话导出失败：cccccccc-3333-4333-8333-333333333333：子代理转录不存在/)).toBeInTheDocument();
    expect(within(report).getByText(/图片附件缺失/)).toBeInTheDocument();
    // skipped：原因
    expect(within(report).getByText(/会话 cwd 不是绝对路径/)).toBeInTheDocument();
    // report.warnings 与 mapSaved=false 警告
    expect(within(report).getByText(/title 为空，已用占位标题/)).toBeInTheDocument();
    expect(within(report).getByText(/映射表保存失败，重复导出可能产生副本/)).toBeInTheDocument();
    expect(within(report).getByText(/export 方向只新增 dsh 会话目录/)).toBeInTheDocument();
  });

  it("方向切换：两个方向的预览缓存独立，切回已预览过的方向不重发请求", async () => {
    const handler = stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload, undefined, sessionPreviewPayload, undefined, exportPreviewPayload, undefined);
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    const sessionDir = screen.getByRole("group", { name: "会话同步方向" });
    const exportFetches = (): number => handler.mock.calls.filter(([url]) => String(url).includes("preview/sessions?direction=export")).length;

    // 导出方向预览一次
    fireEvent.click(within(sessionDir).getByRole("button", { name: "导出到 dsh" }));
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    expect(await screen.findByText("导出的会话 A")).toBeInTheDocument();
    expect(exportFetches()).toBe(1);

    // 切到导入：导入未预览过 → 不发请求；导出清单仍在缓存但不在视图里
    fireEvent.click(within(sessionDir).getByRole("button", { name: "从 dsh 导入" }));
    expect(screen.getByText("点击「预览会话」列出 dsh 侧的会话。")).toBeInTheDocument();
    expect(screen.queryByText("导出的会话 A")).toBeNull();
    expect(handler.mock.calls.some(([url]) => String(url).includes("preview/sessions?direction=import"))).toBe(false);

    // 切回导出：直接复用缓存，不重发请求
    fireEvent.click(within(sessionDir).getByRole("button", { name: "导出到 dsh" }));
    expect(await screen.findByText("导出的会话 A")).toBeInTheDocument();
    expect(exportFetches()).toBe(1);
  });
});

describe("DshSyncPanel 执行门禁与分批", () => {
  it("导出方向：dsh 数据目录缺失时禁用执行按钮并给出原因", async () => {
    stubDshFetch([{ id: "dsh-sync", enabled: true }], statusPayload, undefined, sessionPreviewPayload, undefined, exportPreviewPayload, undefined);
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("未检测到 dsh 数据目录");
    fireEvent.click(within(screen.getByRole("group", { name: "会话同步方向" })).getByRole("button", { name: "导出到 dsh" }));
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("导出的会话 A");
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByRole("button", { name: "执行导出" })).toBeDisabled();
    expect(screen.getByText("未检测到 dsh 数据目录，无法导出")).toBeInTheDocument();
  });

  it("zstd 不可用时：导入方向同样禁用执行按钮", async () => {
    const noZstd: DshSyncStatus = { ...statusPayloadReady, zstdAvailable: false };
    stubDshFetch([{ id: "dsh-sync", enabled: true }], noZstd, undefined, sessionPreviewPayload, undefined, undefined, undefined);
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("/home/u/.dsh");
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("11111111");
    expect(screen.getByRole("button", { name: "执行导入" })).toBeDisabled();
    expect(screen.getAllByText(/zstd 不可用/).length).toBeGreaterThan(0);
  });

  it("分批执行：25 条勾选拆成 20+5 两次 POST", async () => {
    const many: DshSessionPreviewItem[] = Array.from({ length: 25 }, (_, index) => ({
      dshId: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
      cwd: "/work/alpha",
      generation: 4,
      supported: true,
      selectable: true,
    }));
    const handler = stubDshFetch(
      [{ id: "dsh-sync", enabled: true }],
      statusPayloadReady,
      undefined,
      { direction: "import", items: many, zstdAvailable: true, dshRunning: false },
      sessionSyncPayloadResult,
    );
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("/home/u/.dsh");
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("00000000");
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "执行导入" }));
    await waitFor(() => expect(handler.mock.calls.filter(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/sessions")).length).toBe(2));
    const posts = handler.mock.calls.filter(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/sessions"));
    const bodies = posts.map(([, init]) => JSON.parse(String(init?.body)) as { direction: string; items: Array<{ dshId: string }>; onConflict: string });
    expect(bodies[0]!.items).toHaveLength(20);
    expect(bodies[1]!.items).toHaveLength(5);
    expect(bodies[0]!.items[0]!.dshId).toBe("00000000-1111-4111-8111-111111111111");
    expect(bodies[1]!.items[4]!.dshId).toBe("00000024-1111-4111-8111-111111111111");
  });

  it("模型配置方向切换：切回已预览过的方向不重发请求（与会话区块一致）", async () => {
    const handler = stubDshFetch(
      [{ id: "dsh-sync", enabled: true }],
      statusPayloadReady,
      { direction: "import", items: previewItems, unmappedFields: [], warnings: [] },
      undefined,
      undefined,
      undefined,
      undefined,
    );
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("/home/u/.dsh");
    const count = (): number => handler.mock.calls.filter(([url]) => String(url).includes("/preview/providers")).length;
    const dirGroup = screen.getByRole("group", { name: "同步方向" });

    // 导入方向预览一次
    fireEvent.click(screen.getByRole("button", { name: "预览差异" }));
    await screen.findByText("alpha");
    expect(count()).toBe(1);

    // 切到导出方向：此前未预览，不发请求；点预览后才发
    fireEvent.click(within(dirGroup).getByRole("button", { name: "导出到 dsh" }));
    expect(count()).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: "预览差异" }));
    await waitFor(() => expect(count()).toBe(2));

    // 切回导入方向：直接复用缓存，不重发
    fireEvent.click(within(dirGroup).getByRole("button", { name: "从 dsh 导入" }));
    await screen.findByText("alpha");
    expect(count()).toBe(2);
  });

  it("模型配置执行只刷新模型配置区块：不重拉会话清单", async () => {
    const handler = stubDshFetch(
      [{ id: "dsh-sync", enabled: true }],
      statusPayloadReady,
      { direction: "import", items: previewItems, unmappedFields: [], warnings: [] },
      sessionPreviewPayload,
      sessionSyncPayloadResult,
      undefined,
      undefined,
    );
    renderWithClient(<DshSyncPanel />);
    await screen.findByText("/home/u/.dsh");
    // 先预览会话（1 次会话请求），再预览模型配置并执行
    fireEvent.click(screen.getByRole("button", { name: "预览会话" }));
    await screen.findByText("11111111");
    fireEvent.click(screen.getByRole("button", { name: "预览差异" }));
    await screen.findByText("alpha");
    // new 条目默认勾选，直接执行
    // 执行按钮名为「执行同步」
    fireEvent.click(screen.getByRole("button", { name: "执行同步" }));
    await waitFor(() => expect(handler.mock.calls.some(([url]) => String(url).endsWith("/api/ext/dsh-sync/sync/providers"))).toBe(true));
    // 会话清单没有被 invalidate 误刷（仍是一次 preview 请求）
    const sessionFetches = handler.mock.calls.filter(([url]) => String(url).includes("preview/sessions?direction=import")).length;
    expect(sessionFetches).toBe(1);
  });
});
