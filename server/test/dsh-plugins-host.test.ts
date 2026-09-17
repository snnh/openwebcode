/**
 * dsh 兼容层 M2 集成测试：安装 → 启用 → 工具注入 → 宿主调用 → 停用回滚全链路。
 * 真实 fork Extension Host 子进程，插件代码经 ESM 垫片解析钩子 import 本目录垫片。
 */
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionManager } from "../src/extensions/extension-manager.js";
import { dshPluginsRoot, saveDshPluginConfig, setDshPluginEnabled } from "../src/dsh/loader.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/dsh-plugins", import.meta.url));

let dataDir: string;
let manager: ExtensionManager;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "owc-dsh-host-"));
  await cp(FIXTURES, dshPluginsRoot(dataDir), { recursive: true });
  await saveDshPluginConfig(dataDir, {
    version: 1,
    plugins: {
      "tool-hello": { enabled: true, config: { suffix: "!" } },
      "config-fail": { enabled: true, config: { port: "nope" } },
    },
  });
  manager = new ExtensionManager(dataDir);
  await manager.initialize();
});

afterEach(async () => {
  await manager.close();
});

describe("dsh 插件宿主集成", () => {
  it("扫描 → 宿主加载：逐插件状态与兼容结论如实上报", async () => {
    const infos = await manager.syncDsh();
    const byId = new Map(infos.map((info) => [info.id, info]));

    expect(byId.get("hello")).toMatchObject({ status: "running", enabled: true, tools: [] });
    expect(byId.get("tool-hello")).toMatchObject({ status: "running", tools: ["hello_fail", "hello_greet"] });
    expect(byId.get("client-probe")).toMatchObject({ status: "running", clientEntry: "client.js" });
    // Config 校验失败：插件隔离为 error，其余插件不受影响
    expect(byId.get("config-fail")?.status).toBe("error");
    expect(byId.get("config-fail")?.error).toContain("config validation failed");
    // inject 的服务翻译层未提供：保持未激活并列出缺失服务
    expect(byId.get("missing-service")).toMatchObject({ status: "missing-services", missing: ["fs"] });
    // 版本不兼容 / 清单非法：不加载
    expect(byId.get("incompatible-dep")?.status).toBe("incompatible");
    expect(byId.get("incompatible-dep")?.error).toContain("@deepseek-ai/dsh-session");
    expect(byId.get("broken-entry")?.status).toBe("error");

    // 聚合结果与 dshPlugins() 一致
    expect(manager.dshPlugins()).toEqual(infos);
  });

  it("工具注入：伪扩展 id 进工具表，描述与超时预算透传", async () => {
    await manager.syncDsh();
    const tools = manager.registeredTools().filter((tool) => tool.name.startsWith("ext__dsh-"));
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "ext__dsh-hook-gate__gate_check",
      "ext__dsh-tool-hello__hello_fail",
      "ext__dsh-tool-hello__hello_greet",
    ]);
    const greet = tools.find((tool) => tool.name === "ext__dsh-tool-hello__hello_greet");
    expect(greet?.description).toContain("tool-hello");
    expect(greet?.inputSchema).toMatchObject({ type: "object", required: ["who"] });
    // timeoutMs 进 spec → 服务端 IPC 超时按声明放宽（缺省 5s）
    const specs = (manager as unknown as { extensionTools: Map<string, Map<string, { timeoutMs?: number }>> }).extensionTools;
    expect(specs.get("dsh-tool-hello")?.get("hello_greet")?.timeoutMs).toBe(7000);
    expect(specs.get("dsh-hook-gate")?.get("gate_check")?.timeoutMs).toBeUndefined();
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "world" })).resolves.toEqual({ content: "hello, world!" });
  });

  it("工具执行语义：抛错 → isError、参数违规 → INVALID_ARGS 文案", async () => {
    await manager.syncDsh();
    const failed = await manager.invokeTool("ext__dsh-tool-hello__hello_fail", {});
    expect(failed).toEqual({ content: "boom from fixture", isError: true });

    const invalid = await manager.invokeTool("ext__dsh-tool-hello__hello_greet", {});
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain("invalid arguments");
    expect(invalid.content).toContain("who");

    await expect(manager.invokeTool("ext__dsh-tool-hello__nope", {})).rejects.toThrow(/Unknown extension tool/);
  });

  it("事件钩子：tools/pre-execute 瀑布在插件 ctx 上生效（deny 短路 / 放行）", async () => {
    await manager.syncDsh();
    const blocked = await manager.invokeTool("ext__dsh-hook-gate__gate_check", { tool: "blocked_tool" });
    expect(JSON.parse(blocked.content)).toEqual({ kind: "deny", reason: "该工具在本插件中被禁止" });

    const allowed = await manager.invokeTool("ext__dsh-hook-gate__gate_check", { tool: "other_tool" });
    expect(JSON.parse(allowed.content)).toEqual({ kind: "allow", reason: "" });
  });

  it("停用回滚：插件卸载 → 工具摘除、调用被拒，其它插件不受影响", async () => {
    await manager.syncDsh();
    await setDshPluginEnabled(dataDir, "tool-hello", false);
    const infos = await manager.syncDsh();
    const byId = new Map(infos.map((info) => [info.id, info]));

    expect(byId.get("tool-hello")).toMatchObject({ status: "disabled", enabled: false });
    expect(byId.get("hello")?.status).toBe("running");
    expect(manager.registeredTools().filter((tool) => tool.name.startsWith("ext__dsh-tool-hello__"))).toEqual([]);
    // 工具已从表里摘除：调用被拒（unknown 或 disabled 都表示不可达）
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "world" })).rejects.toThrow(/Unknown extension tool|disabled/);
    // 钩子插件的工具仍在（停用是逐插件的）
    await expect(manager.invokeTool("ext__dsh-hook-gate__gate_check", { tool: "other_tool" })).resolves.toBeDefined();

    // 重新启用：加载计划重放，工具回滚可逆
    await setDshPluginEnabled(dataDir, "tool-hello", true);
    await manager.syncDsh();
    await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "again" })).resolves.toEqual({ content: "hello, again!" });
  });

  it("宿主重启后自动重放加载计划（dsh 插件随之重新激活）", async () => {
    await manager.syncDsh();
    expect(manager.registeredTools().filter((tool) => tool.name.startsWith("ext__dsh-")).length).toBe(3);
    // 模拟宿主崩溃退出：重启路径重新 initialize 并重放 dsh 计划（工具表与插件一起回来）
    const internals = manager as unknown as { child?: { connected: boolean; kill(): void } };
    internals.child?.kill();
    await vi.waitFor(async () => {
      expect(internals.child?.connected).toBe(true);
      await expect(manager.invokeTool("ext__dsh-tool-hello__hello_greet", { who: "restart" })).resolves.toEqual({ content: "hello, restart!" });
    }, { timeout: 20_000 });
    expect(manager.registeredTools().filter((tool) => tool.name.startsWith("ext__dsh-")).length).toBe(3);
  });
});
