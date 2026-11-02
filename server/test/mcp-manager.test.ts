import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tempRoot } from "./helpers/temp-roots.js";

// 只验证配置缓存/信任开关，不启动真实 MCP 子进程；每个 server 返回一个最小工具。
const mocks = vi.hoisted(() => {
  const close = vi.fn(async () => {});
  const connectMcpServer = vi.fn(async (name: string) => ({
    listTools: async () => [{ name: "echo", description: name }],
    callTool: async () => ({ content: [] }),
    close,
  }));
  return { close, connectMcpServer };
});
const { close } = mocks;
vi.mock("../src/mcp/client.js", () => ({ connectMcpServer: mocks.connectMcpServer }));

const { McpManager } = await import("../src/mcp/manager.js");

describe("McpManager 项目配置缓存", () => {
  it("信任开关热切换：开启后加载项目 server，关闭后移除并关闭其连接", async () => {
    const root = await tempRoot("owc-mcp-manager-");
    const cwd = path.join(root, "proj");
    await mkdir(path.join(cwd, ".owc"), { recursive: true });
    await writeFile(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { global: { command: "global-cmd" } } }));
    await writeFile(path.join(cwd, ".owc", "mcp.json"), JSON.stringify({ mcpServers: { project: { command: "project-cmd" } } }));

    let trusted = false;
    const manager = new McpManager(root, { projectExecConfigEnabled: () => trusted, sweepMs: 60_000 });
    try {
      const off = await manager.toolsFor(cwd);
      expect(off.tools.map((tool) => tool.name)).toEqual(["mcp__global__echo"]);

      trusted = true;
      const on = await manager.toolsFor(cwd);
      expect(on.tools.map((tool) => tool.name).sort()).toEqual(["mcp__global__echo", "mcp__project__echo"]);

      trusted = false;
      const again = await manager.toolsFor(cwd);
      expect(again.tools.map((tool) => tool.name)).toEqual(["mcp__global__echo"]);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
    }
  });
});
