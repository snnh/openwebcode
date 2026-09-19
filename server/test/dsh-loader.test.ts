/** dsh 兼容层 M2 单测：插件发现（入口/兼容/配置清单）与最小 semver 范围匹配。 */
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkDshCompatibility,
  dshPluginInfos,
  dshPluginsRoot,
  matchesDshRange,
  normalizeDshPluginId,
  readDshPluginConfig,
  saveDshPluginConfig,
  scanDshPlugins,
  setDshPluginConfig,
  setDshPluginEnabled,
} from "../src/dsh/loader.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-plugins", import.meta.url));

async function makeDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "owc-dsh-loader-"));
  await cp(FIXTURES, dshPluginsRoot(dataDir), { recursive: true });
  return dataDir;
}

describe("dsh 最小 semver 范围匹配", () => {
  it("接受与垫片兼容面相交的范围", () => {
    expect(matchesDshRange("4.0.2", "^4.0.2")).toBe(true);
    expect(matchesDshRange("0.1.6", "^0.1.6")).toBe(true);
    // 上游钉版是 0.1.6-alpha.1/alpha.2：声明为 0.1.6 时各类写法都应命中
    expect(matchesDshRange("0.1.6", "^0.1.6-alpha.1")).toBe(true);
    expect(matchesDshRange("0.1.6", "^0.1.6-alpha.2")).toBe(true);
    // 精确预发布范围（`=0.1.6-alpha.2`）不兼容正式版 0.1.6：按 npm 语义判不匹配并如实展示
    expect(matchesDshRange("0.1.6", "0.1.6-alpha.2")).toBe(false);
    expect(matchesDshRange("0.1.6", ">=0.1.6-alpha.2")).toBe(true);
    expect(matchesDshRange("0.1.6", "~0.1.6")).toBe(true);
    expect(matchesDshRange("3.18.2", "^3.18.0")).toBe(true);
    expect(matchesDshRange("4.0.2", ">=3 <5")).toBe(true);
    expect(matchesDshRange("4.0.2", "*")).toBe(true);
    expect(matchesDshRange("0.1.6", "0.1")).toBe(true);
    expect(matchesDshRange("0.1.6", "0.1.x")).toBe(true);
  });

  it("拒绝不匹配的范围", () => {
    expect(matchesDshRange("4.0.2", "^5.0.0")).toBe(false);
    expect(matchesDshRange("0.1.6", "^0.2.0")).toBe(false);
    // 预发布下界：正式版 0.1.6 高于任何 0.1.6-alpha.N，故仍命中（npm 语义）
    expect(matchesDshRange("0.1.6", "^0.1.6-alpha.3")).toBe(true);
    expect(matchesDshRange("0.1.6", ">0.1.6")).toBe(false);
    expect(matchesDshRange("4.0.2", "~4.1.0")).toBe(false);
    expect(matchesDshRange("4.0.2", "1.x")).toBe(false);
    expect(matchesDshRange("4.0.2", ">=5")).toBe(false);
    expect(matchesDshRange("0.1.6", "^5.0.0 || ^6.0.0")).toBe(false);
  });

  it("不可解析的范围返回 undefined（不阻塞加载）", () => {
    expect(matchesDshRange("4.0.2", "workspace:^")).toBeUndefined();
    expect(matchesDshRange("4.0.2", "link:../vendor/cordis")).toBeUndefined();
    expect(matchesDshRange("4.0.2", "latest")).toBeUndefined();
  });
});

describe("dsh 依赖兼容探测", () => {
  it("只放行三个垫片包，其它 @deepseek-ai/* 判不兼容", () => {
    expect(checkDshCompatibility({ "@deepseek-ai/cordis": "^4.0.2" }).compatible).toBe(true);
    const session = checkDshCompatibility({ "@deepseek-ai/cordis": "^4.0.2", "@deepseek-ai/dsh-session": "^0.1.6" });
    expect(session.compatible).toBe(false);
    expect(session.reason).toContain("@deepseek-ai/dsh-session");
  });

  it("非 dsh 依赖（如 zod）不参与判定", () => {
    expect(checkDshCompatibility({ zod: "^4.0.0" }).compatible).toBe(true);
  });
});

describe("dsh 插件 id 规范化", () => {
  it("取 scope 之后的名字并规范化为 [a-z0-9-]", () => {
    expect(normalizeDshPluginId("@scope/My.Plugin", "dir")).toBe("my-plugin");
    expect(normalizeDshPluginId("", "Some_Dir")).toBe("some-dir");
    expect(normalizeDshPluginId("---", "plugin")).toBe("plugin");
  });
});

describe("dsh 插件扫描", () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await makeDataDir();
  });

  it("解析 host/client 入口、兼容结论与加载计划", async () => {
    const scan = await scanDshPlugins(dataDir);
    const byId = new Map(scan.entries.map((entry) => [entry.id, entry]));

    expect([...byId.keys()].sort()).toEqual([
      "broken-entry", "client-entry-missing", "client-platform-missing", "client-probe", "client-worker",
      "config-fail", "hello", "hook-gate", "incompatible-dep", "missing-service", "tool-hello",
    ]);
    expect(byId.get("hello")?.entry).toBe("index.js");
    expect(byId.get("hello")?.problem).toBeUndefined();
    expect(byId.get("client-probe")?.clientEntry).toBe("client.js");
    expect(byId.get("client-probe")?.entry).toBe("index.js");
    expect(byId.get("client-probe")?.problem).toBeUndefined();
    expect(byId.get("client-probe")?.client).toEqual({ platform: "web" });
    // platform 非 web：记录声明，但不解析 client 入口（本层不装载 worker 半边）
    expect(byId.get("client-worker")?.client).toEqual({ platform: "worker", inject: ["connection"], immediately: true });
    expect(byId.get("client-worker")?.clientEntry).toBeUndefined();
    expect(byId.get("client-worker")?.problem).toBeUndefined();
    // 声明非法：缺 platform / platform=web 但缺 exports["./client"] → 清单无效
    expect(byId.get("client-platform-missing")?.problem?.kind).toBe("invalid");
    expect(byId.get("client-platform-missing")?.problem?.message).toContain("platform");
    expect(byId.get("client-entry-missing")?.problem?.kind).toBe("invalid");
    expect(byId.get("client-entry-missing")?.problem?.message).toContain("./client");
    // 认不出 main → 缺省 index.js
    expect(byId.get("missing-service")?.entry).toBe("index.js");

    expect(byId.get("incompatible-dep")?.problem?.kind).toBe("incompatible");
    expect(byId.get("broken-entry")?.problem?.kind).toBe("invalid");
    expect(byId.get("broken-entry")?.problem?.message).toContain("入口无效");

    // 计划只含可加载插件（三个问题插件不在内）
    const planned = scan.plan.map((item) => item.id).sort();
    expect(planned).toEqual(["client-probe", "client-worker", "config-fail", "hello", "hook-gate", "missing-service", "tool-hello"]);
    expect(scan.plan.find((item) => item.id === "hello")?.directory).toBe(path.join(dshPluginsRoot(dataDir), "hello"));
  });

  it("dsh.json 停用的插件不进计划；配置随计划下发", async () => {
    await setDshPluginEnabled(dataDir, "hello", false);
    await setDshPluginConfig(dataDir, "tool-hello", { suffix: "!" });
    const scan = await scanDshPlugins(dataDir);
    const byId = new Map(scan.entries.map((entry) => [entry.id, entry]));

    expect(byId.get("hello")?.enabled).toBe(false);
    expect(scan.plan.some((item) => item.id === "hello")).toBe(false);
    expect(scan.plan.find((item) => item.id === "tool-hello")?.config).toEqual({ suffix: "!" });
  });

  it("配置清单读写：缺省/损坏回落空表，写入后原样读回", async () => {
    expect(await readDshPluginConfig(dataDir)).toEqual({ version: 1, plugins: {} });
    await writeFile(path.join(dataDir, "dsh.json"), "{ not json", "utf8");
    expect(await readDshPluginConfig(dataDir)).toEqual({ version: 1, plugins: {} });

    await setDshPluginEnabled(dataDir, "hello", false);
    await setDshPluginConfig(dataDir, "hello", { greeting: "hi" });
    const stored = JSON.parse(await readFile(path.join(dataDir, "dsh.json"), "utf8")) as { plugins: Record<string, unknown> };
    expect(stored.plugins.hello).toEqual({ enabled: false, config: { greeting: "hi" } });

    // 非对象 config 拒绝
    await expect(saveDshPluginConfig(dataDir, { version: 1, plugins: { hello: { enabled: true, config: [] as unknown as Record<string, unknown> } } }))
      .rejects.toThrow(/config 必须是对象/);
  });

  it("状态合并：不可用原因优先于宿主回报，缺回报判 error", async () => {
    const scan = await scanDshPlugins(dataDir);
    const infos = dshPluginInfos(scan, [
      { id: "hello", status: "running", tools: ["a"] },
      { id: "tool-hello", status: "missing-services", missing: ["tools"] },
    ]);
    const byId = new Map(infos.map((info) => [info.id, info]));

    expect(byId.get("hello")).toMatchObject({ status: "running", tools: ["a"], enabled: true });
    expect(byId.get("tool-hello")).toMatchObject({ status: "missing-services", missing: ["tools"] });
    expect(byId.get("incompatible-dep")?.status).toBe("incompatible");
    expect(byId.get("broken-entry")?.status).toBe("error");
    expect(byId.get("config-fail")?.status).toBe("error");
    expect(byId.get("config-fail")?.error).toContain("未回报");

    // 宿主整体失败：统一错误文案
    const failed = dshPluginInfos(scan, undefined, "Extension Host 未连接");
    expect(failed.find((info) => info.id === "hello")?.error).toBe("Extension Host 未连接");

    // 停用的插件显示 disabled（不报错）
    const disabled = dshPluginInfos({ ...scan, entries: scan.entries.map((entry) => ({ ...entry, enabled: false })) }, undefined);
    expect(disabled.every((info) => info.status === "disabled")).toBe(true);
  });
});
