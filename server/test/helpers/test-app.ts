import path from "node:path";
import { AgentRunner } from "../../src/agent/agent-runner.js";
import { buildServer } from "../../src/app.js";
import type { ModelRegistry } from "../../src/context/model-registry.js";
import { CoreClient } from "../../src/core-client.js";
import { PricingCatalog } from "../../src/cost/pricing-catalog.js";
import { EventBus, type AppEvent } from "../../src/events/event-bus.js";
import type { ProviderProfilesRuntime } from "../../src/provider-profiles-runtime.js";
import { ProviderProfilesService } from "../../src/provider-profiles.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { SettingsService } from "../../src/settings-service.js";
import { tempRoot } from "./temp-roots.js";

export interface TestAppOptions<TPricing extends PricingCatalog = PricingCatalog> {
  /** 临时目录 prefix（各文件保持自己的 prefix）。 */
  tempPrefix?: string;
  /** 覆盖默认 PricingCatalog（如 Stub 子类）；工厂接收 root。 */
  pricing?: (root: string) => TPricing;
  /** 覆盖默认 stub agent（{ isRunning: () => false }）；传 "real" 用真实 AgentRunner。 */
  agent?: AgentRunner | "real";
  /** 覆盖默认空 core（{} as CoreClient）；传 "real" 或工厂用真实 CoreClient。 */
  core?: CoreClient | "real" | ((root: string) => CoreClient);
  /** 自定义 ProviderRegistry（如注册 stub provider）。 */
  configureProviders?: (providers: ProviderRegistry) => void;
  /** 提供（含 {}）则加载 SettingsService、bind 并传给 buildServer。 */
  settingsEnv?: NodeJS.ProcessEnv;
  /** 提供则加载 ModelRegistry 并传给 buildServer；工厂接收 root 与 events（供 onUpdated 发布事件）。 */
  models?: (root: string, events: EventBus) => Promise<ModelRegistry>;
  /** true 时加载 ProviderProfilesService 并传给 buildServer。 */
  providerProfiles?: boolean;
  /** 工厂接收 models（未配置 models 时为 undefined）。 */
  providerProfilesRuntime?: (models: ModelRegistry | undefined) => ProviderProfilesRuntime;
}

/**
 * buildServer 测试骨架：SessionStore/PricingCatalog/ProviderRegistry/EventBus/buildServer
 * 五连抄的公共部分；差异（settings、models、providerProfilesRuntime 等）经参数注入。
 */
export async function makeTestApp<TPricing extends PricingCatalog = PricingCatalog>(options: TestAppOptions<TPricing> = {}) {
  const root = await tempRoot(options.tempPrefix ?? "owc-test-app-");
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const pricing = (options.pricing ? options.pricing(root) : new PricingCatalog(path.join(root, "model-pricing.json"))) as TPricing;
  await pricing.initialize();
  const providers = new ProviderRegistry();
  options.configureProviders?.(providers);
  const events = new EventBus();
  const observed: AppEvent[] = [];
  events.on("event", (event: AppEvent) => observed.push(event));
  const core = options.core === "real"
    ? new CoreClient(path.join(root, "unused-core"))
    : typeof options.core === "function"
      ? options.core(root)
      : options.core ?? ({} as CoreClient);
  const agent = options.agent === "real"
    ? new AgentRunner(sessions, providers, core, events, pricing)
    : options.agent ?? ({ isRunning: () => false } as unknown as AgentRunner);
  const settings = options.settingsEnv !== undefined
    ? await SettingsService.load({ env: options.settingsEnv, filePath: path.join(root, "server-settings.json") })
    : undefined;
  settings?.bind({ providers, core, agent, events });
  const models = options.models ? await options.models(root, events) : undefined;
  const providerProfiles = options.providerProfiles
    ? await ProviderProfilesService.load({ filePath: path.join(root, "provider-profiles.json") })
    : undefined;
  const providerProfilesRuntime = options.providerProfilesRuntime?.(models);
  const app = await buildServer({
    core,
    sessions,
    agent,
    events,
    providers,
    pricing,
    ...(settings ? { settings } : {}),
    ...(models ? { models } : {}),
    ...(providerProfiles ? { providerProfiles } : {}),
    ...(providerProfilesRuntime ? { providerProfilesRuntime } : {}),
  });
  return { root, sessions, pricing, providers, events, observed, core, agent, settings, models, providerProfiles, app };
}
