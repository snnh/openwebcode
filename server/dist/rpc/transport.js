import { EventEmitter } from "node:events";
import { encodeFrame, FrameDecoder } from "./frame-codec.js";
export class RpcTransport extends EventEmitter {
}
class StreamTransport extends RpcTransport {
    decoder = new FrameDecoder();
    constructor() {
        super();
        this.decoder.on("message", (message) => this.emit("message", message));
        this.decoder.on("error", (error) => this.emit("error", error));
    }
    receive(chunk) {
        this.decoder.push(chunk);
    }
}
export class StdioTransport extends StreamTransport {
    process;
    constructor(process) {
        super();
        this.process = process;
        process.stdout.on("data", (chunk) => this.receive(chunk));
        process.stderr.on("data", (chunk) => this.emit("diagnostic", chunk.toString("utf8")));
        process.stdin.on("error", (error) => this.emit("error", error));
        process.on("error", (error) => this.emit("error", error));
        process.on("exit", (code, signal) => this.emit("close", { code, signal }));
    }
    write(message) {
        if (!this.process.stdin.write(encodeFrame(message))) {
            this.process.stdin.once("drain", () => this.emit("drain"));
        }
    }
    async close() {
        if (this.process.exitCode !== null)
            return;
        this.process.stdin.end();
        await new Promise((resolve) => this.process.once("exit", () => resolve()));
    }
}
export class TcpTransport extends StreamTransport {
    socket;
    constructor(socket) {
        super();
        this.socket = socket;
        socket.on("data", (chunk) => this.receive(chunk));
        socket.on("error", (error) => this.emit("error", error));
        socket.on("close", () => this.emit("close", { code: null, signal: null }));
    }
    write(message) {
        this.socket.write(encodeFrame(message));
    }
    async close() {
        if (this.socket.destroyed)
            return;
        this.socket.end();
        await new Promise((resolve) => this.socket.once("close", resolve));
    }
}
