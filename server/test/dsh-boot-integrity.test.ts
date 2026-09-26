/**
 * dsh boot 完整性检查（M4 步骤 19，vendor 缺失时跳过）。这些是**真实 boot 阻断级**不变量：
 * graph 每条 entry 必须指向真实存在且以该 id 自注册的 bundle，rev 与文件内容一致（否则 /plugins
 * 路由会长期发旧 bundle）；挂载集合锁定到钉版 roster，且不得含「仅作为依赖存在、官方未挂载」的包。
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// prettier-ignore
import { DSH_MODULES_ID, bootInjections, buildBootGraph, loadVendorManifest, type DshBootGraph, type DshVendorPlugin } from "../src/dsh/web-protocol/boot-graph.js";
import { loadBridgePlugin } from "../src/dsh/web-protocol/bridge.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR = path.join(SERVER_ROOT, "assets", "dsh-web");
const VENDOR_READY = existsSync(path.join(VENDOR, "manifest.json"));
/** shell 静态播种的模块（不进图，但被 inject 引用合法）。 */
const SEEDED = new Set([
  "react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis",
  "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit",
]);
const packageNameOf = (specifier: string): string => {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? specifier;
};

async function vendor(): Promise<{ plugins: DshVendorPlugin[]; ids: Set<string>; graph: DshBootGraph }> {
  const manifest = await loadVendorManifest(VENDOR);
  expect(manifest, "vendor 清单缺失").toBeDefined();
  const plugins = manifest!.plugins;
  return { plugins, ids: new Set(plugins.map((plugin) => plugin.id)), graph: buildBootGraph(plugins) };
}

describe.skipIf(!VENDOR_READY)("dsh boot 完整性（需 vendor）", () => {
  it("roster 锁定 + 每条 entry 的 bundle 存在、自注册 id 与 entry id 一致、rev 与文件内容一致", async () => {
    const { plugins, graph } = await vendor();
    // 插件数漂移（少装/混入未挂载包）必须在这里变红，而不是等浏览器落到 dsh 错误页
    expect(plugins.length).toBe(58);
    expect(graph.entries.length).toBe(plugins.length);
    const failures: string[] = [];
    for (const entry of graph.entries) {
      const body = await readFile(path.join(VENDOR, "plugins", entry.id, "client.js")).catch(() => undefined);
      if (body === undefined) {
        failures.push(`${entry.id}: bundle 缺失`);
        continue;
      }
      const declared = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(body.toString("utf8"))?.[1];
      if (declared !== entry.id) failures.push(`${entry.id}: 自注册 id 为 ${declared ?? "(未声明)"}`);
      if (!entry.url.includes(entry.rev)) failures.push(`${entry.id}: url 未携带 rev`);
      // rev 必须与磁盘内容一致：`/plugins` 路由按 manifest.rev 做缓存失效
      const expected = createHash("sha1").update(body).digest("hex").slice(0, 12);
      if (expected !== entry.rev) failures.push(`${entry.id}: rev ${entry.rev} ≠ 内容 sha1 ${expected}`);
    }
    expect(failures).toEqual([]);
  });

  it("batch 划分：bootstrap 恰为模块系统，application 覆盖其余 entry，每个 entry 恰好一 batch", async () => {
    const { plugins, graph } = await vendor();
    const bootstrap = graph.batches.filter((batch) => batch.phase === "bootstrap");
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]?.entries).toEqual([DSH_MODULES_ID]);
    const batched = graph.batches.flatMap((batch) => batch.entries);
    expect(batched.sort()).toEqual(graph.entries.map((entry) => entry.id).sort());
    expect(new Set(batched).size).toBe(batched.length);
    // immediately 包（stage-one 预取）缺一即启动卡住
    const immediately = plugins.filter((plugin) => plugin.immediately === true).map((plugin) => plugin.id);
    expect(immediately.length).toBeGreaterThan(0);
    expect(immediately.filter((id) => !graph.entries.some((entry) => entry.id === id))).toEqual([]);
  });

  it("依赖闭包：external/inject 目标都在图中或为 shell 播种；未挂载的依赖闭包页不得混入", async () => {
    const { plugins, ids } = await vendor();
    const missing = plugins.flatMap((plugin) =>
      [...plugin.external, ...plugin.inject]
        .filter((specifier) => !ids.has(packageNameOf(specifier)) && !SEEDED.has(packageNameOf(specifier)))
        .map((specifier) => `${plugin.id} → ${specifier}`));
    expect(missing).toEqual([]);
    // 官方挂载规则：不在 patch 名单者必须被引用。实测 directory-picker-browse 只作为依赖存在，
    // 被当作插件激活会让启动自检 failed（整个 SPA 落错误页），必须排除。
    expect(plugins.some((plugin) => plugin.id.includes("directory-picker"))).toBe(false);
  });

  it("注入行覆盖每条 batch（application 有 preload、bootstrap 有阻塞脚本）且图为 global 行", async () => {
    const { graph } = await vendor();
    const rows = bootInjections(graph);
    const srcOf = (kind: string) => rows.filter((row) => row.kind === kind).map((row) => (row as { src: string }).src);
    const urlsOf = (phase: string) => graph.batches.filter((batch) => batch.phase === phase).map((batch) => batch.url);
    expect(srcOf("script-preload").sort()).toEqual(urlsOf("application").sort());
    expect(srcOf("script-src")).toEqual(urlsOf("bootstrap"));
    const globalRow = rows.find((row) => row.kind === "global");
    expect(globalRow).toMatchObject({ name: "__DSH_BOOT__" });
    expect((globalRow as { value: DshBootGraph }).value.rev).toBe(graph.rev);
  });

  it("桥接插件与 vendor 同图共存，且 graph rev 对条目变化敏感", async () => {
    const { plugins, graph } = await vendor();
    const bridge = await loadBridgePlugin(path.join(SERVER_ROOT, "assets", "dsh-bridge"));
    expect(bridge, "桥接插件缺失").toBeDefined();
    const withBridge = buildBootGraph([...plugins, bridge!]);
    expect(withBridge.entries.some((entry) => entry.id === "owc-dsh-bridge")).toBe(true);
    expect(withBridge.rev).not.toBe(graph.rev);
  });
});
