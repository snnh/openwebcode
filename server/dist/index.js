import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { CoreClient } from "./core-client.js";
const config = loadConfig();
const core = new CoreClient(config.corePath, config.coreRequestTimeoutMs);
core.on("diagnostic", (text) => process.stderr.write(`[owc-exec] ${text}`));
core.on("error", (error) => console.error("Core error:", error));
await core.start();
const app = await buildServer(core);
async function shutdown() {
    await app.close();
    await core.stop();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
await app.listen({ host: config.host, port: config.port });
