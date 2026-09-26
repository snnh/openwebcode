/** dsh 宿主运行时单测（进程内，不 fork）：服务缝按插件绑定来源 id（D5：激活窗口之外的工具执行与
 * 事件 handler 也落回调用方插件目录）与 dshEvents 订阅回收（D4：卸载真正回收，否则重激活叠加 handler）。 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDshHostRuntime, type DshHostRuntime } from "../src/dsh/host-runtime.js";
import type { DshSyncItem } from "../src/dsh/loader.js";

const runtimes: DshHostRuntime[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.dispose();
  while (roots.length > 0) await rm(roots.pop() as string, { recursive: true, force: true });
});

/** 写一个只依赖 ctx 的 dsh 插件包（不 import @deepseek-ai/*，因此不依赖垫片解析钩子）。 */
async function pluginPackage(id: string, register: string, subscribe = ""): Promise<string> {
  if (roots.length === 0) roots.push(await mkdtemp(path.join(tmpdir(), "owc-dsh-host-rt-")));
  const directory = path.join(roots[0] as string, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: id, version: "1.0.0", main: "index.js" }));
  await writeFile(path.join(directory, "index.js"), `export const name = ${JSON.stringify(id)};\nexport function apply(ctx) {\n${register}\n${subscribe}\n}\n`);
  return directory;
}
const syncItem = (id: string, directory: string): DshSyncItem => ({ id, name: id, version: "1.0.0", directory, entry: "index.js", config: {} });
const OUTPUT = '{ schema: { type: "json" }, render: () => [{ type: "text", text: "ok" }] }';
/** `probe` 工具：写自己的 storage；dshEvents handler 也写自己的 storage。 */
const probe = (marker: string) => ({
  register: `  const storage = ctx.get("storage");\n  ctx.tools.register({ name: "probe", description: "写入自己的存储目录", parameters: {}, output: ${OUTPUT}, execute: async () => { await storage.write("note.txt", ${JSON.stringify(marker)}); return { ok: true }; } });`,
  subscribe: `  ctx.dshEvents.subscribe(["agent.state"], () => { void storage.write("events.txt", ${JSON.stringify(marker)}); });`,
});
const PING = `  ctx.tools.register({ name: "ping", description: "ping", parameters: {}, output: { schema: { type: "json" }, render: () => [{ type: "text", text: "pong" }] }, execute: async () => ({ ok: true }) });`;
/** 记录宿主能力调用的假 bridge（`withCall=false` 模拟未绑定服务视图）。 */
function recordingBridge(withCall = true) {
  const calls: Array<{ extensionId: string; api: string; params?: Record<string, unknown> }> = [];
  const bridge: Parameters<typeof createDshHostRuntime>[0] = { log: () => {}, publish: () => {}, ...(withCall ? {
    call: async (extensionId: string, api: string, params?: Record<string, unknown>) => {
      calls.push({ extensionId, api, ...(params === undefined ? {} : { params }) });
      return api === "storage.write" ? { bytes: 1 } : api === "storage.list" ? { files: [] } : api === "storage.read" ? { content: null } : {};
    },
  } : {}) };
  return { calls, bridge };
}
const host = (withCall = true) => {
  const { calls, bridge } = recordingBridge(withCall);
  const runtime = createDshHostRuntime(bridge);
  runtimes.push(runtime);
  return { calls, runtime };
};

describe("dsh 宿主运行时（服务缝绑定与订阅回收）", () => {
  it("D5：两个插件的服务缝调用分别落到 dsh-<id>（工具执行与事件 handler 都在激活窗口之外）", async () => {
    const { calls, runtime } = host();
    const alpha = probe("alpha");
    const beta = probe("beta");
    const reports = await runtime.sync([
      syncItem("plugin-alpha", await pluginPackage("plugin-alpha", alpha.register, alpha.subscribe)),
      syncItem("plugin-beta", await pluginPackage("plugin-beta", beta.register, beta.subscribe)),
    ]);
    expect(reports.map((report) => [report.id, report.status])).toEqual([["plugin-alpha", "running"], ["plugin-beta", "running"]]);
    await runtime.invoke("dsh-plugin-alpha", "probe", {}); await runtime.invoke("dsh-plugin-beta", "probe", {});
    expect(calls.filter((call) => call.api === "storage.write").map((call) => [call.extensionId, call.params?.path]))
      .toEqual([["dsh-plugin-alpha", "note.txt"], ["dsh-plugin-beta", "note.txt"]]);
    // dshEvents handler（激活窗口外）：按 sourceId 派发，写到自己插件的目录
    runtime.dispatchEvent("dsh-plugin-alpha", { type: "agent.state", payload: { state: "idle" } });
    expect(calls.filter((call) => call.api === "storage.write").at(-1))
      .toEqual({ extensionId: "dsh-plugin-alpha", api: "storage.write", params: { path: "events.txt", content: "alpha" } });
  });
  it("D4：卸载真正回收 dshEvents 订阅（重激活不叠加 handler）", async () => {
    const { runtime } = host();
    const id = "plugin-events";
    const directory = await pluginPackage(id, "", `  ctx.dshEvents.subscribe(["agent.state"], () => { globalThis.__dshHits = (globalThis.__dshHits ?? 0) + 1; });`);
    const globals = globalThis as unknown as { __dshHits?: number };
    globals.__dshHits = 0;
    const hit = () => runtime.dispatchEvent(`dsh-${id}`, { type: "agent.state", payload: {} });
    await runtime.sync([syncItem(id, directory)]);
    hit();
    runtime.dispatchEvent(`dsh-${id}`, { type: "tool.start", payload: {} }); // 未订阅的事件不计数
    expect(globals.__dshHits).toBe(1);
    await runtime.sync([]);
    hit();
    expect(globals.__dshHits).toBe(1); // 卸载后不再派发
    await runtime.sync([syncItem(id, directory)]);
    hit();
    expect(globals.__dshHits).toBe(2); // 修复前：旧订阅未回收 → 累计 3
    delete globals.__dshHits;
  });
  it("未绑定服务视图时（缺 call）插件仍可注册并调用工具：ctx.get('tools') 可用", async () => {
    const { runtime } = host(false);
    const reports = await runtime.sync([syncItem("plugin-tools", await pluginPackage("plugin-tools", PING))]);
    expect(reports[0]).toMatchObject({ id: "plugin-tools", status: "running", tools: ["ping"] });
    await expect(runtime.invoke("dsh-plugin-tools", "ping", {})).resolves.toEqual({ content: "pong" });
  });
});
