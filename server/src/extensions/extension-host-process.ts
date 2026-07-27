import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { OFFICIAL_EXTENSIONS, optimizeAttention } from "./official.js";
import { isExtensionEventAllowed, type ApiRequest, type ApiResponse, type ContextHookPayload, type ContextHookResult, type EventMessage, type ExtensionApiMethod, type ExtensionHook, type ExtensionManifest, type ExtensionPermission, type ExtensionState, type ExtensionToolResult, type ExtensionToolSpec, type HostRequest, type HostResponse, type ToolHookPayload, type ToolHookResult } from "./types.js";

type Handler = (payload: unknown, config: Record<string, unknown>) => unknown | Promise<unknown>;
type ToolHandler = (input: Record<string, unknown>, config: Record<string, unknown>) => unknown | Promise<unknown>;
type EventHandler = (event: { type: string; sessionId?: string; payload: unknown }) => void;

const states = new Map<string, ExtensionState>();
const handlers = new Map<string, Map<ExtensionHook, Handler[]>>();
const tools = new Map<string, Map<string, { spec: ExtensionToolSpec; handler: ToolHandler }>>();
const eventSubscriptions = new Map<string, Array<{ types: string[]; handler: EventHandler }>>();
const apiPending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
const HOOK_PERMISSIONS: Record<ExtensionHook, ExtensionPermission[]> = {
  "context.beforeBuild": ["context:read", "context:mutate"],
  "message.beforeSend": ["context:read", "context:mutate"],
  "tool.beforeExecute": ["tools:register"],
};
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function register(id: string, hook: ExtensionHook, handler: Handler): void {
  const extension = handlers.get(id) ?? new Map<ExtensionHook, Handler[]>();
  extension.set(hook, [...(extension.get(hook) ?? []), handler]);
  handlers.set(id, extension);
}

register("attention-optimizer", "context.beforeBuild", (payload, config) => optimizeAttention(payload as ContextHookPayload, config));

function requirePermission(manifest: ExtensionManifest, permission: ExtensionPermission): void {
  if (!manifest.permissions.includes(permission)) throw new Error(`Extension ${manifest.id} lacks permission: ${permission}`);
}

/** host→server 能力调用；server 侧按 id 回 ApiResponse。 */
function callApi(extensionId: string, api: ExtensionApiMethod, params?: Record<string, unknown>): Promise<unknown> {
  if (!process.send) return Promise.reject(new Error("Extension Host IPC is unavailable"));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      apiPending.delete(id);
      reject(new Error(`server api ${api} timeout`));
    }, 5000);
    apiPending.set(id, { resolve, reject, timer });
    process.send!({ id, api, extensionId, ...(params ? { params } : {}) } satisfies ApiRequest);
  });
}

function serializedTools(): Record<string, ExtensionToolSpec[]> {
  const result: Record<string, ExtensionToolSpec[]> = {};
  for (const [extensionId, registered] of tools) {
    result[extensionId] = [...registered.values()].map((entry) => entry.spec);
  }
  return result;
}

function normalizeToolResult(value: unknown): ExtensionToolResult {
  if (typeof value === "string") return { content: value };
  if (value && typeof value === "object" && typeof (value as { content?: unknown }).content === "string") {
    const result = value as { content: string; isError?: unknown };
    return { content: result.content, ...(result.isError === true ? { isError: true } : {}) };
  }
  return { content: JSON.stringify(value) ?? "" };
}

async function loadThirdParty(manifests: Array<ExtensionManifest & { directory?: string }>): Promise<Record<string, string>> {
  const errors: Record<string, string> = {};
  for (const manifest of manifests) {
    if (manifest.official || !manifest.entry || !manifest.directory) continue;
    try {
      const module = await import(pathToFileURL(`${manifest.directory}/${manifest.entry}`).href);
      const activate = module.activate ?? module.default;
      if (typeof activate !== "function") throw new Error("Extension entry must export activate() or a default function");
      await activate({
        manifest: Object.freeze({ ...manifest }),
        on(hook: ExtensionHook, handler: Handler): void {
          if (!["context.beforeBuild", "tool.beforeExecute", "message.beforeSend"].includes(hook) || typeof handler !== "function") {
            throw new Error(`Unsupported extension hook: ${hook}`);
          }
          const missing = HOOK_PERMISSIONS[hook].filter((permission) => !manifest.permissions.includes(permission));
          if (missing.length > 0) throw new Error(`Extension ${manifest.id} lacks permission(s) for ${hook}: ${missing.join(", ")}`);
          register(manifest.id, hook, handler);
        },
        registerTool(spec: { name?: unknown; description?: unknown; inputSchema?: unknown }, handler: ToolHandler): void {
          requirePermission(manifest, "tools:register");
          if (!spec || typeof spec.name !== "string" || !TOOL_NAME_PATTERN.test(spec.name)) throw new Error("registerTool requires a name matching [a-zA-Z0-9_-]{1,64}");
          if (typeof handler !== "function") throw new Error("registerTool requires a handler function");
          const registered = tools.get(manifest.id) ?? new Map<string, { spec: ExtensionToolSpec; handler: ToolHandler }>();
          registered.set(spec.name, {
            spec: {
              name: spec.name,
              description: typeof spec.description === "string" && spec.description.trim() !== "" ? spec.description : spec.name,
              inputSchema: spec.inputSchema && typeof spec.inputSchema === "object" ? spec.inputSchema as Record<string, unknown> : { type: "object", properties: {} },
            },
            handler,
          });
          tools.set(manifest.id, registered);
        },
        sessions: {
          list: (): Promise<unknown> => {
            requirePermission(manifest, "sessions:read");
            return callApi(manifest.id, "sessions.list");
          },
          get: (id: string): Promise<unknown> => {
            requirePermission(manifest, "sessions:read");
            return callApi(manifest.id, "sessions.get", { id });
          },
        },
        context: {
          getView: (sessionId: string): Promise<unknown> => {
            requirePermission(manifest, "context:read");
            return callApi(manifest.id, "context.getView", { sessionId });
          },
          readArtifact: (sessionId: string, artifactId: string, offset?: number, limit?: number): Promise<unknown> => {
            requirePermission(manifest, "context:read");
            return callApi(manifest.id, "context.readArtifact", { sessionId, artifactId, ...(offset !== undefined ? { offset } : {}), ...(limit !== undefined ? { limit } : {}) });
          },
        },
        events: {
          subscribe: (types: unknown, handler: EventHandler): void => {
            requirePermission(manifest, "sessions:read");
            if (!Array.isArray(types) || types.some((type) => typeof type !== "string")) throw new Error("events.subscribe requires an array of event type strings");
            if (typeof handler !== "function") throw new Error("events.subscribe requires a handler function");
            const allowed = (types as string[]).filter(isExtensionEventAllowed);
            const subscriptions = eventSubscriptions.get(manifest.id) ?? [];
            subscriptions.push({ types: allowed, handler });
            eventSubscriptions.set(manifest.id, subscriptions);
            void callApi(manifest.id, "events.subscribe", { types: allowed }).catch((error: unknown) => {
              process.stderr.write(`[extension-host] ${manifest.id} events.subscribe: ${error instanceof Error ? error.message : String(error)}\n`);
            });
          },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors[manifest.id] = message;
      process.stderr.write(`[extension-host] ${manifest.id}: ${message}\n`);
    }
  }
  return errors;
}

async function withTimeout<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("extension hook timeout")), ms); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runHook(hook: ExtensionHook, original: unknown): Promise<unknown> {
  let current = original;
  const ordered = ["context-manager", "attention-optimizer", "content-lens", "pdf-to-image", ...handlers.keys()].filter((id, index, all) => all.indexOf(id) === index);
  for (const id of ordered) {
    const state = states.get(id);
    if (!state?.enabled) continue;
    for (const handler of handlers.get(id)?.get(hook) ?? []) {
      let result: unknown;
      try {
        result = await withTimeout(Promise.resolve(handler(current, state.config)));
      } catch (error) {
        process.stderr.write(`[extension-host] ${id} ${hook}: ${error instanceof Error ? error.message : String(error)}\n`);
        continue;
      }
      if (!result || typeof result !== "object") continue;
      if (hook === "context.beforeBuild" || hook === "message.beforeSend") {
        const value = result as ContextHookResult;
        current = {
          ...(current as ContextHookPayload),
          ...(value.messages ? { messages: value.messages } : {}),
          ...(value.metadata ? { metadata: { ...((current as { metadata?: Record<string, unknown> }).metadata ?? {}), ...value.metadata } } : {}),
        };
      } else {
        const value = result as ToolHookResult;
        current = { ...(current as ToolHookPayload), ...(value.input ? { input: value.input } : {}), ...(value.blocked ? { blocked: true, reason: value.reason } : {}) };
      }
    }
  }
  return current;
}

async function invokeTool(params: Record<string, unknown> | undefined): Promise<ExtensionToolResult> {
  const extensionId = typeof params?.extensionId === "string" ? params.extensionId : "";
  const tool = typeof params?.tool === "string" ? params.tool : "";
  const input = params?.input && typeof params.input === "object" ? params.input as Record<string, unknown> : {};
  if (!states.get(extensionId)?.enabled) throw new Error(`Extension ${extensionId} is disabled`);
  const registered = tools.get(extensionId)?.get(tool);
  if (!registered) throw new Error(`Unknown extension tool: ${extensionId}/${tool}`);
  return normalizeToolResult(await registered.handler(input, states.get(extensionId)?.config ?? {}));
}

process.on("message", (message: HostRequest | EventMessage | ApiResponse) => {
  // server→host 事件推送：按订阅类型分发给扩展本地 handler，无应答。
  if ("event" in message) {
    for (const subscriptions of eventSubscriptions.values()) {
      for (const subscription of subscriptions) {
        if (!subscription.types.includes(message.event)) continue;
        try {
          subscription.handler({ type: message.event, ...(message.sessionId ? { sessionId: message.sessionId } : {}), payload: message.payload });
        } catch (error) {
          process.stderr.write(`[extension-host] event ${message.event}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    }
    return;
  }
  // server→host 能力应答：按 id 匹配挂起的 callApi。
  if ("api" in message) {
    const pending = apiPending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    apiPending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error));
    else pending.resolve(message.result);
    return;
  }
  const request = message;
  void (async () => {
    let result: unknown;
    if (request.method === "initialize" || request.method === "reload") {
      states.clear();
      const rawStates = (request.params?.states ?? {}) as Record<string, ExtensionState>;
      for (const manifest of OFFICIAL_EXTENSIONS) states.set(manifest.id, rawStates[manifest.id] ?? { enabled: manifest.defaultEnabled === true, config: {} });
      for (const [id, state] of Object.entries(rawStates)) states.set(id, state);
      const errors = request.method === "initialize"
        ? await loadThirdParty((request.params?.manifests ?? []) as Array<ExtensionManifest & { directory?: string }>)
        : {};
      result = { ready: true, errors, tools: serializedTools() };
    } else if (request.method === "hook") {
      result = await runHook(request.params?.hook as ExtensionHook, request.params?.payload);
    } else if (request.method === "tool.invoke") {
      result = await invokeTool(request.params);
    } else if (request.method === "shutdown") {
      result = { stopped: true };
      process.send?.({ id: request.id, result } satisfies HostResponse);
      process.disconnect?.();
      return;
    }
    process.send?.({ id: request.id, result } satisfies HostResponse);
  })().catch((error: unknown) => {
    process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) } satisfies HostResponse);
  });
});
