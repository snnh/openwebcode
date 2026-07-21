import { EventEmitter } from "node:events";
import { WSB_WORKSPACE_MOUNT } from "./wsb.js";
/**
 * 宿主路径 → WSB 沙盒内路径：仅翻译会话工作目录前缀（沙盒只能看到挂载点内的树），
 * 目录外路径原样透传——沙盒本就无法访问，由沙盒内 core 按现有策略拒绝。
 * exec.run 的 cmd 字符串内嵌路径不做翻译（不可可靠解析），调用方应使用相对路径。
 */
export function toSandboxPath(hostPath, workspace) {
    const target = hostPath.replace(/\//g, "\\");
    const root = workspace.replace(/\//g, "\\");
    const lower = target.toLowerCase();
    const rootLower = root.toLowerCase();
    if (lower === rootLower)
        return WSB_WORKSPACE_MOUNT;
    if (lower.startsWith(`${rootLower}\\`))
        return WSB_WORKSPACE_MOUNT + target.slice(root.length);
    return hostPath;
}
/** wsb 会话的请求路径翻译；其余会话原样返回 */
function translatePath(request, meta) {
    if (meta?.sandboxMode !== "wsb" || !meta.cwd)
        return request;
    return { ...request, path: toSandboxPath(request.path, meta.cwd) };
}
/**
 * 按会话路由 core 调用：sandboxMode=="wsb" 的会话走 WsbManager 懒启动的沙盒内 core，
 * 其余会话共享宿主机 CoreClient。只实现 agent-runner/app/settings 实际用到的方法子集，
 * 与 CoreClient 同构（CoreClientLike）。
 */
export class CoreRouter extends EventEmitter {
    shared;
    sessions;
    wsb;
    /** 全局 Job Object 资源限制覆盖（仅 Windows）；缺省不下发，core 用内置默认值。 */
    jobObject;
    /** AppContainer 额外可写目录；WSB 会话不映射宿主机目录。 */
    allowPaths;
    constructor(shared, sessions, wsb, jobObject, allowPaths) {
        super();
        this.shared = shared;
        this.sessions = sessions;
        this.wsb = wsb;
        this.jobObject = jobObject;
        this.allowPaths = allowPaths;
        for (const event of ["event", "diagnostic", "error"]) {
            shared.on(event, (...args) => this.emit(event, ...args));
        }
        this.wsb.onClientCreated = (_sessionId, client) => {
            for (const event of ["event", "diagnostic", "error"]) {
                client.on(event, (...args) => this.emit(event, ...args));
            }
        };
    }
    /** sandboxMode → 下发给 core 的策略：wsb/off 由 VM/关闭充当边界；jobobject 下发兼容模式；jobObject 限制仅随启用路径下发 */
    static policyFor(meta, sandbox, jobObject, allowPaths) {
        const mode = meta?.sandboxMode;
        if (mode === "wsb" || mode === "off")
            return { ...sandbox, enabled: false };
        const limits = {
            ...(allowPaths && allowPaths.length > 0 ? { allowPaths } : {}),
            ...(jobObject?.memoryMB !== undefined ? { jobMemoryMB: jobObject.memoryMB } : {}),
            ...(jobObject?.maxProcesses !== undefined ? { jobMaxProcesses: jobObject.maxProcesses } : {}),
        };
        if (mode === "jobobject")
            return { ...sandbox, ...limits, mode: "jobobject" };
        return { ...sandbox, ...limits };
    }
    async metaFor(sessionId) {
        return this.sessions.get(sessionId).catch(() => undefined);
    }
    async clientFor(sessionId) {
        const meta = await this.metaFor(sessionId);
        if (meta?.sandboxMode === "wsb")
            return { client: await this.wsb.acquire(sessionId, meta), meta };
        return { client: this.shared, meta };
    }
    start() {
        return this.shared.start();
    }
    async stop() {
        await this.wsb.releaseAll().catch(() => undefined);
        await this.shared.stop();
    }
    ping() {
        return this.shared.ping();
    }
    setRequestTimeoutMs(timeoutMs) {
        this.shared.setRequestTimeoutMs(timeoutMs);
    }
    /** 释放会话持有的沙盒 core（WSB 虚拟机蒸发）；非 wsb 会话为 no-op。 */
    async release(sessionId) {
        await this.wsb.release(sessionId);
    }
    async configureSession(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
        return client.configureSession({ ...request, cwd, sandbox: CoreRouter.policyFor(meta, request.sandbox, this.jobObject, this.allowPaths) });
    }
    async cleanupSession(sessionId) {
        const meta = await this.metaFor(sessionId);
        if (meta?.sandboxMode === "wsb") {
            // 不为清理而启动虚拟机；沙盒 core 存在才通知（虚拟机整体由 release 回收）
            const client = this.wsb.peek(sessionId);
            if (client)
                await client.cleanupSession(sessionId).catch(() => undefined);
            return { ok: true };
        }
        return this.shared.cleanupSession(sessionId);
    }
    async run(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        const cwd = meta?.sandboxMode === "wsb" && meta.cwd ? toSandboxPath(request.cwd, meta.cwd) : request.cwd;
        return client.run({ ...request, cwd });
    }
    async readFile(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        return client.readFile(translatePath(request, meta));
    }
    async writeFile(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        return client.writeFile(translatePath(request, meta));
    }
    async writeFileBase64(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        if (!client.writeFileBase64)
            throw new Error("Core binary upload support is unavailable");
        return client.writeFileBase64(translatePath(request, meta));
    }
    async editFile(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        return client.editFile(translatePath(request, meta));
    }
    async listFiles(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        return client.listFiles(translatePath(request, meta));
    }
    async globFiles(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        return client.globFiles(translatePath(request, meta));
    }
    async grepFiles(request) {
        const { client, meta } = await this.clientFor(request.sessionId);
        return client.grepFiles(translatePath(request, meta));
    }
}
