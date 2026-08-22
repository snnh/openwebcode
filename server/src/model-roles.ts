import type { ModelSelection } from "./config.js";
import type { EffortLevel, ModelProfile, ThinkingMode } from "./context/model-profile.js";
import type { ProviderRegistry } from "./providers/provider.js";
import type { SettingsService } from "./settings-service.js";

/** 子代理模型角色四档：premium（极致）/ balanced（平衡）/ fast（快速）/ cheap（廉价）。 */
export type ModelRole = "premium" | "balanced" | "fast" | "cheap";

export const MODEL_ROLES: readonly ModelRole[] = ["premium", "balanced", "fast", "cheap"];

export function isModelRole(value: string): value is ModelRole {
  return (MODEL_ROLES as readonly string[]).includes(value);
}

/**
 * 角色 → 生效 provider+model 的解析器。每次调用现读 settings.effective()，
 * settings 热更新即生效，无需显式热应用回调。
 *
 * 存在性校验语义（选定并固定）：角色指向的 provider 已注销/未注册时返回 undefined
 * 而非抛错——角色是可选优化，失效后调用方沿回落链继续（balanced → 会话默认）；
 * 这与显式指定 provider 时的 "Provider X is not configured" 报错刻意区分开。
 */
export class ModelRoleResolver {
  constructor(
    private readonly settings: SettingsService | undefined,
    private readonly providers: ProviderRegistry,
  ) {}

  /** fast 档直接读现有 fastModel 配置；其余档读 roleModels。* 未配置或 provider 已注销返回 undefined。 */
  resolve(role: ModelRole): ModelSelection | undefined {
    const config = this.settings?.effective();
    if (!config) return undefined;
    const selection = role === "fast"
      ? (config.fastModel ? { provider: config.fastModel.provider, model: config.fastModel.model } : undefined)
      : config.roleModels?.[role];
    if (!selection || !this.providers.get(selection.provider)) return undefined;
    return { provider: selection.provider, model: selection.model };
  }

  /** 回落链由调用方提供终点：角色未配置 → balanced → fallback（通常是会话默认，调用方组合）。 */
  resolveWithFallback(role: ModelRole, fallback: ModelSelection | undefined): ModelSelection | undefined {
    return this.resolve(role) ?? (role === "balanced" ? undefined : this.resolve("balanced")) ?? fallback;
  }
}

/**
 * thinking/effort 值传递（用户优先，不设限）：模型目录声明仅用于 UI 能力展示与默认参数
 * （metadata 内置默认、用户可在目录覆盖）；用户显式设置的具体值原样透传，不做模型级
 * 白名单过滤（「推理参数的具体值不设限」）。仅做全局枚举合法性校验（路由层已完成）。
 */
export function filterReasoningByCapabilities(
  _profile: ModelProfile,
  requested: { thinking?: ThinkingMode; effort?: EffortLevel },
): { thinking?: ThinkingMode; effort?: EffortLevel } {
  return { ...(requested.thinking ? { thinking: requested.thinking } : {}), ...(requested.effort ? { effort: requested.effort } : {}) };
}
