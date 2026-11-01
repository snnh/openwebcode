/** Agent 预设：身份行 + 基线提示词 + 产品小节 + 工具形态（白名单/隐藏/别名/描述覆盖）+ 命令提示词拟态（/init、/compact）。 */
export interface PresetAlias {
  from: string;
  as: string;
  description?: string;
  /** 模型可见的输入 schema 覆盖（拟态目标产品的参数形态）；缺省沿用内置工具的 schema。 */
  inputSchema?: Record<string, unknown>;
  /** 参数名归一：模型侧参数名 -> 内置工具参数名。未列出的键原样透传。 */
  argMap?: Record<string, string>;
}

export type PresetCategory = "minimal" | "mimicry" | "custom";

export interface AgentPreset {
  id: string;
  name: string;
  /** 一句话描述（UI 卡片/下拉）；旧文件缺省时回退到 name。 */
  description?: string;
  /** 分类元数据/徽标；UI 不按分类折叠。旧文件缺省时按是否内置推断。 */
  category?: PresetCategory;
  identity: string;
  basePrompt: string;
  productSections: string[];
  /** 白名单：非空时只保留这些内置工具；优先于 hideBuiltIns。精简模式用它。 */
  allowedBuiltIns?: string[];
  /** 黑名单：拟态预设继续使用；白名单之后再剔除。 */
  hideBuiltIns: string[];
  /** 提示词形态：classic=现有完整框架；minimal=精简模式专用裁剪。缺省 classic。 */
  promptStyle?: "classic" | "minimal";
  /** 项目上下文：paths=全局记忆注入+工作区文件只列路径；content=经典全量；none=不注入。缺省 content。 */
  projectContext?: "paths" | "content" | "none";
  /** 是否允许扩展/MCP 工具进入工具表；精简模式默认 false，经典/拟态默认 true。 */
  externalTools?: boolean;
  aliases: PresetAlias[];
  /** 逐工具描述覆盖（不改名也能改描述），键为内置工具名。 */
  toolDescriptions?: Record<string, string>;
  /** 首轮（会话首个模型调用）只注入这些内置工具（模型侧别名后名），其余内置保持
   * 隐藏；不设置则无首轮限制。第二轮起恢复正常形态（hideBuiltIns + read_artifact
   * 驱逐联动）。 */
  firstTurnOnlyTools?: string[];
  /** /init 命令展开提示词拟态（如 cc 产物为 CLAUDE.md）；优先级：用户覆盖 > 本字段 > 内置。 */
  initPrompt?: string;
  /** /compact（overview）压缩系统提示词拟态；优先级同 initPrompt。 */
  compactOverviewPrompt?: string;
  /** /compact tools 压缩系统提示词拟态；优先级同 initPrompt。 */
  compactToolcallsPrompt?: string;
  /** 出站 User-Agent 拟态值；仅当扩展配置 `simulateUserAgent` 手动开启且作为全局 preset 选中时，
   * 才覆盖所有出站 HTTP 请求的 UA（更新检查链路始终使用官方 UA，不参与模拟）。 */
  userAgent?: string;
}

export interface PresetSummary {
  id: string;
  name: string;
  description: string;
  category: PresetCategory;
  builtin: boolean;
  /** 内置预设存在用户覆盖文件（同 id 用户预设生效中）；仅 builtin 时可能出现。 */
  overridden?: boolean;
}

/** 详情端点返回的完整预设（含来源标记；overridden = 内置 id 存在用户覆盖，返回合并形态）。 */
export type PresetDetail = Omit<AgentPreset, "description" | "category"> & {
  description: string;
  category: PresetCategory;
  builtin: boolean;
  overridden?: boolean;
};

export interface PresetToolInfo {
  name: string;
  /** 中文短名（编辑器按 language 二选一显示）。 */
  label: string;
  /** 英文短名。 */
  labelEn: string;
  group: "core" | "web" | "media" | "interaction" | "git" | "analysis" | "orchestration" | "workflow" | "external";
  description: string;
  /** 条件注入（联网、媒体、cron、后台任务、swarm 等）。 */
  optional?: boolean;
  /** 精简模式编辑器不提供的工具（write_file/glob/grep）；拟态预设仍可用 hideBuiltIns。 */
  advancedOnly?: boolean;
  /** 精简模式必选（bash）。 */
  required?: boolean;
  /** 精简模式默认开（core/web/media/interaction）。 */
  defaultEnabled?: boolean;
}

export interface PresetToolGroup {
  id: PresetToolInfo["group"];
  label: string;
  labelEn: string;
  tools: string[];
  defaultEnabled: boolean;
}
