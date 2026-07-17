import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "./agent/agent-runner.js";
import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { ModelRegistry } from "./context/model-registry.js";
import { CoreClient } from "./core-client.js";
import { ExchangeRateService, HttpExchangeRateProvider } from "./cost/exchange-rate.js";
import { PricingCatalog } from "./cost/pricing-catalog.js";
import { EventBus } from "./events/event-bus.js";
import { DevelopmentProvider } from "./providers/development-provider.js";
import { ProviderRegistry } from "./providers/provider.js";
import { SessionStore } from "./sessions/session-store.js";
import { SettingsService } from "./settings-service.js";
import { StorageGC } from "./storage-gc.js";
import { UsageLog } from "./usage-log.js";
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const resolveFromServer = (value) => (path.isAbsolute(value) ? value : path.resolve(moduleDirectory, "..", value));
// settings 文件固定放在 env/默认数据目录下；dataDir 的文件覆盖重启后对业务数据生效，
// 但不改变 settings 文件自身的位置（否则重启后会丢失配置入口）。
const envConfig = loadConfig();
const bootDataDir = resolveFromServer(envConfig.dataDir);
const settings = await SettingsService.load({
    env: process.env,
    filePath: path.join(bootDataDir, "server-settings.json"),
});
const config = settings.effective();
const dataDir = resolveFromServer(config.dataDir);
const core = new CoreClient(config.corePath, config.coreRequestTimeoutMs);
const sessions = new SessionStore(path.join(dataDir, "sessions"));
const providers = new ProviderRegistry();
const events = new EventBus();
const pricing = new PricingCatalog(path.join(dataDir, "model-pricing.json"));
const exchangeRates = new ExchangeRateService({
    cachePath: path.join(dataDir, "exchange-rate.json"),
    ...(config.exchangeRate.url ? { provider: new HttpExchangeRateProvider(config.exchangeRate.url) } : {}),
    timeoutMs: config.exchangeRate.timeoutMs,
    ...(config.exchangeRate.fixedUsdCnyRate ? { fixedUsdCnyRate: config.exchangeRate.fixedUsdCnyRate } : {}),
});
providers.register(new DevelopmentProvider());
const models = await ModelRegistry.load({
    snapshotPath: path.join(dataDir, "models.json"),
    manualPath: path.join(dataDir, "models.manual.json"),
    onUpdated: () => events.publish({ source: "server", type: "models.updated", payload: {} }),
});
const usageLog = new UsageLog(dataDir);
const agent = new AgentRunner(sessions, providers, core, events, pricing, exchangeRates, config.defaultLanguage, 50, (model) => models.get(model), usageLog);
const gc = new StorageGC(path.join(dataDir, "sessions"), config.gcMaxBytes);
settings.bind({ providers, core, agent, events, models, gc });
settings.reconcileProviders();
core.on("diagnostic", (text) => process.stderr.write(`[owc-exec] ${text}`));
core.on("error", (error) => console.error("Core error:", error));
await sessions.initialize();
await pricing.initialize();
await exchangeRates.initialize();
await core.start();
// 存储 GC：启动时一次 + 每小时周期清理（失败仅记日志）
void gc.collect().catch((error) => console.error("Storage GC failed:", error));
const gcTimer = setInterval(() => {
    void gc.collect().catch((error) => console.error("Storage GC failed:", error));
}, 3_600_000);
gcTimer.unref();
const app = await buildServer({
    core,
    sessions,
    agent,
    events,
    providers,
    pricing,
    webDist: path.resolve(moduleDirectory, "../../web/dist"),
    defaultCurrency: config.defaultCurrency,
    defaultLanguage: config.defaultLanguage,
    settings,
    models,
    usageLog,
    getPreferences: () => {
        const effective = settings.effective();
        return { currency: effective.defaultCurrency, language: effective.defaultLanguage };
    },
});
async function shutdown() {
    clearInterval(gcTimer);
    exchangeRates.close();
    await app.close();
    await core.stop();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
