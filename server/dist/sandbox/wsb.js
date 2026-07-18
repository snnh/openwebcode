import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import path from "node:path";
import { CoreClient } from "../core-client.js";
import { TcpTransport } from "../rpc/transport.js";
export function wsbExePath(systemRoot = process.env.SystemRoot ?? "C:\\Windows") {
    return path.join(systemRoot, "System32", "WindowsSandbox.exe");
}
/** 探测 Windows Sandbox 可选功能是否可用；exists/systemRoot 可注入以便测试。 */
export function detectWsb(options) {
    const exists = options?.exists ?? existsSync;
    if (exists(wsbExePath(options?.systemRoot)))
        return { available: true };
    return { available: false, reason: "未启用 Windows Sandbox 可选功能（需 Windows Pro/Enterprise + 功能开关）" };
}
/** 沙盒内工作目录挂载点（.wsb MappedFolder 的 SandboxFolder，与 CoreRouter 路径翻译共用）。 */
export const WSB_WORKSPACE_MOUNT = "C:\\owc-workspace";
function escapeXml(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
/**
 * 生成 .wsb 配置：workspace → C:\owc-workspace（可写），owc 分发目录 → C:\owc（只读），
 * 登录后让沙盒内的 owc-exec 通过 --connect 回连宿主监听端口；setupScript 先行执行。
 */
export function buildWsbConfig(input) {
    const connect = `C:\\owc\\owc-exec.exe --connect ${input.hostIp}:${input.port}`;
    const inner = input.setupScript?.trim() ? `${input.setupScript.trim()} && ${connect}` : connect;
    const command = `cmd /c "${inner}"`;
    return [
        "<Configuration>",
        "  <MappedFolders>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(input.workspace)}</HostFolder>`,
        `      <SandboxFolder>${WSB_WORKSPACE_MOUNT}</SandboxFolder>`,
        "      <ReadOnly>false</ReadOnly>",
        "    </MappedFolder>",
        "    <MappedFolder>",
        `      <HostFolder>${escapeXml(input.distDir)}</HostFolder>`,
        "      <SandboxFolder>C:\\owc</SandboxFolder>",
        "      <ReadOnly>true</ReadOnly>",
        "    </MappedFolder>",
        "  </MappedFolders>",
        "  <LogonCommand>",
        `    <Command>${escapeXml(command)}</Command>`,
        "  </LogonCommand>",
        "  <Networking>Enable</Networking>",
        "</Configuration>",
        "",
    ].join("\n");
}
/** 宿主上供 WSB 回连的第一个非 loopback IPv4 地址。 */
export function defaultHostIp() {
    for (const list of Object.values(networkInterfaces())) {
        for (const item of list ?? []) {
            if (item.family === "IPv4" && !item.internal)
                return item.address;
        }
    }
    return undefined;
}
/** 一个 WSB 虚拟机会话：监听回连端口 → 写 .wsb → 拉起 WindowsSandbox → 接管回连 socket 完成握手。 */
export class WsbSession {
    options;
    server;
    child;
    client;
    wsbPath;
    constructor(options) {
        this.options = options;
    }
    async start() {
        const availability = detectWsb();
        if (!availability.available)
            throw new Error(availability.reason ?? "Windows Sandbox is not available");
        const server = createServer();
        this.server = server;
        await new Promise((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "0.0.0.0", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string")
            throw new Error("WSB listener did not bind a port");
        const hostIp = (this.options.pickHostIp ?? defaultHostIp)();
        if (!hostIp)
            throw new Error("No non-loopback IPv4 address for the sandbox to connect back to");
        await mkdir(this.options.sessionRoot, { recursive: true });
        this.wsbPath = path.join(this.options.sessionRoot, "sandbox.wsb");
        await writeFile(this.wsbPath, buildWsbConfig({
            workspace: this.options.workspace,
            distDir: this.options.distDir,
            hostIp,
            port: address.port,
            ...(this.options.setupScript ? { setupScript: this.options.setupScript } : {}),
        }), "utf8");
        const spawnWsb = this.options.spawnWsb ?? ((wsbPath) => spawn(wsbExePath(), [wsbPath], { windowsHide: true, stdio: "ignore" }));
        this.child = spawnWsb(this.wsbPath);
        const socket = await this.waitForConnection();
        // 只需一条回连；拿到 socket 后关掉监听器
        server.close();
        this.server = undefined;
        const client = new CoreClient("wsb", this.options.requestTimeoutMs ?? 130_000, () => Promise.resolve({ transport: new TcpTransport(socket) }));
        this.client = client;
        await client.start();
        return client;
    }
    waitForConnection() {
        const server = this.server;
        if (!server)
            return Promise.reject(new Error("WSB listener is not running"));
        const timeoutMs = this.options.connectTimeoutMs ?? 120_000;
        return new Promise((resolve, reject) => {
            const finish = (error, socket) => {
                clearTimeout(timer);
                server.removeAllListeners("connection");
                if (socket)
                    resolve(socket);
                else
                    reject(error ?? new Error("WSB connection wait failed"));
            };
            const timer = setTimeout(() => finish(new Error(`Sandbox core did not connect back within ${timeoutMs}ms`)), timeoutMs);
            server.once("connection", (socket) => finish(undefined, socket));
            if (this.child) {
                this.child.once("error", (error) => finish(error));
                this.child.once("exit", (code) => finish(new Error(`WindowsSandbox.exe exited before the core connected back (code ${code ?? "unknown"})`)));
            }
        });
    }
    /** 关闭 socket、杀掉 WindowsSandbox 进程树（虚拟机随之蒸发）、清理 .wsb 文件。 */
    async stop() {
        const client = this.client;
        this.client = undefined;
        if (client)
            await client.stop().catch(() => undefined);
        this.server?.close();
        this.server = undefined;
        const child = this.child;
        this.child = undefined;
        if (child && child.exitCode === null && child.pid !== undefined) {
            if (process.platform === "win32") {
                await new Promise((resolve) => {
                    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
                    killer.once("exit", () => resolve());
                    killer.once("error", () => resolve());
                });
            }
            else {
                child.kill();
            }
        }
        if (this.wsbPath)
            await rm(this.wsbPath, { force: true }).catch(() => undefined);
        this.wsbPath = undefined;
    }
}
/** 按会话懒启动并缓存 WSB 沙盒 core 客户端。 */
export class WsbManager {
    options;
    pending = new Map();
    sessions = new Map();
    resolved = new Map();
    /** CoreRouter 注入：转发沙盒内 core 的事件（exec.output 等）给上层 */
    onClientCreated;
    constructor(options) {
        this.options = options;
    }
    acquire(sessionId, session) {
        const existing = this.pending.get(sessionId);
        if (existing)
            return existing;
        const wsbSession = new WsbSession({
            sessionId,
            sessionRoot: this.options.sessionRootFor(sessionId),
            workspace: session.cwd,
            distDir: path.dirname(this.options.corePath),
            ...(session.setupScript ? { setupScript: session.setupScript } : {}),
            ...(this.options.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.options.requestTimeoutMs } : {}),
            ...(this.options.connectTimeoutMs !== undefined ? { connectTimeoutMs: this.options.connectTimeoutMs } : {}),
            ...(this.options.spawnWsb ? { spawnWsb: this.options.spawnWsb } : {}),
            ...(this.options.pickHostIp ? { pickHostIp: this.options.pickHostIp } : {}),
        });
        const promise = wsbSession.start().then(async (client) => {
            if (this.pending.get(sessionId) !== promise) {
                // 启动期间被 release：立即回收，避免虚拟机泄漏
                await wsbSession.stop();
                throw new Error("WSB session was released during startup");
            }
            this.sessions.set(sessionId, wsbSession);
            this.resolved.set(sessionId, client);
            this.onClientCreated?.(sessionId, client);
            return client;
        }, (error) => {
            this.pending.delete(sessionId);
            throw error instanceof Error ? error : new Error(String(error));
        });
        this.pending.set(sessionId, promise);
        return promise;
    }
    /** 已建立连接的客户端；不会触发懒启动。 */
    peek(sessionId) {
        return this.resolved.get(sessionId);
    }
    async release(sessionId) {
        this.pending.delete(sessionId);
        this.resolved.delete(sessionId);
        const wsbSession = this.sessions.get(sessionId);
        this.sessions.delete(sessionId);
        if (wsbSession)
            await wsbSession.stop().catch(() => undefined);
    }
    async releaseAll() {
        await Promise.all([...this.sessions.keys()].map((sessionId) => this.release(sessionId)));
    }
}
