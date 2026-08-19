import { readFile } from "node:fs/promises";
import path from "node:path";

interface McpServerStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpServerHttpConfig {
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig;

export const isHttpConfig = (config: McpServerConfig): config is McpServerHttpConfig => "url" in config;

export interface McpConfigResult {
  servers: Record<string, McpServerConfig>;
  /** 配置文件中形状非法被跳过的条目（name + 原因）。 */
  skipped: string[];
}

function validate(value: unknown): McpServerConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.url === "string" && record.url !== "") {
    return { url: record.url, ...(record.headers && typeof record.headers === "object" ? { headers: record.headers as Record<string, string> } : {}) };
  }
  if (typeof record.command === "string" && record.command !== "") {
    return {
      command: record.command,
      ...(Array.isArray(record.args) ? { args: record.args.map(String) } : {}),
      ...(record.env && typeof record.env === "object" ? { env: record.env as Record<string, string> } : {}),
      ...(typeof record.cwd === "string" ? { cwd: record.cwd } : {}),
    };
  }
  return undefined;
}

async function readConfigFile(filePath: string, result: McpConfigResult): Promise<void> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return; // 文件不存在或 JSON 损坏：当作无配置（损坏情况由 mcp.degraded 告警暴露的是连接错误，解析错误这里静默）
  }
  const servers = (parsed as { mcpServers?: unknown })?.mcpServers;
  if (!servers || typeof servers !== "object") return;
  for (const [name, value] of Object.entries(servers)) {
    const config = validate(value);
    if (config) result.servers[name] = config;
    else result.skipped.push(name);
  }
}

/**
 * 加载 MCP 配置：全局 <dataDir>/mcp.json + 项目级 <cwd>/.owc/mcp.json。
 * 项目级覆盖同名全局 server（与 claude code 的约定一致）。
 */
export async function loadMcpConfig(dataDir: string, cwd?: string): Promise<McpConfigResult> {
  const result: McpConfigResult = { servers: {}, skipped: [] };
  await readConfigFile(path.join(dataDir, "mcp.json"), result);
  if (cwd) await readConfigFile(path.join(cwd, ".owc", "mcp.json"), result);
  return result;
}
