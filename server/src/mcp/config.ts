import { lstat, readFile } from "node:fs/promises";
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

/** 项目 .owc 配置的路径安全判定：父目录与文件都必须是常规项且不是符号链接。 */
async function isPlainProjectConfig(filePath: string): Promise<boolean> {
  try {
    const [parent, entry] = await Promise.all([lstat(path.dirname(filePath)), lstat(filePath)]);
    return parent.isDirectory() && !parent.isSymbolicLink() && entry.isFile() && !entry.isSymbolicLink();
  } catch {
    return false;
  }
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
 * 项目级文件属执行入口配置（可声明任意待 spawn 命令），仅在调用方显式放行
 * （trustProjectExecConfig）时读取；缺省跳过，与 hooks.ts 的信任边界同口径。
 * `.owc` 或 mcp.json 是符号链接时也跳过，避免经链接读取工作区外的配置。
 */
export async function loadMcpConfig(dataDir: string, cwd?: string, options: { includeProject?: boolean } = {}): Promise<McpConfigResult> {
  const result: McpConfigResult = { servers: {}, skipped: [] };
  await readConfigFile(path.join(dataDir, "mcp.json"), result);
  if (cwd && options.includeProject === true) {
    const projectFile = path.join(cwd, ".owc", "mcp.json");
    // 与 hooks.ts 同口径：符号链接项目配置不以宿主身份读取。
    if (await isPlainProjectConfig(projectFile)) await readConfigFile(projectFile, result);
  }
  return result;
}
