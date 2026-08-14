export type ModelInterfaceType = "anthropic-messages" | "openai-chat-completions" | "openai-responses";
export type WebCapability = "search" | "fetch";
export type WebProviderType = "jina" | "brave" | "tavily" | "custom" | "bing" | "searxng" | "exa" | "linkup" | "bocha" | "firecrawl";

export interface ModelProviderProfileView {
  id: string;
  enabled: boolean;
  interfaceType: ModelInterfaceType;
  baseURL?: string;
  promptCaching?: boolean;
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
