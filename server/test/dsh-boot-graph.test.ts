/** dsh vendor 清单 / boot graph 生成 / index 注入渲染单测（M4 纯逻辑部分）。 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
// prettier-ignore
import { DSH_MODULES_ID, bootInjections, buildBootGraph, loadVendorManifest, pluginUrl, renderIndexInjections, type DshVendorPlugin } from "../src/dsh/web-protocol/boot-graph.js";

const INDEX_HTML = '<!doctype html>\n<html><head><meta charset="utf-8" /><script type="module" crossorigin src="./assets/index-abc.js"></script></head><body><div id="root"></div></body></html>\n';
const plugin = (id: string, extra: Partial<DshVendorPlugin> = {}): DshVendorPlugin =>
  ({ id, version: "0.1.6-alpha.2", rev: "0123456789ab", entry: "client.js", files: ["client.js"], inject: [], external: [], ...extra });
/** 两条插件的最小图：模块系统 + 一个普通包。 */
const baseGraph = () => buildBootGraph([plugin(DSH_MODULES_ID), plugin("a")]);

describe("dsh vendor 清单与 boot graph", () => {
  it("清单加载：缺文件 / 版本不符返回 undefined，合法清单读回", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "owc-dsh-vendor-"));
    const write = (body: unknown) => writeFile(path.join(directory, "manifest.json"), JSON.stringify(body));
    expect(await loadVendorManifest(directory)).toBeUndefined();
    await write({ version: 2, plugins: [] });
    expect(await loadVendorManifest(directory)).toBeUndefined();
    await write({ version: 1, dshVersion: "0.1.6-alpha.2", registry: "https://r", generatedAt: "t", frontend: { files: 1, rev: "x" }, plugins: [plugin("a")] });
    expect(await loadVendorManifest(directory)).toMatchObject({ version: 1, dshVersion: "0.1.6-alpha.2", plugins: [{ id: "a" }] });
  });

  it("graph：bootstrap 只含模块系统、其余进 application、entry 字段按需省略、rev 顺序无关", () => {
    const graph = buildBootGraph([
      plugin(DSH_MODULES_ID, { immediately: true }),
      plugin("@deepseek-ai/dsh-client-ui-chat", { inject: ["@deepseek-ai/dsh-client-modules"], external: ["@deepseek-ai/dsh-api-gateway/client"] }),
      plugin("owc-dsh-bridge"),
    ]);
    expect(graph.batches.map((batch) => [batch.phase, batch.entries])).toEqual([
      ["bootstrap", [DSH_MODULES_ID]],
      ["application", ["@deepseek-ai/dsh-client-ui-chat"]],
      ["application", ["owc-dsh-bridge"]],
    ]);
    const byId = (id: string) => graph.entries.find((entry) => entry.id === id);
    expect(byId("@deepseek-ai/dsh-client-ui-chat")).toMatchObject({
      url: pluginUrl("@deepseek-ai/dsh-client-ui-chat", "client.js", "0123456789ab"),
      rev: "0123456789ab",
      inject: ["@deepseek-ai/dsh-client-modules"],
      external: ["@deepseek-ai/dsh-api-gateway/client"],
    });
    expect(byId("owc-dsh-bridge")?.inject).toBeUndefined(); // 无 inject/external 者不带这些键
    expect(byId(DSH_MODULES_ID)?.immediately).toBe(true);
    expect(() => buildBootGraph([plugin("a")])).toThrow(/dsh-client-modules/); // 早失败优于半启动
    expect(buildBootGraph([plugin("b"), plugin(DSH_MODULES_ID), plugin("a")]).rev)
      .toBe(buildBootGraph([plugin("a"), plugin("b"), plugin(DSH_MODULES_ID)]).rev);
  });

  it("注入行：队列脚本 → application preload → bootstrap 阻塞脚本 → 图", () => {
    const rows = bootInjections(baseGraph());
    expect(rows.map((row) => row.kind)).toEqual(["script", "script-preload", "script-src", "global"]);
    expect(rows[1]).toEqual({ kind: "script-preload", src: "/plugins/a/client.js?rev=0123456789ab" });
    expect(rows[3]).toMatchObject({ kind: "global", name: "__DSH_BOOT__" });
    const queueText = (rows[0] as { text: string }).text;
    expect(queueText).toContain(`registration.id===${JSON.stringify(DSH_MODULES_ID)}`);
    expect(queueText).toContain("createClientModuleSystem");
  });

  it("index 注入：插入位置、尾标顺序、< 转义，无 head/body 片段也能插入", () => {
    const html = renderIndexInjections(INDEX_HTML, bootInjections(baseGraph()));
    // 队列脚本紧跟 <head>；preload 与 bootstrap 也在 head（模块 shell 之前解析执行）
    expect(html.slice(html.indexOf("<head>") + "<head>".length)).toMatch(/^<script>\(\(\)=>\{/);
    expect(html).toContain('window.__ModuleLoader__={');
    expect(html).toContain('<link rel="preload" as="script" href="/plugins/a/client.js?rev=0123456789ab">');
    expect(html).toContain("globalThis[\"__DSH_BOOT__\"]");
    expect(html.indexOf('<script src="/plugins/')).toBeLessThan(html.indexOf('<script type="module" crossorigin'));
    expect(html).toContain("<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>");
    expect(html.indexOf("__DSH_BOOT_READY__")).toBeLessThan(html.indexOf('<div id="root">'));

    const fragment = renderIndexInjections("<div>x</div>", [{ kind: "script", placement: "head", text: "1" }]);
    expect(fragment.startsWith("<script>1</script>")).toBe(true);
    // 图值里的 `<` 转义（防脚本元素提前闭合）
    const escaped = renderIndexInjections("<head></head>", [{ kind: "global", name: "__X__", value: { text: "</script>" } }]);
    expect(escaped).toContain("\\u003c/script>");
    expect(escaped).not.toContain("</script></script>");
  });
});
