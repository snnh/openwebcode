/** dsh boot graph 与 index 注入单测（M4 步骤 15 纯逻辑部分）。 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DSH_MODULES_ID,
  bootInjections,
  buildBootGraph,
  loadVendorManifest,
  pluginUrl,
  renderIndexInjections,
  type DshVendorPlugin,
} from "../src/dsh/web-protocol/boot-graph.js";

const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <script type="module" crossorigin src="./assets/index-abc.js"></script>
  </head>
  <body>
    <div id="root"></div>
  </body>
</html>
`;

function plugin(id: string, extra: Partial<DshVendorPlugin> = {}): DshVendorPlugin {
  return { id, version: "0.1.6-alpha.2", rev: "0123456789ab", entry: "client.js", files: ["client.js"], inject: [], external: [], ...extra };
}

describe("dsh vendor 清单", () => {
  it("读取合法清单；缺文件/版本不符返回 undefined", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "owc-dsh-vendor-"));
    expect(await loadVendorManifest(directory)).toBeUndefined();
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify({ version: 2, plugins: [] }));
    expect(await loadVendorManifest(directory)).toBeUndefined();
    const manifest = { version: 1, dshVersion: "0.1.6-alpha.2", registry: "https://r", generatedAt: "t", frontend: { files: 1, rev: "x" }, plugins: [plugin("a")] };
    await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
    expect(await loadVendorManifest(directory)).toMatchObject({ dshVersion: "0.1.6-alpha.2" });
  });
});

describe("dsh boot graph", () => {
  it("bootstrap 只含模块系统，其余进 application；entry 字段按需省略", () => {
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
    const chat = graph.entries.find((entry) => entry.id === "@deepseek-ai/dsh-client-ui-chat");
    expect(chat).toEqual({
      id: "@deepseek-ai/dsh-client-ui-chat",
      url: pluginUrl("@deepseek-ai/dsh-client-ui-chat", "client.js", "0123456789ab"),
      rev: "0123456789ab",
      inject: ["@deepseek-ai/dsh-client-modules"],
      external: ["@deepseek-ai/dsh-api-gateway/client"],
    });
    expect(graph.entries.find((entry) => entry.id === "owc-dsh-bridge")?.inject).toBeUndefined();
    expect(graph.entries.find((entry) => entry.id === DSH_MODULES_ID)?.immediately).toBe(true);
    // rev 稳定：同输入同输出，顺序无关
    expect(buildBootGraph([plugin("b"), plugin(DSH_MODULES_ID), plugin("a")]).rev).toBe(buildBootGraph([plugin("a"), plugin("b"), plugin(DSH_MODULES_ID)]).rev);
  });

  it("缺模块系统时抛错（早失败优于半启动）", () => {
    expect(() => buildBootGraph([plugin("a")])).toThrow(/dsh-client-modules/);
  });

  it("注入行顺序：队列脚本 → application preload → bootstrap 阻塞脚本 → 图", () => {
    const graph = buildBootGraph([plugin(DSH_MODULES_ID), plugin("a")]);
    const rows = bootInjections(graph);
    expect(rows.map((row) => row.kind)).toEqual(["script", "script-preload", "script-src", "global"]);
    expect(rows[1]).toEqual({ kind: "script-preload", src: "/plugins/a/client.js?rev=0123456789ab" });
    expect(rows[3]).toMatchObject({ kind: "global", name: "__DSH_BOOT__" });
    const queueText = (rows[0] as { text: string }).text;
    expect(queueText).toContain(`registration.id===${JSON.stringify(DSH_MODULES_ID)}`);
    expect(queueText).toContain("createClientModuleSystem");
  });
});

describe("dsh index 注入渲染", () => {
  it("head/body 行按表格顺序插入，尾标追加在 body 行之后", () => {
    const graph = buildBootGraph([plugin(DSH_MODULES_ID), plugin("a")]);
    const html = renderIndexInjections(INDEX_HTML, bootInjections(graph));
    const headIndex = html.indexOf("<head>") + "<head>".length;
    expect(html.slice(headIndex)).toMatch(/^<script>\(\(\)=>\{/);
    // 队列脚本在内联位置；preload 与 bootstrap 也都在 head（模块 shell 之前解析执行）
    expect(html).toContain('window.__ModuleLoader__={');
    expect(html).toContain('<link rel="preload" as="script" href="/plugins/a/client.js?rev=0123456789ab">');
    expect(html).toContain(`<script src="/plugins/${DSH_MODULES_ID}/client.js?rev=0123456789ab"></script>`);
    expect(html).toContain("globalThis[\"__DSH_BOOT__\"]");
    // bootstrap 阻塞脚本出现在模块 shell 标签之前（解析顺序保证 __ModuleLoader__ 就绪）
    expect(html.indexOf('<script src="/plugins/')).toBeLessThan(html.indexOf('<script type="module" crossorigin'));
    expect(html).toContain("<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>");
    expect(html.indexOf("__DSH_BOOT_READY__")).toBeLessThan(html.indexOf('<div id="root">'));
  });

  it("无 head/body 的片段也能插入（prepend/append）", () => {
    const html = renderIndexInjections("<div>x</div>", [{ kind: "script", placement: "head", text: "1" }]);
    expect(html.startsWith("<script>1</script>")).toBe(true);
    expect(html.endsWith("</script>")).toBe(true);
  });

  it("图值里的 `<` 被转义（防脚本元素提前闭合）", () => {
    const rows = [{ kind: "global" as const, name: "__X__", value: { text: "</script>" } }];
    const html = renderIndexInjections("<head></head>", rows);
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toContain("</script></script>");
  });
});
