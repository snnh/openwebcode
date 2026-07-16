import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { StdioTransport } from "./rpc/transport.js";
export class CoreRpcError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "CoreRpcError";
    }
}
export class CoreClient extends EventEmitter {
    corePath;
    requestTimeoutMs;
    transport;
    child;
    pending = new Map();
    nextId = 1;
    stopping = false;
    restartCount = 0;
    restartTimer;
    startPromise;
    generation = 0;
    failedGeneration = 0;
    constructor(corePath, requestTimeoutMs = 130_000) {
        super();
        this.corePath = corePath;
        this.requestTimeoutMs = requestTimeoutMs;
    }
    start() {
        if (this.startPromise)
            return this.startPromise;
        this.stopping = false;
        const generation = ++this.generation;
        this.startPromise = this.spawnAndHandshake(generation).catch((error) => {
            this.failConnection(generation, error instanceof Error ? error : new Error(String(error)));
            throw error;
        });
        return this.startPromise;
    }
    async stop() {
        this.stopping = true;
        if (this.restartTimer)
            clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        const generation = this.generation;
        const transport = this.transport;
        if (transport) {
            try {
                await this.call("core.shutdown", {}, 5_000);
            }
            catch {
                this.child?.kill();
            }
            try {
                await transport.close();
            }
            catch {
                this.child?.kill();
            }
        }
        this.failConnection(generation, new Error("Core client stopped"), false);
        this.startPromise = undefined;
    }
    ping() {
        return this.call("core.ping", {});
    }
    run(request) {
        return this.call("exec.run", request, (request.timeoutMs ?? 120_000) + 10_000);
    }
    configureSession(request) { return this.call("session.configure", request); }
    cleanupSession(sessionId) { return this.call("session.cleanup", { sessionId }); }
    readFile(request) { return this.call("fs.read", request); }
    writeFile(request) { return this.call("fs.write", request); }
    editFile(request) { return this.call("fs.edit", request); }
    listFiles(request) { return this.call("fs.list", request); }
    globFiles(request) { return this.call("fs.glob", request); }
    grepFiles(request) { return this.call("fs.grep", request); }
    async spawnAndHandshake(generation) {
        const executable = this.resolveCorePath();
        const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const transport = new StdioTransport(child);
        this.child = child;
        this.transport = transport;
        transport.on("message", (message) => this.onMessage(generation, message));
        transport.on("diagnostic", (text) => this.emit("diagnostic", text));
        transport.on("error", (error) => this.failConnection(generation, normalizeError(error)));
        transport.on("close", (details) => this.failConnection(generation, new Error("Core process exited"), true, details));
        const info = await this.ping();
        if (generation !== this.generation || this.failedGeneration === generation)
            throw new Error("Core process exited during handshake");
        this.restartCount = 0;
        this.emitEvent("core.ready", info);
        return info;
    }
    resolveCorePath() {
        if (path.isAbsolute(this.corePath))
            return this.corePath;
        const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
        return path.resolve(moduleDirectory, "..", this.corePath);
    }
    call(method, params, timeoutMs = this.requestTimeoutMs) {
        const transport = this.transport;
        const generation = this.generation;
        if (!transport || this.failedGeneration === generation)
            return Promise.reject(new Error("Core is not running"));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const error = new Error(`Core request ${method} timed out`);
                this.failConnection(generation, error);
            }, timeoutMs);
            this.pending.set(id, { resolve: (value) => resolve(value), reject, timer, generation });
            try {
                transport.write({ jsonrpc: "2.0", id, method, params });
            }
            catch (error) {
                this.failConnection(generation, normalizeError(error));
            }
        });
    }
    onMessage(generation, message) {
        if (generation !== this.generation || !message || typeof message !== "object")
            return;
        if ("method" in message) {
            const notification = message;
            if (notification.jsonrpc !== "2.0" || typeof notification.method !== "string") {
                this.failConnection(generation, new Error("Malformed RPC notification"));
                return;
            }
            this.emitEvent(notification.method, notification.params);
            return;
        }
        const response = message;
        if (response.jsonrpc !== "2.0" || typeof response.id !== "number") {
            this.failConnection(generation, new Error("Malformed RPC response"));
            return;
        }
        const hasResult = Object.prototype.hasOwnProperty.call(response, "result");
        const hasError = Object.prototype.hasOwnProperty.call(response, "error");
        if (hasResult === hasError || (hasError && !isRpcError(response.error))) {
            this.failConnection(generation, new Error("Malformed RPC response"));
            return;
        }
        const pending = this.pending.get(response.id);
        if (!pending || pending.generation !== generation)
            return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (hasError && response.error)
            pending.reject(new CoreRpcError(response.error.code, response.error.message));
        else
            pending.resolve(response.result);
    }
    failConnection(generation, error, restart = true, details) {
        if (generation !== this.generation || this.failedGeneration === generation)
            return;
        this.failedGeneration = generation;
        const child = this.child;
        this.transport = undefined;
        this.child = undefined;
        this.startPromise = undefined;
        for (const [id, pending] of this.pending) {
            if (pending.generation !== generation)
                continue;
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
        if (child && child.exitCode === null)
            child.kill();
        this.emitEvent("core.exit", details ?? { message: error.message });
        if (this.stopping || !restart || this.restartCount >= 3)
            return;
        const delay = 250 * 2 ** this.restartCount++;
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            this.start().catch((restartError) => this.emit("error", normalizeError(restartError)));
        }, delay);
    }
    emitEvent(type, payload) {
        const event = { source: "core", type, payload };
        this.emit("event", event);
    }
}
function isRpcError(value) {
    return Boolean(value) && typeof value === "object" &&
        typeof value.code === "number" &&
        typeof value.message === "string";
}
function normalizeError(error) {
    return error instanceof Error ? error : new Error(String(error));
}
