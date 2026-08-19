import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "./agent/agent-runner.js";
import { BackgroundTaskRegistry } from "./agent/background-tasks.js";
import { buildServer } from "./app.js";
import { TotpAuthService } from "./auth-totp.js";
import { buildAccessUrls, listLanAddresses, regenerateAccessToken, resolveAccessToken } from "./access-token.js";
import { isLoopbackHost, loadConfig } from "./config.js";
import { ModelRegistry } from "./context/model-registry.js";
import { CoreClient } from "./core-client.js";
import { CoreLogArchive } from "./core-log.js";
import { ExchangeRateService, HttpExchangeRateProvider } from "./cost/exchange-rate.js";
import { PricingCatalog } from "./cost/pricing-catalog.js";
import { EventBus } from "./events/event-bus.js";
import { ensureDirWithMode } from "./fs-utils.js";
import { installGracefulShutdown } from "./shutdown.js";
import { HookRunner } from "./hooks.js";
import { ensureHomeEnv } from "./host-env.js";
import { IndexManager } from "./index/index-manager.js";
import { DiagnosticsService } from "./diagnostics/service.js";
import { ScmService } from "./scm/service.js";
import { ProviderRegistry } from "./providers/provider.js";
import { CoreRouter } from "./sandbox/core-router.js";
import { FilteredProxyManager } from "./sandbox/filtered-proxy.js";
import { WsbManager } from "./sandbox/wsb.js";
import { SessionStore } from "./sessions/session-store.js";
import { defaultSandboxPolicy } from "./sessions/default-sandbox.js";
import { SettingsService } from "./settings-service.js";
import { SkillRegistry } from "./skills.js";
import { AgentRegistry } from "./agents.js";
import { CommandRegistry } from "./commands.js";
import { McpManager } from "./mcp/manager.js";
import { ManagedWorkspaceManager } from "./snapshots/managed-disk.js";
import { FastModelClient } from "./fast-model.js";
import { ModelRoleResolver } from "./model-roles.js";
import { Compactor } from "./context/compactor.js";
import { StorageGC } from "./storage-gc.js";
import { UsageLog } from "./usage-log.js";
import { GITHUB_RELEASES_URL, getServerVersion, readServerVersion, setServerVersion } from "./version.js";
import { UpdateChecker } from "./update-checker.js";
import { UpdateApplier } from "./update-applier.js";
import { applyProxyConfig } from "./proxy.js";
import { createProfileSearchProvider, createProfileWebFetchProvider } from "./web-tools.js";
import { ProviderProfilesService } from "./provider-profiles.js";
import { ProviderProfilesRuntime } from "./provider-profiles-runtime.js";
import { ExtensionManager } from "./extensions/extension-manager.js";
import { ContentLensService } from "./extensions/content-lens.js";
import { CompactVaultService } from "./extensions/compact-vault.js";
import { RemoteSyncScheduler } from "./remote-sync-scheduler.js";
import { CronScheduler } from "./cron-scheduler.js";
import { EvalEvaluator } from "./eval/evaluator.js";
import { ChatAssistantStore, ChatConfigService, ChatPythonEnv, ChatRunner, ChatSessionStore } from "./chat/index.js";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const resolveFromServer = (value: string) => (path.isAbsolute(value) ? value : path.resolve(moduleDirectory, "..", value));

// Linux 基准环境是 systemd/Docker 等最小环境：可能不带 HOME。按 passwd 记录补齐，
// 保证沙盒 shell（~/.bashrc 依赖 $HOME）、git 凭据查找、uv/fnm 探测拿到一致 home。
ensureHomeEnv();

// settings 文件固定放在 env/默认数据目录下；dataDir 的文件覆盖重启后对业务数据生效，
// 但不改变 settings 文件自身的位置（否则重启后会丢失配置入口）。
const envConfig = loadConfig();
const bootDataDir = resolveFromServer(envConfig.dataDir);
// 设置目录含敏感文件（API Key、访问令牌）：POSIX 收紧 0700（Windows no-op）
await ensureDirWithMode(bootDataDir, 0o700);
// 解析服务版本并初始化全局 User-Agent（所有出站 HTTP 统一注入 UA）
const serverVersion = await readServerVersion();
setServerVersion(serverVersion);
process.stderr.write(`openwebcode ${serverVersion} starting\n`);
const settings = await SettingsService.load({
  env: process.env,
  filePath: path.join(bootDataDir, "server-settings.json"),
});

const config = settings.effective();
const dataDir = resolveFromServer(config.dataDir);
// 出站代理：按当前设置安装全局 dispatcher（off/env/custom），先于一切出站请求；
// 设置保存后由 SettingsService.hotApply 热重应用
const proxyDescription = applyProxyConfig(config.proxy);
process.stderr.write(`[proxy] ${proxyDescription.summary}\n`);
// 业务数据目录可与设置目录不同（settings dataDir 覆盖）：同样收紧 0700
await ensureDirWithMode(dataDir, 0o700);
// 共享宿主机 core；sandboxMode=="wsb" 的会话由 CoreRouter 路由到 WSB 沙盒内的 core
const sharedCore = new CoreClient(config.corePath, config.coreRequestTimeoutMs);
const sessions = new SessionStore(path.join(dataDir, "sessions"));
const wsbManager = new WsbManager({
  corePath: resolveFromServer(config.corePath),
  sessionRootFor: (sessionId) => sessions.contextRoot(sessionId),
  requestTimeoutMs: config.coreRequestTimeoutMs,
});
// filtered 网络档 sidecar 编排：代理设置与拦截清单现读 settings（热生效）
const filteredProxy = new FilteredProxyManager({
  dataDir,
  getProxyConfig: () => settings.effective().proxy,
  getDenyList: () => settings.effective().sandboxProxyDenyList ?? [],
});
const core = new CoreRouter(sharedCore, sessions, wsbManager, config.sandbox?.jobObject, config.sandbox?.allowPaths, undefined, filteredProxy);
const providers = new ProviderRegistry();
const events = new EventBus();
const pricing = new PricingCatalog(path.join(dataDir, "model-pricing.json"));
const exchangeRates = new ExchangeRateService({
  cachePath: path.join(dataDir, "exchange-rate.json"),
  ...(config.exchangeRate.url ? { provider: new HttpExchangeRateProvider(config.exchangeRate.url) } : {}),
  timeoutMs: config.exchangeRate.timeoutMs,
  ...(config.exchangeRate.fixedUsdCnyRate ? { fixedUsdCnyRate: config.exchangeRate.fixedUsdCnyRate } : {}),
  // 离线模式（热生效，现读 settings）：跳过在线汇率拉取，回落缓存/固定汇率
  isOffline: () => settings.effective().offlineMode,
});
const models = await ModelRegistry.load({
  snapshotPath: path.join(dataDir, "models.json"),
  syncedSnapshotPath: path.join(dataDir, "models.synced.json"),
  manualPath: path.join(dataDir, "models.manual.json"),
  onUpdated: () => events.publish({ source: "server", type: "models.updated", payload: {} }),
});
const providerProfiles = await ProviderProfilesService.load({
  filePath: path.join(dataDir, "provider-profiles.json"),
});
const usageLog = new UsageLog(dataDir);
const skills = new SkillRegistry(path.join(dataDir, "skills"));
const agents = new AgentRegistry(path.join(dataDir, "agents"));
const commands = new CommandRegistry(path.join(dataDir, "commands"));
const mcp = new McpManager(dataDir);
const fastModel = new FastModelClient(providers, config.fastModel);
// 子代理角色档解析器（settings 热更新现读生效）：premium/balanced/fast/cheap → provider+model
const modelRoles = new ModelRoleResolver(settings, providers);
// Hooks（可信配置，等同 yolo 级别）：全局 <dataDir>/hooks.json，项目 <cwd>/.owc/hooks.json 现读覆盖
const hooks = new HookRunner(path.join(dataDir, "hooks.json"), events);
const compactor = new Compactor(sessions, fastModel, { usageLog, pricing, exchangeRates, hooks });
// 档案库压缩（compact-vault 官方扩展的 server 侧服务）：归档完整上下文 + 目录索引 + 按需召回
const vaultService: CompactVaultService = new CompactVaultService(sessions, fastModel, providers, {
  usageLog, pricing, exchangeRates, hooks,
  // 扩展配置延迟读取（ExtensionManager 在其后创建）：maxTokens 等由用户在扩展设置里配置
  getConfig: () => extensions.list().find((item) => item.id === "compact-vault")?.config ?? {},
});
const extensions: ExtensionManager = new ExtensionManager(dataDir, events, { sessions, fastModel, vaultService, providers, core });
await extensions.initialize();
const contentLens = new ContentLensService(sessions, fastModel);
// Production evaluations share the normal Core boundary, so workspace access
// keeps the same path policy and sandbox enforcement as ordinary sessions.
const evalEvaluator = new EvalEvaluator(dataDir, core);
const selectedWeb = providerProfiles.selectedWebProfiles();
const search = createProfileSearchProvider(selectedWeb.search);
const webFetch = createProfileWebFetchProvider(selectedWeb.fetch);
const backgroundTasks = new BackgroundTaskRegistry(
  () => new CoreClient(config.corePath, config.coreRequestTimeoutMs),
  async (client, sessionId, cwd) => {
    const session = await sessions.get(sessionId);
    const sandbox = session?.sandbox ?? defaultSandboxPolicy(cwd);
    await client.configureSession({ sessionId, cwd, sandbox });
  },
  (info) => events.publish({ source: "agent", type: "task.finished", sessionId: info.sessionId, payload: info }),
  undefined,
  (info) => events.publish({ source: "agent", type: "task.started", sessionId: info.sessionId, payload: info }),
);
// Hooks 已在上方（compactor 之前）创建，此处直接注入 agent
const agent = new AgentRunner(sessions, providers, core, events, pricing, exchangeRates, config.defaultLanguage, 50, (model, provider) => models.get(model, provider), usageLog, skills, mcp, compactor, dataDir, agents, commands, search, undefined, backgroundTasks, hooks, extensions, webFetch);
agent.setPythonEnvDefault(() => settings.effective().pythonEnv);
agent.setNodeEnvDefault(() => settings.effective().nodeEnv);
core.setNodeEnvDefault(() => settings.effective().nodeEnv);
core.setPythonEnvDefault(() => settings.effective().pythonEnv, dataDir);
agent.setMaxTurns(() => settings.effective().agentMaxTurns);
agent.setSubAgentMaxTurns(() => settings.effective().subAgentMaxTurns);
agent.setCompactionThreshold(() => settings.effective().compactionThresholdPercent);
compactor.setCompactMaxTokens(() => settings.effective().compactMaxTokens);
agent.setWebSearchMode(() => settings.effective().webSearchMode ?? "local");
agent.setFastModel(fastModel);
agent.setVaultService(vaultService);
agent.setModelRoleResolver(modelRoles);
// 符号索引（0.4.0 Phase 2）：数据目录 index/ 下，按 workspace-hash 分桶；不进会话历史、不导出
const indexManager = new IndexManager(core, path.join(dataDir, "index"), events);
agent.setIndexManager(indexManager);
// 诊断闭环（0.4.0 Phase 3a）：test_runner 工具、REST tests/diagnostics、diagnostics.updated 事件共用
const diagnostics = new DiagnosticsService(core, sessions, events);
agent.setDiagnostics(diagnostics);
// Git 集成（0.4.0 Phase 4a）：git_status/diff/commit 工具、git/* REST、worktree 生命周期（<dataDir>/worktrees）、scm.updated 事件共用
const scm = new ScmService(core, sessions, events, { worktreeRoot: path.join(dataDir, "worktrees") });
agent.setScm(scm);
// cron 定时任务（提交⑫）：<dataDir>/cron.json 持久化，单 timer 调度；触发经 follow-up 队列注入
// （极简 [cron] 前缀标记来源，stale 为 7 天保留期到期的最后一次触发）。会话已删时自愈级联。
const cron = new CronScheduler({
  file: path.join(dataDir, "cron.json"),
  fire: async (sessionId, prompt, meta) => {
    if (!(await sessions.get(sessionId))) {
      await cron.deleteForSession(sessionId);
      return;
    }
    await agent.fireCronFollowUp(sessionId, meta.stale ? `[cron] 到期最后一次触发：${prompt}` : `[cron] ${prompt}`);
  },
});
agent.setCronScheduler(cron);
const providerProfilesRuntime = new ProviderProfilesRuntime(providerProfiles, providers, agent, models, events);
// 托管工作区（plan §6.4）：镜像/挂载点位于 dataDir 下；孤儿挂载清理挂在 GC 启动扫描上。
// overlayfs 托管经宿主机 core 的 overlay.* 原语挂载 merged 视图（仅 Linux）。
const managed = new ManagedWorkspaceManager({ dataDir, core: sharedCore });
const gc = new StorageGC(path.join(dataDir, "sessions"), config.gcMaxBytes, () => managed.sweepOrphans());
// 更新检查（默认关闭）：周期性查询 GitHub Releases 最新版本，结果仅在设置页静默展示
const updateChecker = new UpdateChecker({
  cachePath: path.join(dataDir, "update-check.json"),
  defaultUrl: config.updateCheck.url ?? GITHUB_RELEASES_URL,
});
// 离线模式：启动期检测与定时调度一并关闭（settings 变更的热生效在 SettingsService.hotApply 同样把关）
updateChecker.configure({ ...config.updateCheck, enabled: config.updateCheck.enabled && !config.offlineMode });
// 在线更新：installRoot 在 dist 下解析为 OWC_HOME（server/dist/../..）；tsx dev 时为 server/ 上一级，仅开发场景
const updateApplier = new UpdateApplier({
  dataDir,
  installRoot: path.resolve(moduleDirectory, "../.."),
  getReleaseUrl: () => settings.effective().updateCheck.url ?? GITHUB_RELEASES_URL,
  getCurrentVersion: getServerVersion,
});
settings.bind({ providers, core, agent, events, gc, fastModel, profiles: providerProfiles, models, updateChecker, sandboxProxy: filteredProxy, usageLog });
providerProfilesRuntime.start();

// core stderr/diagnostic 双写：终端 + <dataDir>/logs/core.log（超 5MB 启动时轮转为 core.log.1，仅一代）
const coreLog = new CoreLogArchive(path.join(dataDir, "logs"));
await coreLog.initialize().catch((error: unknown) => process.stderr.write(`[core-log] 初始化失败：${error instanceof Error ? error.message : String(error)}\n`));
core.on("diagnostic", (text: string) => {
  process.stderr.write(`[owc-exec] ${text}`);
  coreLog.append(text.endsWith("\n") ? `[owc-exec] ${text}` : `[owc-exec] ${text}\n`);
});
core.on("error", (error: Error) => {
  process.stderr.write(`[owc-exec] core error: ${error}\n`);
  coreLog.append(`[owc-exec] core error: ${error}\n`);
});

await sessions.initialize();
await pricing.initialize();
await exchangeRates.initialize();
await updateChecker.initialize();

/** Remote model/pricing catalogs share settings but fail independently: one bad endpoint never
 * prevents the other catalog from refreshing, nor does it replace a validated local snapshot. */
const syncRemoteCatalogs = async (): Promise<void> => {
  // 离线模式：后台自动同步整体跳过（手动入口 /api/models/sync、/api/models/refresh 不经过这里，仍可用）
  if (settings.effective().offlineMode) return;
  const remote = settings.effective().models;
  if (remote.catalogSyncUrl) {
    try {
      const result = await models.syncCatalogFromUrl(remote.catalogSyncUrl);
      if (!result.ok) process.stderr.write(`[sync] 远程模型目录同步失败：${result.error}\n`);
    } catch (error) {
      process.stderr.write(`[sync] 远程模型目录同步失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (remote.pricingSyncUrl) {
    try {
      const result = await pricing.syncFromUrl(remote.pricingSyncUrl);
      if (result.ok) {
        events.publish({ source: "server", type: "model.pricing_updated", payload: { updatedAt: result.updatedAt, entries: result.count } });
      } else {
        process.stderr.write(`[sync] 远程模型定价同步失败：${result.error}\n`);
      }
    } catch (error) {
      process.stderr.write(`[sync] 远程模型定价同步失败：${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
};
const remoteSyncScheduler = new RemoteSyncScheduler({
  // 离线模式视同间隔 0：不建立定时器（sync 内还有一道闸门，双保险）
  getIntervalMinutes: () => settings.effective().offlineMode ? 0 : settings.effective().models.syncIntervalMinutes,
  sync: syncRemoteCatalogs,
});
events.on("event", (event) => {
  if (event.type !== "server.settings_updated" || !event.payload || typeof event.payload !== "object") return;
  const keys = (event.payload as { keys?: unknown }).keys;
  // offlineMode 切换也要重排定时器（开 → 停，关 → 按当前间隔恢复）
  if (!Array.isArray(keys) || !keys.some((key) => key === "catalogSyncUrl" || key === "pricingSyncUrl" || key === "syncIntervalMinutes" || key === "offlineMode")) return;
  remoteSyncScheduler.refreshAfterSettingsChange();
});
remoteSyncScheduler.start();
await core.start();
// cron 恢复需在 sessions/core 就绪之后：load 会 coalesce 补发停机期间错过的触发（经 follow-up 队列起 run）
await cron.load();
// 存储 GC：启动时一次（含托管挂载孤儿清理）+ 每小时周期清理（失败仅记日志）
void gc.startup().catch((error: unknown) => process.stderr.write(`[gc] startup failed: ${error instanceof Error ? error.message : String(error)}\n`));
const gcTimer = setInterval(() => {
  void gc.collect().catch((error: unknown) => process.stderr.write(`[gc] collect failed: ${error instanceof Error ? error.message : String(error)}\n`));
}, 3_600_000);
gcTimer.unref();
// usage-events 清理：启动时一次 + 每小时按设置策略清理（off 模式 no-op，失败仅记日志）
const pruneUsageLog = (): void => {
  const effective = settings.effective();
  void usageLog.prune({
    mode: effective.usageLogCleanupMode,
    retentionDays: effective.usageLogRetentionDays,
  }).catch((error: unknown) => process.stderr.write(`[usage-log] 清理失败：${error instanceof Error ? error.message : String(error)}\n`));
};
pruneUsageLog();
const usageLogTimer = setInterval(pruneUsageLog, 3_600_000);
usageLogTimer.unref();
// TOTP 全局登录认证（提交⑥）：启动时加载凭据；文件缺失视为关闭，门禁不生效
const totp = new TotpAuthService(path.join(dataDir, "totp.json"));
await totp.load();
// 聊天模式（Chat）：独立会话存储（<dataDir>/chat-sessions/）、全局配置（chat.json）、
// 助手预设（chat-assistants.json）与执行引擎；搜索/抓取复用 provider profiles 选定的 web 能力
const chatConfigService = new ChatConfigService(path.join(dataDir, "chat.json"));
// Python 环境预装库：chat.json 的 pythonLibraries 优先，缺省回落内置默认；
// 惰性求值——ensure() 首次建环境时才读取配置（热修改下一轮生效）
const DEFAULT_CHAT_PYTHON_LIBRARIES = ["numpy", "pandas", "matplotlib", "sympy", "scipy", "Pillow"];
const chatPythonEnv = ChatPythonEnv.forDataDir(
  dataDir,
  () => chatConfigService.get().then((c) => c.pythonLibraries ?? DEFAULT_CHAT_PYTHON_LIBRARIES),
);
const chatSessions = new ChatSessionStore(dataDir);
const chatAssistantStore = new ChatAssistantStore(path.join(dataDir, "chat-assistants.json"));
await chatAssistantStore.init();
const chatRunner = new ChatRunner(
  chatSessions, providers, chatPythonEnv,
  search, webFetch,
  // media 工具（image_gen/vision）适配器现读：chat.json + provider profiles 热生效
  chatConfigService, providerProfiles,
  chatAssistantStore,
  // 最大轮次共享基础模式 agentMaxTurns 设置（现读，热生效）
  () => settings.effective().agentMaxTurns,
  // Windows 上 chat python 经 CoreRouter job.* 在 Job Object 内运行
  core,
);
// chat 侧搜索/抓取服务商跟随 provider profiles 热更新（注入即同步一次当前值）
providerProfilesRuntime.setChatRunner(chatRunner);
// 非回环监听：OWC_ACCESS_TOKEN 未显式设置时自动生成并持久化（<dataDir>/access-token，
// 0600），「设置页改监听地址即可用」；token 与 origins 仍可被环境变量覆盖。
// loopback + 显式 env token 保持既有行为（不读令牌文件、不校验长度）。
const accessTokenFile = path.join(dataDir, "access-token");
const resolvedAccessToken = !isLoopbackHost(config.host)
  ? await resolveAccessToken({ envToken: config.accessToken, filePath: accessTokenFile })
  : (config.accessToken ? { token: config.accessToken, source: "env" as const } : undefined);
const authState = resolvedAccessToken
  ? { accessToken: resolvedAccessToken.token, allowedOrigins: config.allowedOrigins, autoAllowSameOrigin: config.autoAllowSameOrigin ?? false }
  : undefined;
const lanAddresses = listLanAddresses();
const app = await buildServer({
  core,
  sessions,
  agent,
  events,
  providers,
  pricing,
  exchangeRates,
  managed,
  webDist: path.resolve(moduleDirectory, "../../web/dist"),
  defaultCurrency: config.defaultCurrency,
  defaultLanguage: config.defaultLanguage,
  settings,
  models,
  usageLog,
  skills,
  compactor,
  vaultService,
  backgroundTasks,
  extensions,
  contentLens,
  providerProfiles,
  providerProfilesRuntime,
  indexManager,
  diagnostics,
  scm,
  evalEvaluator,
  updateChecker,
  updateApplier,
  dataDir,
  cron,
  // 聊天模式（Chat）：/api/chat/* 与 /api/share/* 路由依赖
  chatSessions,
  chatConfig: chatConfigService,
  chatRunner,
  chatAssistants: chatAssistantStore,
  chatPythonEnv,
  // chat 会话删除后释放 "chat-python-<id>" 的 core 侧配置（与 core 同实例）
  coreRouter: core,
  // TOTP 全局登录认证（提交⑥）：凭据 <dataDir>/totp.json（0600），票据仅内存
  totp,
  listenHost: config.host,
  ...(authState ? { auth: authState } : {}),
  ...(resolvedAccessToken
    ? {
        remoteAccess: {
          host: config.host,
          port: config.port,
          tokenSource: resolvedAccessToken.source,
          lanAddresses,
          ...(resolvedAccessToken.source === "generated"
            ? {
                regenerate: async () => {
                  const token = await regenerateAccessToken(accessTokenFile);
                  authState!.accessToken = token;
                  return token;
                },
              }
            : {}),
        },
      }
    : {}),
  getPreferences: () => {
    const effective = settings.effective();
    return { currency: effective.defaultCurrency, language: effective.defaultLanguage };
  },
});

async function shutdown(): Promise<void> {
  clearInterval(gcTimer);
  cron.stop();
  indexManager.stop();
  remoteSyncScheduler.stop();
  providerProfilesRuntime.stop();
  updateChecker.close();
  exchangeRates.close();
  await mcp.close();
  await extensions.close();
  await backgroundTasks.shutdown().catch((error: unknown) => console.error("Background tasks shutdown error:", error));
  await app.close();
  await core.stop();
}

installGracefulShutdown({ shutdown });

await app.listen({ host: config.host, port: config.port });
// 非回环监听：启动后打印一次带 token 的访问链接（局域网/移动端直接打开即写入登录 Cookie）
if (authState && !isLoopbackHost(config.host)) {
  for (const url of buildAccessUrls(config.host, config.port, lanAddresses, authState.accessToken)) {
    console.log(`openwebcode 访问链接: ${url}`);
  }
}
