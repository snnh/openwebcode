import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Dispatcher } from "undici";
import {
  applyProxyConfig,
  parseNoProxyList,
  sanitizeProxyUrl,
  shouldBypassProxy,
  type ProxyConfig,
  type ProxyDispatcherControl,
} from "../src/proxy.js";
import { SettingsService, type SettingsView } from "../src/settings-service.js";
import { tempRoot } from "./helpers/temp-roots.js";

/** 注入式 fake dispatcher 控制面：记录安装顺序并捕获 custom 模式的路由回调，不动真实全局状态。 */
function fakeControl() {
  const installed: unknown[] = [];
  let routing: { shouldBypass(origin: URL): boolean; proxyFor(origin: URL): string | undefined } | undefined;
  const control: ProxyDispatcherControl = {
    setGlobalDispatcher: (dispatcher: Dispatcher) => { installed.push(dispatcher); },
    createOffDispatcher: () => ({ kind: "off" }) as unknown as Dispatcher,
    createEnvDispatcher: () => ({ kind: "env" }) as unknown as Dispatcher,
    createRoutingDispatcher: (shouldBypass, proxyFor) => {
      routing = { shouldBypass, proxyFor };
      return { kind: "routing" } as unknown as Dispatcher;
    },
  };
  return { control, installed, routing: () => routing };
}

describe("parseNoProxyList", () => {
  it("解析逗号分隔列表：去空白、小写归一、去空项", () => {
    expect(parseNoProxyList(" Example.COM , .corp.local ,,")).toEqual(["example.com", ".corp.local"]);
    expect(parseNoProxyList(undefined)).toEqual([]);
    expect(parseNoProxyList("  ")).toEqual([]);
  });
});

describe("shouldBypassProxy", () => {
  it.each<{ host: string; bypass: string[]; expected: boolean }>([
    // 本机回环地址始终绕过
    { host: "localhost", bypass: [], expected: true },
    { host: "api.localhost", bypass: [], expected: true },
    { host: "127.0.0.1", bypass: [], expected: true },
    { host: "127.1.2.3", bypass: [], expected: true },
    { host: "::1", bypass: [], expected: true },
    { host: "[::1]", bypass: [], expected: true },
    // 精确主机匹配
    { host: "internal.example.com", bypass: ["internal.example.com"], expected: true },
    { host: "other.example.com", bypass: ["internal.example.com"], expected: false },
    // 后缀域名匹配（含前导点与 *. 写法），不误伤相似域名
    { host: "a.example.com", bypass: ["example.com"], expected: true },
    { host: "a.example.com", bypass: [".example.com"], expected: true },
    { host: "a.example.com", bypass: ["*.example.com"], expected: true },
    { host: "example.com", bypass: ["example.com"], expected: true },
    { host: "evil-example.com", bypass: ["example.com"], expected: false },
    { host: "notexample.com", bypass: ["example.com"], expected: false },
    { host: "a.b.example.com", bypass: ["b.example.com"], expected: true },
    // 通配 * 全绕过；大小写不敏感
    { host: "anything.example.org", bypass: ["*"], expected: true },
    { host: "A.EXAMPLE.com", bypass: ["example.COM"], expected: true },
  ])("匹配矩阵（回环/精确/后缀/通配/大小写）：$host 与 $bypass → $expected", ({ host, bypass, expected }) => {
    expect(shouldBypassProxy(host, bypass), host).toBe(expected);
  });
});

describe("sanitizeProxyUrl", () => {
  it("隐去凭据、保留 scheme 与 host", () => {
    expect(sanitizeProxyUrl("http://user:secret@proxy.local:8080")).toBe("http://•••@proxy.local:8080");
    expect(sanitizeProxyUrl("http://proxy.local:8080")).toBe("http://proxy.local:8080");
    expect(sanitizeProxyUrl("not a url")).toBe("•••");
  });
});

describe("applyProxyConfig（fake dispatcher 控制面）", () => {
  it("off/env 模式安装对应 dispatcher", () => {
    const off = fakeControl();
    const result = applyProxyConfig({ mode: "off" }, off.control);
    expect(result.mode).toBe("off");
    expect(result.summary).toContain("直连");
    expect(off.installed).toEqual([{ kind: "off" }]);

    const env = fakeControl();
    const envResult = applyProxyConfig({ mode: "env" }, env.control);
    expect(envResult.mode).toBe("env");
    expect(env.installed).toEqual([{ kind: "env" }]);
  });

  it("custom 模式安装路由 dispatcher，按目标协议选代理", () => {
    const fake = fakeControl();
    const result = applyProxyConfig(
      { mode: "custom", httpProxy: "http://127.0.0.1:7890", httpsProxy: "http://127.0.0.1:7891" },
      fake.control,
    );
    expect(result.mode).toBe("custom");
    expect(fake.installed).toEqual([{ kind: "routing" }]);
    const routing = fake.routing()!;
    expect(routing.proxyFor(new URL("https://api.example.com"))).toBe("http://127.0.0.1:7891");
    expect(routing.proxyFor(new URL("http://api.example.com"))).toBe("http://127.0.0.1:7890");
  });

  it("custom 模式：协议专属代理缺失时回退另一个", () => {
    const fake = fakeControl();
    applyProxyConfig({ mode: "custom", httpProxy: "http://127.0.0.1:7890" }, fake.control);
    const routing = fake.routing()!;
    expect(routing.proxyFor(new URL("https://api.example.com"))).toBe("http://127.0.0.1:7890");
    expect(routing.proxyFor(new URL("http://api.example.com"))).toBe("http://127.0.0.1:7890");
  });

  it("custom 模式：noProxy 与回环绕过", () => {
    const fake = fakeControl();
    applyProxyConfig(
      { mode: "custom", httpProxy: "http://127.0.0.1:7890", noProxy: "internal.example.com, .corp.local" },
      fake.control,
    );
    const routing = fake.routing()!;
    expect(routing.shouldBypass(new URL("https://internal.example.com"))).toBe(true);
    expect(routing.shouldBypass(new URL("https://git.corp.local"))).toBe(true);
    expect(routing.shouldBypass(new URL("http://127.0.0.1:3000"))).toBe(true);
    expect(routing.shouldBypass(new URL("https://api.example.com"))).toBe(false);
  });

  it("custom 模式无合法代理地址时抛错（防御设置层之外的调用）", () => {
    const fake = fakeControl();
    expect(() => applyProxyConfig({ mode: "custom" }, fake.control)).toThrow(/至少一个/);
    expect(() => applyProxyConfig({ mode: "custom", httpProxy: "ftp://x" }, fake.control)).toThrow(/至少一个/);
    expect(fake.installed).toEqual([]);
  });

  it("custom 模式摘要不泄露代理凭据", () => {
    const fake = fakeControl();
    const result = applyProxyConfig(
      { mode: "custom", httpProxy: "http://user:topsecret@proxy.local:8080" },
      fake.control,
    );
    expect(result.summary).not.toContain("topsecret");
    expect(result.summary).toContain("proxy.local:8080");
  });
});

async function loadSettings(env: NodeJS.ProcessEnv = {}): Promise<SettingsService> {
  const root = await tempRoot("owc-proxy-settings-");
  return SettingsService.load({ env, filePath: path.join(root, "server-settings.json") });
}

function fieldOf(view: SettingsView, key: string) {
  for (const group of view.groups) {
    const found = group.fields.find((item) => item.key === key);
    if (found) return found;
  }
  throw new Error(`Field ${key} not found`);
}

/** 仅代理热应用所需的最小 deps（事件总线 + fake applyProxy）。 */
function bindProxyProbe(settings: SettingsService) {
  const applied: ProxyConfig[] = [];
  settings.bind({
    events: { publish: () => undefined },
    applyProxy: (config: ProxyConfig) => {
      applied.push(config);
      return { mode: config.mode, summary: "fake" };
    },
  } as unknown as Parameters<SettingsService["bind"]>[0]);
  return applied;
}

describe("settings 代理字段", () => {
  it("默认 proxyMode=env，代理地址为空", async () => {
    const settings = await loadSettings();
    const proxy = settings.effective().proxy;
    expect(proxy).toEqual({ mode: "env" });
    const view = settings.view();
    expect(fieldOf(view, "proxyMode").value).toBe("env");
    expect(fieldOf(view, "proxyHttp").hasValue).toBe(false);
  });

  it("拒绝非法 proxyMode 与非法代理 URL", async () => {
    const settings = await loadSettings();
    await expect(settings.update({ proxyMode: "bogus" })).rejects.toThrow(/off \/ env \/ custom/);
    await expect(settings.update({ proxyHttp: "not-a-url" })).rejects.toThrow(/URL/);
    await expect(settings.update({ proxyHttps: "socks5://127.0.0.1:1080" })).rejects.toThrow(/http\/https/);
  });

  it("自定义模式要求至少一个代理地址（保存时组合校验）", async () => {
    const settings = await loadSettings();
    await expect(settings.update({ proxyMode: "custom" })).rejects.toThrow(/至少填写一个/);
    // 先存代理再切模式可以；之后清掉两个代理则拒绝
    await settings.update({ proxyHttp: "http://127.0.0.1:7890" });
    await settings.update({ proxyMode: "custom" });
    expect(settings.effective().proxy.mode).toBe("custom");
    await expect(settings.update({ proxyHttp: null })).rejects.toThrow(/至少填写一个/);
  });

  it("例外列表校验：拒绝空项与非法字符", async () => {
    const settings = await loadSettings();
    await settings.update({ proxyNoProxy: "internal.example.com, .corp.local, *.svc" });
    expect(settings.effective().proxy.noProxy).toBe("internal.example.com, .corp.local, *.svc");
    await expect(settings.update({ proxyNoProxy: "bad host!" })).rejects.toThrow(/例外列表/);
  });

  it("代理地址按 secret 脱敏展示：value 不下发、masked 不含凭据", async () => {
    const settings = await loadSettings();
    const view = await settings.update({ proxyHttp: "http://user:topsecret@proxy.local:8080" });
    const field = fieldOf(view, "proxyHttp");
    expect(field.type).toBe("secret");
    expect(field.value).toBeNull();
    expect(field.hasValue).toBe(true);
    expect(field.masked).toBe("http://•••@proxy.local:8080");
    expect(JSON.stringify(view)).not.toContain("topsecret");
  });

  it("模式切换热应用：off/env/custom 保存后立即回调 applyProxy", async () => {
    const settings = await loadSettings();
    const applied = bindProxyProbe(settings);
    await settings.update({ proxyHttp: "http://127.0.0.1:7890" });
    expect(applied).toEqual([{ mode: "env", httpProxy: "http://127.0.0.1:7890" }]);
    await settings.update({ proxyMode: "custom" });
    expect(applied[1]).toEqual({ mode: "custom", httpProxy: "http://127.0.0.1:7890" });
    await settings.update({ proxyMode: "off" });
    expect(applied[2]).toEqual({ mode: "off", httpProxy: "http://127.0.0.1:7890" });
    // 非代理字段不触发热应用
    await settings.update({ agentMaxTurns: 60 });
    expect(applied).toHaveLength(3);
  });

  it("显式设置优先于环境变量；env 覆盖也参与组合校验", async () => {
    const settings = await loadSettings({ OWC_PROXY_MODE: "custom", OWC_PROXY_HTTP: "http://127.0.0.1:9000" });
    const proxy = settings.effective().proxy;
    expect(proxy.mode).toBe("custom");
    expect(proxy.httpProxy).toBe("http://127.0.0.1:9000");
    // env 控制下界面不可改
    await expect(settings.update({ proxyMode: "off" })).rejects.toThrow(/环境变量/);
    // env 提供了代理地址时，custom 组合校验可通过（仅文件侧补 noProxy）
    await settings.update({ proxyNoProxy: "example.com" });
    expect(settings.effective().proxy.noProxy).toBe("example.com");
  });

  it("非法 OWC_PROXY_MODE 环境值在 loadConfig 严格校验下抛错（与 currency/pythonEnv 一致）", async () => {
    const settings = await loadSettings({ OWC_PROXY_MODE: "bogus" });
    expect(() => settings.effective()).toThrow(/off, env, or custom/);
  });
});
