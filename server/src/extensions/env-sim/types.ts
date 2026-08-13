/** env-sim 预设：身份行 + 基线提示词 + 产品小节 + 工具形态（隐藏/别名）+ 命令提示词拟态（/init、/compact）。 */
export interface PersonaAlias {
  from: string;
  as: string;
  description?: string;
  /** 模型可见的输入 schema 覆盖（拟态目标产品的参数形态）；缺省沿用内置工具的 schema。 */
  inputSchema?: Record<string, unknown>;
  /** 参数名归一：模型侧参数名 -> 内置工具参数名。未列出的键原样透传。 */
  argMap?: Record<string, string>;
}

export interface PersonaPreset {
  id: string;
  name: string;
  identity: string;
  basePrompt: string;
  productSections: string[];
  hideBuiltIns: string[];
  aliases: PersonaAlias[];
  /** /init 命令展开提示词拟态（如 cc 产物为 CLAUDE.md）；优先级：用户覆盖 > 本字段 > 内置。 */
  initPrompt?: string;
  /** /compact（overview）压缩系统提示词拟态；优先级同 initPrompt。 */
  compactOverviewPrompt?: string;
  /** /compact tools 压缩系统提示词拟态；优先级同 initPrompt。 */
  compactToolcallsPrompt?: string;
  /** 出站 User-Agent 拟态值（如 "claude-code/2.4.6"）；仅当扩展配置
   * `simulateUserAgent` 手动开启且作为全局 persona 选中时，才覆盖所有出站
   * HTTP 请求的 UA（更新检查链路始终使用官方 UA，不参与模拟）。 */
  userAgent?: string;
}

export interface PersonaSummary {
  id: string;
  name: string;
  builtin: boolean;
}

/** 详情端点返回的完整预设（含来源标记）。 */
export interface PersonaDetail extends PersonaPreset {
  builtin: boolean;
}
