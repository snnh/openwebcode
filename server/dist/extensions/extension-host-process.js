import { pathToFileURL } from "node:url";
import { OFFICIAL_EXTENSIONS, optimizeAttention } from "./official.js";
const states = new Map();
const handlers = new Map();
const HOOK_PERMISSIONS = {
    "context.beforeBuild": ["context:read", "context:mutate"],
    "message.beforeSend": ["context:read", "context:mutate"],
    "tool.beforeExecute": ["tools:register"],
};
function register(id, hook, handler) {
    const extension = handlers.get(id) ?? new Map();
    extension.set(hook, [...(extension.get(hook) ?? []), handler]);
    handlers.set(id, extension);
}
register("attention-optimizer", "context.beforeBuild", (payload, config) => optimizeAttention(payload, config));
async function loadThirdParty(manifests) {
    const errors = {};
    for (const manifest of manifests) {
        if (manifest.official || !manifest.entry || !manifest.directory)
            continue;
        try {
            const module = await import(pathToFileURL(`${manifest.directory}/${manifest.entry}`).href);
            const activate = module.activate ?? module.default;
            if (typeof activate !== "function")
                throw new Error("Extension entry must export activate() or a default function");
            await activate({
                manifest: Object.freeze({ ...manifest }),
                on(hook, handler) {
                    if (!["context.beforeBuild", "tool.beforeExecute", "message.beforeSend"].includes(hook) || typeof handler !== "function") {
                        throw new Error(`Unsupported extension hook: ${hook}`);
                    }
                    const missing = HOOK_PERMISSIONS[hook].filter((permission) => !manifest.permissions.includes(permission));
                    if (missing.length > 0)
                        throw new Error(`Extension ${manifest.id} lacks permission(s) for ${hook}: ${missing.join(", ")}`);
                    register(manifest.id, hook, handler);
                },
            });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors[manifest.id] = message;
            process.stderr.write(`[extension-host] ${manifest.id}: ${message}\n`);
        }
    }
    return errors;
}
async function withTimeout(promise, ms = 5000) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error("extension hook timeout")), ms); }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
async function runHook(hook, original) {
    let current = original;
    const ordered = ["context-manager", "attention-optimizer", "content-lens", "pdf-to-image", ...handlers.keys()].filter((id, index, all) => all.indexOf(id) === index);
    for (const id of ordered) {
        const state = states.get(id);
        if (!state?.enabled)
            continue;
        for (const handler of handlers.get(id)?.get(hook) ?? []) {
            let result;
            try {
                result = await withTimeout(Promise.resolve(handler(current, state.config)));
            }
            catch (error) {
                process.stderr.write(`[extension-host] ${id} ${hook}: ${error instanceof Error ? error.message : String(error)}\n`);
                continue;
            }
            if (!result || typeof result !== "object")
                continue;
            if (hook === "context.beforeBuild" || hook === "message.beforeSend") {
                const value = result;
                current = {
                    ...current,
                    ...(value.messages ? { messages: value.messages } : {}),
                    ...(value.metadata ? { metadata: { ...(current.metadata ?? {}), ...value.metadata } } : {}),
                };
            }
            else {
                const value = result;
                current = { ...current, ...(value.input ? { input: value.input } : {}), ...(value.blocked ? { blocked: true, reason: value.reason } : {}) };
            }
        }
    }
    return current;
}
process.on("message", (request) => {
    void (async () => {
        let result;
        if (request.method === "initialize" || request.method === "reload") {
            states.clear();
            const rawStates = (request.params?.states ?? {});
            for (const manifest of OFFICIAL_EXTENSIONS)
                states.set(manifest.id, rawStates[manifest.id] ?? { enabled: manifest.defaultEnabled === true, config: {} });
            for (const [id, state] of Object.entries(rawStates))
                states.set(id, state);
            const errors = request.method === "initialize"
                ? await loadThirdParty((request.params?.manifests ?? []))
                : {};
            result = { ready: true, errors };
        }
        else if (request.method === "hook") {
            result = await runHook(request.params?.hook, request.params?.payload);
        }
        else if (request.method === "shutdown") {
            result = { stopped: true };
            process.send?.({ id: request.id, result });
            process.disconnect?.();
            return;
        }
        process.send?.({ id: request.id, result });
    })().catch((error) => {
        process.send?.({ id: request.id, error: error instanceof Error ? error.message : String(error) });
    });
});
