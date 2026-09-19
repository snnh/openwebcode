/**
 * owc-dsh-bridge 产物加载与 owc 事实端点（M4 步骤 18）。
 *
 * 桥接插件是**手写 bundle**（无构建步骤），随 `server/assets/` 一起进发布包；翻译层在启动时
 * 读它、算 rev、追加进 boot graph。文件缺失时如实跳过（不阻塞 dsh 模式本身）。
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DshVendorPlugin } from "./boot-graph.js";

/** 桥接插件 id（boot graph 里的 entry 名，也是 `/plugins/<id>/client.js` 的路径段）。 */
export const OWC_BRIDGE_ID = "owc-dsh-bridge";

/** 桥接插件 bundle 相对桥接目录的文件名（目录本身由调用方给出：`server/assets/dsh-bridge`）。 */
export const OWC_BRIDGE_FILE = "client.js";

/** owc 事实（dsh 端口同源端点 `/dsh-owc/status` 的响应体）。 */
export interface DshOwcStatus {
  /** 服务版本（展示与排障用）。 */
  version: string;
  /** dsh UI 版本（vendor 钉版）。 */
  dshVersion: string;
  /** 回跳 owc 主 SPA 的 URL（含令牌参数，便于首次换 cookie）。 */
  workbenchUrl: string;
  /** 入口按钮文案（跟随界面语言）。 */
  workbenchLabel: string;
  [key: string]: unknown;
}

/**
 * 读桥接插件产物并生成 boot graph entry；文件缺失返回 undefined。
 * rev 用 bundle 内容的 sha1 前 12 位（与 vendor 插件同口径，供 `/plugins` 路由校验）。
 */
export async function loadBridgePlugin(assetsDirectory: string): Promise<DshVendorPlugin | undefined> {
  const file = path.join(assetsDirectory, OWC_BRIDGE_FILE);
  const body = await readFile(file).catch(() => undefined);
  if (body === undefined) return undefined;
  return {
    id: OWC_BRIDGE_ID,
    version: "1.12.0",
    rev: createHash("sha1").update(body).digest("hex").slice(0, 12),
    entry: "client.js",
    files: ["client.js"],
    // dsh 官方 UI 包之外的自有插件：无 inject/external 依赖（只用 fetch + DOM）
    inject: [],
    external: [],
  };
}

/** 构造 `/dsh-owc/status` 响应体（令牌只在主端口首次换 cookie 时需要，故按需带上）。 */
export function buildOwcStatus(input: {
  version: string;
  dshVersion: string;
  mainPort: number;
  protocol: string;
  host: string;
  accessToken?: string | undefined;
  label?: string;
}): DshOwcStatus {
  const token = input.accessToken === undefined ? "" : `?token=${encodeURIComponent(input.accessToken)}`;
  return {
    version: input.version,
    dshVersion: input.dshVersion,
    workbenchUrl: `${input.protocol}//${input.host}:${input.mainPort}/${token}`,
    workbenchLabel: input.label ?? "返回 Workbench",
  };
}
