/**
 * dsh 模型面（M4 续）：`session/modelCatalog`、`session/selectModel` 与会话 `modelSelection` 投影。
 *
 * 形状权威来源：vendor `@deepseek-ai/dsh-api-session-controller` 的 `typert.remote-client.js`
 * （`ModelCatalog` / `SessionSelectModelRequest` / `SessionSelectModelValue` / `ModelSelectionProjection`）。
 * 原则与 session-projection 一致：只做只读投影与入参校验，不编造能力、不建第二份模型目录。
 */
import type { SessionMeta } from "../../sessions/types.js";
import { wireError, type DshWireError } from "./wire.js";
import type { DshProjected } from "./session-projection.js";

/** 一次模型选择（dsh `ModelSelection`；`reasoningEffort` 对应 owc 的会话 effort）。 */
export interface DshModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

/** 目录里的一条模型（owc `ModelRegistry.list()` 的窄投影）。 */
export interface DshCatalogModel {
  provider: string;
  id: string;
  displayName?: string;
  contextWindow?: number;
  capabilities?: { thinking?: readonly string[]; effort?: readonly string[] };
}

/** 翻译层需要的模型事实来源（由 index.ts 装配，测试可注入假对象）。 */
export interface DshModelBridge {
  /** 当前可路由（已配置凭据）的服务商名。 */
  providers(): string[];
  /** 模型目录。 */
  models(): readonly DshCatalogModel[];
  /** 部署默认选择（settings defaultModel + 能力白名单校验过的 defaultEffort）。 */
  defaults(): DshModelSelection | undefined;
}

/** effort 档位展示名（id 是契约，name 只是 dsh UI 的标题）。 */
const EFFORT_LABELS: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "X-High",
  max: "Max",
  ultra: "Ultra",
};

/**
 * 模型未声明 effort 档位时的兜底（与 REST `/api/sessions/:id/config` 的「未声明 = 全开」一致）：
 * 空数组 = 不限制，UI 给出全部合法档位。
 */
const ALL_EFFORTS: readonly string[] = ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 单条模型 → dsh catalog 行；`reasoning` 只在该模型确实支持思考时下发。 */
function catalogModel(model: DshCatalogModel, defaults: DshModelSelection | undefined): Record<string, unknown> {
  const thinking = model.capabilities?.thinking ?? [];
  const declared = model.capabilities?.effort ?? [];
  const supportsReasoning = thinking.length > 0 || declared.length > 0;
  const row: Record<string, unknown> = {
    id: model.id,
    name: model.displayName ?? model.id,
  };
  if (!supportsReasoning) return row;
  const efforts = declared.length > 0 ? declared : ALL_EFFORTS;
  row.reasoning = {
    efforts: efforts.map((level) => ({ id: level, name: EFFORT_LABELS[level] ?? level })),
    ...(defaults !== undefined && defaults.provider === model.provider && defaults.model === model.id && defaults.reasoningEffort !== undefined
      ? { defaultEffort: defaults.reasoningEffort }
      : {}),
  };
  return row;
}

/** 无默认设置时的回退：优先「可路由服务商」的第一条模型，其次是目录第一条（都没有则如实留空）。 */
function fallbackSelection(routable: readonly string[], models: readonly DshCatalogModel[]): DshModelSelection {
  const preferred = models.find((model) => routable.includes(model.provider)) ?? models[0];
  if (preferred === undefined) return { provider: routable[0] ?? "", model: "" };
  return { provider: preferred.provider, model: preferred.id };
}

/**
 * `session/modelCatalog`：按服务商分组下发模型目录 + 部署默认值 + 可路由服务商。
 *
 * `failures`：owc 的模型目录是「启动时同步 + 手动刷新」的快照，没有按服务商的独立失败面，
 * 因此如实留空（不编造失败项；服务商不可用的信息由 `routableProviders` 表达）。
 */
export function projectModelCatalog(bridge: DshModelBridge): Record<string, unknown> {
  const routable = [...bridge.providers()];
  const defaults = bridge.defaults();
  const groups = new Map<string, { id: string; name: string; models: unknown[] }>();
  for (const model of bridge.models()) {
    let group = groups.get(model.provider);
    if (group === undefined) {
      group = { id: model.provider, name: model.provider, models: [] };
      groups.set(model.provider, group);
    }
    group.models.push(catalogModel(model, defaults));
  }
  return {
    default: defaults ?? fallbackSelection(routable, bridge.models()),
    routableProviders: routable,
    groups: [...groups.values()],
    failures: [],
  };
}

/**
 * 会话 `projections.values.modelSelection`：dsh 模型选择器的「当前选择」来源。
 *
 * `next` 为空（未记录选择，如 provider/model 落在旧数据里为空串）时下发 null，
 * 客户端按 catalog 的部署默认值展示；`lastUsed` 不单独记账，如实为 null。
 */
export function modelSelectionValue(meta: Pick<SessionMeta, "provider" | "model" | "effort">): Record<string, unknown> {
  const provider = asString(meta.provider);
  const model = asString(meta.model);
  const selected = provider === undefined || model === undefined
    ? null
    : { provider, model, ...(meta.effort === undefined ? {} : { reasoningEffort: meta.effort }) };
  return { lastUsed: null, next: selected };
}

/** `session/selectModel` 的落盘侧依赖（runtime 装配；单测注入假对象）。 */
export interface DshModelSelectDeps extends DshModelBridge {
  /** 读会话当前选择；会话不存在返回 undefined。 */
  selectionOf(sessionId: string): Promise<DshModelSelection | undefined>;
  /** 会话是否在跑（owc 只在空闲时允许切模型，与 REST 一致）。 */
  isRunning(sessionId: string): boolean;
  /** 写入选择（provider/model 必写；effort 为 undefined 时按 updateConfig 语义清除）。 */
  apply(sessionId: string, selection: DshModelSelection): Promise<void>;
}

/** 解析 dsh 请求体里的选择字段（`args.request`）。 */
function parseSelection(args: Record<string, unknown>): { sessionId: string; selection: DshModelSelection } | { error: DshWireError } {
  const request = typeof args.request === "object" && args.request !== null && !Array.isArray(args.request)
    ? (args.request as Record<string, unknown>)
    : {};
  const sessionId = asString(request.sessionId);
  if (sessionId === undefined) return { error: wireError("session/arguments-invalid", "request.sessionId 缺失") };
  const provider = asString(request.provider);
  const model = asString(request.model);
  if (provider === undefined || model === undefined) {
    return { error: wireError("session/arguments-invalid", "request.provider/model 缺失") };
  }
  const effort = request.reasoningEffort;
  if (effort !== undefined && (typeof effort !== "string" || effort === "")) {
    return { error: wireError("session/arguments-invalid", "reasoningEffort 必须是非空字符串") };
  }
  return { sessionId, selection: { provider, model, ...(typeof effort === "string" ? { reasoningEffort: effort } : {}) } };
}

/**
 * `session/selectModel`：校验后写入会话模型。
 *
 * 校验口径与 REST `/api/sessions/:id/config` 一致：服务商须已配置、模型须在目录中、
 * effort 须在该模型声明的档位内（模型未声明档位 = 全开）。
 */
export async function projectSelectModel(deps: DshModelSelectDeps, args: Record<string, unknown>): Promise<DshProjected<{ selected: DshModelSelection }>> {
  const parsed = parseSelection(args);
  if ("error" in parsed) return parsed;
  const { sessionId, selection } = parsed;
  if (await deps.selectionOf(sessionId) === undefined) {
    return { error: wireError("session/not-found", "会话不存在", { sessionId }) };
  }
  if (deps.isRunning(sessionId)) {
    return { error: wireError("session/agent-busy", "会话运行中，模型只能在空闲时切换", { sessionId }) };
  }
  if (!deps.providers().includes(selection.provider)) {
    return { error: wireError("session/model-unavailable", `服务商未配置：${selection.provider}`, { provider: selection.provider }) };
  }
  const model = deps.models().find((item) => item.provider === selection.provider && item.id === selection.model);
  if (model === undefined) {
    return { error: wireError("session/model-unavailable", `模型不在目录中：${selection.model}`, { provider: selection.provider, model: selection.model }) };
  }
  const declared = model.capabilities?.effort ?? [];
  if (selection.reasoningEffort !== undefined && declared.length > 0 && !declared.includes(selection.reasoningEffort)) {
    return {
      error: wireError("session/arguments-invalid", `模型不支持该思考力度：${selection.reasoningEffort}`, {
        model: selection.model,
        reasoningEffort: selection.reasoningEffort,
      }),
    };
  }
  await deps.apply(sessionId, selection);
  return { value: { selected: selection } };
}
