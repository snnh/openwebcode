/**
 * dsh-sync M2a（模型配置双向同步：映射模块 + server API + 预览/执行路由）单测。
 *
 * 覆盖四件事：
 * 1. {@link dshProvidersToOwc} / {@link owcProfilesToDsh} 的字段映射、凭据策略与未映射字段报告；
 * 2. {@link diffProviderItems} 的三态 diff（含 import 部分更新 vs export 整条目替换的口径差异）；
 * 3. {@link createDshSyncRoutes} 的预览/执行语义（假 server API + mkdtemp 的 fixture 副本）；
 * 4. manifest.routes ↔ 路由键集合一致性。
 *
 * fixture 只读使用；需要写盘的用例先把 fixture 复制到 mkdtemp 再改副本。
 */
import { cp, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { dshPatchFile, readDshProviders } from "../src/extensions/dsh-sync-dsh.js";
import {
  createDshSyncRoutes,
  type DshSyncProviderPreview,
  type DshSyncProviderResult,
  type DshSyncServerApi,
} from "../src/extensions/dsh-sync-host.js";
import {
  diffProviderItems,
  dshProvidersToOwc,
  owcProfilesToDsh,
  type DshCredentialState,
  type DshExportCredentialState,
  type OwcProfilePatch,
  type ProviderFieldChange,
} from "../src/extensions/dsh-sync-providers.js";
import { OFFICIAL_EXTENSIONS } from "../src/extensions/official.js";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import type { ExtensionManifest } from "../src/extensions/types.js";
import { ProviderProfilesService } from "../src/provider-profiles.js";
import { ModelRegistry } from "../src/context/model-registry.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-sync", import.meta.url));
const PATCH_FIXTURE = path.join(FIXTURES, "profiles", "web", "cordis.patch.yml");

/** 临时目录登记（afterAll 统一清理）。 */
const tempDirs: string[] = [];

/** 建临时目录（登记清理）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 复制 fixture 的 dshHome 到临时目录（写盘用例专用）。 */
async function fixtureHome(prefix: string): Promise<string> {
  const home = path.join(await tempDir(prefix), "dsh-home");
  await cp(FIXTURES, home, { recursive: true });
  return home;
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

// ── fixture 的 providers 解包值（gateway 用 apiKeyEnv、legacy 用内联 apiKey 且 enabled:false） ──
async function fixtureProviders(): Promise<Record<string, unknown>> {
  const providers = await readDshProviders(PATCH_FIXTURE);
  if (providers === undefined) throw new Error("fixture patch.yml 缺少 providers");
  return providers;
}

/** 环境变量注入辅助（route 侧读 process.env，故必须临时改写真实环境）。 */
async function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

afterEach(() => {
  delete process.env.GATEWAY_API_KEY;
});

// ── 假 server API ──
interface FakeApi {
  api: DshSyncServerApi;
  upserts: Array<{ profiles: unknown[]; models?: unknown[] }>;
}

/** 构造假 DshSyncServerApi：listProfiles 固定返回，upsertProfiles 记录入参并默认全项成功。 */
function makeFakeApi(
  profiles: Array<Record<string, unknown>>,
  respond?: (input: { profiles: unknown[]; models?: unknown[] }) => unknown,
): FakeApi {
  const upserts: Array<{ profiles: unknown[]; models?: unknown[] }> = [];
  return {
    upserts,
    api: {
      listProfiles: async () => profiles,
      // 本文件只覆盖模型配置同步：默认选择解析用不到，回空对象即可（导出补全在会话路由侧测）
      defaultSelection: async () => ({}),
      upsertProfiles: async (input) => {
        upserts.push(input);
        if (respond) return respond(input);
        return {
          profiles: input.profiles.map((item) => ({ id: (item as { id: string }).id, ok: true })),
          models: (input.models ?? []).map((item) => {
            const entry = item as { id: string; provider: string };
            return { id: entry.id, provider: entry.provider, ok: true };
          }),
        };
      },
    },
  };
}

describe("dshProvidersToOwc", () => {
  it("apiKeyEnv 在当前环境缺失：留空 + 标记 missing + 警告", async () => {
    const result = await withEnv("GATEWAY_API_KEY", undefined, async () => dshProvidersToOwc(await fixtureProviders(), process.env));
    const gateway: OwcProfilePatch | undefined = result.profiles.find((profile) => profile.id === "gateway");
    expect(gateway).toEqual({
      id: "gateway",
      enabled: true,
      interfaceType: "openai-responses",
      baseURL: "https://gateway.example.com/v1",
      promptCaching: true,
    });
    expect(gateway?.apiKey).toBeUndefined();
    const credentials: Record<string, DshCredentialState> = result.credentials;
    expect(credentials.gateway).toBe("missing");
    expect(result.warnings.some((line) => line.includes("GATEWAY_API_KEY"))).toBe(true);
  });

  it("apiKeyEnv 读到值：内联为 apiKey 并标记 resolved", async () => {
    const result = await withEnv("GATEWAY_API_KEY", "sk-from-env", async () => dshProvidersToOwc(await fixtureProviders(), process.env));
    expect(result.profiles.find((profile) => profile.id === "gateway")?.apiKey).toBe("sk-from-env");
    expect(result.credentials.gateway).toBe("resolved");
    expect(result.warnings).toEqual([]);
  });

  it("内联 apiKey 直通（inline）、enabled:false 直通、models:[] 不产条目", async () => {
    const result = await withEnv("GATEWAY_API_KEY", undefined, async () => dshProvidersToOwc(await fixtureProviders(), process.env));
    const legacy = result.profiles.find((profile) => profile.id === "legacy");
    expect(legacy?.apiKey).toBe("sk-inline-demo-key");
    expect(legacy?.enabled).toBe(false);
    expect(result.credentials.legacy).toBe("inline");
    expect(result.models.some((model) => model.provider === "legacy")).toBe(false);
  });

  it("dsh models[] → owc 目录条目（词表内字段），未映射字段计入报告", async () => {
    const result = await withEnv("GATEWAY_API_KEY", undefined, async () => dshProvidersToOwc(await fixtureProviders(), process.env));
    expect(result.models).toEqual([{
      id: "deepseek-v4-pro",
      provider: "gateway",
      contextWindow: 1_000_000,
      capabilities: {
        modalities: ["text"],
        effort: ["low", "high"],
        thinkingStyle: "thinking",
        reasoningContent: true,
      },
    }]);
    expect(result.unmappedFields).toContain("gateway.models[].maxTokens");
  });

  it("provider 级未映射字段（displayName/headers/maxConcurrent/retryPolicy 等）计入报告", () => {
    const result = dshProvidersToOwc({
      gateway: {
        interfaceType: "openai-chat-completions",
        displayName: "网关",
        headers: { "x-route": "gw" },
        maxConcurrent: 8,
        streamIdleTimeoutMs: 60_000,
        retryPolicy: { maxRetries: 2 },
        imageRequestMaxBytes: 1024,
        imageOffloadCountQuantum: 5,
        catalog: "official.json",
      },
    }, {});
    expect(result.profiles).toEqual([{ id: "gateway", enabled: true, interfaceType: "openai-chat-completions" }]);
    for (const field of ["displayName", "headers", "maxConcurrent", "streamIdleTimeoutMs", "retryPolicy", "imageRequestMaxBytes", "imageOffloadCountQuantum", "catalog"]) {
      expect(result.unmappedFields).toContain(`gateway.${field}`);
    }
    expect(result.credentials.gateway).toBe("none");
  });

  it("坏条目宽松跳过：非对象、非法配置名、interfaceType 缺失/越界", () => {
    const result = dshProvidersToOwc({
      ok: { interfaceType: "openai-chat-completions" },
      "not an object": 42,
      "{bad}": { interfaceType: "openai-chat-completions" },
      noProtocol: { baseURL: "https://x.example.com" },
      weird: { interfaceType: "grpc" },
    }, {});
    expect(result.profiles.map((profile) => profile.id)).toEqual(["ok"]);
    expect(result.warnings).toHaveLength(4);
  });

  it("既无 contextWindow 又无 capabilities 的模型条目跳过；坏模型条目记 warning", () => {
    const result = dshProvidersToOwc({
      gateway: {
        interfaceType: "openai-chat-completions",
        models: [
          { id: "empty-model" },
          { id: "typed", contextWindow: 8192 },
          { id: "capped", capabilities: { modalities: ["text"] } },
          "not-an-object",
          { contextWindow: 4096 },
        ],
      },
    }, {});
    expect(result.models.map((model) => model.id)).toEqual(["typed", "capped"]);
    expect(result.models[1]?.contextWindow).toBeUndefined();
    expect(result.warnings).toHaveLength(3);
  });
});

describe("owcProfilesToDsh", () => {
  it("有 Key：只写 apiKeyEnv 引用（不写明文）并登记 envNeeded", () => {
    const result = owcProfilesToDsh([
      { id: "deepseek", enabled: true, interfaceType: "openai-chat-completions", baseURL: "https://api.deepseek.com", hasApiKey: true, maskedApiKey: "sk-abc…1234" },
    ]);
    expect(result.providers.deepseek).toEqual({
      interfaceType: "openai-chat-completions",
      enabled: true,
      baseURL: "https://api.deepseek.com",
      apiKeyEnv: "OWC_SYNC_DEEPSEEK_API_KEY",
    });
    expect(result.envNeeded).toEqual({ OWC_SYNC_DEEPSEEK_API_KEY: "deepseek" });
    expect(result.credentials.deepseek).toBe("env");
    expect(JSON.stringify(result.providers)).not.toContain("sk-abc");
  });

  it("无 Key：不写 apiKeyEnv，标记 credential:none", () => {
    const result = owcProfilesToDsh([{ id: "local", enabled: false, interfaceType: "anthropic-messages", hasApiKey: false }]);
    const entry = result.providers.local as Record<string, unknown>;
    expect(entry.apiKeyEnv).toBeUndefined();
    expect(entry.credential).toBe("none");
    expect(entry.enabled).toBe(false);
    expect(result.envNeeded).toEqual({});
    expect(result.credentials.local).toBe("none");
  });

  it("env 变量名：id 非字母数字转下划线，冲突加 _2 后缀", () => {
    const result = owcProfilesToDsh([
      { id: "Next API.v2", interfaceType: "openai-responses", hasApiKey: true },
      { id: "next-api-v2", interfaceType: "openai-responses", hasApiKey: true },
      { id: "中文 Provider", interfaceType: "openai-responses", hasApiKey: true },
    ]);
    expect((result.providers["Next API.v2"] as Record<string, unknown>).apiKeyEnv).toBe("OWC_SYNC_NEXT_API_V2_API_KEY");
    expect((result.providers["next-api-v2"] as Record<string, unknown>).apiKeyEnv).toBe("OWC_SYNC_NEXT_API_V2_API_KEY_2");
    expect((result.providers["中文 Provider"] as Record<string, unknown>).apiKeyEnv).toBe("OWC_SYNC_PROVIDER_API_KEY");
    expect(result.envNeeded).toEqual({
      OWC_SYNC_NEXT_API_V2_API_KEY: "Next API.v2",
      OWC_SYNC_NEXT_API_V2_API_KEY_2: "next-api-v2",
      OWC_SYNC_PROVIDER_API_KEY: "中文 Provider",
    });
  });

  it("坏 profile 宽松跳过（缺 id / interfaceType 越界 / id 重复）", () => {
    const result = owcProfilesToDsh([
      { interfaceType: "openai-responses" },
      { id: "weird", interfaceType: "grpc" },
      { id: "dup", interfaceType: "openai-responses" },
      { id: "dup", interfaceType: "openai-responses" },
    ]);
    expect(Object.keys(result.providers)).toEqual(["dup"]);
    expect(result.warnings).toHaveLength(3);
  });
});

describe("diffProviderItems", () => {
  it("import：键集合取 dsh 侧，new/changed/same 三态", () => {
    const items = diffProviderItems(
      {
        same: { interfaceType: "openai-responses", baseURL: "https://a.example.com" },
        moved: { interfaceType: "openai-responses", baseURL: "https://new.example.com" },
        fresh: { interfaceType: "openai-chat-completions" },
      },
      {
        same: { interfaceType: "openai-responses", baseURL: "https://a.example.com", promptCaching: true },
        moved: { interfaceType: "openai-responses", baseURL: "https://old.example.com" },
        owcOnly: { interfaceType: "openai-responses" },
      },
      "import",
    );
    expect(items.map((item) => [item.key, item.status])).toEqual([["fresh", "new"], ["moved", "changed"], ["same", "same"]]);
    const changed = items.find((item) => item.key === "moved");
    const changes: ProviderFieldChange[] | undefined = changed?.changes;
    expect(changes).toEqual([{ field: "baseURL", source: "https://new.example.com", target: "https://old.example.com" }]);
  });

  it("import 是部分更新：dsh 未声明的字段不参与比较（不产生虚假 changed）", () => {
    const items = diffProviderItems(
      { a: { interfaceType: "anthropic-messages" } },
      { a: { interfaceType: "anthropic-messages", promptCaching: true, extraBody: { temperature: 0.2 } } },
      "import",
    );
    expect(items).toEqual([{ key: "a", status: "same" }]);
  });

  it("export 是整条目替换：owc 未声明的字段按「写回后消失」参与比较", () => {
    const items = diffProviderItems(
      { a: { interfaceType: "openai-responses", baseURL: "https://dsh.example.com", enabled: false } },
      { a: { interfaceType: "openai-responses", enabled: true } },
      "export",
    );
    expect(items[0]?.status).toBe("changed");
    // changes 按同步面字段固定顺序产出：enabled → interfaceType → baseURL → promptCaching → includeUsage → extraBody
    expect(items[0]?.changes).toEqual([
      { field: "enabled", source: true, target: false },
      { field: "baseURL", source: undefined, target: "https://dsh.example.com" },
    ]);
  });

  it("extraBody 按排序后的规范化 JSON 比较（键序无关）", () => {
    const items = diffProviderItems(
      { a: { interfaceType: "openai-chat-completions", extraBody: { b: 2, a: 1 } } },
      { a: { interfaceType: "openai-chat-completions", extraBody: { a: 1, b: 2 } } },
      "import",
    );
    expect(items).toEqual([{ key: "a", status: "same" }]);
  });

  it("enabled 缺省两侧都按 true materialize", () => {
    const items = diffProviderItems(
      { a: { interfaceType: "openai-responses" } },
      { a: { interfaceType: "openai-responses", enabled: true } },
      "import",
    );
    expect(items).toEqual([{ key: "a", status: "same" }]);
  });
});

describe("GET /preview/providers", () => {
  it("import：逐项附 credential，未映射字段与模型清单随体返回", async () => {
    const home = await fixtureHome("dsh-sync-providers-preview-");
    const fake = makeFakeApi([{ id: "gateway", interfaceType: "openai-responses", baseURL: "https://gateway.example.com/v1", promptCaching: true }]);
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/providers");
    await withEnv("GATEWAY_API_KEY", "sk-preview", async () => {
      const response = await handler?.({ method: "GET", path: "/preview/providers", query: { direction: "import" } }, { dshHome: home, profile: "web" });
      const body = response?.body as DshSyncProviderPreview;
      expect(body.direction).toBe("import");
      expect(body.items.map((item) => [item.key, item.status, item.credential])).toEqual([
        ["gateway", "same", "resolved"],
        ["legacy", "new", "inline"],
      ]);
      expect(body.items.find((item) => item.key === "gateway")?.models).toBe(1);
      expect(body.models).toEqual([expect.objectContaining({ id: "deepseek-v4-pro", provider: "gateway" })]);
      expect(body.unmappedFields).toContain("gateway.models[].maxTokens");
      expect(typeof body.dshRunning).toBe("boolean");
    });
  });

  it("import：环境变量缺失时凭据标记为 missing（其余字段照常映射）", async () => {
    const home = await fixtureHome("dsh-sync-providers-missing-");
    const fake = makeFakeApi([]);
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/providers");
    await withEnv("GATEWAY_API_KEY", undefined, async () => {
      const response = await handler?.({ method: "GET", path: "/preview/providers", query: {} }, { dshHome: home, profile: "web" });
      const body = response?.body as DshSyncProviderPreview;
      expect(body.direction).toBe("import");
      expect(body.items.find((item) => item.key === "gateway")?.credential).toBe("missing");
    });
  });

  it("dshHome/patch 缺失：import 返回空列表 + warning，不抛错", async () => {
    const home = path.join(await tempDir("dsh-sync-providers-empty-"), "nope");
    const fake = makeFakeApi([]);
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/providers");
    const response = await handler?.({ method: "GET", path: "/preview/providers", query: {} }, { dshHome: home, profile: "web" });
    expect(response?.status).toBe(200);
    const body = response?.body as DshSyncProviderPreview;
    expect(body.items).toEqual([]);
    expect(body.warning).toContain("llm-service-lite");
  });

  it("export：键集合取 owc 侧（dsh 独有 key 不成条目），附 apiKeyEnv/envNeeded", async () => {
    const home = await fixtureHome("dsh-sync-providers-export-");
    const fake = makeFakeApi([
      { id: "gateway", enabled: true, interfaceType: "openai-responses", baseURL: "https://gateway.example.com/v1", hasApiKey: true },
      { id: "freshapi", enabled: true, interfaceType: "openai-chat-completions", hasApiKey: false },
    ]);
    const handler = createDshSyncRoutes(fake.api).get("GET /preview/providers");
    const response = await handler?.({ method: "GET", path: "/preview/providers", query: { direction: "export" } }, { dshHome: home, profile: "web" });
    const body = response?.body as DshSyncProviderPreview;
    expect(body.direction).toBe("export");
    expect(body.items.map((item) => item.key)).toEqual(["freshapi", "gateway"]);
    expect(body.items.find((item) => item.key === "freshapi")).toMatchObject({ status: "new", credential: "none" });
    expect(body.items.find((item) => item.key === "gateway")).toMatchObject({ status: "changed", credential: "env" as DshExportCredentialState, apiKeyEnv: "OWC_SYNC_GATEWAY_API_KEY" });
    expect(body.envNeeded).toEqual({ OWC_SYNC_GATEWAY_API_KEY: "gateway" });
  });
});

describe("POST /sync/providers", () => {
  it("import：upsertProfiles 收到映射后的 patch 与模型条目", async () => {
    const home = await fixtureHome("dsh-sync-sync-import-");
    const fake = makeFakeApi([]);
    const handler = createDshSyncRoutes(fake.api).get("POST /sync/providers");
    await withEnv("GATEWAY_API_KEY", "sk-sync", async () => {
      const response = await handler?.(
        { method: "POST", path: "/sync/providers", query: {}, body: { direction: "import", keys: ["gateway"] } },
        { dshHome: home, profile: "web" },
      );
      const body = response?.body as DshSyncProviderResult;
      expect(fake.upserts).toHaveLength(1);
      expect(fake.upserts[0]?.profiles).toEqual([{
        id: "gateway",
        enabled: true,
        interfaceType: "openai-responses",
        baseURL: "https://gateway.example.com/v1",
        promptCaching: true,
        apiKey: "sk-sync",
      }]);
      expect(fake.upserts[0]?.models).toEqual([expect.objectContaining({ id: "deepseek-v4-pro", provider: "gateway", contextWindow: 1_000_000 })]);
      expect(body.applied.map((item) => [item.key, item.kind])).toEqual([["gateway", "profile"], ["deepseek-v4-pro", "model"]]);
      expect(body.skipped).toEqual([{ key: "legacy", kind: "profile", reason: "未勾选" }]);
      expect(body.report.credentials).toEqual({ gateway: "resolved", legacy: "inline" });
    });
  });

  it("import：单项失败不中断，失败项进 skipped 并带服务端原因", async () => {
    const home = await fixtureHome("dsh-sync-sync-partial-");
    const fake = makeFakeApi([], (input) => ({
      profiles: input.profiles.map((item) => {
        const id = (item as { id: string }).id;
        return id === "legacy" ? { id, ok: false, error: "模型服务商配置名称重复：legacy" } : { id, ok: true };
      }),
      models: [],
    }));
    const handler = createDshSyncRoutes(fake.api).get("POST /sync/providers");
    const response = await handler?.(
      { method: "POST", path: "/sync/providers", query: {}, body: { direction: "import", keys: ["gateway", "legacy"] } },
      { dshHome: home, profile: "web" },
    );
    const body = response?.body as DshSyncProviderResult;
    expect(body.applied.map((item) => item.key)).toEqual(["gateway"]);
    expect(body.skipped).toEqual([{ key: "legacy", kind: "profile", reason: "模型服务商配置名称重复：legacy" }]);
  });

  it("import：dsh 侧无 providers 配置 → 全部 skipped + 报告，不抛错", async () => {
    const home = path.join(await tempDir("dsh-sync-sync-nopatch-"), "nope");
    const fake = makeFakeApi([]);
    const handler = createDshSyncRoutes(fake.api).get("POST /sync/providers");
    const response = await handler?.(
      { method: "POST", path: "/sync/providers", query: {}, body: { direction: "import", keys: ["gateway"] } },
      { dshHome: home, profile: "web" },
    );
    const body = response?.body as DshSyncProviderResult;
    expect(body.applied).toEqual([]);
    expect(body.skipped[0]?.key).toBe("gateway");
    expect(body.report.warnings[0]).toContain("llm-service-lite");
    expect(fake.upserts).toEqual([]);
  });

  it("export：备份 + 合并改写 patch.yml（未勾选 key 保留、注释与 !!js 行保留）", async () => {
    const home = await fixtureHome("dsh-sync-sync-export-");
    const patchFile = dshPatchFile(home, "web");
    const fake = makeFakeApi([
      { id: "gateway", enabled: true, interfaceType: "openai-responses", baseURL: "https://gateway.example.com/v2", hasApiKey: true },
    ]);
    const handler = createDshSyncRoutes(fake.api).get("POST /sync/providers");
    const response = await handler?.(
      { method: "POST", path: "/sync/providers", query: {}, body: { direction: "export", keys: ["gateway"] } },
      { dshHome: home, profile: "web" },
    );
    const body = response?.body as DshSyncProviderResult;
    expect(body.applied).toEqual([{ key: "gateway", kind: "profile" }]);
    expect(body.skipped).toEqual([{ key: "legacy", kind: "profile", reason: "未勾选（保留 dsh 既有配置）" }]);
    expect(body.envNeeded).toEqual({ OWC_SYNC_GATEWAY_API_KEY: "gateway" });

    // 备份文件生成（同目录 .owc-sync-backup-<时间戳>）
    expect(body.backupPath).toContain(".owc-sync-backup-");
    const backupText = await readFile(body.backupPath ?? "", "utf8");
    expect(backupText).toContain("apiKeyEnv: GATEWAY_API_KEY");
    const names = await readdir(path.dirname(patchFile));
    expect(names.some((name) => name.includes(".owc-sync-backup-"))).toBe(true);

    // 改写结果：勾选项覆盖、未勾选项保留、注释与 !!js 标签逐字保留
    const next = await readFile(patchFile, "utf8");
    expect(next).toContain("trustedHosts: !!js ctx.lanAccess.trustedHosts");
    expect(next).toContain("# 尾部注释：改写后应保留");
    expect(next).toContain("OWC_SYNC_GATEWAY_API_KEY");
    expect(next).not.toMatch(/apiKeyEnv: GATEWAY_API_KEY/);
    expect(next).toContain("sk-inline-demo-key");
    expect(next).toContain("https://gateway.example.com/v2");

    const providers = await readDshProviders(patchFile);
    expect(Object.keys(providers ?? {})).toEqual(["gateway", "legacy"]);
    expect((providers?.gateway as Record<string, unknown>)).toEqual({
      interfaceType: "openai-responses",
      enabled: true,
      baseURL: "https://gateway.example.com/v2",
      apiKeyEnv: "OWC_SYNC_GATEWAY_API_KEY",
    });
    expect((providers?.legacy as Record<string, unknown>).apiKey).toBe("sk-inline-demo-key");
  });

  it("export：未勾选的全部 key 原样保留（不隐式删除用户配置）", async () => {
    const home = await fixtureHome("dsh-sync-sync-export-none-");
    const patchFile = dshPatchFile(home, "web");
    const before = await readFile(patchFile, "utf8");
    const fake = makeFakeApi([]);
    const handler = createDshSyncRoutes(fake.api).get("POST /sync/providers");
    const response = await handler?.(
      { method: "POST", path: "/sync/providers", query: {}, body: { direction: "export", keys: [] } },
      { dshHome: home, profile: "web" },
    );
    const body = response?.body as DshSyncProviderResult;
    expect(body.applied).toEqual([]);
    expect(body.skipped.map((item) => item.key).sort()).toEqual(["gateway", "legacy"]);
    // 字典合并后逐字段等价（注释形态可能因重新渲染 providers 块而变化，这里只比较配置语义）
    const after = await readDshProviders(patchFile);
    expect(after).toEqual(await readDshProviders(path.join(FIXTURES, "profiles", "web", "cordis.patch.yml")));
    expect(before).toContain("llm-service-lite");
  });
});

describe("manifest.routes ↔ host 路由表一致性（M2a 扩充）", () => {
  it("dsh-sync 的 manifest 路由与工厂生成的路由键集合一一对应", () => {
    const manifest = OFFICIAL_EXTENSIONS.find((item) => item.id === "dsh-sync");
    expect(manifest).toBeDefined();
    const declared = (manifest?.routes ?? []).map((route) => `${route.method} ${route.path}`).sort();
    // 会话路由（M3b）的完整契约由 dsh-sync-sessions-route.test.ts 守；这里只断言模型配置三条仍在
    expect(declared).toEqual(expect.arrayContaining(["GET /preview/providers", "GET /status", "POST /sync/providers"]));
    const fake = makeFakeApi([]);
    expect(declared).toEqual([...createDshSyncRoutes(fake.api).keys()].sort());
  });

  it("manifest 声明了新权限与 60s 同步路由超时，版本已 bump（0.2.1）", () => {
    const manifest = OFFICIAL_EXTENSIONS.find((item) => item.id === "dsh-sync");
    expect(manifest?.permissions).toEqual(expect.arrayContaining(["providers:read", "providers:mutate", "sessions:read", "sessions:mutate"]));
    expect(manifest?.version).toBe("0.2.1");
    const sync = (manifest?.routes ?? []).find((route) => route.path === "/sync/providers");
    expect(sync?.timeoutMs).toBe(60_000);
  });
});

describe("server API：providers.listProfiles / providers.upsertProfiles（经 ExtensionManager 分发）", () => {
  /**
   * 白盒构造：只注入 manifests（跳过 initialize 以免 fork Extension Host），
   * 用真实 ProviderProfilesService + ModelRegistry（落盘到 mkdtemp）验证端到端写盘语义。
   */
  async function buildManager(options: { withServices: boolean }): Promise<{
    dispatch: (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) => Promise<unknown>;
    providerProfiles?: ProviderProfilesService;
  }> {
    const dataDir = await tempDir("dsh-sync-server-api-");
    const providerProfiles = options.withServices
      ? await ProviderProfilesService.load({ filePath: path.join(dataDir, "provider-profiles.json") })
      : undefined;
    const models = options.withServices
      ? await ModelRegistry.load({
        snapshotPath: path.join(dataDir, "models.json"),
        syncedSnapshotPath: path.join(dataDir, "models.synced.json"),
        manualPath: path.join(dataDir, "models.manual.json"),
      })
      : undefined;
    const manager = new ExtensionManager(dataDir, undefined, {
      ...(providerProfiles ? { providerProfiles } : {}),
      ...(models ? { models } : {}),
    });
    // manifests 由 initialize() 建立；这里直接注入官方清单，避免为一条 API 拉起宿主子进程。
    (manager as unknown as { manifests: ExtensionManifest[] }).manifests = [
      ...OFFICIAL_EXTENSIONS,
      { id: "third-party", name: "第三方", version: "0.0.1", description: "无新权限", apiVersion: "1", permissions: [] },
    ];
    const dispatch = (request: { id: string; api: string; extensionId: string; params?: Record<string, unknown> }) =>
      (manager as unknown as { dispatchApi(request: unknown): Promise<unknown> }).dispatchApi(request);
    return { dispatch, ...(providerProfiles ? { providerProfiles } : {}) };
  }

  it("listProfiles 返回脱敏视图（hasApiKey，不含明文）", async () => {
    const { dispatch, providerProfiles } = await buildManager({ withServices: true });
    await providerProfiles?.upsertModel("gateway", { id: "gateway", enabled: true, interfaceType: "openai-responses", apiKey: "sk-secret" });
    const profiles = await dispatch({ id: "1", api: "providers.listProfiles", extensionId: "dsh-sync" }) as Array<Record<string, unknown>>;
    expect(profiles).toEqual([expect.objectContaining({ id: "gateway", hasApiKey: true })]);
    expect(JSON.stringify(profiles)).not.toContain("sk-secret");
  });

  it("upsertProfiles 逐项写入 profile 与模型目录，并返回逐项结论", async () => {
    const { dispatch, providerProfiles } = await buildManager({ withServices: true });
    const result = await dispatch({
      id: "2",
      api: "providers.upsertProfiles",
      extensionId: "dsh-sync",
      params: {
        profiles: [{ id: "gateway", enabled: true, interfaceType: "openai-responses", baseURL: "https://gateway.example.com/v1", apiKey: "sk-secret" }],
        models: [{ id: "deepseek-v4-pro", provider: "gateway", contextWindow: 1_000_000, capabilities: { modalities: ["text"], tools: true } }],
      },
    }) as { profiles: Array<{ id: string; ok: boolean }>; models: Array<{ id: string; provider: string; ok: boolean }> };
    expect(result.profiles).toEqual([{ id: "gateway", ok: true }]);
    expect(result.models).toEqual([{ id: "deepseek-v4-pro", provider: "gateway", ok: true }]);
    expect(providerProfiles?.modelProfiles()[0]?.apiKey).toBe("sk-secret");
  });

  it("apiKey 缺省不进 patch：无凭据更新保留已有 Key（单项失败不中断）", async () => {
    const { dispatch, providerProfiles } = await buildManager({ withServices: true });
    await providerProfiles?.upsertModel("gateway", { id: "gateway", enabled: true, interfaceType: "openai-responses", apiKey: "sk-secret" });
    const result = await dispatch({
      id: "3",
      api: "providers.upsertProfiles",
      extensionId: "dsh-sync",
      params: {
        profiles: [
          { id: "gateway", interfaceType: "openai-responses", baseURL: "https://gateway.example.com/v2" },
          { id: "broken provider name!", interfaceType: "openai-responses" },
        ],
      },
    }) as { profiles: Array<{ id: string; ok: boolean; error?: string }> };
    expect(result.profiles[0]).toEqual({ id: "gateway", ok: true });
    expect(result.profiles[1]?.ok).toBe(false);
    expect(result.profiles[1]?.error).toContain("配置名称");
    // 「无凭据更新」语义：patch 未带 apiKey，服务层保留旧 Key，只更新 baseURL
    const profile = providerProfiles?.modelProfiles().find((item) => item.id === "gateway");
    expect(profile?.apiKey).toBe("sk-secret");
    expect(profile?.baseURL).toBe("https://gateway.example.com/v2");
  });

  it("权限门禁：第三方扩展无 providers:mutate 被拒；缺服务时报明确错误", async () => {
    const { dispatch } = await buildManager({ withServices: true });
    await expect(dispatch({ id: "4", api: "providers.upsertProfiles", extensionId: "third-party", params: { profiles: [] } }))
      .rejects.toThrow(/lacks permission: providers:mutate/);
    await expect(dispatch({ id: "5", api: "providers.listProfiles", extensionId: "third-party" }))
      .rejects.toThrow(/lacks permission: providers:read/);

    const bare = await buildManager({ withServices: false });
    await expect(bare.dispatch({ id: "6", api: "providers.listProfiles", extensionId: "dsh-sync" }))
      .rejects.toThrow(/Provider profiles service is not configured/);
    const partial = await bare.dispatch({
      id: "7",
      api: "providers.upsertProfiles",
      extensionId: "dsh-sync",
      params: { profiles: [{ id: "x", interfaceType: "openai-responses" }], models: [{ id: "m", provider: "x" }] },
    }) as { profiles: Array<{ ok: boolean; error?: string }>; models: Array<{ ok: boolean; error?: string }> };
    expect(partial.profiles[0]?.error).toContain("Provider profiles service is not configured");
    expect(partial.models[0]?.error).toContain("Model registry is not configured");
  });

  it("扩展 id 落在 dsh- 前缀里仍走扩展通道（官方 dsh-sync 不被误判为 dsh 插件）", async () => {
    const { dispatch } = await buildManager({ withServices: true });
    // 真扩展：先命中 manifests → 走 providers:read 门禁与真实分发（而不是被当成 dsh 插件拒绝）
    await expect(dispatch({ id: "8", api: "providers.listProfiles", extensionId: "dsh-sync" })).resolves.toEqual([]);
    // 伪扩展 dsh-<pluginId>：仍在 manifests 里找不到 → 继续走 dsh 插件通道
    await expect(dispatch({ id: "9", api: "providers.listProfiles", extensionId: "dsh-nope" }))
      .rejects.toThrow(/dsh plugin lacks api access/);
  });
});
