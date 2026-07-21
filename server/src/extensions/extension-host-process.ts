import { pathToFileURL } from "node:url";
import { OFFICIAL_EXTENSIONS, optimizeAttention } from "./official.js";
import type { ContextHookPayload, ContextHookResult, ExtensionHook, ExtensionManifest, ExtensionPermission, ExtensionState, HostRequest, HostResponse, ToolHookPayload, ToolHookResult } from "./types.js";

type Handler = (payload: unknown, config: Record<string, unknown>) => unknown | Promise<unknown>;

const states = new Map<string, ExtensionState>();
const handlers = new Map<string, Map<ExtensionHook, Handler[]>>();
const HOOK_PERMISSIONS: Record<ExtensionHook, ExtensionPermission[]> = {
  "context.beforeBuild": ["context:read", "context:mutate"],
  "message.beforeSend": ["context:read", "context:mutate"],
  "tool.beforeExecute": ["tools:register"],
};

function register(id: string, hook: ExtensionHook, handler: Handler): void {
  const extension = handlers.get(id) ?? new Map<ExtensionHook, Handler[]>();
  extension.set(hook, [...(extension.get(hook) ?? []), handler]);
  handlers.set(id, extension);
}

register("attention-optimizer", "context.beforeBuild", (payload, config) => optimizeAttention(payload as ContextHookPayload, config));

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

process.on("message", (request: HostRequest) => {
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
      result = { ready: true, errors };
    } else if (request.method === "hook") {
      result = await runHook(request.params?.hook as ExtensionHook, request.params?.payload);
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
