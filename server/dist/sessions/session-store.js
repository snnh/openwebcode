import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { parseSessionImport, serializeSession } from "./session-transfer.js";
export class SessionStore {
    root;
    constructor(root) {
        this.root = root;
    }
    async initialize() {
        await mkdir(this.root, { recursive: true });
    }
    async create(input) {
        const now = new Date().toISOString();
        const resolvedCwd = path.resolve(input.cwd);
        const meta = {
            id: input.id ?? randomUUID(),
            cwd: resolvedCwd,
            provider: input.provider ?? "development",
            model: input.model ?? "deterministic-tool-loop",
            sandbox: { enabled: true, readRoots: [resolvedCwd], writeRoots: [resolvedCwd], denyPaths: [path.join(resolvedCwd, ".env")], network: "allow" },
            title: input.title ?? "New session",
            createdAt: now,
            updatedAt: now,
            ...(input.workspace ? { workspace: input.workspace } : {}),
            ...(input.snapshotBackend ? { snapshotBackend: input.snapshotBackend } : {}),
        };
        // appcontainer 为默认不落盘；setupScript 仅非空时保留
        if (input.sandboxMode && input.sandboxMode !== "appcontainer")
            meta.sandboxMode = input.sandboxMode;
        if (input.setupScript?.trim())
            meta.setupScript = input.setupScript;
        if (input.agentMode === "plan")
            meta.agentMode = "plan";
        await mkdir(this.sessionPath(meta.id), { recursive: false });
        await this.writeMeta(meta);
        await writeFile(this.messagesPath(meta.id), "", { encoding: "utf8", flag: "wx" });
        return meta;
    }
    async list() {
        await this.initialize();
        const entries = await readdir(this.root, { withFileTypes: true });
        const sessions = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
            try {
                return await this.readMeta(entry.name);
            }
            catch {
                return undefined;
            }
        }));
        return sessions
            .filter((session) => session !== undefined)
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    async get(id) {
        let meta;
        try {
            meta = await this.readMeta(id);
        }
        catch (error) {
            if (isMissing(error))
                return undefined;
            throw error;
        }
        const raw = await readFile(this.messagesPath(id), "utf8");
        const messages = raw
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line));
        return { ...meta, messages };
    }
    async appendMessage(sessionId, role, content) {
        const meta = await this.readMeta(sessionId);
        const now = new Date().toISOString();
        const message = {
            id: randomUUID(),
            role,
            content,
            createdAt: now,
        };
        await appendFile(this.messagesPath(sessionId), `${JSON.stringify(message)}\n`, "utf8");
        meta.updatedAt = now;
        if (meta.title === "New session" && role === "user") {
            const firstText = content.find((block) => block.type === "text");
            if (firstText?.type === "text")
                meta.title = firstText.text.slice(0, 80);
        }
        await this.writeMeta(meta);
        return message;
    }
    async updateConfig(id, update) {
        const meta = await this.readMeta(id);
        meta.provider = update.provider;
        meta.model = update.model;
        if (update.thinking === undefined)
            delete meta.thinking;
        else
            meta.thinking = update.thinking;
        if (update.effort === undefined)
            delete meta.effort;
        else
            meta.effort = update.effort;
        if (update.agentMode === undefined || update.agentMode === "build")
            delete meta.agentMode;
        else
            meta.agentMode = update.agentMode;
        if (update.snapshotMode === undefined || update.snapshotMode === "auto")
            delete meta.snapshotMode;
        else
            meta.snapshotMode = update.snapshotMode;
        meta.updatedAt = new Date().toISOString();
        await this.writeMeta(meta);
        return meta;
    }
    async truncateMessages(id, count) {
        if (!Number.isSafeInteger(count) || count < 0)
            throw new Error("Message count must be a non-negative integer");
        const detail = await this.get(id);
        if (!detail)
            throw new Error("Session not found");
        const messages = detail.messages.slice(0, count);
        await writeFile(this.messagesPath(id), messages.map((message) => JSON.stringify(message)).join("\n") + (messages.length ? "\n" : ""), "utf8");
        const meta = await this.readMeta(id);
        meta.updatedAt = new Date().toISOString();
        await this.writeMeta(meta);
    }
    async updatePermissions(id, permissionMode, permissionRules) {
        const meta = await this.readMeta(id);
        if (permissionMode === undefined)
            delete meta.permissionMode;
        else
            meta.permissionMode = permissionMode;
        meta.permissionRules = permissionRules.map((rule) => ({ ...rule }));
        meta.updatedAt = new Date().toISOString();
        await this.writeMeta(meta);
        return meta;
    }
    /** 更新沙盒模式；appcontainer/空 setupScript 视为缺省（从 meta 删除） */
    async updateSandboxMode(id, sandboxMode, setupScript) {
        const meta = await this.readMeta(id);
        if (!sandboxMode || sandboxMode === "appcontainer")
            delete meta.sandboxMode;
        else
            meta.sandboxMode = sandboxMode;
        if (!setupScript?.trim())
            delete meta.setupScript;
        else
            meta.setupScript = setupScript;
        meta.updatedAt = new Date().toISOString();
        await this.writeMeta(meta);
        return meta;
    }
    /** 记录探测到的快照后端名（zfs 附带数据集："zfs:<dataset>"）。 */
    async updateSnapshotBackend(id, backend) {
        const meta = await this.readMeta(id);
        meta.snapshotBackend = backend;
        meta.updatedAt = new Date().toISOString();
        await this.writeMeta(meta);
        return meta;
    }
    contextRoot(id) {
        return this.sessionPath(id);
    }
    async delete(id) {
        try {
            await rm(this.sessionPath(id), { recursive: true, force: false });
            return true;
        }
        catch (error) {
            if (isMissing(error))
                return false;
            throw error;
        }
    }
    /** 导出为 JSONL：首行 meta，其后每行一条消息；ledger/artifacts 不含在内（上下文按消息重建）。 */
    async exportJsonl(id) {
        const detail = await this.get(id);
        if (!detail)
            return undefined;
        const { messages, ...meta } = detail;
        return serializeSession(meta, messages);
    }
    /** 导入 JSONL：原 id 未被占用则沿用（迁移恢复），否则分配新 id。 */
    async importJsonl(text) {
        const parsed = parseSessionImport(text);
        let id = parsed.meta.id ?? randomUUID();
        try {
            await mkdir(this.sessionPath(id), { recursive: false });
        }
        catch (error) {
            if (error instanceof Error && "code" in error && error.code === "EEXIST") {
                id = randomUUID();
                await mkdir(this.sessionPath(id), { recursive: false });
            }
            else {
                throw error;
            }
        }
        const { id: _ignored, ...restMeta } = parsed.meta;
        const meta = { ...restMeta, id };
        await this.writeMeta(meta);
        await writeFile(this.messagesPath(id), parsed.messages.map((message) => JSON.stringify(message)).join("\n") + (parsed.messages.length ? "\n" : ""), "utf8");
        return meta;
    }
    sessionPath(id) {
        if (!/^[0-9a-f-]{36}$/.test(id))
            throw new Error("Invalid session ID");
        return path.join(this.root, id);
    }
    metaPath(id) {
        return path.join(this.sessionPath(id), "meta.json");
    }
    messagesPath(id) {
        return path.join(this.sessionPath(id), "messages.jsonl");
    }
    async readMeta(id) {
        return JSON.parse(await readFile(this.metaPath(id), "utf8"));
    }
    async writeMeta(meta) {
        const target = this.metaPath(meta.id);
        const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        await rename(temporary, target);
    }
}
function isMissing(error) {
    return error instanceof Error && "code" in error && error.code === "ENOENT";
}
