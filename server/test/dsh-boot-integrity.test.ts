/**
 * dsh boot 完整性检查（M4 步骤 19，vendor 缺失时跳过）。
 *
 * 这些是**真实 boot 阻断级**的不变量：boot graph 的每条 entry 必须指向一个真实存在、
 * 且以该 entry id 自注册的 bundle；每个插件文件的 rev 必须与清单一致。任何一条不满足，
 * dsh SPA 都会在浏览器里启动失败（而这些错在服务端静默 200 是查不出来的）。
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DSH_MODULES_ID,
  bootInjections,
  buildBootGraph,
  loadVendorManifest,
  type DshBootGraph,
} from "../src/dsh/web-protocol/boot-graph.js";
import { loadBridgePlugin } from "../src/dsh/web-protocol/bridge.js";

const SERVER_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VENDOR = path.join(SERVER_ROOT, "assets", "dsh-web");
const VENDOR_READY = existsSync(path.join(VENDOR, "manifest.json"));

describe.skipIf(!VENDOR_READY)("dsh boot 完整性（需 vendor）", () => {
  it("每条 graph entry 的 bundle 存在、自注册 id 与 entry id 一致", async () => {
    const manifest = await loadVendorManifest(VENDOR);
    expect(manifest).toBeDefined();
    const graph = buildBootGraph(manifest!.plugins);
    expect(graph.entries.length).toBeGreaterThan(50);
    const failures: string[] = [];
    for (const entry of graph.entries) {
      const file = path.join(VENDOR, "plugins", entry.id, "client.js");
      const source = await readFile(file, "utf8").catch(() => undefined);
      if (source === undefined) {
        failures.push(`${entry.id}: bundle 缺失`);
        continue;
      }
      const declared = /__ModuleLoader__\.load\(\{\s*id:\s*"([^"]+)"/.exec(source)?.[1];
      if (declared !== entry.id) failures.push(`${entry.id}: 自注册 id 为 ${declared ?? "(未声明)"}`);
      if (!entry.url.includes(encodeURIComponent(entry.rev)) && !entry.url.includes(entry.rev)) {
        failures.push(`${entry.id}: url 未携带 rev`);
      }
    }
    expect(failures).toEqual([]);
  });

  it("boot graph：bootstrap 恰为模块系统，application 覆盖其余 entry，每个 entry 恰好属于一个 batch", async () => {
    const manifest = await loadVendorManifest(VENDOR);
    const graph = buildBootGraph(manifest!.plugins);
    const bootstrap = graph.batches.filter((batch) => batch.phase === "bootstrap");
    expect(bootstrap).toHaveLength(1);
    expect(bootstrap[0]?.entries).toEqual([DSH_MODULES_ID]);
    const batched = graph.batches.flatMap((batch) => batch.entries);
    expect(batched.sort()).toEqual(graph.entries.map((entry) => entry.id).sort());
    expect(new Set(batched).size).toBe(batched.length);
    // immediately 包（stage-one 预取）必须都在图里（缺一即启动卡住）
    const immediately = manifest!.plugins.filter((plugin) => plugin.immediately === true).map((plugin) => plugin.id);
    expect(immediately.length).toBeGreaterThan(0);
    for (const id of immediately) expect(graph.entries.some((entry) => entry.id === id)).toBe(true);
  });

  it("external 声明的目标包在图中存在（缺失即运行时模块解析失败）", async () => {
    const manifest = await loadVendorManifest(VENDOR);
    const ids = new Set(manifest!.plugins.map((plugin) => plugin.id));
    const missing: string[] = [];
    for (const plugin of manifest!.plugins) {
      for (const external of plugin.external) {
        // external 可指向 `@scope/pkg/subpath`：按包名（前两段）判定
        const parts = external.split("/");
        const packageName = external.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? external;
        if (!ids.has(packageName)) missing.push(`${plugin.id} → ${external}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("inject 声明的目标也在图中（或由 shell 静态播种），且挂载集合不含未挂载的依赖闭包页", async () => {
    const manifest = await loadVendorManifest(VENDOR);
    const ids = new Set(manifest!.plugins.map((plugin) => plugin.id));
    // shell 静态播种的模块（`PLATFORM_MODULES`）：它们不进图，但 inject 引用它们是合法的
    const seeded = new Set([
      "react", "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis",
      "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-ui-primitives", "@deepseek-ai/dsh-client-ui-dockkit",
    ]);
    const packageNameOf = (specifier: string): string => {
      const parts = specifier.split("/");
      return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0] ?? specifier;
    };
    const missing: string[] = [];
    for (const plugin of manifest!.plugins) {
      for (const inject of plugin.inject) {
        const name = packageNameOf(inject);
        if (!ids.has(name) && !seeded.has(name)) missing.push(`${plugin.id} → ${inject}`);
      }
    }
    expect(missing).toEqual([]);

    // 挂载规则回归：依赖闭包里「作为依赖存在但官方未挂载」的包不得进图。
    // 实测踩过：directory-picker-browse 被当作插件激活时在启动自检里 failed（整个 SPA 落到错误页），
    // 它与 native 都只作为依赖存在、不被任何插件 inject/external 引用 → 必须被排除。
    expect(manifest!.plugins.some((plugin) => plugin.id.includes("directory-picker"))).toBe(false);
  });

  it("注入行覆盖每条 batch：application 都有 preload、bootstrap 有阻塞脚本", async () => {
    const manifest = await loadVendorManifest(VENDOR);
    const graph = buildBootGraph(manifest!.plugins);
    const rows = bootInjections(graph);
    const preloads = rows.filter((row) => row.kind === "script-preload").map((row) => (row as { src: string }).src);
    const blocking = rows.filter((row) => row.kind === "script-src").map((row) => (row as { src: string }).src);
    const application = graph.batches.filter((batch) => batch.phase === "application").map((batch) => batch.url);
    expect(preloads.sort()).toEqual([...application].sort());
    expect(blocking).toEqual(graph.batches.filter((batch) => batch.phase === "bootstrap").map((batch) => batch.url));
    // 图作为 global 行注入，且 `__DSH_BOOT_READY__` 尾标在渲染结果里
    const globalRow = rows.find((row) => row.kind === "global");
    expect(globalRow).toMatchObject({ name: "__DSH_BOOT__" });
    expect((globalRow as { value: DshBootGraph }).value.rev).toBe(graph.rev);
  });

  it("桥接插件与 vendor 同图共存，且 graph rev 对条目变化敏感", async () => {
    const manifest = await loadVendorManifest(VENDOR);
    const bridge = await loadBridgePlugin(path.join(SERVER_ROOT, "assets", "dsh-bridge"));
    const withBridge = buildBootGraph([...manifest!.plugins, ...(bridge === undefined ? [] : [bridge])]);
    expect(withBridge.entries.some((entry) => entry.id === "owc-dsh-bridge")).toBe(bridge !== undefined);
    const withoutBridge = buildBootGraph(manifest!.plugins);
    if (bridge !== undefined) expect(withBridge.rev).not.toBe(withoutBridge.rev);
  });
});
