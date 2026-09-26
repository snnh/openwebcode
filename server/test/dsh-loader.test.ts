/** dsh 兼容层 M2 单测：插件发现（入口/兼容/配置清单）、最小 semver 范围匹配、宿主状态合并。 */
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkDshCompatibility, dshPluginInfos, dshPluginsRoot, matchesDshRange, normalizeDshPluginId,
  readDshPluginConfig, saveDshPluginConfig, scanDshPlugins, setDshPluginConfig, setDshPluginEnabled,
} from "../src/dsh/loader.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-plugins", import.meta.url));
let dataDir: string;

async function makeDataDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "owc-dsh-loader-"));
  await cp(FIXTURES, dshPluginsRoot(directory), { recursive: true });
  return directory;
}
beforeEach(async () => { dataDir = await makeDataDir(); });

describe("dsh 依赖兼容探测与最小 semver", () => {
  it("matchesDshRange：接受相交范围、拒绝越线、不可解析范围返回 undefined（不阻塞加载）", () => {
    const accepted: Array<[string, string]> = [
      ["4.0.2", "^4.0.2"], ["0.1.6", "^0.1.6"], ["0.1.6", "^0.1.6-alpha.1"], ["0.1.6", "^0.1.6-alpha.2"],
      ["0.1.6", ">=0.1.6-alpha.2"], ["0.1.6", "~0.1.6"], ["3.18.2", "^3.18.0"], ["4.0.2", ">=3 <5"],
      ["4.0.2", "*"], ["0.1.6", "0.1"], ["0.1.6", "0.1.x"], ["0.1.6", "^0.1.6-alpha.3"],
    ];
    const rejected: Array<[string, string]> = [
      // 精确预发布范围（=0.1.6-alpha.2）不兼容正式版 0.1.6：按 npm 语义不匹配并如实展示
      ["0.1.6", "0.1.6-alpha.2"], ["4.0.2", "^5.0.0"], ["0.1.6", "^0.2.0"], ["0.1.6", ">0.1.6"],
      ["4.0.2", "~4.1.0"], ["4.0.2", "1.x"], ["4.0.2", ">=5"], ["0.1.6", "^5.0.0 || ^6.0.0"],
    ];
    for (const [version, range] of accepted) expect(matchesDshRange(version, range), `${version} ⊂ ${range}`).toBe(true);
    for (const [version, range] of rejected) expect(matchesDshRange(version, range), `${version} ⊄ ${range}`).toBe(false);
    for (const range of ["workspace:^", "link:../vendor/cordis", "latest"]) expect(matchesDshRange("4.0.2", range)).toBeUndefined();
  });

  it("checkDshCompatibility：钉版预发布声明命中、越线或非垫片包如实报不兼容，非 dsh 依赖不参与判定", () => {
    for (const deps of [
      { "@deepseek-ai/dsh-tools": "0.1.6-alpha.2" }, { "@deepseek-ai/dsh-tools": "0.1.6-alpha.10" },
      { "@deepseek-ai/dsh-tools": "^0.1.6" }, { "@deepseek-ai/cordis": "4.0.2", "@deepseek-ai/schemastery": "^3.18.0" },
      { "@deepseek-ai/cordis": "4.0.0 - 5.0.0" }, { zod: "^4.0.0" },
    ]) expect(checkDshCompatibility(deps), JSON.stringify(deps)).toEqual({ compatible: true });
    expect(checkDshCompatibility({ "@deepseek-ai/dsh-tools": "^0.2.0" }).compatible).toBe(false);
    expect(checkDshCompatibility({ "@deepseek-ai/cordis": "^5.0.0" }).compatible).toBe(false);
    expect(checkDshCompatibility({ "@deepseek-ai/dsh-unknown-pkg": "1.0.0" }).compatible).toBe(false);
    // 只放行三个垫片包：其余 @deepseek-ai/* 一律不兼容并点名原因
    const other = checkDshCompatibility({ "@deepseek-ai/cordis": "^4.0.2", "@deepseek-ai/dsh-session": "^0.1.6" });
    expect([other.compatible, other.reason]).toEqual([false, expect.stringContaining("@deepseek-ai/dsh-session")]);
    expect([normalizeDshPluginId("@scope/My.Plugin", "dir"), normalizeDshPluginId("", "Some_Dir"), normalizeDshPluginId("---", "plugin")])
      .toEqual(["my-plugin", "some-dir", "plugin"]);
  });
});

describe("dsh 插件扫描", () => {
  it("入口解析：host exports['.']→main→index.js，client exports['./client'] 与 platform 声明；清单非法/版本不兼容/入口无效如实标注", async () => {
    const scan = await scanDshPlugins(dataDir);
    const byId = new Map(scan.entries.map((entry) => [entry.id, entry]));
    expect([...byId.keys()].sort()).toEqual([
      "broken-entry", "client-entry-missing", "client-platform-missing", "client-probe", "client-worker",
      "config-fail", "hello", "hook-gate", "incompatible-dep", "missing-service", "tool-hello",
    ]);
    expect([byId.get("hello")?.entry, byId.get("hello")?.problem, byId.get("missing-service")?.entry]).toEqual(["index.js", undefined, "index.js"]); // 认不出 main → index.js
    expect([byId.get("client-probe")?.clientEntry, byId.get("client-probe")?.client]).toEqual(["client.js", { platform: "web" }]);
    // platform 非 web：记录声明但不解析 client 入口（本层不装载 worker 半边）
    expect([byId.get("client-worker")?.client, byId.get("client-worker")?.clientEntry, byId.get("client-worker")?.problem])
      .toEqual([{ platform: "worker", inject: ["connection"], immediately: true }, undefined, undefined]);
    expect([byId.get("client-platform-missing")?.problem?.kind, byId.get("client-platform-missing")?.problem?.message])
      .toEqual(["invalid", expect.stringContaining("platform")]);
    expect([byId.get("client-entry-missing")?.problem?.kind, byId.get("client-entry-missing")?.problem?.message])
      .toEqual(["invalid", expect.stringContaining("./client")]);
    expect([byId.get("incompatible-dep")?.problem?.kind, byId.get("broken-entry")?.problem?.kind, byId.get("broken-entry")?.problem?.message])
      .toEqual(["incompatible", "invalid", expect.stringContaining("入口无效")]);
    // 计划只含可加载插件，且 directory 指向包目录
    expect(scan.plan.map((item) => item.id).sort()).toEqual(["client-probe", "client-worker", "config-fail", "hello", "hook-gate", "missing-service", "tool-hello"]);
    expect(scan.plan.find((item) => item.id === "hello")?.directory).toBe(path.join(dshPluginsRoot(dataDir), "hello"));
  });

  it("@scope/pkg 布局也能被发现（scope 目录只下探一层，本身不算插件）", async () => {
    const scoped = await mkdtemp(path.join(tmpdir(), "owc-dsh-scoped-"));
    const root = dshPluginsRoot(scoped);
    for (const [directory, name] of [["@acme/gizmo", "@acme/gizmo"], ["plain", "plain"]]) {
      await mkdir(path.join(root, directory), { recursive: true });
      await writeFile(path.join(root, directory, "package.json"), JSON.stringify({ name, version: "1.0.0", main: "index.js" }));
      await writeFile(path.join(root, directory, "index.js"), "export function apply() {}\n");
    }
    const scan = await scanDshPlugins(scoped);
    expect(scan.plan.map((item) => item.id).sort()).toEqual(["gizmo", "plain"]);
    const gizmo = scan.plan.find((item) => item.id === "gizmo");
    expect([gizmo?.directory, gizmo?.name]).toEqual([path.join(root, "@acme", "gizmo"), "@acme/gizmo"]);
    // scope 目录没被误当插件（否则会多出一个 invalid 的 `@acme` 条目）
    expect([scan.entries.map((entry) => entry.id).sort(), scan.entries.every((entry) => entry.problem === undefined)]).toEqual([["gizmo", "plain"], true]);
  });

  it("dsh.json：停用的插件不进计划、配置随计划下发；清单缺省/损坏回落空表、写入后可读回、非对象 config 拒绝", async () => {
    expect(await readDshPluginConfig(dataDir)).toEqual({ version: 1, plugins: {} });
    await writeFile(path.join(dataDir, "dsh.json"), "{ not json", "utf8");
    expect(await readDshPluginConfig(dataDir)).toEqual({ version: 1, plugins: {} });
    await setDshPluginEnabled(dataDir, "hello", false);
    await setDshPluginConfig(dataDir, "tool-hello", { suffix: "!" });
    const scan = await scanDshPlugins(dataDir);
    expect([scan.entries.find((entry) => entry.id === "hello")?.enabled, scan.plan.some((item) => item.id === "hello"), scan.plan.find((item) => item.id === "tool-hello")?.config])
      .toEqual([false, false, { suffix: "!" }]);
    const stored = JSON.parse(await readFile(path.join(dataDir, "dsh.json"), "utf8")) as { plugins: Record<string, unknown> };
    expect([stored.plugins.hello, stored.plugins["tool-hello"]]).toEqual([{ enabled: false, config: {} }, { enabled: true, config: { suffix: "!" } }]);
    await expect(saveDshPluginConfig(dataDir, { version: 1, plugins: { hello: { enabled: true, config: [] as unknown as Record<string, unknown> } } }))
      .rejects.toThrow(/config 必须是对象/);
  });

  it("状态合并：不可用原因优先于宿主回报、缺回报判 error、宿主整体失败统一文案、停用显示 disabled", async () => {
    const scan = await scanDshPlugins(dataDir);
    const byId = new Map(dshPluginInfos(scan, [
      { id: "hello", status: "running", tools: ["a"] },
      { id: "tool-hello", status: "missing-services", missing: ["tools"] },
    ]).map((info) => [info.id, info]));
    expect(byId.get("hello")).toMatchObject({ status: "running", tools: ["a"], enabled: true });
    expect(byId.get("tool-hello")).toMatchObject({ status: "missing-services", missing: ["tools"] });
    expect([byId.get("incompatible-dep")?.status, byId.get("broken-entry")?.status, byId.get("config-fail")?.status]).toEqual(["incompatible", "error", "error"]);
    expect(byId.get("config-fail")?.error).toContain("未回报");
    expect(dshPluginInfos(scan, undefined, "Extension Host 未连接").find((info) => info.id === "hello")?.error).toBe("Extension Host 未连接");
    const disabled = dshPluginInfos({ ...scan, entries: scan.entries.map((entry) => ({ ...entry, enabled: false })) }, undefined);
    expect(disabled.every((info) => info.status === "disabled")).toBe(true);
  });
});
