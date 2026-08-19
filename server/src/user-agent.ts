import { getServerVersion } from "./version.js";

/**
 * User-Agent 的唯一出口：所有出站 HTTP 请求的 UA 统一经本模块解析。
 *
 * - `getUserAgent()`：当前生效 UA——env-sim 扩展开启「模拟出站 User-Agent」时
 *   返回所选预设的拟态值，否则返回官方默认 `owc/openwebcode{version}`。
 *   一般出站点（web 工具、LLM provider、MCP、模型目录、定价等）都走它。
 * - `getOfficialUserAgent()`：恒为官方 UA，不受模拟影响。更新检查/更新应用
 *   链路（GitHub release 查询、校验和、安装包下载）必须用它——即使模拟生效，
 *   也始终以产品官方身份访问 GitHub。
 *
 * 模拟覆盖由 env-sim 扩展的全局配置驱动（见 extension-manager.ts 的
 * applyUserAgentSimulation）；会话级 persona 覆盖不参与——出站请求没有会话
 * 上下文，全局覆盖会在并发会话间串扰。
 */

let simulatedUserAgent: string | null = null;

/**
 * Build the official User-Agent header value.
 * Format: `owc/openwebcode{version}` (e.g. `owc/openwebcode0.5.2`).
 */
function buildUserAgent(version: string): string {
  return `owc/openwebcode${version}`;
}

/**
 * The currently effective User-Agent for outbound HTTP requests:
 * the simulated persona UA when env-sim UA simulation is active, otherwise the
 * official `owc/openwebcode{version}`. Resolved lazily on every call so the
 * simulation toggle takes effect immediately.
 */
export function getUserAgent(): string {
  return simulatedUserAgent ?? buildUserAgent(getServerVersion());
}

/**
 * The official User-Agent, always `owc/openwebcode{version}` regardless of any
 * active UA simulation. Update-check/update-apply traffic must use this.
 */
export function getOfficialUserAgent(): string {
  return buildUserAgent(getServerVersion());
}

/**
 * Set or clear the simulated outbound User-Agent (null restores the official
 * default). Called by the env-sim extension (ExtensionManager) only; driven by
 * the extension's global config, never by session-level persona overrides.
 */
export function setSimulatedUserAgent(ua: string | null): void {
  simulatedUserAgent = ua;
}
