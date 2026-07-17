import { randomUUID } from "node:crypto";
export class SessionTransferError extends Error {
    constructor(message) {
        super(message);
        this.name = "SessionTransferError";
    }
}
const ROLES = ["user", "assistant", "tool"];
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;
/** 导出格式：首行 meta（含会话配置），其后每行一条 ChatMessage（与 messages.jsonl 同构）。 */
export function serializeSession(meta, messages) {
    const { id, ...rest } = meta;
    const head = {
        kind: "meta",
        version: 1,
        exportedAt: new Date().toISOString(),
        session: { ...rest, id },
    };
    return [JSON.stringify(head), ...messages.map((message) => JSON.stringify(message))].join("\n") + "\n";
}
export function parseSessionImport(text) {
    if (typeof text !== "string" || text.trim() === "")
        throw new SessionTransferError("导入内容为空");
    const lines = text.split("\n").filter((line) => line.trim() !== "");
    let head;
    try {
        head = JSON.parse(lines[0]);
    }
    catch {
        throw new SessionTransferError("首行不是合法的 JSON");
    }
    if (head?.kind !== "meta" || head.version !== 1 || !head.session || typeof head.session !== "object") {
        throw new SessionTransferError("首行必须是 {kind:\"meta\",version:1,session:{...}}");
    }
    const session = head.session;
    for (const key of ["cwd", "provider", "model", "title"]) {
        if (typeof session[key] !== "string" || session[key] === "") {
            throw new SessionTransferError(`meta.session.${key} 缺失或不是非空字符串`);
        }
    }
    if (session.id !== undefined && !SESSION_ID_PATTERN.test(session.id)) {
        throw new SessionTransferError("meta.session.id 不是合法的会话 id");
    }
    const messages = [];
    for (let index = 1; index < lines.length; index += 1) {
        let parsed;
        try {
            parsed = JSON.parse(lines[index]);
        }
        catch {
            throw new SessionTransferError(`第 ${index + 1} 行不是合法的 JSON`);
        }
        if (!parsed || !ROLES.includes(parsed.role) || !Array.isArray(parsed.content)) {
            throw new SessionTransferError(`第 ${index + 1} 行不是合法的消息（role/content 缺失）`);
        }
        messages.push({
            id: typeof parsed.id === "string" ? parsed.id : randomUUID(),
            role: parsed.role,
            content: parsed.content,
            createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : new Date().toISOString(),
        });
    }
    // createdAt/updatedAt 在 SessionMeta 上必填且列表按 updatedAt 排序：导入是信任边界，缺失时兜底为当前时间
    const now = new Date().toISOString();
    const { id, ...rest } = session;
    return {
        meta: {
            ...rest,
            createdAt: typeof session.createdAt === "string" && session.createdAt !== "" ? session.createdAt : now,
            updatedAt: typeof session.updatedAt === "string" && session.updatedAt !== "" ? session.updatedAt : now,
            ...(id ? { id } : {}),
        },
        messages,
    };
}
