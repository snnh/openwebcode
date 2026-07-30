import { useState, type ReactElement, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { LiveSubagentRun } from "../lib/contracts";
import { api } from "../lib/api";
import { Icon, type IconName } from "./Icon";
import { Popover } from "./ComposerPopovers";
import { useI18n } from "../i18n";

/**
 * 输入卡片上方的状态芯片行（参考 Kimi Code Web）：后台 Bash / 子 Agent / 待办。
 * tasks/todos 与 JobHeader、App 同 react-query 键，零额外请求；子代理运行态由 App 传入。
 * 零计数芯片置灰不可点；点击弹小浮层列出条目（只读速览，操作仍走既有面板/标签）。
 */
export function ComposerChips({ sessionId, subagents }: {
  sessionId: string;
  subagents?: Record<string, LiveSubagentRun> | undefined;
}): ReactElement {
  const { t } = useI18n();
  const tasks = useQuery({ queryKey: ["tasks", sessionId], queryFn: () => api.tasks(sessionId) });
  const todos = useQuery({ queryKey: ["todos", sessionId], queryFn: () => api.todos(sessionId) });
  const taskItems = tasks.data ?? [];
  const runningTasks = taskItems.filter((task) => task.status === "running");
  const subagentRuns = Object.values(subagents ?? {});
  const runningSubagents = subagentRuns.filter((run) => run.status === "running");
  const todoItems = todos.data ?? [];
  const doneTodos = todoItems.filter((item) => item.status === "done").length;

  const taskStatusLabel = (status: string): string =>
    status === "running" ? t("运行中", "Running")
      : status === "done" ? t("完成", "Done")
        : status === "failed" ? t("失败", "Failed")
          : t("已停止", "Stopped");
  const subagentStatusLabel = (status: string): string =>
    status === "running" ? t("运行中", "Running") : status === "failed" ? t("失败", "Failed") : t("完成", "Done");
  const todoStatusLabel = (status: string): string =>
    status === "done" ? t("完成", "Done") : status === "in_progress" ? t("进行中", "In progress") : t("待办", "Pending");

  return (
    <div className="composer-chips" aria-label={t("运行状态速览", "Activity overview")}>
      <Chip icon="clock" label={t("后台 Bash", "Background Bash")} count={`(${runningTasks.length})`} disabled={taskItems.length === 0}>
        {taskItems.length === 0
          ? <div className="chip-list-empty">{t("暂无后台任务", "No background tasks")}</div>
          : (
            <div className="chip-list">
              {taskItems.slice(0, 20).map((task) => (
                <div className="chip-row" key={task.taskId}>
                  <span className="chip-row-id">{task.taskId.slice(0, 8)}</span>
                  <span className="chip-row-main">{task.cmd}</span>
                  <span className="chip-row-status" data-status={task.status}>{taskStatusLabel(task.status)}</span>
                </div>
              ))}
            </div>
          )}
      </Chip>
      <Chip icon="layers" label={t("子 Agent", "Subagents")} count={`(${runningSubagents.length})`} disabled={subagentRuns.length === 0}>
        {subagentRuns.length === 0
          ? <div className="chip-list-empty">{t("暂无子代理", "No subagents")}</div>
          : (
            <div className="chip-list">
              {subagentRuns.slice(0, 20).map((run) => (
                <div className="chip-row" key={run.taskId}>
                  <span className="chip-row-id">{run.agent ?? run.taskId.slice(0, 8)}</span>
                  <span className="chip-row-main">{run.prompt}</span>
                  <span className="chip-row-status" data-status={run.status}>{subagentStatusLabel(run.status)}</span>
                </div>
              ))}
            </div>
          )}
      </Chip>
      <Chip icon="list" label={t("待办", "Todos")} count={`(${doneTodos}/${todoItems.length})`} disabled={todoItems.length === 0}>
        {todoItems.length === 0
          ? <div className="chip-list-empty">{t("暂无待办", "No todos")}</div>
          : (
            <div className="chip-list">
              {todoItems.map((item, index) => (
                <div className="chip-row" key={`${index}-${item.content.length}`}>
                  <span className="chip-row-main">{item.content}</span>
                  <span className="chip-row-status" data-status={item.status === "in_progress" ? "running" : item.status}>{todoStatusLabel(item.status)}</span>
                </div>
              ))}
            </div>
          )}
      </Chip>
    </div>
  );
}

/** 单个芯片：计数按钮 + 小浮层；禁用（零计数）时不弹层。 */
function Chip({ icon, label, count, disabled, children }: {
  icon: IconName;
  label: string;
  count: string;
  disabled: boolean;
  children: ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className="composer-menu">
      <button
        type="button"
        className="composer-chip"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={icon} size={12} />
        <span>{label}</span>
        <span className="composer-chip-count">{count}</span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>{children}</Popover>
    </div>
  );
}
