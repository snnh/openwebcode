/**
 * 出站代理：为全局 fetch（undici 实现）安装全局 dispatcher，覆盖模型 API、
 * 联网搜索/抓取、更新检测与在线更新等所有 Node 侧出站请求。
 *
 * 配置优先级：显式设置（server-settings.json 的 proxy* 字段，含 OWC_PROXY_* 环境覆盖）
 * > 环境变量（mode=env 时由 EnvHttpProxyAgent 现读 HTTPS_PROXY/HTTP_PROXY/NO_PROXY 及小写变体）。
 *
 * 代理 URL 可能含凭据：对外描述（日志/诊断）一律经 sanitizeProxyUrl 脱敏。
 */
import {
  Agent,
  EnvHttpProxyAgent,
  ProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  type Dispatcher,
} from "undici";

export type ProxyMode = "off" | "env" | "custom";

export interface ProxyConfig {
  mode: ProxyMode;
  httpProxy?: string;
  httpsProxy?: string;
  /** 逗号分隔的主机名/域名后缀例外列表；本机回环地址始终绕过代理 */
  noProxy?: string;
}

export interface ProxyApplyResult {
  mode: ProxyMode;
  /** 已脱敏（不含代理凭据）的生效描述，可安全写日志 */
  summary: string;
}

/**
 * dispatcher 操作面：测试注入 fake，避免触碰真实全局状态。
 * createOffDispatcher 返回「关闭代理」时要安装的 dispatcher（默认实现即进程启动时的原始 dispatcher）。
 */
export interface ProxyDispatcherControl {
  setGlobalDispatcher(dispatcher: Dispatcher): void;
  createOffDispatcher(): Dispatcher;
  createEnvDispatcher(): Dispatcher;
  /** 自建按目标分发的 dispatcher：shouldBypass 命中或 proxyFor 返回 undefined 时直连 */
  createRoutingDispatcher(
    shouldBypass: (origin: URL) => boolean,
    proxyFor: (origin: URL) => string | undefined,
  ): Dispatcher;
}

// 模块加载时（任何 apply 之前）捕获原始全局 dispatcher，供 off 模式恢复默认。
const originalDispatcher = getGlobalDispatcher();

const defaultControl: ProxyDispatcherControl = {
  setGlobalDispatcher: (dispatcher) => setGlobalDispatcher(dispatcher),
  createOffDispatcher: () => originalDispatcher,
  createEnvDispatcher: () => new EnvHttpProxyAgent(),
  createRoutingDispatcher: (shouldBypass, proxyFor) => {
    const direct = new Agent();
    const proxies = new Map<string, ProxyAgent>();
    return new Agent({
      factory: (origin) => {
        const url = typeof origin === "string" ? new URL(origin) : origin;
        const proxyUrl = shouldBypass(url) ? undefined : proxyFor(url);
        if (!proxyUrl) return direct;
        let agent = proxies.get(proxyUrl);
        if (!agent) {
          agent = new ProxyAgent(proxyUrl);
          proxies.set(proxyUrl, agent);
        }
        return agent;
      },
    });
  },
};

/** 代理解析前的 URL 校验：仅 http/https scheme；非法返回 undefined。 */
function validProxyUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return undefined;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? raw : undefined;
}

/** 脱敏代理 URL：保留 scheme 与 host，隐去用户名/密码；非法 URL 全遮。 */
export function sanitizeProxyUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    const auth = parsed.username || parsed.password ? "•••@" : "";
    return `${parsed.protocol}//${auth}${parsed.host}`;
  } catch {
    return "•••";
  }
}

/** 解析 noProxy 列表：逗号分隔，小写归一，去空项。 */
export function parseNoProxyList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") ||
    h === "::1" || h === "127.0.0.1" || h.startsWith("127.");
}

/**
 * noProxy 匹配：`*` 全绕过；精确主机；后缀域名（`example.com` 命中
 * `a.example.com`，前导 `.`/`*.` 写法等价）；本机回环地址始终绕过。
 */
export function shouldBypassProxy(hostname: string, noProxy: string[]): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isLoopbackHostname(h)) return true;
  for (const entry of noProxy) {
    if (entry === "*") return true;
    const token = entry.toLowerCase().replace(/^\*\./, "").replace(/^\./, "");
    if (!token) continue;
    if (h === token || h.endsWith(`.${token}`)) return true;
  }
  return false;
}

/**
 * 按配置安装全局 dispatcher，热生效；返回脱敏的生效描述供日志/诊断。
 * custom 模式要求至少一个合法代理地址（设置层已校验，此处防御性抛错）。
 */
export function applyProxyConfig(
  config: ProxyConfig,
  control: ProxyDispatcherControl = defaultControl,
): ProxyApplyResult {
  if (config.mode === "off") {
    control.setGlobalDispatcher(control.createOffDispatcher());
    return { mode: "off", summary: "出站代理已关闭：所有请求直连" };
  }
  if (config.mode === "env") {
    control.setGlobalDispatcher(control.createEnvDispatcher());
    return { mode: "env", summary: "出站代理跟随环境变量（HTTP_PROXY/HTTPS_PROXY/NO_PROXY）" };
  }
  const httpProxy = validProxyUrl(config.httpProxy);
  const httpsProxy = validProxyUrl(config.httpsProxy);
  if (!httpProxy && !httpsProxy) {
    throw new Error("自定义代理模式需要至少一个合法的 http/https 代理地址");
  }
  const noProxy = parseNoProxyList(config.noProxy);
  const routing = control.createRoutingDispatcher(
    (origin) => shouldBypassProxy(origin.hostname, noProxy),
    // 按目标协议选代理；协议专属代理缺失时回退另一个（常见场景：只配一个 HTTP 代理）
    (origin) => (origin.protocol === "https:" ? httpsProxy ?? httpProxy : httpProxy ?? httpsProxy),
  );
  control.setGlobalDispatcher(routing);
  const parts = [
    `HTTP=${httpProxy ? sanitizeProxyUrl(httpProxy) : "—"}`,
    `HTTPS=${httpsProxy ? sanitizeProxyUrl(httpsProxy) : "—"}`,
  ];
  if (noProxy.length > 0) parts.push(`例外=${noProxy.join(",")}`);
  return { mode: "custom", summary: `出站代理使用自定义配置：${parts.join("，")}` };
}
