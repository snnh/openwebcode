/**
 * 内置工具的常见异名参数容错表（模型把其他产品的参数形态套用到本工具时）：
 * 规范键缺失时由别名键回填，显式提供的规范键永远优先；命中的别名键一律剥离，
 * 未列出的键原样透传（不引入 additionalProperties 强制，schema 仍是唯一声明面）。
 */
const BUILTIN_INPUT_ALIASES: Record<string, Record<string, string>> = {
  // bash：Claude Code 等形态用 command
  bash: { command: "cmd" },
  // 文件工具：Claude Code 形态 file_path / old_string / new_string / replace_all
  read_file: { file_path: "path" },
  write_file: { file_path: "path" },
  edit_file: { file_path: "path", old_string: "oldText", new_string: "newText", replace_all: "replaceAll" },
  // 后台任务：snake_case task_id
  task_output: { task_id: "taskId" },
  task_stop: { task_id: "taskId" },
};

/**
 * 异名参数归一：name 为内置工具名（调用方先经 resolveBuiltinToolName 解析）。
 * 有改写时返回新对象（copy-on-write，不改原引用）；无改写原样返回。
 * 必须在权限判定/重复守卫/执行分发之前应用，下游只看到规范参数名。
 */
export function normalizeBuiltinToolInput(name: string, input: Record<string, unknown>): Record<string, unknown> {
  const aliases = BUILTIN_INPUT_ALIASES[name];
  if (!aliases) return input;
  let normalized: Record<string, unknown> | undefined;
  for (const [alias, canonical] of Object.entries(aliases)) {
    // 别名键缺失时跳过；规范键（含已改写出的）存在时仅剥离别名键，不覆盖
    if (input[alias] === undefined) continue;
    normalized ??= { ...input };
    if (normalized[canonical] === undefined) normalized[canonical] = normalized[alias];
    delete normalized[alias];
  }
  return normalized ?? input;
}

/**
 * 工具形态别名解析器（拆分自 agent-runner.ts）：
 * 会话级别名（模型侧工具名 → 内置名）与参数名归一（模型侧参数名 → 内置参数名）。
 * 形态由实时扩展配置（env-sim 等）驱动，不可跨 run 缓存——每轮重建，run 结束清理。
 * 执行/权限/门禁统一按内置名归一。
 */
export class ToolAliasResolver {
  private readonly toolAliases = new Map<string, Map<string, string>>();
  private readonly toolAliasArgMaps = new Map<string, Map<string, Record<string, string>>>();

  /** 每轮重建别名面（工具形态应用结果）；无形态时传空 Map 等价清空。 */
  setShaping(
    sessionId: string,
    aliasMap: Map<string, string>,
    aliasArgMaps: Map<string, Record<string, string>>,
  ): void {
    this.toolAliases.set(sessionId, aliasMap);
    this.toolAliasArgMaps.set(sessionId, aliasArgMaps);
  }

  /** 工具形态别名 → 内置名解析；无映射时原样返回（权限/门禁/分发统一按内置名）。 */
  resolveBuiltinToolName(sessionId: string, name: string): string {
    return this.toolAliases.get(sessionId)?.get(name) ?? name;
  }

  /**
   * 别名工具的参数名归一（env-sim 拟态外部产品参数形态）：模型侧参数名按 argMap
   * 改回内置参数名，未列出的键原样透传。归一发生在权限/门禁/执行之前，
   * 下游链路只看到内置工具的标准参数。
   */
  translateAliasInput(sessionId: string, name: string, input: Record<string, unknown>): Record<string, unknown> {
    const argMap = this.toolAliasArgMaps.get(sessionId)?.get(name);
    if (!argMap) return input;
    const translated: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) translated[argMap[key] ?? key] = value;
    return translated;
  }

  /** run 结束清理：abort 与正常结束都调用，避免跨会话残留别名。 */
  discard(sessionId: string): void {
    this.toolAliases.delete(sessionId);
    this.toolAliasArgMaps.delete(sessionId);
  }
}
