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
    constructor(corePath, requestTimeoutMs = 130_000) {
        super();
        this.corePath = corePath;
        this.requestTimeoutMs = requestTimeoutMs;
    }
    start() {
        if (this.startPromise)
            return this.startPromise;
        this.stopping = false;
        this.startPromise = this.spawnAndHandshake();
        return this.startPromise;
    }
    async stop() {
        this.stopping = true;
        if (this.restartTimer)
            clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        if (!this.transport)
            return;
        try {
            await this.call("core.shutdown", {}, 5_000);
        }
        catch {
            this.child?.kill();
        }
        await this.transport.close();
        this.transport = undefined;
        this.child = undefined;
        this.startPromise = undefined;
    }
    ping() {
        return this.call("core.ping", {});
    }
    run(request) {
        return this.call("exec.run", request, (request.timeoutMs ?? 120_000) + 10_000);
    }
    async spawnAndHandshake() {
        const executable = this.resolveCorePath();
        const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        this.child = child;
        const transport = new StdioTransport(child);
        this.transport = transport;
        transport.on("message", (message) => this.onMessage(message));
        transport.on("diagnostic", (text) => this.emit("diagnostic", text));
        transport.on("error", (error) => this.emit("error", error));
        transport.on("close", (details) => this.onClose(details));
        const info = await this.ping();
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
        if (!transport)
            return Promise.reject(new Error("Core is not running"));
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Core request ${method} timed out`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
            });
            transport.write({ jsonrpc: "2.0", id, method, params });
        });
    }
    onMessage(message) {
        if (!message || typeof message !== "object")
            return;
        if ("method" in message) {
            const notification = message;
            this.emitEvent(notification.method, notification.params);
            return;
        }
        const response = message;
        if (typeof response.id !== "number")
            return;
        const pending = this.pending.get(response.id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error)
            pending.reject(new CoreRpcError(response.error.code, response.error.message));
        else
            pending.resolve(response.result);
    }
    emitEvent(type, payload) {
        const event = { source: "core", type, payload };
        this.emit("event", event);
    }
    onClose(details) {
        this.transport = undefined;
        this.child = undefined;
        this.startPromise = undefined;
        const error = new Error("Core process exited");
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
        this.emitEvent("core.exit", details);
        if (this.stopping || this.restartCount >= 3)
            return;
        const delay = 250 * 2 ** this.restartCount++;
        this.restartTimer = setTimeout(() => {
            this.start().catch((restartError) => this.emit("error", restartError));
        }, delay);
    }
}
