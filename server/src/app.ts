import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { existsSync } from "node:fs";
import path from "node:path";
import type { AgentRunner } from "./agent/agent-runner.js";
import { CoreRpcError, type CoreClient, type ExecRequest } from "./core-client.js";
import { ContextManager, type BudgetUpdate } from "./context/context-manager.js";
import { getModelProfile, listModelProfiles, type Currency, type EffortLevel, type ModelPricing, type ThinkingMode } from "./context/model-profile.js";
import { PricingValidationError, type PricingCatalog, type PricingDocument } from "./cost/pricing-catalog.js";
import { parseDecimalToScaled } from "./cost/exchange-rate.js";
import type { AppEvent, EventBus } from "./events/event-bus.js";
import type { ProviderRegistry } from "./providers/provider.js";
import { GitShadowSnapshots } from "./snapshots/git-shadow.js";
import type { PermissionMode } from "./sessions/types.js";
import type { SessionStore } from "./sessions/session-store.js";

interface CreateSessionBody {
  cwd: string;
  provider?: string;
  model?: string;
  title?: string;
}

interface MessageBody {
  content: string;
}

interface SessionConfigBody {
  provider?: string;
  model?: string;
  thinking?: ThinkingMode | null;
  effort?: EffortLevel | null;
  permissionMode?: PermissionMode;
}

interface BudgetBody {
  maxSessionTokens?: number | null;
  maxSessionCost?: { amount: string; currency?: Currency | "RMB" } | null;
}

export interface ServerDependencies {
  core: CoreClient;
  sessions: SessionStore;
  agent: AgentRunner;
  events: EventBus;
  providers: ProviderRegistry;
  pricing: PricingCatalog;
  defaultCurrency?: Currency;
  defaultLanguage?: string;
  webDist?: string;
}

function serializePricing(pricing: ModelPricing): Record<string, string> {
  return {
    currency: pricing.currency,
    input: pricing.input.toString(),
    output: pricing.output.toString(),
    cacheRead: pricing.cacheRead.toString(),
    cacheWrite: pricing.cacheWrite.toString(),
  };
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { core, sessions, agent, events, providers, pricing } = dependencies;
  const defaultCurrency = dependencies.defaultCurrency ?? "CNY";
  const defaultLanguage = dependencies.defaultLanguage ?? "zh-CN";
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  await app.register(websocket);
  if (dependencies.webDist && existsSync(dependencies.webDist)) {
    await app.register(fastifyStatic, { root: dependencies.webDist, prefix: "/" });
  }
  const clients = new Set<{ send(data: string): void; readonly readyState: number; sessionId?: string }>();

  events.on("event", (event: AppEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1 && (!client.sessionId || !event.sessionId || client.sessionId === event.sessionId)) client.send(serialized);
    }
  });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/core", async () => core.ping());
  app.get("/api/providers", async () => providers.list());
  app.get("/api/models", async () => listModelProfiles().map((profile) => ({
    ...profile,
    ...(pricing.get(profile.provider, profile.id) ? {
      pricing: serializePricing(pricing.get(profile.provider, profile.id)!),
    } : {}),
  })));
  app.get("/api/model-pricing", async () => pricing.list());
  app.put<{ Body: PricingDocument }>("/api/model-pricing", async (request, reply) => {
    try {
      const document = await pricing.replace(request.body);
      events.publish({
        source: "server",
        type: "model.pricing_updated",
        payload: { version: document.version, updatedAt: document.updatedAt, entries: document.entries.length },
      });
      return document;
    } catch (error) {
      return reply.code(error instanceof PricingValidationError ? 400 : 500).send({
        error: error instanceof PricingValidationError
          ? error.message
          : "Failed to persist model pricing",
      });
    }
  });
  app.post<{ Body: ExecRequest }>("/api/exec", async (request) => core.run(request.body));

  app.post<{ Body: CreateSessionBody }>("/api/sessions", async (request, reply) => {
    if (!request.body || typeof request.body.cwd !== "string" || !request.body.cwd) {
      return reply.code(400).send({ error: "cwd must be a non-empty string" });
    }
    const provider = request.body.provider ?? "development";
    if (!providers.get(provider)) {
      return reply.code(400).send({ error: `Provider ${provider} is not configured` });
    }
    const session = await sessions.create({ ...request.body, provider });
    events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
    return reply.code(201).send(session);
  });

  app.get("/api/sessions", async () => sessions.list());

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    return session;
  });

  app.put<{ Params: { id: string }; Body: SessionConfigBody }>("/api/sessions/:id/config", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) return reply.code(409).send({ error: "Session is running; update its config when it is idle" });
    const provider = request.body?.provider ?? session.provider;
    const model = request.body?.model ?? session.model;
    if (!providers.get(provider)) return reply.code(400).send({ error: `Provider ${provider} is not configured` });
    if (typeof model !== "string" || !model) return reply.code(400).send({ error: "model must be a non-empty string" });
    const profile = getModelProfile(model);
    const thinking = request.body && "thinking" in request.body ? request.body.thinking ?? undefined : session.thinking;
    const effort = request.body && "effort" in request.body ? request.body.effort ?? undefined : session.effort;
    if (thinking !== undefined && !profile.capabilities.thinking.includes(thinking)) {
      return reply.code(400).send({ error: `Model ${model} does not support thinking mode ${thinking}` });
    }
    if (effort !== undefined && !profile.capabilities.effort.includes(effort)) {
      return reply.code(400).send({ error: `Model ${model} does not support effort ${effort}` });
    }
    const permissionMode = request.body?.permissionMode ?? session.permissionMode ?? "ask";
    if (!["ask", "acceptEdits", "yolo"].includes(permissionMode)) return reply.code(400).send({ error: "permissionMode must be ask, acceptEdits, or yolo" });
    await sessions.updateConfig(request.params.id, { provider, model, ...(thinking ? { thinking } : {}), ...(effort ? { effort } : {}) });
    const updated = await sessions.updatePermissions(request.params.id, permissionMode, session.permissionRules ?? []);
    events.publish({ source: "session", type: "session.config_updated", sessionId: session.id, payload: updated });
    return updated;
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/context", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    const view = await manager.buildView(session.messages);
    return { ...view, preferences: { language: defaultLanguage, currency: defaultCurrency, currencyLabel: defaultCurrency === "CNY" ? "RMB" : "USD" } };
  });

  app.put<{ Params: { id: string }; Body: BudgetBody }>("/api/sessions/:id/context/budget", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; update its budget when it is idle" });
    }
    const tokenValue = request.body?.maxSessionTokens;
    if (tokenValue !== null && tokenValue !== undefined && (!Number.isSafeInteger(tokenValue) || tokenValue < 1)) {
      return reply.code(400).send({ error: "maxSessionTokens must be a positive integer or null" });
    }
    let costValue: { currency: Currency; microUnits: string } | undefined;
    const requestedCost = request.body?.maxSessionCost;
    if (requestedCost !== null && requestedCost !== undefined) {
      const requestedCurrency = requestedCost.currency === "RMB" ? "CNY" : requestedCost.currency ?? defaultCurrency;
      if (!requestedCost || typeof requestedCost.amount !== "string" || !["USD", "CNY"].includes(requestedCurrency)) {
        return reply.code(400).send({ error: "maxSessionCost must contain amount string and optional USD, CNY, or RMB currency, or null" });
      }
      try {
        costValue = {
          currency: requestedCurrency,
          microUnits: parseDecimalToScaled(requestedCost.amount, 1_000_000n).toString(),
        };
      } catch (error) {
        return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) });
      }
    }
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    const update: BudgetUpdate = {};
    if (request.body && "maxSessionTokens" in request.body) update.maxSessionTokens = tokenValue ?? undefined;
    if (request.body && "maxSessionCost" in request.body) update.maxSessionCost = costValue;
    const ledger = await manager.updateBudget(update);
    events.publish({ source: "session", type: "context.budget_updated", sessionId: request.params.id, payload: await manager.budgetStatus() });
    return ledger;
  });
  app.post<{ Params: { id: string }; Body: { messageId: string } }>("/api/sessions/:id/context/restore", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; restore context when it is idle" });
    }
    if (!request.body || typeof request.body.messageId !== "string" || !request.body.messageId) {
      return reply.code(400).send({ error: "messageId must be a non-empty string" });
    }
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    try {
      const ledger = await manager.restore(request.body.messageId);
      events.publish({ source: "session", type: "context.restored", sessionId: request.params.id, payload: { messageId: request.body.messageId } });
      return ledger;
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? { enabled: true, readRoots: [session.cwd], writeRoots: [session.cwd], denyPaths: [], network: "allow" } });
    return core.listFiles({ sessionId: request.params.id, path: request.query.path || "." });
  });
  app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/sessions/:id/files/content", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    if (!request.query.path) return reply.code(400).send({ error: "path is required" });
    await core.configureSession({ sessionId: session.id, cwd: session.cwd, sandbox: session.sandbox ?? { enabled: true, readRoots: [session.cwd], writeRoots: [session.cwd], denyPaths: [], network: "allow" } });
    return core.readFile({ sessionId: request.params.id, path: request.query.path });
  });
  app.get<{ Params: { id: string; checkpointId: string } }>("/api/sessions/:id/checkpoints/:checkpointId/diff", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    return { diff: await new GitShadowSnapshots(sessions.contextRoot(session.id), session.cwd).diff(request.params.checkpointId) };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    return new GitShadowSnapshots(sessions.contextRoot(session.id), session.cwd).list();
  });
  app.post<{ Params: { id: string }; Body: { label?: string } }>("/api/sessions/:id/checkpoints", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    const label = request.body?.label ?? "Manual checkpoint"; if (typeof label !== "string" || !label.trim()) return reply.code(400).send({ error: "label must be a non-empty string" });
    const ledger = await new ContextManager(sessions.contextRoot(session.id)).load();
    const checkpoint = await new GitShadowSnapshots(sessions.contextRoot(session.id), session.cwd).create(label, session.messages.length, ledger);
    events.publish({ source: "session", type: "checkpoint.created", sessionId: session.id, payload: checkpoint }); return reply.code(201).send(checkpoint);
  });
  app.post<{ Params: { id: string; checkpointId: string }; Body: { confirm?: boolean; filesOnly?: boolean } }>("/api/sessions/:id/checkpoints/:checkpointId/restore", async (request, reply) => {
    const session = await sessions.get(request.params.id); if (!session) return reply.code(404).send({ error: "Session not found" });
    if (agent.isRunning(session.id)) return reply.code(409).send({ error: "Session is running" });
    if (request.body?.confirm !== true) return reply.code(400).send({ error: "confirm must be true" });
    const checkpoint = await new GitShadowSnapshots(sessions.contextRoot(session.id), session.cwd).restore(request.params.checkpointId);
    if (!request.body?.filesOnly) { await sessions.truncateMessages(session.id, checkpoint.messageCount); await new ContextManager(sessions.contextRoot(session.id)).replaceLedger(checkpoint.ledger); }
    events.publish({ source: "session", type: "checkpoint.restored", sessionId: session.id, payload: { id: checkpoint.id, filesOnly: request.body?.filesOnly === true } }); return checkpoint;
  });

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; abort it before deletion" });
    }
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    await core.cleanupSession(request.params.id).catch(() => undefined);
    if (!(await sessions.delete(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string }; Body: MessageBody }>(
    "/api/sessions/:id/messages",
    async (request, reply) => {
      if (!request.body || typeof request.body.content !== "string" || !request.body.content) {
        return reply.code(400).send({ error: "content must be a non-empty string" });
      }
      if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
      if (agent.isRunning(request.params.id)) {
        try {
          const queued = agent.enqueueSteering(request.params.id, request.body.content);
          return reply.code(202).send({ accepted: true, queued: true, ...queued });
        } catch (error) {
          return reply.code(error instanceof Error && error.message.includes("full") ? 429 : 409).send({ error: error instanceof Error ? error.message : String(error) });
        }
      }
      const budget = await new ContextManager(sessions.contextRoot(request.params.id)).budgetStatus();
      if (budget.paused) {
        return reply.code(409).send({
          error: budget.cost.paused ? "Session cost budget is exhausted or unavailable" : "Session token budget is exhausted",
          budget,
        });
      }
      void agent.run(request.params.id, request.body.content).catch(() => undefined);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Params: { id: string }; Body: { requestId: string; decision: "allow" | "allow_always" | "deny"; reason?: string } }>("/api/sessions/:id/permissions/respond", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    const body = request.body;
    if (!body || typeof body.requestId !== "string" || !["allow", "allow_always", "deny"].includes(body.decision) || (body.reason !== undefined && typeof body.reason !== "string")) {
      return reply.code(400).send({ error: "requestId, decision allow|allow_always|deny, and optional reason are required" });
    }
    if (!(await agent.respondPermission(request.params.id, body.requestId, body.decision, body.reason))) return reply.code(404).send({ error: "Permission request not found" });
    return { accepted: true };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id/steering", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    return agent.listSteering(request.params.id);
  });
  app.delete<{ Params: { id: string; steeringId: string } }>("/api/sessions/:id/steering/:steeringId", async (request, reply) => {
    if (!(await sessions.get(request.params.id))) return reply.code(404).send({ error: "Session not found" });
    if (!agent.removeSteering(request.params.id, request.params.steeringId)) return reply.code(404).send({ error: "Steering item not found" });
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (request, reply) => {
    if (!agent.abort(request.params.id)) return reply.code(409).send({ error: "Session is not running" });
    return reply.code(202).send({ accepted: true });
  });

  app.get<{ Querystring: { after?: string; sessionId?: string } }>("/api/events", { websocket: true }, (socket, request) => {
    const parsedAfter = Number(request.query.after ?? 0);
    const after = Number.isSafeInteger(parsedAfter) && parsedAfter >= 0 ? parsedAfter : 0;
    const sessionId = request.query.sessionId;
    const replay = events.replay(after, sessionId);
    if (replay.requiresResync) {
      socket.send(JSON.stringify({
        source: "server",
        type: "resync.required",
        seq: replay.latestSeq,
        createdAt: new Date().toISOString(),
        ...(sessionId ? { sessionId } : {}),
        payload: { after, latestSeq: replay.latestSeq },
      }));
    } else {
      for (const event of replay.events) socket.send(JSON.stringify(event));
    }
    const client = {
      get readyState(): number { return socket.readyState; },
      send: (data: string) => socket.send(data),
      ...(sessionId ? { sessionId } : {}),
    };
    clients.add(client);
    socket.send(JSON.stringify({ source: "server", type: "connected", seq: replay.latestSeq, createdAt: new Date().toISOString(), payload: { latestSeq: replay.latestSeq } }));
    socket.on("close", () => clients.delete(client));
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    let code = 500;
    if (normalized instanceof CoreRpcError) {
      if (normalized.code === -32602 || normalized.code === -32600) code = 400;
      else if (normalized.code === -32003) code = 404;
      else if (normalized.code === -32002) code = 403;
      else if (normalized.code === -32001) code = 504;
      else code = 502;
    } else if (normalized.message === "Invalid session ID") {
      code = 400;
    } else if ("code" in normalized && normalized.code === "FST_ERR_VALIDATION") {
      code = 400;
    }
    reply.code(code).send({ error: normalized.message });
  });

  return app;
}
