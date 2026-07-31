import { randomUUID } from "node:crypto";
import type { ChatMessage, MessageRole, SessionMeta } from "./types.js";

export class SessionTransferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTransferError";
  }
}

const ROLES: readonly MessageRole[] = ["user", "assistant", "tool"];
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;

export interface SessionExportDocument {
  kind: "meta";
  version: 1;
  exportedAt: string;
  session: Omit<SessionMeta, "id"> & { id: string };
}

/** 导出格式：首行 meta（含会话配置），其后每行一条 ChatMessage（与 messages.jsonl 同构）。 */
export function serializeSession(meta: SessionMeta, messages: ChatMessage[]): string {
  const { id, ...rest } = meta;
  const head: SessionExportDocument = {
    kind: "meta",
    version: 1,
    exportedAt: new Date().toISOString(),
    session: { ...rest, id },
  };
  return [JSON.stringify(head), ...messages.map((message) => JSON.stringify(message))].join("\n") + "\n";
}

export interface ParsedSessionImport {
  meta: Omit<SessionMeta, "id"> & { id?: string };
  messages: ChatMessage[];
}

export function parseSessionImport(text: string): ParsedSessionImport {
  if (typeof text !== "string" || text.trim() === "") throw new SessionTransferError("导入内容为空");
  const lines = text.split("\n").filter((line) => line.trim() !== "");
  let head: SessionExportDocument;
  try {
    head = JSON.parse(lines[0]!) as SessionExportDocument;
  } catch {
    throw new SessionTransferError("首行不是合法的 JSON");
  }
  if (head?.kind !== "meta" || head.version !== 1 || !head.session || typeof head.session !== "object") {
    throw new SessionTransferError("首行必须是 {kind:\"meta\",version:1,session:{...}}");
  }
  const session = head.session;
  for (const key of ["cwd", "provider", "title"] as const) {
    if (typeof session[key] !== "string" || session[key] === "") {
      throw new SessionTransferError(`meta.session.${key} 缺失或不是非空字符串`);
    }
  }
  // A newly created session may intentionally have no selected catalog model yet.
  if (typeof session.model !== "string") {
    throw new SessionTransferError("meta.session.model 缺失或不是字符串");
  }
  if (session.id !== undefined && !SESSION_ID_PATTERN.test(session.id)) {
    throw new SessionTransferError("meta.session.id 不是合法的会话 id");
  }
  const messages: ChatMessage[] = [];
  for (let index = 1; index < lines.length; index += 1) {
    let parsed: ChatMessage;
    try {
      parsed = JSON.parse(lines[index]!) as ChatMessage;
    } catch {
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
      ...(typeof parsed.parentId === "string" ? { parentId: parsed.parentId } : {}),
      ...(typeof parsed.runId === "string" ? { runId: parsed.runId } : {}),
      ...(typeof parsed.turnId === "string" ? { turnId: parsed.turnId } : {}),
    });
  }
  // createdAt/updatedAt 在 SessionMeta 上必填且列表按 updatedAt 排序：导入是信任边界，缺失时兜底为当前时间
  const now = new Date().toISOString();
  const { id } = session;
  // 信任边界：显式挑选可保留字段，权限/沙盒元数据（permissionMode、permissionRules、
  // sandbox、sandboxMode、setupScript）与托管工作区元数据（workspace）一律剥离，
  // 重置为新建会话的默认值，避免导入文件在宿主放大执行权限。
  return {
    meta: {
      cwd: session.cwd,
      provider: session.provider,
      model: session.model,
      title: session.title,
      createdAt: typeof session.createdAt === "string" && session.createdAt !== "" ? session.createdAt : now,
      updatedAt: typeof session.updatedAt === "string" && session.updatedAt !== "" ? session.updatedAt : now,
      ...(session.thinking === "adaptive" || session.thinking === "enabled" || session.thinking === "disabled" ? { thinking: session.thinking } : {}),
      ...(session.effort === "low" || session.effort === "medium" || session.effort === "high" || session.effort === "xhigh" || session.effort === "max" || session.effort === "ultra" ? { effort: session.effort } : {}),
      ...(session.agentMode === "plan" || session.agentMode === "code" || session.agentMode === "goal" ? { agentMode: session.agentMode } : {}),
      ...(typeof session.snapshotBackend === "string" ? { snapshotBackend: session.snapshotBackend } : {}),
      ...(session.snapshotMode === "auto" || session.snapshotMode === "manual" ? { snapshotMode: session.snapshotMode } : {}),
      ...(session.shellBackend !== undefined ? { shellBackend: session.shellBackend } : {}),
      ...(typeof session.activeLeafId === "string" ? { activeLeafId: session.activeLeafId } : {}),
      ...(id ? { id } : {}),
    },
    messages,
  };
}
