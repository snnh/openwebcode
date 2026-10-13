/**
 * dsh-sync M1a（dsh 数据发现层）单测：路径归一、patch 读/改、会话扫描与解码。
 *
 * fixtures 只读使用；需要写入的用例先 mkdtemp 复制到临时目录再改副本。
 */
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import {
  DSH_SYNC_DEFAULT_PROFILE,
  backupFile,
  decodeDshSessionFile,
  dshEncodeSegment,
  dshPatchFile,
  dshProjectKey,
  dshSessionDir,
  probeDshRunning,
  readDshProviders,
  replaceDshProviders,
  resolveDshHome,
  resolveDshProfile,
  scanDshSessions,
  zstdAvailable,
  type DshSessionEntry,
} from "../src/extensions/dsh-sync-dsh.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-sync", import.meta.url));
const PATCH_FILE = path.join(FIXTURES, "profiles", "web", "cordis.patch.yml");
const RELCWD_ID = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
const DEMO_MAIN = "11111111-2222-4333-8444-555566667777";
const DEMO_SUB = "dddddddd-eeee-4fff-8000-111111111111";
const RAW_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const MULTI_ID = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
const LEGACY_ID = "cccccccc-dddd-4eee-8fff-000000000000";
/**
 * fixture 里 v4 zstd 会话（dsh 当前代际：一等 tool 角色消息 + plugin: 前缀块 + 附加事件）。
 * 文件用 node `zlib.zstdCompressSync` 生成，帧布局仿真实 dsh：首帧恰好一行头行，事件按批分帧。
 */
const V4_ID = "77777777-8888-4999-8aaa-bbbbbbbbbbbb";
/** 临时目录登记（afterAll 统一清理）。 */
const tempDirs: string[] = [];

/** 建临时目录（登记清理）。 */
async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** 扫描 fixture 会话目录并按 sessionId 建索引。 */
async function sessionsById(): Promise<Map<string, DshSessionEntry>> {
  return new Map((await scanDshSessions(FIXTURES)).map((entry) => [entry.sessionId, entry]));
}

/** 取选中文件信息（供 decodeDshSessionFile 使用）。 */
function picked(entry: DshSessionEntry | undefined): { file: string; generation: number; compressed: boolean } {
  if (entry?.file === undefined || entry.generation === undefined || entry.compressed === undefined) {
    throw new Error(`扫描结果缺少选中文件：${JSON.stringify(entry)}`);
  }
  return { file: entry.file, generation: entry.generation, compressed: entry.compressed };
}

afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true });
});

describe("resolveDshHome / resolveDshProfile / dshPatchFile", () => {
  it("缺省 ~/.dsh 展开为 homedir 下的 .dsh", () => {
    expect(resolveDshHome()).toBe(path.join(os.homedir(), ".dsh"));
    expect(resolveDshHome({})).toBe(path.join(os.homedir(), ".dsh"));
  });

  it("~ 前缀展开、其它路径 resolve 为绝对路径", () => {
    expect(resolveDshHome({ dshHome: "~/.dsh" })).toBe(path.join(os.homedir(), ".dsh"));
    expect(resolveDshHome({ dshHome: "~/.dsh-custom" })).toBe(path.join(os.homedir(), ".dsh-custom"));
    expect(resolveDshHome({ dshHome: "/tmp/dsh-home" })).toBe("/tmp/dsh-home");
    expect(resolveDshHome({ dshHome: "./relative-dsh-home" })).toBe(path.resolve("./relative-dsh-home"));
    expect(path.isAbsolute(resolveDshHome({ dshHome: "./relative-dsh-home" }))).toBe(true);
  });

  it("profile 缺省 web、可覆盖", () => {
    expect(DSH_SYNC_DEFAULT_PROFILE).toBe("web");
    expect(resolveDshProfile()).toBe("web");
    expect(resolveDshProfile({})).toBe("web");
    expect(resolveDshProfile({ profile: "dev" })).toBe("dev");
  });

  it("patch 路径 = <dshHome>/profiles/<profile>/cordis.patch.yml", () => {
    expect(dshPatchFile("/tmp/dsh-home", "web")).toBe(path.join("/tmp/dsh-home", "profiles", "web", "cordis.patch.yml"));
  });

  it("profile 白名单：目录穿越/绝对路径/超长/非法字符一律回落 web", () => {
    for (const profile of ["../etc", "..", ".", "a/b", "a\\b", "/etc", "web ", "wéb", "a".repeat(65), "\u0000evil"]) {
      expect(resolveDshProfile({ profile })).toBe(DSH_SYNC_DEFAULT_PROFILE);
    }
    // 白名单内的合法值原样保留（含点/下划线/连字符）
    expect(resolveDshProfile({ profile: "web-2_x.dev" })).toBe("web-2_x.dev");
  });

  it("dshPatchFile 的 containment 断言：解析后逃出 profiles 目录即抛错", () => {
    expect(() => dshPatchFile("/tmp/dsh-home", "../../etc")).toThrow(/逃出/);
    expect(() => dshPatchFile("/tmp/dsh-home", "../profiles-other")).toThrow(/逃出/);
    // 正常 profile（含点号）不触发断言
    expect(dshPatchFile("/tmp/dsh-home", "web-2_x.dev")).toBe(
      path.join("/tmp/dsh-home", "profiles", "web-2_x.dev", "cordis.patch.yml"),
    );
  });
});

describe("zstdAvailable", () => {
  it("返回 boolean（Node 24 起为 true；不硬断言环境）", () => {
    expect(typeof zstdAvailable()).toBe("boolean");
    if (process.versions.node.split(".").map(Number)[0]! >= 24) {
      expect(zstdAvailable()).toBe(true);
    }
  });
});

describe("readDshProviders", () => {
  it("读到 gateway / legacy 两个 provider，字段完整", async () => {
    const providers = (await readDshProviders(PATCH_FILE)) ?? {};
    expect(Object.keys(providers).sort()).toEqual(["gateway", "legacy"]);

    const gateway = providers.gateway as {
      interfaceType?: string;
      baseURL?: string;
      apiKeyEnv?: string;
      promptCaching?: boolean;
      models?: Array<{ id?: string; contextWindow?: number; maxTokens?: number }>;
    };
    expect(gateway.interfaceType).toBe("openai-responses");
    expect(gateway.baseURL).toBe("https://gateway.example.com/v1");
    expect(gateway.apiKeyEnv).toBe("GATEWAY_API_KEY");
    expect(gateway.promptCaching).toBe(true);
    expect(gateway.models).toHaveLength(1);
    expect(gateway.models?.[0]).toMatchObject({ id: "deepseek-v4-pro", contextWindow: 1000000, maxTokens: 393216 });

    const legacy = providers.legacy as { enabled?: boolean; apiKey?: string; models?: unknown[] };
    expect(legacy.enabled).toBe(false);
    expect(legacy.apiKey).toBe("sk-inline-demo-key");
  });

  it("!!js 自定义标签不炸（解析容忍、值按字符串透传）", async () => {
    // 同一文件里 connection 条目带 `trustedHosts: !!js ctx.lanAccess.trustedHosts`
    await expect(readDshProviders(PATCH_FILE)).resolves.toBeDefined();
  });

  it("文件缺失 / 条目缺失返回 undefined", async () => {
    expect(await readDshProviders(path.join(FIXTURES, "profiles", "web", "nope.yml"))).toBeUndefined();
    const dir = await tempDir("dsh-sync-read-");
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, "# 空 patch\n- id: connection\n  config:\n    trusted: yes\n", "utf8");
    expect(await readDshProviders(file)).toBeUndefined();
  });
});

describe("replaceDshProviders", () => {
  it("替换 providers，且保留注释与 !!js 标签（CST 级改写）", async () => {
    const text = await readFile(PATCH_FILE, "utf8");
    const out = replaceDshProviders(text, {
      synced: {
        interfaceType: "openai-responses",
        baseURL: "https://synced.example.com/v1",
        apiKeyEnv: "SYNCED_KEY",
        models: [{ id: "synced-model", contextWindow: 128000, maxTokens: 8192 }],
      },
    });

    // 注释与 !!js 标签逐字保留
    expect(out).toContain("# 测试 fixture：模拟 dsh profile 的 cordis.patch.yml");
    expect(out).toContain("# llm-service-lite：模型服务商配置（同步目标区块）");
    expect(out).toContain("# 尾部注释：改写后应保留");
    expect(out).toContain("!!js ctx.lanAccess.trustedHosts");
    // 旧 providers 内容被整体替换
    expect(out).not.toContain("GATEWAY_API_KEY");
    expect(out).not.toContain("sk-inline-demo-key");
    // 入参文本未被就地修改（纯函数）
    expect(text).toContain("GATEWAY_API_KEY");

    // 重读新文本得到新 providers
    const dir = await tempDir("dsh-sync-replace-");
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, out, "utf8");
    const reread = (await readDshProviders(file)) ?? {};
    expect(Object.keys(reread)).toEqual(["synced"]);
    const synced = reread.synced as { apiKeyEnv?: string; models?: Array<{ id?: string }> };
    expect(synced.apiKeyEnv).toBe("SYNCED_KEY");
    expect(synced.models?.[0]?.id).toBe("synced-model");
  });

  it("providers 块后紧跟注释行（无空行）时，替换结果仍是合法 YAML", async () => {
    // 真实结构（~/.dsh/profiles/web/cordis.patch.yml）：值节点之后紧跟注释行，中间没有空行。
    const text = [
      "- id: llm-service-lite",
      "  config:",
      "    providers:",
      "      gateway:",
      "        interfaceType: openai-responses",
      "        models: []",
      "# TEMPORARILY DISABLED: 被注释掉的条目",
      "- id: role-config",
      "  config:",
      "    keep: true",
      "",
    ].join("\n");

    const out = replaceDshProviders(text, {
      demo: { interfaceType: "openai-chat-completions", models: [] },
    });

    // (a) 改写后无 YAML 语法错误（旧实现会产出 `models: []# TEMPORARILY ...` 粘连行）
    expect(out).not.toContain("[]#");
    const doc = parseDocument(out);
    expect(doc.errors.map((error) => error.message)).toEqual([]);

    // (b) 注释行原样保留且独立成行
    expect(out.split("\n")).toContain("# TEMPORARILY DISABLED: 被注释掉的条目");
    // 其余结构逐字保留
    expect(out.split("\n")).toContain("- id: role-config");
    expect(out.split("\n")).toContain("    keep: true");

    // (c) 重读 providers 得到新值
    const dir = await tempDir("dsh-sync-gluing-");
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, out, "utf8");
    const reread = (await readDshProviders(file)) ?? {};
    expect(Object.keys(reread)).toEqual(["demo"]);
    expect((reread.demo as { interfaceType?: string }).interfaceType).toBe("openai-chat-completions");
  });

  it("providers 块后是空行或文件尾时不吞/不多加空行", () => {
    const head = ["- id: llm-service-lite", "  config:", "    providers:", "      a: 1"].join("\n");

    // 紧跟空行 + 注释：空行保留（不吞行尾换行）
    const blank = replaceDshProviders(`${head}\n\n# tail\n- id: other\n`, { b: { models: [] } });
    const blankLines = blank.split("\n");
    expect(blankLines).toContain("# tail");
    expect(blankLines[blankLines.indexOf("# tail") - 1]).toBe("");
    expect(parseDocument(blank).errors.map((error) => error.message)).toEqual([]);

    // 文件尾无换行：追加后同样无尾换行；文件尾有换行：保留单个尾换行
    const noNewline = replaceDshProviders(`${head}`, { b: { models: [] } });
    expect(noNewline.endsWith("\n")).toBe(false);
    expect(parseDocument(noNewline).errors.map((error) => error.message)).toEqual([]);
    const newline = replaceDshProviders(`${head}\n`, { b: { models: [] } });
    expect(newline.endsWith("\n")).toBe(true);
    expect(newline.endsWith("\n\n")).toBe(false);
    expect(parseDocument(newline).errors.map((error) => error.message)).toEqual([]);
  });

  it("providers 为空值 / flow 同行值时也能改写成合法 YAML", () => {
    // 空值：`providers:` 后直接是注释行
    const empty = replaceDshProviders(
      "- id: llm-service-lite\n  config:\n    providers:\n# note\n- id: role\n",
      { c: { models: [] } },
    );
    expect(parseDocument(empty).errors.map((error) => error.message)).toEqual([]);
    expect(empty.split("\n")).toContain("# note");

    // flow 同行值：`providers: {a: 1}` + 行内注释
    const flow = replaceDshProviders(
      "- id: llm-service-lite\n  config:\n    providers: {a: {models: []}} # inline\n- id: role\n",
      { d: { models: [] } },
    );
    expect(parseDocument(flow).errors.map((error) => error.message)).toEqual([]);
    expect(flow).toContain("# inline");
    expect(flow).not.toContain("{a: {models: []}}");
  });

  it("条目不存在时在文档末尾追加 llm-service-lite 条目", async () => {
    const bare = "# 别的条目\n- id: connection\n  config:\n    trusted: yes\n";
    const appended = replaceDshProviders(bare, { p1: { apiKeyEnv: "P1_KEY", enabled: true } });
    expect(appended).toContain("# 别的条目");
    expect(appended).toContain("- id: llm-service-lite");
    expect(appended).toContain("    providers:");

    const dir = await tempDir("dsh-sync-append-");
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, appended, "utf8");
    const reread = (await readDshProviders(file)) ?? {};
    expect(Object.keys(reread)).toEqual(["p1"]);
    expect((reread.p1 as { apiKeyEnv?: string }).apiKeyEnv).toBe("P1_KEY");
  });

  it("条目存在但缺 providers 字段时补写该字段", async () => {
    const text = "- id: llm-service-lite\n  name: \"@deepseek-ai/dsh-llm-service-lite\"\n  config:\n    concurrency: 2\n";
    const out = replaceDshProviders(text, { x: { apiKeyEnv: "X_KEY" } });
    expect(out).toContain("concurrency: 2");

    const dir = await tempDir("dsh-sync-insert-");
    const file = path.join(dir, "cordis.patch.yml");
    await writeFile(file, out, "utf8");
    const reread = (await readDshProviders(file)) ?? {};
    expect(Object.keys(reread)).toEqual(["x"]);
  });
});

describe("backupFile", () => {
  it("副本存在、内容一致、文件名含时间戳且无冒号", async () => {
    const dir = await tempDir("dsh-sync-backup-");
    const file = path.join(dir, "cordis.patch.yml");
    await copyFile(PATCH_FILE, file);

    const backup = await backupFile(file);
    expect(path.dirname(backup)).toBe(dir);
    expect(path.basename(backup)).toContain(".owc-sync-backup-");
    expect(path.basename(backup)).not.toContain(":");
    expect(await readFile(backup, "utf8")).toBe(await readFile(file, "utf8"));
  });
});

describe("dshProjectKey / dshEncodeSegment / dshSessionDir", () => {
  it("undefined → _no-cwd；slug 为空 → root；分隔符折叠为 -（对齐上游 projectKey）", () => {
    expect(dshProjectKey(undefined)).toBe("_no-cwd");
    expect(dshProjectKey("/tmp/demo")).toBe("--tmp-demo--");
    expect(dshProjectKey("/")).toBe("--root--");
    expect(dshProjectKey("C:\\work\\proj")).toBe("--C-work-proj--");
    expect(dshProjectKey("/a//b")).toBe("--a-b--");
    expect(dshProjectKey("/w~x")).toBe("--w~007Ex--");
  });

  it("长路径按 251 字符截断", () => {
    const key = dshProjectKey(`/${"a".repeat(400)}`);
    expect(key).toBe(`--${"a".repeat(251)}--`);
  });

  it("encodeSegment 转义不安全码元并保持可逆", () => {
    expect(dshEncodeSegment("plain-id_1.2")).toBe("plain-id_1.2");
    expect(dshEncodeSegment(".")).toBe("~002E");
    expect(dshEncodeSegment("..")).toBe("~002E~002E");
    // 仅整段 `.` / `..` 特判；段内 `.` 是安全码元，故沿用上游语义
    expect(dshEncodeSegment("../a b")).toBe("..~002Fa~0020b");
    expect(dshEncodeSegment("~")).toBe("~007E");
    expect(() => dshEncodeSegment("")).toThrow();
  });

  it("sessionDir = <dshHome>/sessions/<projectKey>/<encodeSegment(id)>", () => {
    expect(dshSessionDir("/tmp/dsh-home", "/tmp/demo", DEMO_MAIN))
      .toBe(path.join("/tmp/dsh-home", "sessions", "--tmp-demo--", DEMO_MAIN));
    expect(dshSessionDir("/tmp/dsh-home", undefined, "a/b"))
      .toBe(path.join("/tmp/dsh-home", "sessions", "_no-cwd", "a~002Fb"));
  });
});

describe("scanDshSessions", () => {
  it("扫出 7 个会话目录、每目录选最高代际规范文件", async () => {
    const entries = await scanDshSessions(FIXTURES);
    expect(entries).toHaveLength(7);
    expect(entries.map((entry) => entry.sessionId).sort()).toEqual([DEMO_MAIN, DEMO_SUB, RAW_ID, MULTI_ID, LEGACY_ID, V4_ID, RELCWD_ID].sort());
    for (const entry of entries) expect(path.isAbsolute(entry.dir)).toBe(true);
  });

  it("multi 目录（v0 + v3 并存）选中 v3", async () => {
    const multi = (await sessionsById()).get(MULTI_ID);
    expect(multi).toBeDefined();
    expect(multi?.generation).toBe(3);
    expect(multi?.compressed).toBe(false);
    expect(multi?.file).toBe(path.join(FIXTURES, "sessions", "--tmp-multi--", MULTI_ID, "session.v3.jsonl"));
    expect(multi?.header).toMatchObject({ type: "session", version: 3, id: MULTI_ID, cwd: "/tmp/multi" });
    expect(multi?.cwd).toBe("/tmp/multi");
    expect(multi?.error).toBeUndefined();
  });

  it("zstd 会话头可解析（只解头帧）", async () => {
    const demo = (await sessionsById()).get(DEMO_MAIN);
    expect(demo?.generation).toBe(3);
    expect(demo?.compressed).toBe(true);
    expect(demo?.file?.endsWith("session.v3.jsonl.zstd")).toBe(true);
    expect(demo?.header).toMatchObject({ type: "session", version: 3, cwd: "/tmp/demo" });
    expect(demo?.error).toBeUndefined();
  });

  it("v4 会话同样解析头行（读支持 v3/v4）", async () => {
    const v4 = (await sessionsById()).get(V4_ID);
    expect(v4?.generation).toBe(4);
    expect(v4?.compressed).toBe(true);
    expect(v4?.file?.endsWith("session.v4.jsonl.zstd")).toBe(true);
    expect(v4?.header).toMatchObject({ type: "session", version: 4, id: V4_ID, cwd: "/tmp/v4" });
    expect(v4?.cwd).toBe("/tmp/v4");
    expect(v4?.error).toBeUndefined();
  });

  it("legacy 目录（仅 v1）不解析头行，仅报代际", async () => {
    const legacy = (await sessionsById()).get(LEGACY_ID);
    expect(legacy?.generation).toBe(1);
    expect(legacy?.compressed).toBe(false);
    expect(legacy?.header).toBeUndefined();
    expect(legacy?.cwd).toBeUndefined();
    expect(legacy?.error).toBeUndefined();
  });

  it("subagent 会话的 origin / parentSession 正确", async () => {
    const sub = (await sessionsById()).get(DEMO_SUB);
    expect(sub?.origin).toBe("subagent");
    expect(sub?.parentSession).toBe(DEMO_MAIN);
    expect(sub?.cwd).toBe("/tmp/demo");
    expect(sub?.generation).toBe(3);
  });

  it("目录不存在返回空数组", async () => {
    expect(await scanDshSessions(path.join(os.tmpdir(), "dsh-sync-absent-home"))).toEqual([]);
  });
});

describe("decodeDshSessionFile", () => {
  it("zstd 多帧容器：解出头行 + 2 个事件", async () => {
    const entry = picked((await sessionsById()).get(DEMO_MAIN));
    expect(entry.compressed).toBe(true);
    const { header, events } = await decodeDshSessionFile(entry);
    expect(header).toMatchObject({ type: "session", version: 3, id: DEMO_MAIN, cwd: "/tmp/demo", delegationDepth: 0 });
    expect(events.map((event) => event.type)).toEqual(["user/message", "assistant/message"]);
    expect(events.map((event) => event.seq)).toEqual([0, 1]);
    expect(events[0]).toMatchObject({ surfaceOp: "append", data: { id: "m1", role: "user" } });
    expect(typeof events[1]?.time).toBe("number");
  });

  it("raw 会话文件同样可解", async () => {
    const entry = picked((await sessionsById()).get(RAW_ID));
    expect(entry.compressed).toBe(false);
    const { header, events } = await decodeDshSessionFile(entry);
    expect(header).toMatchObject({ type: "session", version: 3, cwd: "/tmp/raw" });
    expect(events.map((event) => event.seq)).toEqual([0]);
    expect(events[0]?.type).toBe("user/message");
  });

  it("zstd v4 容器：解出头行 + 全部事件（一等 tool 角色消息 + plugin: 前缀块 + 附加事件）", async () => {
    const entry = picked((await sessionsById()).get(V4_ID));
    expect(entry.generation).toBe(4);
    const { header, events } = await decodeDshSessionFile(entry);
    expect(header).toMatchObject({ type: "session", version: 4, id: V4_ID, cwd: "/tmp/v4", delegationDepth: 0 });
    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.map((event) => event.type)).toEqual([
      "permission/preset",
      "user/message",
      "assistant/message",
      "tool/call",
      "tool/result",
      "session-log-deepseek/delivery-accepted",
      "assistant/message",
      "tool/call",
      "tool/result",
      "sandbox/mode",
    ]);
    const toolResult = events[4]?.data as { message: Record<string, unknown> };
    expect(toolResult.message).toMatchObject({ role: "tool", toolCallId: "call-1", isError: false });
    expect(toolResult.message.content).toEqual([{ type: "text", text: "file body" }]);
  });

  it("v1 代际抛「不支持的代际」", async () => {
    const legacy = (await sessionsById()).get(LEGACY_ID);
    const entry = picked(legacy);
    expect(entry.generation).toBe(1);
    await expect(decodeDshSessionFile(entry)).rejects.toThrow(/不支持的代际/);
  });

  it("seq 断档抛「格式损坏」", async () => {
    const dir = await tempDir("dsh-sync-gap-");
    const file = path.join(dir, "session.v3.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "gap-session", createdAt: 1, isSeeded: false, delegationDepth: 0 });
    const event = (seq: number) => JSON.stringify({ type: "user/message", seq, time: 1, data: { id: `m${seq}` } });
    await writeFile(file, `${header}\n${event(0)}\n${event(2)}\n`, "utf8");
    await expect(decodeDshSessionFile({ file, generation: 3, compressed: false })).rejects.toThrow(/格式损坏/);
  });

  it("高于读支持上界的代际（v5）抛「不支持的代际」", async () => {
    const dir = await tempDir("dsh-sync-future-");
    const file = path.join(dir, "session.v5.jsonl");
    const header = JSON.stringify({ type: "session", version: 5, id: "future", createdAt: 1 });
    await writeFile(file, `${header}\n`, "utf8");
    await expect(decodeDshSessionFile({ file, generation: 5, compressed: false })).rejects.toThrow(/不支持的代际/);
  });

  it("头行代际不符 / 非 JSON 抛「格式损坏」", async () => {
    const dir = await tempDir("dsh-sync-broken-");
    const badHeader = path.join(dir, "session.v3.jsonl");
    const header = JSON.stringify({ type: "session", version: 1, id: "x", createdAt: 1, isSeeded: false, delegationDepth: 0 });
    await writeFile(badHeader, `${header}\n`, "utf8");
    await expect(decodeDshSessionFile({ file: badHeader, generation: 3, compressed: false })).rejects.toThrow(/格式损坏/);

    // v4 文件的头行 version 必须与实测代际一致（generation 取错也算损坏）
    const wrongGen = path.join(dir, "session.v4.jsonl");
    const v3Header = JSON.stringify({ type: "session", version: 3, id: "x", createdAt: 1, isSeeded: false, delegationDepth: 0 });
    await writeFile(wrongGen, `${v3Header}\n`, "utf8");
    await expect(decodeDshSessionFile({ file: wrongGen, generation: 4, compressed: false })).rejects.toThrow(/格式损坏/);

    const notJson = path.join(dir, "session.v3.jsonl");
    await writeFile(notJson, "not json\n", "utf8");
    await expect(decodeDshSessionFile({ file: notJson, generation: 3, compressed: false })).rejects.toThrow(/格式损坏/);
  });
});

describe("probeDshRunning", () => {
  it("监听中 → true；已关闭端口 → false", async () => {
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    expect(port).toBeGreaterThan(0);

    expect(await probeDshRunning(port)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await probeDshRunning(port)).toBe(false);
  });
});
