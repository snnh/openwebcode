import path from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "./agent/agent-runner.js";
import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { CoreClient } from "./core-client.js";
import { EventBus } from "./events/event-bus.js";
import { DevelopmentProvider } from "./providers/development-provider.js";
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
providers.register(new DevelopmentProvider());
const agent = new AgentRunner(sessions, providers, core, events);

core.on("diagnostic", (text: string) => process.stderr.write(`[owc-exec] ${text}`));
core.on("error", (error: Error) => console.error("Core error:", error));

await sessions.initialize();
await core.start();
const app = await buildServer({ core, sessions, agent, events });

async function shutdown(): Promise<void> {
  await app.close();
  await core.stop();
}

process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

await app.listen({ host: config.host, port: config.port });
