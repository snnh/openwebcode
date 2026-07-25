/**
 * 命令注册表（0.4.0 Phase 5a）：命令 id、双语标题、when 条件、handler。
 * 注册表与 UI 解耦：App 在挂载时注册内建命令（见 builtin.ts），
 * 命令面板/快捷键分发/审计测试都从这里读取。
 */

export interface Command {
  id: string;
  /** 双语标题；命令 id 不翻译（守则 §8） */
  title: { zh: string; en: string };
  /**
   * when 条件：空格分隔的上下文 key，全部满足才可用；`!key` 表示取反。
   * 例："sessionActive running"、"!dialogOpen"
   */
  when?: string;
  handler(): void;
}

/** when 求值所需的上下文快照，由调用方（App/测试）提供 */
export type WhenContext = Record<string, boolean>;

export function evaluateWhen(when: string | undefined, context: WhenContext): boolean {
  if (!when) return true;
  for (const clause of when.split(/\s+/)) {
    if (!clause) continue;
    if (clause.startsWith("!")) {
      if (context[clause.slice(1)]) return false;
    } else if (!context[clause]) {
      return false;
    }
  }
  return true;
}

const commands = new Map<string, Command>();

export function registerCommand(command: Command): () => void {
  if (commands.has(command.id)) throw new Error(`duplicate command id: ${command.id}`);
  commands.set(command.id, command);
  return () => {
    // 只允许注销自己注册的条目（防止 cleanup 顺序问题误删后来注册者）
    if (commands.get(command.id) === command) commands.delete(command.id);
  };
}

export function getCommand(id: string): Command | undefined {
  return commands.get(id);
}

export function listCommands(context?: WhenContext): Command[] {
  const all = [...commands.values()];
  return context ? all.filter((command) => evaluateWhen(command.when, context)) : all;
}

export function runCommand(id: string, context?: WhenContext): boolean {
  const command = commands.get(id);
  if (!command || (context && !evaluateWhen(command.when, context))) return false;
  command.handler();
  return true;
}

/** 测试专用：清空注册表 */
export function resetCommands(): void {
  commands.clear();
}
