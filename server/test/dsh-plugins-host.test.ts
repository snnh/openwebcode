/** dsh 兼容层 M2 集成：安装 → 启用 → 工具注入 → 宿主调用 → 停用/崩溃重放。
 * 真实 fork Extension Host 子进程，插件代码经 ESM 垫片解析钩子 import 本目录垫片。 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { dshPluginsRoot, saveDshPluginConfig, setDshPluginEnabled } from "../src/dsh/loader.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-plugins", import.meta.url));
const dshTools = (manager: ExtensionManager) => manager.registeredTools().filter((tool) => tool.name.startsWith("ext__dsh-")).map((tool) => tool.name).sort();

describe("dsh 插件宿主集成", () => {
  let dataDir: string;
  let manager: ExtensionManager;
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), "owc-dsh-host-"));
    await cp(FIXTURES, dshPluginsRoot(dataDir), { recursive: true });
    await saveDshPluginConfig(dataDir, { version: 1, plugins: { "tool-hello": { enabled: true, config: { suffix: "!" } }, "config-fail": { enabled: true, config: { port: "nope" } } } });
    manager = new ExtensionManager(dataDir);
    await manager.initialize();
  });
  afterEach(() => manager.close());
  it("扫描 → 宿主加载：逐插件状态与兼容结论如实上报，聚合结果与 dshPlugins() 一致", async () => {
    const infos = await manager.syncDsh();
    const byId = new Map(infos.map((info) => [info.id, info]));
    expect(byId.get("hello")).toMatchObject({ status: "running", enabled: true, tools: [] });
    expect(byId.get("tool-hello")).toMatchObject({ status: "running", tools: ["hello_fail", "hello_greet"] });
    expect(byId.get("client-probe")).toMatchObject({ status: "running", clientEntry: "client.js" });
    // Config 校验失败：插件隔离为 error、其余不受影响；缺服务如实列出；版本不兼容/入口坏不加载
    expect(byId.get("config-fail")?.error).toContain("config validation failed");
    expect(byId.get("missing-service")).toMatchObject({ status: "missing-services", missing: ["fs"] });
    expect(byId.get("incompatible-dep")?.error).toContain("@deepseek-ai/dsh-session");
    expect([byId.get("config-fail")?.status, byId.get("hello")?.status, byId.get("incompatible-dep")?.status, byId.get("broken-entry")?.status]).toEqual(["error", "running", "incompatible", "error"]);
    expect(manager.dshPlugins()).toEqual(infos);
  });
  it("工具注入与执行语义 + 事件钩子：伪扩展 id 进表、描述/超时预算透传、pre-execute 瀑布生效", async () => {
    await manager.syncDsh();
    expect(dshTools(manager)).toEqual([
      "ext__dsh-hook-gate__gate_check",
      "ext__dsh-tool-hello__hello_fail",
      "ext__dsh-tool-hello__hello_greet",
    ]);
    const greet = manager.registeredTools().find((tool) => tool.name === "ext__dsh-tool-hello__hello_greet");
    expect(greet).toMatchObject({ inputSchema: { type: "object", required: ["who"] }, description: expect.stringContaining("tool-hello") });
    // timeoutMs 进 spec → 服务端 IPC 超时按声明放宽（缺省 5s）
    const specs = (manager as unknown as { extensionTools: Map<string, Map<string, { timeoutMs?: number }>> }).extensionTools;
    expect([specs.get("dsh-tool-hello")?.get("hello_greet")?.timeoutMs, specs.get("dsh-hook-gate")?.get("gate_check")?.timeoutMs]).toEqual([7000, undefined]);
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "world" })).resolves.toEqual({ content: "hello, world!" });
    // 抛错 → isError；参数违规 → INVALID_ARGS 文案；未知工具 → 拒绝
    expect(await manager.invokeTool("ext__dsh-tool-hello__hello_fail", {})).toEqual({ content: "boom from fixture", isError: true });
    const invalid = await manager.invokeTool("ext__dsh-tool-hello__hello_greet", {});
    expect([invalid.isError, invalid.content.includes("invalid arguments"), invalid.content.includes("who")]).toEqual([true, true, true]);
    await expect(manager.invokeTool("ext__dsh-tool-hello__nope", {})).rejects.toThrow(/Unknown extension tool/);
    // tools/pre-execute 瀑布在插件 ctx 上生效：deny 短路 / 放行
    const gate = async (tool: string) => JSON.parse((await manager.invokeTool("ext__dsh-hook-gate__gate_check", { tool })).content);
    await expect(gate("blocked_tool")).resolves.toEqual({ kind: "deny", reason: "该工具在本插件中被禁止" });
    await expect(gate("other_tool")).resolves.toEqual({ kind: "allow", reason: "" });
  });
  it("停用回滚与模式开关：逐插件摘除工具、调用被拒，重启用/重开模式可逆装回", async () => {
    await manager.syncDsh();
    await setDshPluginEnabled(dataDir, "tool-hello", false);
    const byId = new Map((await manager.syncDsh()).map((info) => [info.id, info]));
    expect(byId.get("tool-hello")).toMatchObject({ status: "disabled", enabled: false });
    expect(byId.get("hello")?.status).toBe("running"); // 停用是逐插件的：钩子插件工具仍在
    expect(dshTools(manager)).toEqual(["ext__dsh-hook-gate__gate_check"]);
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "world" })).rejects.toThrow(/Unknown extension tool|disabled/);
    await setDshPluginEnabled(dataDir, "tool-hello", true); // 加载计划重放，可逆
    await manager.syncDsh();
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "again" })).resolves.toEqual({ content: "hello, again!" });

    // 模式开关：syncDsh(false) 下发空计划，插件全部卸载且状态如实标注原因
    const off = await manager.syncDsh(false);
    expect(off.every((info) => info.status === "disabled")).toBe(true);
    expect(off.find((info) => info.id === "tool-hello")?.error).toContain("dshCompatEnabled=false");
    expect(dshTools(manager)).toEqual([]);
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "world" })).rejects.toThrow(/Unknown extension tool|disabled/);
    await manager.syncDsh(true); // 重新开启：同一份计划可逆地装回来
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "back" })).resolves.toEqual({ content: "hello, back!" });
  });
  it("宿主崩溃重启：换新进程后重放加载计划；关闭态重启重放空计划（插件不被偷偷带回）", async () => {
    await manager.syncDsh();
    const internals = manager as unknown as { child?: { connected: boolean; pid?: number; kill(): void } };
    const oldPid = internals.child?.pid;
    internals.child?.kill();
    await vi.waitFor(async () => {
      expect(internals.child?.pid).not.toBe(oldPid);
      await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "restart" })).resolves.toEqual({ content: "hello, restart!" });
    }, { timeout: 20_000 });
    expect(dshTools(manager)).toHaveLength(3);
    await manager.syncDsh(false);
    const pidBeforeOff = internals.child?.pid;
    internals.child?.kill();
    await vi.waitFor(() => {
      expect(internals.child?.pid).not.toBe(pidBeforeOff);
      expect(dshTools(manager)).toEqual([]);
    }, { timeout: 20_000 });
  });
});
