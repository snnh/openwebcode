import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Socket } from "node:net";
import { encodeFrame, FrameDecoder } from "./frame-codec.js";

export abstract class RpcTransport extends EventEmitter {
  abstract write(message: unknown): void;
  abstract close(): Promise<void>;
}

abstract class StreamTransport extends RpcTransport {
  private readonly decoder = new FrameDecoder();

  protected constructor() {
    super();
    this.decoder.on("message", (message) => this.emit("message", message));
    this.decoder.on("error", (error) => this.emit("error", error));
  }

  protected receive(chunk: Buffer): void {
    this.decoder.push(chunk);
  }
}

export class StdioTransport extends StreamTransport {
  constructor(private readonly process: ChildProcessWithoutNullStreams) {
    super();
    process.stdout.on("data", (chunk: Buffer) => this.receive(chunk));
    process.stderr.on("data", (chunk: Buffer) => this.emit("diagnostic", chunk.toString("utf8")));
    process.on("error", (error) => this.emit("error", error));
    process.on("exit", (code, signal) => this.emit("close", { code, signal }));
  }

  write(message: unknown): void {
    if (!this.process.stdin.write(encodeFrame(message))) {
      this.process.stdin.once("drain", () => this.emit("drain"));
    }
  }

  async close(): Promise<void> {
    if (this.process.exitCode !== null) return;
    this.process.stdin.end();
    await new Promise<void>((resolve) => this.process.once("exit", () => resolve()));
  }
}

export class TcpTransport extends StreamTransport {
  constructor(private readonly socket: Socket) {
    super();
    socket.on("data", (chunk) => this.receive(chunk));
    socket.on("error", (error) => this.emit("error", error));
    socket.on("close", () => this.emit("close", { code: null, signal: null }));
  }

  write(message: unknown): void {
    this.socket.write(encodeFrame(message));
  }

  async close(): Promise<void> {
    if (this.socket.destroyed) return;
    this.socket.end();
    await new Promise<void>((resolve) => this.socket.once("close", resolve));
  }
}
