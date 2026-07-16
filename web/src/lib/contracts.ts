export type PermissionMode = "ask" | "acceptEdits" | "yolo";
export type SandboxCapability = "advisory" | "partial" | "enforced";

export interface MessageContent {
  type: "text" | "thinking" | "tool_call" | "tool_result";
  text?: string;
  provider?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  toolCallId?: string;
  content?: string;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  content: MessageContent[];
  createdAt: string;
}

export interface Session {
  id: string;
  cwd: string;
  provider: string;
  model: string;
  thinking?: "adaptive" | "enabled" | "disabled";
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  permissionMode?: PermissionMode;
  sandbox?: {
    enabled: boolean;
    readRoots: string[];
    writeRoots: string[];
    denyPaths: string[];
    network: "allow" | "deny";
  };
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionDetail extends Session {
  messages: ChatMessage[];
}

export interface AppEvent {
  source: "server" | "core" | "agent" | "session";
  type: string;
  sessionId?: string;
  seq: number;
  createdAt: string;
  payload: unknown;
}

export interface ContextView {
  ledger: {
    usage: { inputTokens: number; outputTokens: number; cacheRead: number; cacheWrite: number };
    cost: { usdMicroUnits: string; cnyMicroUnits: string; unpricedTokens: number };
    entries: Array<{ messageId: string; state: "full" | "evicted" | "restored"; artifactId: string }>;
  };
  preferences: { language: string; currency: "USD" | "CNY"; currencyLabel: string };
}

export interface ModelProfile {
  id: string;
  provider: string;
  displayName: string;
  contextWindow: number;
  maxOutput: number;
  capabilities: {
    thinking: Array<"adaptive" | "enabled" | "disabled">;
    effort: Array<"low" | "medium" | "high" | "xhigh" | "max">;
  };
  pricing?: { currency: string; input: string; output: string; cacheRead: string; cacheWrite: string };
}

export interface Checkpoint {
  id: string;
  label: string;
  createdAt: string;
  messageCount: number;
}

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "other";
  size: number;
}
