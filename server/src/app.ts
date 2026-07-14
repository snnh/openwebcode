import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { CoreRpcError, type CoreClient, type CoreEvent, type ExecRequest } from "./core-client.js";

interface ExecBody extends ExecRequest {}

export async function buildServer(core: CoreClient): Promise<FastifyInstance> {
  const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
  await app.register(websocket);
  const clients = new Set<{ send(data: string): void; readyState: number }>();

  core.on("event", (event: CoreEvent) => {
    const serialized = JSON.stringify(event);
    for (const client of clients) {
      if (client.readyState === 1) client.send(serialized);
    }
  });

  app.get("/api/health", async () => ({ status: "ok" }));
  app.get("/api/core", async () => core.ping());

  app.post<{ Body: ExecBody }>("/api/exec", async (request, reply) => {
    const body = request.body;
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "Request body must be an object" });
    }
    return core.run(body);
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
    } else if ("code" in normalized && normalized.code === "FST_ERR_VALIDATION") {
      code = 400;
    }
    reply.code(code).send({ error: normalized.message });
  });

  return app;
}
