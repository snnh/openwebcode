/**
 * dsh 模型事实桥（M4 续）：把 owc 的服务商注册表 / 模型目录 / 设置默认值投影成
 * {@link DshModelBridge}，供 dsh 兼容模式的 `session/modelCatalog` 与 `session/selectModel` 使用。
 *
 * 放在 `dsh/`（而不是 `dsh/web-protocol/`）：这里读 owc 服务，是装配层；翻译层的投影保持纯函数。
 */
import type { ModelProfile, EffortLevel } from "../context/model-profile.js";
import type { ModelSelection } from "../config.js";
import type { CatalogModel } from "../context/model-registry.js";
import type { DshCatalogModel, DshModelBridge, DshModelSelection } from "./web-protocol/models.js";

/** 装配所需的最小事实来源面（index.ts 传入真实对象；测试可注入假对象）。 */
export interface DshModelSources {
  providers: { list(): string[] };
  models: {
    list(): CatalogModel[];
    get(model: string, provider?: string): ModelProfile;
  };
  settings: { effective(): { defaultModel?: ModelSelection; defaultEffort?: EffortLevel } };
}

/** 目录行投影（只取翻译层用到的能力位，避免把整个 profile 泄漏进 wire 层）。 */
function toCatalogModel(model: CatalogModel): DshCatalogModel {
  return {
    provider: model.provider,
    id: model.id,
    ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
    ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
    capabilities: {
      thinking: [...(model.capabilities.thinking ?? [])],
      effort: [...(model.capabilities.effort ?? [])],
    },
  };
}

/**
 * 部署默认选择：`settings.defaultModel`（新建会话的隐式模型）。
 *
 * effort 跟随 `settings.defaultEffort`，但做与新建会话同口径的能力白名单校验
 * （模型声明了档位就必须包含，未声明 = 全开）——不支持时静默不带 effort，与 REST 路径一致。
 */
export function defaultDshSelection(sources: DshModelSources): DshModelSelection | undefined {
  const config = sources.settings.effective();
  const selected = config.defaultModel;
  if (selected === undefined) return undefined;
  const declared = sources.models.get(selected.model, selected.provider).capabilities.effort;
  const effort = config.defaultEffort;
  const effortOk = effort !== undefined && (declared.length === 0 || declared.includes(effort));
  return {
    provider: selected.provider,
    model: selected.model,
    ...(effortOk ? { reasoningEffort: effort } : {}),
  };
}

/** 组装 dsh 模型桥；`models()` 每次现读（模型目录/服务商可热更新，不做缓存）。 */
export function createDshModelBridge(sources: DshModelSources): DshModelBridge {
  return {
    providers: () => sources.providers.list(),
    models: () => sources.models.list().map(toCatalogModel),
    defaults: () => defaultDshSelection(sources),
  };
}
