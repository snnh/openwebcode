import { EventEmitter } from "node:events";
import path from "node:path";
import { AgentRunner } from "../../src/agent/agent-runner.js";
import { buildServer } from "../../src/app.js";
import type { CoreClientLike } from "../../src/core-client.js";
import { PricingCatalog } from "../../src/cost/pricing-catalog.js";
import { EventBus } from "../../src/events/event-bus.js";
import { ProviderRegistry } from "../../src/providers/provider.js";
import { SessionStore } from "../../src/sessions/session-store.js";
import { makeStubProvider } from "./stub-provider.js";
import { tempRoot } from "./temp-roots.js";

/**
 * export.html / export.md 路由只读 SessionStore，core 用最小 fake 即可满足 buildServer 依赖。
 * title 会被断言传进导出产物，各测试文件必须保留自己的标题。
 */
export async function makeExportHarness(options: { title: string; tempPrefix: string }) {
  const root = await tempRoot(options.tempPrefix);
  const sessions = new SessionStore(path.join(root, "sessions"));
  await sessions.initialize();
  const session = await sessions.create({ cwd: root, provider: "test-stub", model: "deterministic-tool-loop", title: options.title });
  const pricing = new PricingCatalog(path.join(root, "pricing.json"));
  await pricing.initialize();
  const events = new EventBus();
  const providers = new ProviderRegistry();
  providers.register(makeStubProvider("test-stub", async function* () {
    yield { type: "done", stopReason: "end_turn" };
  }));
  const core = new EventEmitter() as unknown as CoreClientLike;
  const agent = new AgentRunner(sessions, providers, core, events, pricing);
  const app = await buildServer({ core, sessions, agent, events, providers, pricing });
  return { root, sessions, session, app };
}
