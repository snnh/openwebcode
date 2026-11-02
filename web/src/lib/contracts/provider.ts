export type ModelInterfaceType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
export type WebCapability = "search" | "fetch";
export type WebProviderType = "jina" | "brave" | "tavily" | "custom" | "bing" | "searxng" | "exa" | "linkup" | "bocha" | "firecrawl" | "baidu" | "scrapingbee" | "scraperapi" | "zenrows";

export interface ModelProviderProfileView {
  id: string;
  enabled: boolean;
  interfaceType: ModelInterfaceType;
  baseURL?: string;
  promptCaching?: boolean;
  reasoningSummary?: boolean;
  extraBody?: Record<string, unknown>;
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export interface WebProviderProfileView {
  id: string;
  provider: WebProviderType;
  capabilities: WebCapability[];
  searchBaseURL?: string;
  fetchBaseURL?: string;
  searchDepth?: "basic" | "advanced";
  /** 百度 AI 搜索版本：standard 标准版（默认）/ turbo 增强版 / pro 旗舰版（计费与能力不同）。 */
  searchEdition?: "standard" | "turbo" | "pro";
  /** 百度 AI 搜索国内外内容控制（仅 turbo 生效）：domestic 国内（默认）/ abroad 国外 / auto 按 query 语言自动。 */
  complianceScene?: "domestic" | "abroad" | "auto";
  resultCount?: number;
  hasApiKey: boolean;
  maskedApiKey?: string;
}

export interface ProviderProfilesView {
  modelProviders: ModelProviderProfileView[];
  webProviders: WebProviderProfileView[];
  activeWeb: { search?: string; fetch?: string };
}

/** POST /api/provider-profiles/test 的返回：ok 时带延迟（429 限流视为可达并附 note），失败时给中文可操作错误 */
export interface ProviderConnectionTestResult {
  ok: boolean;
  latencyMs?: number;
  note?: string;
  error?: string;
}
