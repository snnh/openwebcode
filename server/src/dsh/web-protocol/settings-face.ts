/**
 * dsh 设置 / 模型目录面（M4 续）：`llm/*`、`settings/describe`、`credentials/describe` 的**只读投影**。
 *
 * 背景：dsh 的「设置 → 模型」页与「通用设置」页分别依赖
 *   - `llm/listProviders`（已注册服务商）与 `llm/listConfigurableProviders`（可配置目录，客户端按
 *     `settingsNs` + `settingsPath` 去读设置值与凭据）；
 *   - `settings/describe`（设置命名空间视图：`value`/`base`/`user`/`secrets`/`revision`/`applies`）；
 *   - `credentials/describe(refs)`（凭据是否已配置）。
 * 三者缺一，页面直接报「加载提供方目录失败」（实测）。owc 侧的事实来源是**服务商档案**
 * （`<dataDir>/provider-profiles.json`，含 apiKey/baseURL/interfaceType），因此这里把它投影成
 * 一个只读命名空间 `owc.provider-profiles`：模型列表照实显示、凭据状态照实显示，
 * `writable: false` 明确表达「dsh 面板不接管 owc 的设置写入」（写入走 owc 主界面/REST）。
 *
 * 形状权威来源：vendor `@deepseek-ai/dsh-api-remotes` 的 strict codec（typert.remote-client）：
 *   llm/listProviders → { id, name }[]
 *   llm/listConfigurableProviders → { provider, displayName, settingsNs, settingsPath, declared?, error? }[]
 *   settings/describe → { writable, hasDocument, namespaces: [{ ns, schema, value, base?, user?, applies, secrets: [{path, set}], revision }] }
 *   credentials/describe(refs) → Record<ref, { configured, source?, writable }>
 */
/** 只读命名空间名（dsh 侧设置页的分组键；`owc.` 前缀表明来源是 owc 而非 dsh 自身）。 */
export const OWC_SETTINGS_NS = "owc.provider-profiles";

/** 服务商档案的窄投影（翻译层只需这几项）。 */
interface DshProviderProfile {
  id: string;
  enabled: boolean;
  interfaceType: string;
  baseURL?: string;
  hasApiKey: boolean;
}

/** 设置面需要的事实来源（index.ts 用 providerProfiles 装配；测试注入假对象）。 */
export interface DshSettingsSources {
  profiles(): readonly DshProviderProfile[];
  /** 按 profile id 派生的凭据引用（与 vendor `deriveKeyRef` 同规则）。 */
}

/**
 * 凭据引用派生：与 vendor `dsh-client-ui-settings-models` 的 `deriveKeyRef` **逐字同规则**
 * （`${id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`）——否则 `credentials/describe`
 * 的键对不上，UI 会一直显示「未配置」。
 */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

/**
 * `llm/listConfigurableProviders`：已声明（档案里存在）的服务商 + 其设置位置。
 *
 * `settingsPath` 指向命名空间值里的 profile id，UI 用它判断 `configured`（值存在即已配置）；
 * `declared: true` 表示这是声明式目录项（有档案），与「仅注册」的服务商区分。
 */
export function projectConfigurableProviders(sources: DshSettingsSources): Array<Record<string, unknown>> {
  return sources.profiles().map((profile) => ({
    provider: profile.id,
    displayName: profile.id,
    settingsNs: OWC_SETTINGS_NS,
    settingsPath: [profile.id],
    declared: true,
  }));
}

/**
 * `settings/describe`：owc 服务商档案的只读命名空间视图。
 *
 * - `writable: false`：dsh 面板不写 owc 设置（写入走 owc 主界面 / REST，避免两套写入面互相覆盖）；
 * - `value`/`base` 同值（没有 user 覆盖层），使 UI 判「已配置」而非「可移除」；
 * - `secrets` 逐档案列出 apiKey 路径与是否已设置（不泄漏任何密钥值）；
 * - `applies: 'live'`：owc 的服务商档案热生效（保存即重建 provider）。
 */
/**
 * 端点 URL 脱敏：去掉 userinfo（`https://user:token@host/...` 这类内联凭据），
 * 内网地址与路径照实保留（dsh 设置页需要展示端点以辨认服务商）。不可解析时返回原串。
 */
function redactBaseUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.username === "" && parsed.password === "") return value;
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return value;
  }
}

export function projectSettingsDescribe(sources: DshSettingsSources, revision = 1): Record<string, unknown> {
  const profiles = sources.profiles();
  const value: Record<string, unknown> = {};
  const secrets: Array<{ path: string[]; set: boolean }> = [];
  for (const profile of profiles) {
    value[profile.id] = {
      enabled: profile.enabled,
      interfaceType: profile.interfaceType,
      ...(profile.baseURL === undefined ? {} : { baseURL: redactBaseUrl(profile.baseURL) }),
    };
    secrets.push({ path: [profile.id, "apiKey"], set: profile.hasApiKey });
  }
  return {
    writable: false,
    hasDocument: true,
    namespaces: [
      {
        ns: OWC_SETTINGS_NS,
        schema: null,
        value,
        base: value,
        applies: "live",
        secrets,
        revision,
      },
    ],
  };
}

/**
 * `credentials/describe(refs)`：请求的引用是否已配置。
 *
 * 只认派生的约定引用（`<PROVIDER>_API_KEY`）：匹配到同名档案且该档案有 apiKey 即 `configured: true`；
 * 未匹配到档案的引用如实回 `configured: false`（不猜、不假装凭据存在）。
 * `writable: false`：凭据只在 owc 主界面管理。
 */
export function projectCredentialsDescribe(sources: DshSettingsSources, refs: readonly string[]): Record<string, unknown> {
  const profiles = sources.profiles();
  const configured = new Set(profiles.filter((profile) => profile.hasApiKey).map((profile) => deriveKeyRef(profile.id)));
  const result: Record<string, unknown> = {};
  for (const ref of refs) result[ref] = { configured: configured.has(ref), writable: false };
  return result;
}

/** 解析 `credentials/describe` 的入参（第一个位置参数是引用数组）。 */
export function parseCredentialRefs(value: unknown): string[] | { error: string } {
  if (!Array.isArray(value)) return { error: "credentials/describe 需要引用数组" };
  const refs = value.filter((item): item is string => typeof item === "string" && item !== "");
  if (refs.length !== value.length) return { error: "引用必须是非空字符串" };
  return refs;
}
