/**
 * dsh **线格式断言工具**（测试专用）。
 *
 * 唯一事实来源是 vendor 客户端产物（`server/assets/dsh-web/**`，钉版 0.1.6-alpha.2）：
 * - 面事件标记校验（`assertSessionWireEvent` / `surfaceOpOf` / `SURFACE_EVENT_TYPES`）与
 *   「follow 首帧必须带 assistantStream 基线」逐字从
 *   `plugins/@deepseek-ai/dsh-api-session-controller/client.js` 的 esbuild region 抽出后
 *   **原样求值**（不做二次实现，避免测试自己造一套宽松校验）；
 * - 端点参数形状校验直接读 vendor 生成的 typert 描述符（`parameters[].wire`），
 *   复刻客户端把请求编码成 `payload:{args}` 的规则。
 *
 * vendor 缺失时构造器抛错，调用方用 {@link vendorWireAssertions} 的 undefined 结果跳过整组测试。
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VENDOR_PLUGINS = path.join(SERVER_ROOT, "assets", "dsh-web", "plugins");

/** 会话控制器的 client bundle（校验函数所在产物）。 */
const SESSION_CONTROLLER_CLIENT = path.join(VENDOR_PLUGINS, "@deepseek-ai", "dsh-api-session-controller", "client.js");

/** 会话控制器的 typert 客户端描述符（参数/结果形状）。 */
const SESSION_CONTROLLER_DESCRIPTORS = path.join(VENDOR_PLUGINS, "@deepseek-ai", "dsh-api-session-controller", "typert.remote-client.js");

/** vendor 产物是否就绪（未 vendor 时相关测试整组跳过）。 */
export const VENDOR_READY = existsSync(SESSION_CONTROLLER_CLIENT) && existsSync(SESSION_CONTROLLER_DESCRIPTORS);

/** 一个 session wire 事件（`session/follow` 的 records 元素内层 / `session/page` 的 records 元素内层）。 */
interface VendorWireEvent {
  type: string;
  seq: number;
  time: number;
  data: unknown;
  surfaceOp?: unknown;
  sourceEventSeqs?: unknown;
  ignorable?: true;
}

/** 从 vendor bundle 里抽出的**真实**校验函数（由 vendor 源码原样求值得到）。 */
export interface VendorWireAssertions {
  /** vendor `assertSessionWireEvent`：逐条校验事件信封 + surface 标记 + 局部载荷规则。 */
  assertSessionWireEvent(value: unknown): void;
  /** vendor `surfaceOpOf`：返回事件的面操作（非面事件为 undefined）。 */
  surfaceOpOf(event: VendorWireEvent): unknown;
  /** vendor `SURFACE_EVENT_TYPES` 的判定。 */
  isSurfaceEligibleType(type: string): boolean;
  /** 断言一帧 follow 快照（含客户端对 assistantStream 基线的硬要求）。 */
  assertFollowSnapshot(value: unknown): void;
}

/** 从 bundle 文本里按 region 标记抽取片段（esbuild region 边界是稳定锚点）。 */
function extractRegion(source: string, name: string): string {
  const start = source.indexOf(`//#region ${name}`);
  if (start === -1) throw new Error(`vendor 产物缺少 region：${name}（产物版本漂移？）`);
  const rest = source.slice(start + `//#region ${name}`.length);
  const end = rest.search(/\n\s*\/\/#(?:region|endregion)/);
  if (end === -1) throw new Error(`vendor 产物的 region 未闭合：${name}`);
  return rest.slice(0, end);
}

/** 构造断言工具（读 vendor 产物；产物缺失返回 undefined，调用方据此跳过）。 */
export function vendorWireAssertions(): VendorWireAssertions | undefined {
  if (!VENDOR_READY) return undefined;
  const source = readFileSync(SESSION_CONTROLLER_CLIENT, "utf8");
  const moduleSource = [
    extractRegion(source, "../../core/session/lib/types/known-event-types.js"),
    extractRegion(source, "../../core/session/lib/types/surface.js"),
    extractRegion(source, "lib/types/client/session-wire-event.js"),
  ].join("\n");
  const factory = new Function(
    `${moduleSource}\nreturn { assertSessionWireEvent, surfaceOpOf, isSurfaceEligibleType };`,
  ) as () => Pick<VendorWireAssertions, "assertSessionWireEvent" | "surfaceOpOf" | "isSurfaceEligibleType">;
  const real = factory();
  return {
    ...real,
    assertFollowSnapshot(value: unknown): void {
      // 客户端 SessionEventStream.follow 的首帧校验（client.js）：records 逐条断言 + assistantStream 必须在
      const frame = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
      if (frame.type !== "snapshot") throw new Error("follow 首帧不是 snapshot");
      const records = frame.records;
      if (!Array.isArray(records)) throw new Error("follow 首帧缺少 records 数组");
      for (const record of records) {
        const inner = (typeof record === "object" && record !== null ? (record as Record<string, unknown>).event : undefined);
        real.assertSessionWireEvent(inner);
      }
      const assistantStream = frame.assistantStream;
      if (assistantStream === undefined) throw new Error("session assistant stream omitted its opted-in opening baseline");
      const revision = (assistantStream as { revision?: unknown }).revision;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
        throw new Error("assistantStream.revision 必须是非负安全整数");
      }
    },
  };
}

/** 一条 typert 端点描述符（只取形状校验需要的字段）。 */
export interface VendorDescriptor {
  namespace: string;
  method: string;
  parameters: Array<{ name: string; wire: string; optional?: boolean }>;
  result: { create: () => { parse: (value: unknown) => unknown } };
}

/** 读 vendor 生成的 typert 描述符（按 `<namespace>/<method>` 索引）。 */
export async function vendorDescriptors(file = SESSION_CONTROLLER_DESCRIPTORS): Promise<Map<string, VendorDescriptor>> {
  const mod = (await import(`file://${file}`)) as { default: { descriptors: VendorDescriptor[] } };
  const map = new Map<string, VendorDescriptor>();
  for (const descriptor of mod.default.descriptors) map.set(`${descriptor.namespace}/${descriptor.method}`, descriptor);
  return map;
}

/**
 * 端点参数形状校验（复刻客户端编码规则）：open 帧 `payload` 只能有 `args` 键，`args` 的键
 * 必须都在描述符声明的 wire 名里，且无参数端点只能收到空 args。
 * @throws 形状不符时说明差异（测试里表现为断言失败）。
 */
export function assertOpenPayloadShape(descriptor: VendorDescriptor, payload: unknown): void {
  const record = (typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : undefined) as Record<string, unknown> | undefined;
  if (record === undefined) throw new Error(`${descriptor.namespace}/${descriptor.method}: open 帧 payload 必须是对象`);
  const payloadKeys = Object.keys(record);
  if (payloadKeys.length !== 1 || payloadKeys[0] !== "args") {
    throw new Error(`${descriptor.namespace}/${descriptor.method}: open 帧 payload 键必须恰好是 args，实际 ${JSON.stringify(payloadKeys)}`);
  }
  const args = record.args;
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new Error(`${descriptor.namespace}/${descriptor.method}: args 必须是对象`);
  const wireNames = new Set(descriptor.parameters.map((parameter) => parameter.wire));
  for (const key of Object.keys(args)) {
    if (!wireNames.has(key)) throw new Error(`${descriptor.namespace}/${descriptor.method}: args 出现未声明参数 ${key}（声明：${[...wireNames].join(", ") || "无"}）`);
  }
  if (descriptor.parameters.length === 0 && Object.keys(args).length > 0) {
    throw new Error(`${descriptor.namespace}/${descriptor.method}: 该端点无参数，args 必须为空对象`);
  }
}
