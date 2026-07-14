import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { CoreRpcError } from "./core-client.js";
export async function buildServer(dependencies) {
    const { core, sessions, agent, events } = dependencies;
    const app = Fastify({ logger: true, bodyLimit: 1024 * 1024 });
    await app.register(websocket);
    const clients = new Set();
    events.on("event", (event) => {
        const serialized = JSON.stringify(event);
        for (const client of clients) {
            if (client.readyState === 1)
                client.send(serialized);
        }
    });
    app.get("/api/health", async () => ({ status: "ok" }));
    app.get("/api/core", async () => core.ping());
    app.post("/api/exec", async (request) => core.run(request.body));
    app.post("/api/sessions", async (request, reply) => {
        if (!request.body || typeof request.body.cwd !== "string" || !request.body.cwd) {
            return reply.code(400).send({ error: "cwd must be a non-empty string" });
        }
        const session = await sessions.create(request.body);
        events.publish({ source: "session", type: "session.created", sessionId: session.id, payload: session });
        return reply.code(201).send(session);
    });
    app.get("/api/sessions", async () => sessions.list());
    app.get("/api/sessions/:id", async (request, reply) => {
        const session = await sessions.get(request.params.id);
        if (!session)
            return reply.code(404).send({ error: "Session not found" });
        return session;
    });
    app.delete("/api/sessions/:id", async (request, reply) => {
        if (agent.isRunning(request.params.id)) {
            return reply.code(409).send({ error: "Session is running; abort it before deletion" });
        }
        if (!(await sessions.delete(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        return reply.code(204).send();
    });
    app.post("/api/sessions/:id/messages", async (request, reply) => {
        if (!request.body || typeof request.body.content !== "string" || !request.body.content) {
            return reply.code(400).send({ error: "content must be a non-empty string" });
        }
        if (!(await sessions.get(request.params.id)))
            return reply.code(404).send({ error: "Session not found" });
        if (agent.isRunning(request.params.id)) {
            return reply.code(409).send({ error: "Session agent is already running" });
        }
        void agent.run(request.params.id, request.body.content).catch(() => undefined);
        return reply.code(202).send({ accepted: true });
    });
    app.post("/api/sessions/:id/abort", async (request, reply) => {
        if (!agent.abort(request.params.id))
            return reply.code(409).send({ error: "Session is not running" });
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
            if (normalized.code === -32602 || normalized.code === -32600)
                code = 400;
            else if (normalized.code === -32001)
                code = 504;
            else
                code = 502;
        }
        else if (normalized.message === "Invalid session ID") {
            code = 400;
        }
        else if ("code" in normalized && normalized.code === "FST_ERR_VALIDATION") {
            code = 400;
        }
        reply.code(code).send({ error: normalized.message });
    });
    return app;
}
