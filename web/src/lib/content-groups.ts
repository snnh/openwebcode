import { isSubagentToolCallName } from "./subagent-runs";
import type { MessageContent } from "./contracts";

/** 历史消息内容的分组项：single 原位渲染；tool-group 为相邻工具调用合并组（≥2 个调用）。 */
type ContentGroup =
  | { kind: "single"; block: MessageContent }
  | { kind: "tool-group"; blocks: MessageContent[] };

/**
 * 可进组合并的块：普通 tool_call / tool_result。
 * subagent/spawn_swarm（含历史消息旧名 spawn_task）保留 SubagentRunCard 专用形态，
 * 不进组且打断相邻性；其子代理结果（携带 subagentTaskIds/subagentTasks 的 tool_result）
 * 同样保留原形态、打断相邻性。
 */
function isGroupableToolBlock(block: MessageContent): boolean {
  if (block.type === "tool_call") return !isSubagentToolCallName(block.name);
  if (block.type === "tool_result") return !(block.subagentTaskIds?.length || block.subagentTasks?.length);
  return false;
}

/**
 * 历史消息分组预处理：连续相邻的 tool_call/tool_result 序列含 ≥2 个调用时合并为一个折叠组，
 * tool_call 与其 tool_result（按 toolCallId 相邻）自然落在同一组；thinking/text/image/spawn 原位渲染。
 */
export function groupContentBlocks(blocks: MessageContent[]): ContentGroup[] {
  const groups: ContentGroup[] = [];
  let run: MessageContent[] = [];
  const flush = (): void => {
    const callCount = run.filter((block) => block.type === "tool_call").length;
    if (callCount >= 2) {
      groups.push({ kind: "tool-group", blocks: run });
    } else {
      for (const block of run) groups.push({ kind: "single", block });
    }
    run = [];
  };
  for (const block of blocks) {
    if (isGroupableToolBlock(block)) {
      run.push(block);
    } else {
      flush();
      groups.push({ kind: "single", block });
    }
  }
  flush();
  return groups;
}
