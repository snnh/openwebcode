/**
 * dsh 宿主运行时单测（进程内，不 fork Extension Host）：插件 ctx 的服务视图绑定与订阅回收。
 *
 * 覆盖两个已确认缺陷：
 * - D4：`dshEvents` 订阅键口径必须与卸载一致（否则卸载不回收 → 重激活叠加 handler，事件重复触发）；
 * - D5：服务缝（storage/llm/sessions）必须按插件绑定来源 id，激活窗口之外的调用
 *   （工具执行、事件 handler、timer 回调）也要落到调用方插件自己的隔离目录。
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDshHostRuntime, type DshHostRuntime } from "../src/dsh/host-runtime.js";
import type { DshSyncItem } from "../src/dsh/loader.js";

const runtimes: DshHostRuntime[] = [];
const fixtureRoots: string[] = [];

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()?.dispose();
  while (fixtureRoots.length > 0) await rm(fixtureRoots.pop() as string, { recursive: true, force: true });
});

/** 写一个只依赖 ctx 的 dsh 插件包（不 import @deepseek-ai/*，因此不依赖垫片解析钩子）。 */
async function pluginPackage(id: string, body: string): Promise<string> {
  const root = fixtureRoots[0] ?? (await mkdtemp(path.join(tmpdir(), "owc-dsh-host-rt-")));
  if (fixtureRoots.length === 0) fixtureRoots.push(root);
  const directory = path.join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "package.json"), JSON.stringify({ name: id, version: "1.0.0", main: "index.js" }));
  await writeFile(path.join(directory, "index.js"), body);
  return directory;
}

function syncItem(id: string, directory: string): DshSyncItem {
  return { id, name: id, version: "1.0.0", directory, entry: "index.js", config: {} };
}

/** 记录宿主能力调用的假 bridge。 */
function recordingBridge(): { calls: Array<{ extensionId: string; api: string; params?: Record<string, unknown> }>; bridge: Parameters<typeof createDshHostRuntime>[0] } {
  const calls: Array<{ extensionId: string; api: string; params?: Record<string, unknown> }> = [];
  return {
    calls,
    bridge: {
      log: () => {},
      publish: () => {},
      call: async (extensionId, api, params) => {
        calls.push({ extensionId, api, ...(params === undefined ? {} : { params }) });
        if (api === "storage.write") return { bytes: 1 };
        if (api === "storage.list") return { files: [] };
        if (api === "storage.read") return { content: null };
        return {};
      },
    },
  };
}

/** 插件体：注册 `probe` 工具（写自己的 storage）+ 订阅 dshEvents（handler 也写自己的 storage）。 */
const PROBE_PLUGIN = (marker: string): string => `
export const name = ${JSON.stringify(marker)};
export function apply(ctx) {
  const storage = ctx.get("storage");
  ctx.tools.register({
    name: "probe",
    description: "写入自己的存储目录",
    parameters: {},
    output: { schema: { type: "json" }, render: () => [{ type: "text", text: "ok" }] },
    execute: async () => { await storage.write("note.txt", ${JSON.stringify(marker)}); return { ok: true }; },
  });
  ctx.dshEvents.subscribe(["agent.state"], () => { void storage.write("events.txt", ${JSON.stringify(marker)}); });
}
`;

describe("dsh 宿主运行时（服务缝绑定与订阅回收）", () => {
  it("D5：两个插件的服务缝调用分别落到 dsh-<id>（工具执行与事件 handler 都在激活窗口之外）", async () => {
    const { bridge, calls } = recordingBridge();
    const runtime = createDshHostRuntime(bridge);
    runtimes.push(runtime);
    const alpha = await pluginPackage("plugin-alpha", PROBE_PLUGIN("alpha"));
    const beta = await pluginPackage("plugin-beta", PROBE_PLUGIN("beta"));
    const reports = await runtime.sync([syncItem("plugin-alpha", alpha), syncItem("plugin-beta", beta)]);
    expect(reports.map((report) => [report.id, report.status])).toEqual([["plugin-alpha", "running"], ["plugin-beta", "running"]]);

    // 工具执行（激活窗口外）
    await runtime.invoke("dsh-plugin-alpha", "probe", {});
    await runtime.invoke("dsh-plugin-beta", "probe", {});
    expect(calls.filter((call) => call.api === "storage.write").map((call) => [call.extensionId, call.params?.path]))
      .toEqual([["dsh-plugin-alpha", "note.txt"], ["dsh-plugin-beta", "note.txt"]]);

    // dshEvents handler（激活窗口外）：按 sourceId 派发，写到自己插件的目录
    runtime.dispatchEvent("dsh-plugin-alpha", { type: "agent.state", payload: { state: "idle" } });
    expect(calls.filter((call) => call.api === "storage.write").at(-1)).toEqual({ extensionId: "dsh-plugin-alpha", api: "storage.write", params: { path: "events.txt", content: "alpha" } });
  });

  it("D4：卸载真正回收 dshEvents 订阅，重激活不叠加 handler", async () => {
    const { bridge } = recordingBridge();
    const runtime = createDshHostRuntime(bridge);
    runtimes.push(runtime);
    const id = "plugin-events";
    const directory = await pluginPackage(id, `
export const name = "plugin-events";
export function apply(ctx) {
  ctx.dshEvents.subscribe(["agent.state"], () => { globalThis.__dshHits = (globalThis.__dshHits ?? 0) + 1; });
}
`);
    const globals = globalThis as unknown as { __dshHits?: number };
    globals.__dshHits = 0;

    await runtime.sync([syncItem(id, directory)]);
    runtime.dispatchEvent(`dsh-${id}`, { type: "agent.state", payload: {} });
    runtime.dispatchEvent(`dsh-${id}`, { type: "tool.start", payload: {} });
    expect(globals.__dshHits).toBe(1);

    await runtime.sync([]);
    runtime.dispatchEvent(`dsh-${id}`, { type: "agent.state", payload: {} });
    expect(globals.__dshHits).toBe(1);

    await runtime.sync([syncItem(id, directory)]);
    runtime.dispatchEvent(`dsh-${id}`, { type: "agent.state", payload: {} });
    // 修复前：旧订阅未回收 + 新订阅 → 这里会变成 2（累计 3）
    expect(globals.__dshHits).toBe(2);
    delete globals.__dshHits;
  });

  it("未绑定服务视图时（缺 call）插件仍可注册工具：ctx.get('tools') 可用", async () => {
    const runtime = createDshHostRuntime({ log: () => {}, publish: () => {} });
    runtimes.push(runtime);
    const directory = await pluginPackage("plugin-tools", `
export const name = "plugin-tools";
export function apply(ctx) {
  ctx.tools.register({
    name: "ping",
    description: "ping",
    parameters: {},
    output: { schema: { type: "json" }, render: () => [{ type: "text", text: "pong" }] },
    execute: async () => ({ ok: true }),
  });
}
`);
    const reports = await runtime.sync([syncItem("plugin-tools", directory)]);
    expect(reports[0]).toMatchObject({ id: "plugin-tools", status: "running", tools: ["ping"] });
    await expect(runtime.invoke("dsh-plugin-tools", "ping", {})).resolves.toEqual({ content: "pong" });
  });
});
