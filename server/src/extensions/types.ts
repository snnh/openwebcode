import type { ChatMessage } from "../sessions/types.js";

export const EXTENSION_API_VERSION = "1";

export type ExtensionPermission =
  | "context:read"
  | "context:mutate"
  | "tools:register"
  | "sessions:read"
  | "ui:panel"
  | "ui:messageAttachment"
  | "network:fetch";

export type ExtensionHook = "context.beforeBuild" | "tool.beforeExecute" | "message.beforeSend";

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  apiVersion: string;
  permissions: ExtensionPermission[];
  official?: boolean;
  defaultEnabled?: boolean;
  entry?: string;
}

export interface ExtensionState {
  enabled: boolean;
  config: Record<string, unknown>;
}

export interface ExtensionInfo extends ExtensionManifest {
  enabled: boolean;
  builtIn: boolean;
  status: "running" | "disabled" | "error";
  config: Record<string, unknown>;
  error?: string;
}

export interface ContextHookPayload {
  sessionId: string;
  cwd: string;
  messages: ChatMessage[];
  ledger: {
    round: number;
    entries: Array<{ messageId: string; state: string; pinnedUntilRound: number }>;
    compacted?: { summary: string; instructions: string[] };
  };
}

export interface ContextHookResult {
  messages?: ChatMessage[];
  metadata?: Record<string, unknown>;
}

export interface ToolHookPayload {
  sessionId: string;
  cwd: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ToolHookResult {
  input?: Record<string, unknown>;
  blocked?: boolean;
  reason?: string;
}

export interface HostRequest {
  id: string;
  method: "initialize" | "reload" | "hook" | "shutdown";
  params?: Record<string, unknown>;
}

export interface HostResponse {
  id: string;
  result?: unknown;
  error?: string;
}
