import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "./agent/agent-runner.js";
import { BackgroundTaskRegistry } from "./agent/background-tasks.js";
import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { ModelRegistry } from "./context/model-registry.js";
import { CoreClient } from "./core-client.js";
import { ExchangeRateService, HttpExchangeRateProvider } from "./cost/exchange-rate.js";
import { PricingCatalog } from "./cost/pricing-catalog.js";
import { EventBus } from "./events/event-bus.js";
import { HookRunner } from "./hooks.js";
import { ProviderRegistry } from "./providers/provider.js";
import { CoreRouter } from "./sandbox/core-router.js";
import { WsbManager } from "./sandbox/wsb.js";
import { SessionStore } from "./sessions/session-store.js";
import { SettingsService } from "./settings-service.js";
import { SkillRegistry } from "./skills.js";
import { AgentRegistry } from "./agents.js";
import { CommandRegistry } from "./commands.js";
import { McpManager } from "./mcp/manager.js";
import { ManagedWorkspaceManager } from "./snapshots/managed-disk.js";
import { Provider2Client } from "./provider2.js";
import { Compactor } from "./context/compactor.js";
import { StorageGC } from "./storage-gc.js";
import { UsageLog } from "./usage-log.js";
import { createSearchProvider } from "./web-tools.js";
import { ExtensionManager } from "./extensions/extension-manager.js";
import { ContentLensService } from "./extensions/content-lens.js";
import { RemoteSyncScheduler } from "./remote-sync-scheduler.js";
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
// 共享宿主机 core；sandboxMode=="wsb" 的会话由 CoreRouter 路由到 WSB 沙盒内的 core
const sharedCore = new CoreClient(config.corePath, config.coreRequestTimeoutMs);
const sessions = new SessionStore(path.join(dataDir, "sessions"));
const wsbManager = new WsbManager({
    corePath: resolveFromServer(config.corePath),
    sessionRootFor: (sessionId) => sessions.contextRoot(sessionId),
    requestTimeoutMs: config.coreRequestTimeoutMs,
});
const core = new CoreRouter(sharedCore, sessions, wsbManager, config.sandbox?.jobObject, config.sandbox?.allowPaths);
const providers = new ProviderRegistry();
const events = new EventBus();
const pricing = new PricingCatalog(path.join(dataDir, "model-pricing.json"));
const exchangeRates = new ExchangeRateService({
    cachePath: path.join(dataDir, "exchange-rate.json"),
    ...(config.exchangeRate.url ? { provider: new HttpExchangeRateProvider(config.exchangeRate.url) } : {}),
    timeoutMs: config.exchangeRate.timeoutMs,
    ...(config.exchangeRate.fixedUsdCnyRate ? { fixedUsdCnyRate: config.exchangeRate.fixedUsdCnyRate } : {}),
});
const models = await ModelRegistry.load({
    snapshotPath: path.join(dataDir, "models.json"),
    syncedSnapshotPath: path.join(dataDir, "models.synced.json"),
    manualPath: path.join(dataDir, "models.manual.json"),
    onUpdated: () => events.publish({ source: "server", type: "models.updated", payload: {} }),
});
const usageLog = new UsageLog(dataDir);
const skills = new SkillRegistry(path.join(dataDir, "skills"));
const agents = new AgentRegistry(path.join(dataDir, "agents"));
const commands = new CommandRegistry(path.join(dataDir, "commands"));
const mcp = new McpManager(dataDir);
const provider2 = new Provider2Client(config.provider2);
const compactor = new Compactor(sessions, provider2, { usageLog, pricing, exchangeRates });
const extensions = new ExtensionManager(dataDir, events);
await extensions.initialize();
const contentLens = new ContentLensService(sessions, provider2);
const search = createSearchProvider(config.search);
const backgroundTasks = new BackgroundTaskRegistry(() => new CoreClient(config.corePath, config.coreRequestTimeoutMs), async (client, sessionId, cwd) => {
    const session = await sessions.get(sessionId);
    const sandbox = session?.sandbox ?? { enabled: true, readRoots: [cwd], writeRoots: [cwd], denyPaths: [], network: "allow" };
    await client.configureSession({ sessionId, cwd, sandbox });
}, (info) => events.publish({ source: "agent", type: "task.finished", sessionId: info.sessionId, payload: info }));
// Hooks（可信配置，等同 yolo 级别）：全局 <dataDir>/hooks.json，项目 <cwd>/.owc/hooks.json 现读覆盖
const hooks = new HookRunner(path.join(dataDir, "hooks.json"), events);
const agent = new AgentRunner(sessions, providers, core, events, pricing, exchangeRates, config.defaultLanguage, 50, (model) => models.get(model), usageLog, skills, mcp, compactor, dataDir, agents, commands, search, undefined, backgroundTasks, hooks, extensions);
// 托管工作区（plan §6.4）：镜像/挂载点位于 dataDir 下；孤儿挂载清理挂在 GC 启动扫描上
const managed = new ManagedWorkspaceManager({ dataDir });
const gc = new StorageGC(path.join(dataDir, "sessions"), config.gcMaxBytes, () => managed.sweepOrphans());
settings.bind({ providers, core, agent, events, models, gc, provider2 });
settings.reconcileProviders();
core.on("diagnostic", (text) => process.stderr.write(`[owc-exec] ${text}`));
core.on("error", (error) => console.error("Core error:", error));
await sessions.initialize();
await pricing.initialize();
await exchangeRates.initialize();
/** Remote model/pricing catalogs share settings but fail independently: one bad endpoint never
 * prevents the other catalog from refreshing, nor does it replace a validated local snapshot. */
const syncRemoteCatalogs = async () => {
    const remote = settings.effective().models;
    if (remote.catalogSyncUrl) {
        try {
            const result = await models.syncCatalogFromUrl(remote.catalogSyncUrl);
            if (!result.ok)
                process.stderr.write(`[sync] 远程模型目录同步失败：${result.error}\n`);
        }
        catch (error) {
            process.stderr.write(`[sync] 远程模型目录同步失败：${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
    if (remote.pricingSyncUrl) {
        try {
            const result = await pricing.syncFromUrl(remote.pricingSyncUrl);
            if (result.ok) {
                events.publish({ source: "server", type: "model.pricing_updated", payload: { updatedAt: result.updatedAt, entries: result.count } });
            }
            else {
                process.stderr.write(`[sync] 远程模型定价同步失败：${result.error}\n`);
            }
        }
        catch (error) {
            process.stderr.write(`[sync] 远程模型定价同步失败：${error instanceof Error ? error.message : String(error)}\n`);
        }
    }
};
const remoteSyncScheduler = new RemoteSyncScheduler({
    getIntervalMinutes: () => settings.effective().models.syncIntervalMinutes,
    sync: syncRemoteCatalogs,
});
events.on("event", (event) => {
    if (event.type !== "server.settings_updated" || !event.payload || typeof event.payload !== "object")
        return;
    const keys = event.payload.keys;
    if (!Array.isArray(keys) || !keys.some((key) => key === "catalogSyncUrl" || key === "pricingSyncUrl" || key === "syncIntervalMinutes"))
        return;
    remoteSyncScheduler.refreshAfterSettingsChange();
});
remoteSyncScheduler.start();
await core.start();
// 存储 GC：启动时一次（含托管挂载孤儿清理）+ 每小时周期清理（失败仅记日志）
void gc.startup().catch((error) => console.error("Storage GC failed:", error));
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
    managed,
    webDist: path.resolve(moduleDirectory, "../../web/dist"),
    defaultCurrency: config.defaultCurrency,
    defaultLanguage: config.defaultLanguage,
    settings,
    models,
    usageLog,
    skills,
    compactor,
    backgroundTasks,
    extensions,
    contentLens,
    getPreferences: () => {
        const effective = settings.effective();
        return { currency: effective.defaultCurrency, language: effective.defaultLanguage };
    },
});
async function shutdown() {
    clearInterval(gcTimer);
    remoteSyncScheduler.stop();
    exchangeRates.close();
    await mcp.close();
    await extensions.close();
    await backgroundTasks.shutdown().catch((error) => console.error("Background tasks shutdown error:", error));
    await app.close();
    await core.stop();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
