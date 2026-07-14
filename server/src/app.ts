import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { AgentRunner } from "./agent/agent-runner.js";
import { CoreRpcError, type CoreClient, type ExecRequest } from "./core-client.js";
import { ContextManager } from "./context/context-manager.js";
import type { AppEvent, EventBus } from "./events/event-bus.js";
import type { ProviderRegistry } from "./providers/provider.js";
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

export interface ServerDependencies {
  core: CoreClient;
  sessions: SessionStore;
  agent: AgentRunner;
  events: EventBus;
  providers: ProviderRegistry;
}

export async function buildServer(dependencies: ServerDependencies): Promise<FastifyInstance> {
  const { core, sessions, agent, events, providers } = dependencies;
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  await app.register(websocket);
  const clients = new Set<{ send(data: string): void; readyState: number }>();

  events.on("event", (event: AppEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1) client.send(serialized);
    }
  });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/core", async () => core.ping());
  app.get("/api/providers", async () => providers.list());
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

  app.get<{ Params: { id: string } }>("/api/sessions/:id/context", async (request, reply) => {
    const session = await sessions.get(request.params.id);
    if (!session) return reply.code(404).send({ error: "Session not found" });
    const manager = new ContextManager(sessions.contextRoot(request.params.id));
    return manager.buildView(session.messages);
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

  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (request, reply) => {
    if (agent.isRunning(request.params.id)) {
      return reply.code(409).send({ error: "Session is running; abort it before deletion" });
    }
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
        return reply.code(409).send({ error: "Session agent is already running" });
      }
      void agent.run(request.params.id, request.body.content).catch(() => undefined);
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post<{ Params: { id: string } }>("/api/sessions/:id/abort", async (request, reply) => {
    if (!agent.abort(request.params.id)) return reply.code(409).send({ error: "Session is not running" });
    return reply.code(202).send({ accepted: true });
  });

  app.get("/api/events", { websocket: true }, (socket) => {
    clients.add(socket);
    socket.send(JSON.stringify({ source: "server", type: "connected", payload: null }));
    socket.on("close", () => clients.delete(socket));
  });

  app.setErrorHandler((error, _request, reply) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    let code = 500;
    if (normalized instanceof CoreRpcError) {
      if (normalized.code === -32602 || normalized.code === -32600) code = 400;
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
