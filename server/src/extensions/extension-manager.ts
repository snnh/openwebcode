import { randomUUID } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EventBus } from "../events/event-bus.js";
import type { ChatMessage } from "../sessions/types.js";
import { EXTENSION_API_VERSION, type ContextHookPayload, type ExtensionHook, type ExtensionInfo, type ExtensionManifest, type ExtensionState, type HostRequest, type HostResponse, type ToolHookPayload } from "./types.js";
import { OFFICIAL_DEFAULT_CONFIG, OFFICIAL_EXTENSIONS } from "./official.js";

interface StoredConfig { version: 1; extensions: Record<string, ExtensionState> }
type DiscoveredManifest = ExtensionManifest & { directory?: string };

export class ExtensionManager {
  private readonly root: string;
  private readonly configPath: string;
  private manifests: DiscoveredManifest[] = [];
  private states: Record<string, ExtensionState> = {};
  private child: ChildProcess | undefined;
  private hostErrors: Record<string, string> = {};
  private readonly pending = new Map<string, { child: ChildProcess; resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();

  constructor(dataDir: string, private readonly events?: EventBus) {
    this.root = path.join(dataDir, "extensions");
    this.configPath = path.join(this.root, "extensions.json");
  }

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    this.manifests = [...OFFICIAL_EXTENSIONS, ...(await this.discoverThirdParty())];
    this.states = await this.loadStates();
    await this.startHost();
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    await this.request("shutdown").catch(() => undefined);
    // Host 可能在 shutdown 响应后立即自行退出，exit handler 会先清空 this.child。
    // 始终操作捕获的实例，并只在它仍是当前实例时清理引用。
    if (!child.killed) child.kill();
    if (this.child === child) this.child = undefined;
  }

  list(): ExtensionInfo[] {
    return this.manifests.map((manifest) => {
      const state = this.stateFor(manifest);
      const hostError = this.hostErrors[manifest.id];
      const connected = this.child?.connected === true;
      const status = !state.enabled ? "disabled" as const : connected && !hostError ? "running" as const : "error" as const;
      const { directory: _directory, ...publicManifest } = manifest;
      return {
        ...publicManifest,
        enabled: state.enabled,
        builtIn: manifest.official === true,
        status,
        config: { ...state.config },
        ...(state.enabled && (hostError || !connected) ? { error: hostError ?? "Extension Host 未连接" } : {}),
      };
    });
  }

  isEnabled(id: string): boolean {
    const manifest = this.manifests.find((item) => item.id === id);
    return manifest ? this.stateFor(manifest).enabled : false;
  }

  async configure(id: string, update: { enabled?: boolean; config?: Record<string, unknown> }): Promise<ExtensionInfo> {
    const manifest = this.manifests.find((item) => item.id === id);
    if (!manifest) throw new Error("Extension not found");
    const previous = this.stateFor(manifest);
    this.states[id] = {
      enabled: update.enabled ?? previous.enabled,
      config: update.config ? { ...previous.config, ...update.config } : previous.config,
    };
    await this.saveStates();
    await this.request("reload", { states: this.states });
    this.events?.publish({ source: "server", type: "extension.updated", payload: { id, ...this.states[id] } });
    return this.list().find((item) => item.id === id)!;
  }

  async install(sourcePath: string): Promise<ExtensionInfo> {
    if (!path.isAbsolute(sourcePath)) throw new Error("Extension path must be absolute");
    if (!(await stat(sourcePath).catch(() => undefined))?.isDirectory()) throw new Error("Extension path must be a directory");
    const manifest = await readManifest(sourcePath);
    if (manifest.official) throw new Error("Third-party extension cannot claim official status");
    if (this.manifests.some((item) => item.id === manifest.id)) throw new Error(`Extension ID already exists: ${manifest.id}`);
    const target = path.join(this.root, `owc-ext-${manifest.id}`);
    await cp(sourcePath, target, { recursive: true, force: false, errorOnExist: true });
    await this.restart();
    const installed = this.list().find((item) => item.id === manifest.id);
    if (!installed) throw new Error("Installed extension was not discovered");
    return installed;
  }

  async uninstall(id: string): Promise<void> {
    const manifest = this.manifests.find((item) => item.id === id);
    if (!manifest) throw new Error("Extension not found");
    if (manifest.official || !manifest.directory) throw new Error("Official extensions cannot be uninstalled");
    await rm(manifest.directory, { recursive: true, force: true });
    delete this.states[id];
    await this.saveStates();
    await this.restart();
  }

  async transformContext(payload: ContextHookPayload): Promise<{ messages: ChatMessage[]; metadata?: Record<string, unknown> }> {
    const result = await this.hook("context.beforeBuild", payload) as ContextHookPayload & { metadata?: Record<string, unknown> };
    return { messages: result.messages, ...(result.metadata ? { metadata: result.metadata } : {}) };
  }

  async beforeSend(payload: ContextHookPayload): Promise<{ messages: ChatMessage[]; metadata?: Record<string, unknown> }> {
    const result = await this.hook("message.beforeSend", payload) as ContextHookPayload & { metadata?: Record<string, unknown> };
    return { messages: result.messages, ...(result.metadata ? { metadata: result.metadata } : {}) };
  }

  async beforeTool(payload: ToolHookPayload): Promise<ToolHookPayload & { blocked?: boolean; reason?: string }> {
    return this.hook("tool.beforeExecute", payload) as Promise<ToolHookPayload & { blocked?: boolean; reason?: string }>;
  }

  private async hook(hook: ExtensionHook, payload: unknown): Promise<unknown> {
    try {
      return await this.request("hook", { hook, payload });
    } catch (error) {
      this.events?.publish({ source: "server", type: "extension.hook_failed", payload: { hook, message: error instanceof Error ? error.message : String(error) } });
      return payload;
    }
  }

  private stateFor(manifest: ExtensionManifest): ExtensionState {
    return this.states[manifest.id] ?? {
      enabled: manifest.defaultEnabled === true,
      config: { ...(OFFICIAL_DEFAULT_CONFIG[manifest.id] ?? {}) },
    };
  }

  private async loadStates(): Promise<Record<string, ExtensionState>> {
    let stored: StoredConfig = { version: 1, extensions: {} };
    try { stored = JSON.parse(await readFile(this.configPath, "utf8")) as StoredConfig; } catch { /* first run */ }
    const result: Record<string, ExtensionState> = {};
    for (const manifest of this.manifests) {
      const value = stored.extensions?.[manifest.id];
      result[manifest.id] = {
        enabled: typeof value?.enabled === "boolean" ? value.enabled : manifest.defaultEnabled === true,
        config: { ...(OFFICIAL_DEFAULT_CONFIG[manifest.id] ?? {}), ...(value?.config ?? {}) },
      };
    }
    return result;
  }

  private async saveStates(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await writeFile(this.configPath, `${JSON.stringify({ version: 1, extensions: this.states }, null, 2)}\n`, "utf8");
  }

  private async discoverThirdParty(): Promise<DiscoveredManifest[]> {
    const result: DiscoveredManifest[] = [];
    const ids = new Set(OFFICIAL_EXTENSIONS.map((manifest) => manifest.id));
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || !entry.name.startsWith("owc-ext-")) continue;
      const directory = path.join(this.root, entry.name);
      try {
        const manifest = await readManifest(directory);
        if (ids.has(manifest.id)) throw new Error(`Duplicate or reserved extension ID: ${manifest.id}`);
        ids.add(manifest.id);
        result.push({ ...manifest, directory });
      } catch (error) {
        this.events?.publish({ source: "server", type: "extension.invalid", payload: { directory, message: error instanceof Error ? error.message : String(error) } });
      }
    }
    return result;
  }

  private async restart(): Promise<void> {
    await this.close();
    this.manifests = [...OFFICIAL_EXTENSIONS, ...(await this.discoverThirdParty())];
    this.states = await this.loadStates();
    await this.startHost();
  }

  private async startHost(): Promise<void> {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    const worker = fileURLToPath(new URL(`./extension-host-process.${extension}`, import.meta.url));
    // dist 运行直接 fork 编译后的 JS；tsx 开发/测试运行显式安装 loader，确保 NodeNext 的 .js specifier 可解析到 .ts 源文件。
    const execArgv = extension === "ts" ? ["--import", "tsx"] : [];
    this.child = fork(worker, [], { stdio: ["ignore", "ignore", "pipe", "ipc"], execArgv });
    const child = this.child;
    child.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("message", (message: HostResponse) => {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
    });
    child.on("exit", () => {
      // restart() 可能已经启动新 Host；旧进程的迟到 exit 不能清掉新引用。
      if (this.child === child) this.child = undefined;
      for (const [id, pending] of this.pending) {
        if (pending.child !== child) continue;
        clearTimeout(pending.timer);
        pending.reject(new Error("Extension Host exited"));
        this.pending.delete(id);
      }
      this.events?.publish({ source: "server", type: "extension.host_stopped", payload: {} });
    });
    const initialized = await this.request("initialize", { states: this.states, manifests: this.manifests }) as { errors?: Record<string, string> };
    this.hostErrors = initialized.errors ?? {};
    this.events?.publish({ source: "server", type: "extension.host_started", payload: { extensions: this.list().length } });
  }

  private request(method: HostRequest["method"], params?: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child?.connected) return Promise.reject(new Error("Extension Host is not connected"));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Extension Host ${method} timeout`));
      }, 5500);
      this.pending.set(id, { child, resolve, reject, timer });
      child.send({ id, method, ...(params ? { params } : {}) } satisfies HostRequest);
    });
  }
}

async function readManifest(directory: string): Promise<ExtensionManifest> {
  const raw = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8")) as Partial<ExtensionManifest>;
  if (!raw.id || !/^[a-z0-9][a-z0-9-]{1,63}$/.test(raw.id)) throw new Error("manifest.id is invalid");
  if (!raw.name || !raw.version || !raw.description) throw new Error("manifest requires name, version and description");
  if (raw.apiVersion !== EXTENSION_API_VERSION) throw new Error(`Unsupported apiVersion ${raw.apiVersion ?? "missing"}`);
  const allowedPermissions = new Set(["context:read", "context:mutate", "tools:register", "sessions:read", "ui:panel", "ui:messageAttachment", "network:fetch"]);
  if (!Array.isArray(raw.permissions) || raw.permissions.some((permission) => typeof permission !== "string" || !allowedPermissions.has(permission))) throw new Error("manifest.permissions contains an unsupported permission");
  const entry = raw.entry ?? "index.js";
  if (path.isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) throw new Error("manifest.entry must stay inside the extension directory");
  return {
    id: raw.id,
    name: raw.name,
    version: raw.version,
    description: raw.description,
    apiVersion: raw.apiVersion,
    permissions: raw.permissions,
    entry,
    defaultEnabled: false,
  };
}
