import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "./agent/agent-runner.js";
import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { CoreClient } from "./core-client.js";
import { ExchangeRateService, HttpExchangeRateProvider } from "./cost/exchange-rate.js";
import { PricingCatalog } from "./cost/pricing-catalog.js";
import { EventBus } from "./events/event-bus.js";
import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { DevelopmentProvider } from "./providers/development-provider.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { ProviderRegistry } from "./providers/provider.js";
import { SessionStore } from "./sessions/session-store.js";

const config = loadConfig();
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.isAbsolute(config.dataDir)
  ? config.dataDir
  : path.resolve(moduleDirectory, "..", config.dataDir);
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
if (config.anthropic) providers.register(new AnthropicProvider(config.anthropic));
if (config.openai) providers.register(new OpenAICompatibleProvider(config.openai));
const agent = new AgentRunner(sessions, providers, core, events, pricing, exchangeRates, config.defaultLanguage);

core.on("diagnostic", (text: string) => process.stderr.write(`[owc-exec] ${text}`));
core.on("error", (error: Error) => console.error("Core error:", error));

await sessions.initialize();
await pricing.initialize();
await exchangeRates.initialize();
await core.start();
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
});

async function shutdown(): Promise<void> {
  exchangeRates.close();
  await app.close();
  await core.stop();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
