/**
 * vendor **全量端点描述符**读取（`@deepseek-ai/dsh-api-remotes/client.js`）。
 *
 * 为什么需要它：只有部分包会单独出 `typert.remote-client.js`（如 session-controller），
 * `pluginManager/*`、`llm/*`、`settings/*` 等端点的 strict codec 只存在于 api-remotes 的
 * ModuleLoader 产物里。这里用 VM 造一个最小 ModuleLoader 环境执行该产物，再调用它的
 * `apply(ctx)` —— apply 会把 `{package, descriptors}` 逐个交给 `ctx.remote.$mount`，
 * 于是我们拿到的就是**客户端真实使用的同一批描述符与 codec 实例**。
 *
 * 注意：这是测试助手，只在 vendor 产物存在时可用；缺失时调用方整组跳过。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const REMOTES_BUNDLE = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins", "@deepseek-ai", "dsh-api-remotes", "client.js");

/** 一条 typert 端点描述符（只取形状校验需要的字段）。 */
export interface VendorEndpointDescriptor {
  namespace: string;
  method: string;
  parameters: Array<{ name: string; wire: string; optional?: boolean }>;
  scope?: { context: string; wire: string };
  result: { create: () => { parse: (value: unknown) => unknown } };
}

/** 从 vendor 产物加载全部端点描述符（按 `<namespace>/<method>` 索引）。 */
export async function loadVendorEndpointDescriptors(): Promise<Map<string, VendorEndpointDescriptor>> {
  const code = readFileSync(REMOTES_BUNDLE, "utf8");
  let captured: { factory: (require: (id: string) => unknown) => { apply?: (ctx: unknown) => unknown } } | undefined;
  const sandbox = {
    window: { __ModuleLoader__: { load: (entry: typeof captured) => { captured = entry; } } },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  if (captured?.factory === undefined) throw new Error("api-remotes 产物未注册 ModuleLoader 条目");
  const mod = captured.factory((id: string) => {
    throw new Error(`api-remotes 产物出现未打包的外部依赖：${id}`);
  });
  const mounted: Array<{ descriptors?: VendorEndpointDescriptor[] }> = [];
  await mod.apply?.({ remote: { $mount: async (contribution: { descriptors?: VendorEndpointDescriptor[] }) => {
    mounted.push(contribution);
    return () => undefined;
  } } });
  const map = new Map<string, VendorEndpointDescriptor>();
  for (const contribution of mounted) {
    for (const descriptor of contribution.descriptors ?? []) map.set(`${descriptor.namespace}/${descriptor.method}`, descriptor);
  }
  if (map.size === 0) throw new Error("api-remotes 未产出任何端点描述符");
  return map;
}
