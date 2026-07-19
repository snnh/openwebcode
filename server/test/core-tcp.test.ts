import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CoreClient } from "../src/core-client.js";
import { TcpTransport } from "../src/rpc/transport.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corePath = process.env.OWC_CORE_PATH ?? path.resolve(
  here,
  process.platform === "win32" ? "../../build/Debug/owc-exec.exe" : "../../build/owc-exec",
);
const coreExists = existsSync(corePath);
const itIfCore = coreExists ? it : it.skip;

let server: Server | undefined;
let child: ChildProcess | undefined;
let client: CoreClient | undefined;

afterEach(async () => {
  await client?.stop().catch(() => undefined);
  client = undefined;
  if (child && child.exitCode === null) child.kill();
  child = undefined;
  server?.close();
  server = undefined;
});

describe.skipIf(!existsSync(corePath))("owc-exec --connect TCP loopback", () => {
  itIfCore("handshakes core.ping over the connect-back socket", async () => {
    server = createServer();
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener did not bind a port");
    const socketPromise = new Promise<Socket>((resolve) => server!.once("connection", resolve));
    child = spawn(corePath, ["--connect", `127.0.0.1:${address.port}`], { windowsHide: true });
    const socket = await socketPromise;
    // 复用 CoreClient 的外部连接注入：传输为回连 TCP socket，完成真实握手
    client = new CoreClient(corePath, 10_000, () => Promise.resolve({ transport: new TcpTransport(socket) }));
    const info = await client.start();
    expect(["windows", "linux", "darwin"]).toContain(info.platform);
    expect(info.sandboxCapability).toBeTruthy();
    await client.stop();
    client = undefined;
    // core.shutdown 后进程应自行退出
    await new Promise<void>((resolve) => {
      if (child!.exitCode !== null) return resolve();
      child!.once("exit", () => resolve());
      setTimeout(resolve, 5_000);
    });
    expect(child.exitCode).toBe(0);
  }, 30_000);

  itIfCore("rejects invalid arguments with usage on stderr and exit code 2", async () => {
    const result = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      const proc = spawn(corePath, ["--bogus"], { windowsHide: true });
      let stderr = "";
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      proc.once("exit", (code) => resolve({ code, stderr }));
    });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("usage:");
  }, 15_000);

  itIfCore("fails to connect with a non-zero exit code", async () => {
    // 在空闲端口上连接应立即失败
    server = createServer();
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("listener did not bind a port");
    server.close();
    server = undefined;
    const code = await new Promise<number | null>((resolve) => {
      child = spawn(corePath, ["--connect", `127.0.0.1:${address.port}`], { windowsHide: true });
      child.once("exit", resolve);
    });
    expect(code).toBe(1);
  }, 15_000);
});
