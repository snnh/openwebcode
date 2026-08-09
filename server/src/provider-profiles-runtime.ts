import type { AgentRunner } from "./agent/agent-runner.js";
import type { ChatRunner } from "./chat/chat-runner.js";
import type { ModelRegistry, ModelProviderCredentials, RefreshReport } from "./context/model-registry.js";
import type { EventBus } from "./events/event-bus.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { DEFAULT_MAX_CONCURRENT } from "./providers/concurrency-limiter.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { OpenAIResponsesProvider } from "./providers/openai-responses-provider.js";
import type { ProviderRegistry } from "./providers/provider.js";
import type { ProviderProfilesService } from "./provider-profiles.js";
import { createProfileSearchProvider, createProfileWebFetchProvider } from "./web-tools.js";

export class ProviderProfilesRuntime {
  private managedProviders = new Set<string>();
  private unsubscribe: (() => void) | undefined;
  /** chat 执行引擎（可选）：注入后搜索/抓取服务商变更同步热更新到 chat 工具上下文 */
  private chatRunner: ChatRunner | undefined;

  constructor(
    private readonly profiles: ProviderProfilesService,
    private readonly providers: ProviderRegistry,
    private readonly agent: AgentRunner,
    private readonly models: ModelRegistry | undefined,
    private readonly events: EventBus,
  ) {}

  /** 装配顺序上 ChatRunner 晚于本对象创建，故以 setter 注入；注入即同步一次当前 web 服务商。 */
  setChatRunner(chatRunner: ChatRunner): void {
    this.chatRunner = chatRunner;
    this.syncChatWebProviders();
  }

  start(): void {
    this.apply();
    void this.refreshModels().catch((error: unknown) => {
      process.stderr.write(`[profiles] 启动时模型目录刷新失败：${error instanceof Error ? error.message : String(error)}\n`);
    });
    this.unsubscribe = this.profiles.onChanged(() => {
      this.apply();
      void this.refreshModels().catch((error: unknown) => {
        process.stderr.write(`[profiles] 模型目录刷新失败：${error instanceof Error ? error.message : String(error)}\n`);
      });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  configuredProviderNames(): string[] {
    return this.profiles.modelProfiles().filter((profile) => profile.enabled).map((profile) => profile.id).sort();
  }

  modelCredentials(): ModelProviderCredentials[] {
    return this.profiles.modelProfiles().filter((profile) => profile.enabled).map((profile) => ({
      provider: profile.id,
      interfaceType: profile.interfaceType,
      ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
      ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
    }));
  }

  async refreshModels(): Promise<RefreshReport> {
    if (!this.models) return { added: 0, total: 0, errors: ["Model registry is not configured"] };
    return this.models.refresh({ providers: this.modelCredentials() });
  }

  private apply(): void {
    for (const id of this.managedProviders) this.providers.unregister(id);
    this.managedProviders.clear();
    // SSE 流 idle 超时（半开连接兜底）：env 覆盖，缺省用 provider 内置 DEFAULT_STREAM_IDLE_TIMEOUT_MS
    const streamIdleTimeoutMs = parseStreamIdleTimeout(process.env.OWC_PROVIDER_STREAM_IDLE_MS);
    const idleOption = streamIdleTimeoutMs === undefined ? {} : { streamIdleTimeoutMs };
    for (const profile of this.profiles.modelProfiles()) {
      if (!profile.enabled) continue;
      try {
        // 生产注册路径统一按默认 3 并发接线（provider.ts 注释口径），超出排队
        if (profile.interfaceType === "anthropic-messages") {
          this.providers.register(new AnthropicProvider({
            name: profile.id,
            ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
            ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
            promptCaching: profile.promptCaching !== false,
            ...(profile.extraBody ? { extraBody: profile.extraBody } : {}),
          }), DEFAULT_MAX_CONCURRENT);
        } else if (profile.interfaceType === "openai-responses") {
          this.providers.register(new OpenAIResponsesProvider({
            name: profile.id,
            baseURL: profile.baseURL ?? "https://api.openai.com/v1",
            ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
            ...(profile.extraBody ? { extraBody: profile.extraBody } : {}),
            ...idleOption,
          }), DEFAULT_MAX_CONCURRENT);
        } else {
          this.providers.register(new OpenAICompatibleProvider({
            name: profile.id,
            baseURL: profile.baseURL ?? "https://api.openai.com/v1",
            ...(profile.apiKey ? { apiKey: profile.apiKey } : {}),
            ...(profile.extraBody ? { extraBody: profile.extraBody } : {}),
            ...idleOption,
          }), DEFAULT_MAX_CONCURRENT);
        }
        this.managedProviders.add(profile.id);
      } catch (error) {
        process.stderr.write(`[profiles] 模型服务商 ${profile.id} 注册失败：${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
    const selected = this.profiles.selectedWebProfiles();
    this.agent.setSearchProvider(createProfileSearchProvider(selected.search));
    this.agent.setWebFetchProvider(createProfileWebFetchProvider(selected.fetch));
    this.syncChatWebProviders();
    this.events.publish({ source: "server", type: "provider_profiles.updated", payload: this.profiles.view() });
  }

  /** chat 侧搜索/抓取服务商热更新：与基础模式 agent 同一份 selectedWebProfiles。 */
  private syncChatWebProviders(): void {
    if (!this.chatRunner) return;
    const selected = this.profiles.selectedWebProfiles();
    this.chatRunner.setSearchProvider(createProfileSearchProvider(selected.search));
    this.chatRunner.setWebFetchProvider(createProfileWebFetchProvider(selected.fetch));
  }
}

/** OWC_PROVIDER_STREAM_IDLE_MS：非负整数毫秒（0 = 关闭 idle 超时）；非法值回落内置默认。 */
function parseStreamIdleTimeout(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}
