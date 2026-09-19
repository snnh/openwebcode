/**
 * dsh SPA 自托管：boot graph 生成与 index 注入（M4 步骤 15）。
 *
 * 复刻上游 wire（`packages/client/modules/src/client/manifest.ts` 的 WebBootGraph/WebBootEntry/WebBootBatch）
 * 与注入渲染（`packages/host/webserver/src/injections.ts` 的 IndexInjection + renderIndexInjections）。
 * 差异：v1 每个 entry 单独一个 batch（单条 url），不实现 combo 拼接——协议允许 per-entry url，
 * 少一处拼接逻辑与 URL 长度上限处理（combo 仍可后续加，见 docs/dsh-protocol-map.md §5.4）。
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

/** vendor 清单（`scripts/fetch-dsh-web.mjs` 产出）。 */
export interface DshVendorPlugin {
  id: string;
  version: string;
  rev: string;
  entry: string;
  files: string[];
  inject: string[];
  external: string[];
  immediately?: boolean;
}

export interface DshVendorManifest {
  version: number;
  dshVersion: string;
  registry: string;
  generatedAt: string;
  frontend: { files: number; rev: string };
  plugins: DshVendorPlugin[];
}

/** 模块系统自身（bootstrap phase 的唯一成员；上游 CLIENT_MODULES_ID）。 */
export const DSH_MODULES_ID = "@deepseek-ai/dsh-client-modules";

/** boot graph wire。 */
export interface DshBootEntry {
  id: string;
  url: string;
  rev: string;
  inject?: string[];
  immediately?: boolean;
  external?: string[];
}

export interface DshBootBatch {
  phase: "bootstrap" | "application";
  url: string;
  rev: string;
  entries: string[];
}

export interface DshBootGraph {
  rev: string;
  entries: DshBootEntry[];
  batches: DshBootBatch[];
}

/** 结构化注入行（与上游 IndexInjection 同形）。 */
export type DshIndexInjection =
  | { kind: "global"; name: string; value: unknown }
  | { kind: "script"; placement: "head" | "body"; text: string }
  | { kind: "script-src"; placement: "head" | "body"; src: string }
  | { kind: "script-preload"; src: string }
  | { kind: "style"; text: string }
  | { kind: "html"; placement: "head" | "body"; html: string };

/** 读 vendor 清单；缺失返回 undefined（调用方据此如实报「未安装 dsh UI」）。 */
export async function loadVendorManifest(directory: string): Promise<DshVendorManifest | undefined> {
  try {
    const raw = await readFile(path.join(directory, "manifest.json"), "utf8");
    const parsed = JSON.parse(raw) as DshVendorManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.plugins)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

/** 插件 bundle 的 URL（单资源形态；`rev` 参与缓存失效）。 */
export function pluginUrl(id: string, entry: string, rev: string): string {
  return `/plugins/${id}/${entry}?rev=${rev}`;
}

/** graph rev：由各 entry rev 派生（稳定性用于客户端缓存与 HMR 判定锚点）。 */
function graphRev(plugins: readonly DshVendorPlugin[]): string {
  const seed = plugins.map((plugin) => `${plugin.id}@${plugin.rev}`).sort().join("|");
  // 与上游一致地用短哈希；这里用 FNV-1a 32 位十六进制（无 crypto 依赖、稳定可测）
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * 组装 boot graph：`bootstrap` phase 只含模块系统，其余（含 bridge 插件）进 `application`。
 * 缺模块系统时抛错（客户端会因缺少 bootstrap 而无法启动，早失败优于半启动）。
 */
export function buildBootGraph(plugins: readonly DshVendorPlugin[]): DshBootGraph {
  const modules = plugins.find((plugin) => plugin.id === DSH_MODULES_ID);
  if (modules === undefined) throw new Error(`dsh vendor 缺少 ${DSH_MODULES_ID}（无法生成 boot graph）`);
  const entries: DshBootEntry[] = plugins.map((plugin) => ({
    id: plugin.id,
    url: pluginUrl(plugin.id, plugin.entry, plugin.rev),
    rev: plugin.rev,
    ...(plugin.inject.length === 0 ? {} : { inject: [...plugin.inject] }),
    ...(plugin.immediately === true ? { immediately: true } : {}),
    ...(plugin.external.length === 0 ? {} : { external: [...plugin.external] }),
  }));
  const bootstrap: DshBootBatch = {
    phase: "bootstrap",
    url: pluginUrl(modules.id, modules.entry, modules.rev),
    rev: modules.rev,
    entries: [modules.id],
  };
  const application: DshBootBatch[] = plugins
    .filter((plugin) => plugin.id !== DSH_MODULES_ID)
    .map((plugin) => ({
      phase: "application" as const,
      url: pluginUrl(plugin.id, plugin.entry, plugin.rev),
      rev: plugin.rev,
      entries: [plugin.id],
    }));
  return { rev: graphRev(plugins), entries, batches: [bootstrap, ...application] };
}

/**
 * boot 注入行（复刻上游 `bootInjections`）：内联注册队列 → application preload →
 * bootstrap 阻塞脚本 → `__DSH_BOOT__` 图；队列表格顺序即执行顺序。
 */
export function bootInjections(graph: DshBootGraph): DshIndexInjection[] {
  const queue = MODULE_LOADER_QUEUE;
  const application = graph.batches.filter((batch) => batch.phase === "application");
  const bootstrap = graph.batches.filter((batch) => batch.phase === "bootstrap");
  const rows: DshIndexInjection[] = [{ kind: "script", placement: "head", text: queue }];
  for (const batch of application) rows.push({ kind: "script-preload", src: batch.url });
  for (const batch of bootstrap) rows.push({ kind: "script-src", placement: "head", src: batch.url });
  rows.push({ kind: "global", name: "__DSH_BOOT__", value: graph });
  return rows;
}

/**
 * `window.__ModuleLoader__` 队列 facade（逐字复刻上游文本：`create()` 从队列里取
 * 模块系统 bundle 并委托它构造），`${CLIENT_MODULES_ID}` 已内联为实际包名。
 */
const MODULE_LOADER_QUEUE = `(()=>{
const pendingQueue=[]
window.__ModuleLoader__={
  mode:"queue",
  pendingQueue,
  load(registration){pendingQueue.push(registration)},
  create(options){
    if(this.mode!=="queue")throw new Error("client-modules: window.__ModuleLoader__.create called after module-system boot")
    const index=pendingQueue.findIndex(registration=>registration.id===${JSON.stringify(DSH_MODULES_ID)})
    const registration=pendingQueue[index]
    if(registration===undefined)throw new Error("client-modules: HTML did not preload ${DSH_MODULES_ID}/client.js")
    pendingQueue.splice(index,1)
    const exports=registration.factory(specifier=>{
      throw new Error('client-modules: ${DSH_MODULES_ID}/client.js requested external "'+specifier+'" before the module system existed')
    })
    if(typeof exports!=="object"||exports===null||typeof exports.createClientModuleSystem!=="function"||typeof exports.apply!=="function"){
      throw new Error("client-modules: ${DSH_MODULES_ID}/client.js did not export the bootstrap module face")
    }
    return exports.createClientModuleSystem(this,{id:registration.id,exports},options)
  }
}
})()`;

/** boot 就绪尾标（上游 READY_MARKUP）。 */
const READY_MARKUP = "<script>(globalThis.__DSH_BOOT_READY__ ??= Promise.withResolvers()).resolve()</script>";

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** 单行渲染（与上游 renderRow 一致）。 */
function renderRow(row: DshIndexInjection): { placement: "head" | "body"; markup: string } {
  switch (row.kind) {
    case "global": {
      const name = JSON.stringify(row.name).replaceAll("<", "\\u003c");
      const value = row.value === undefined ? "undefined" : JSON.stringify(row.value).replaceAll("<", "\\u003c");
      return { placement: "head", markup: `<script>globalThis[${name}] = ${value}</script>` };
    }
    case "script":
      return { placement: row.placement, markup: `<script>${row.text}</script>` };
    case "script-src":
      return { placement: row.placement, markup: `<script src="${escapeHtmlAttribute(row.src)}"></script>` };
    case "script-preload":
      return { placement: "head", markup: `<link rel="preload" as="script" href="${escapeHtmlAttribute(row.src)}">` };
    case "style":
      return { placement: "head", markup: `<style>${row.text}</style>` };
    case "html":
      return { placement: row.placement, markup: row.html };
  }
}

function splice(html: string, at: number, markup: string): string {
  return `${html.slice(0, at)}${markup}${html.slice(at)}`;
}

/** 把注入行渲染进 index.html（head 行紧跟 `<head>`，body 行紧跟 `<body>`，尾标追加）。 */
export function renderIndexInjections(html: string, rows: readonly DshIndexInjection[]): string {
  let head = "";
  let body = "";
  for (const row of rows) {
    const rendered = renderRow(row);
    if (rendered.placement === "head") head += rendered.markup;
    else body += rendered.markup;
  }
  body += READY_MARKUP;
  let out = html;
  if (head !== "") {
    const open = /<head(?:\s[^>]*)?>/i.exec(out);
    out = open === null ? `${head}${out}` : splice(out, open.index + open[0].length, head);
  }
  if (body !== "") {
    const open = /<body(?:\s[^>]*)?>/i.exec(out);
    out = open === null ? `${out}${body}` : splice(out, open.index + open[0].length, body);
  }
  return out;
}
