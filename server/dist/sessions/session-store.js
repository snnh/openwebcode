import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
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
        const meta = {
            id: randomUUID(),
            cwd: path.resolve(input.cwd),
            provider: input.provider ?? "development",
            model: input.model ?? "deterministic-tool-loop",
            title: input.title ?? "New session",
            createdAt: now,
            updatedAt: now,
        };
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
