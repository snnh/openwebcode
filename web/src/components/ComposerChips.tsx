import { useState, type ReactElement, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CronJobInfo, LiveSubagentRun } from "../lib/contracts";
import { api } from "../lib/api";
import { Icon, type IconName } from "./Icon";
import { Popover } from "./ComposerPopovers";
import { useI18n } from "../i18n";
import { COMPACT_BREAKPOINT, useMediaQuery } from "../hooks/use-media-query";

/**
 * 输入卡片上方的状态芯片行（参考 Kimi Code Web）：后台 Bash / 子 Agent / 待办 / 定时。
 * tasks/todos 与 JobHeader、App 同 react-query 键，零额外请求；子代理运行态由 App 传入。
 * 零计数芯片置灰不可点（定时芯片例外：零任务也要能打开添加表单）；点击弹小浮层列出条目。
 * ≤768px 紧凑断点：零计数芯片整体隐藏（含定时，有计数才出现），全部为零时整行不渲染；
 * 桌面端保持定时芯片零计数可点开添加表单。
 */
export function ComposerChips({ sessionId, subagents }: {
  sessionId: string;
  subagents?: Record<string, LiveSubagentRun> | undefined;
}): ReactElement | null {
  const { t } = useI18n();
  const compact = useMediaQuery(COMPACT_BREAKPOINT);
  const tasks = useQuery({ queryKey: ["tasks", sessionId], queryFn: () => api.tasks(sessionId) });
  const todos = useQuery({ queryKey: ["todos", sessionId], queryFn: () => api.todos(sessionId) });
  // 定时任务变化不频繁：15s 轮询兜底（agent 侧 cron_create 也能刷到），手动增删后 invalidate 立即刷新
  const cron = useQuery({ queryKey: ["cron", sessionId], queryFn: () => api.cronJobs(sessionId), refetchInterval: 15_000 });
  const cronJobs = cron.data ?? [];
  const taskItems = tasks.data ?? [];
  const runningTasks = taskItems.filter((task) => task.status === "running");
  const subagentRuns = Object.values(subagents ?? {});
  const runningSubagents = subagentRuns.filter((run) => run.status === "running");
  const todoItems = todos.data ?? [];
  const doneTodos = todoItems.filter((item) => item.status === "done").length;

  // ≤768px：零计数芯片（含定时）不占位；全部为零时整行不渲染，避免空行吃掉一屏高度
  const hasActivity = taskItems.length > 0 || subagentRuns.length > 0 || todoItems.length > 0 || cronJobs.length > 0;
  if (compact && !hasActivity) return null;
  const showCronChip = !compact || cronJobs.length > 0;

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
          ? <div className="muted-empty chip-list-empty">{t("暂无后台任务", "No background tasks")}</div>
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
          ? <div className="muted-empty chip-list-empty">{t("暂无子代理", "No subagents")}</div>
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
          ? <div className="muted-empty chip-list-empty">{t("暂无待办", "No todos")}</div>
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
      {showCronChip && (
        <Chip icon="bell" label={t("定时", "Cron")} count={`(${cronJobs.length})`} disabled={false}>
          <CronPanel sessionId={sessionId} jobs={cronJobs} />
        </Chip>
      )}
    </div>
  );
}

const CRON_WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const CRON_WEEKDAYS_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** cron 表达式人类化简述：只识别常见形态，其余返回 null（UI 回退展示原文）。 */
function describeCron(expression: string, t: (zh: string, en: string) => string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dom, , dow] = parts as [string, string, string, string, string];
  const pad = (value: string): string => value.padStart(2, "0");
  if (expression.trim() === "* * * * *") return t("每分钟", "Every minute");
  const step = /^\*\/(\d+)$/.exec(minute!);
  if (step && hour === "*" && dom === "*" && dow === "*") return t(`每 ${step[1]} 分钟`, `Every ${step[1]} minutes`);
  if (/^\d+$/.test(minute!) && /^\d+$/.test(hour!) && dom === "*" && /^\d$/.test(dow!)) {
    const day = Number(dow) % 7;
    return t(`每${CRON_WEEKDAYS_ZH[day]} ${pad(hour!)}:${pad(minute!)}`, `Every ${CRON_WEEKDAYS_EN[day]} at ${pad(hour!)}:${pad(minute!)}`);
  }
  if (/^\d+$/.test(minute!) && /^\d+$/.test(hour!) && dom === "*" && dow === "*") {
    return t(`每天 ${pad(hour!)}:${pad(minute!)}`, `Daily at ${pad(hour!)}:${pad(minute!)}`);
  }
  if (/^\d+$/.test(minute!) && /^\d+$/.test(hour!) && /^\d+$/.test(dom!) && dow === "*") {
    return t(`每月 ${dom} 日 ${pad(hour!)}:${pad(minute!)}`, `Monthly on day ${dom} at ${pad(hour!)}:${pad(minute!)}`);
  }
  return null;
}

/** 下次触发的相对时间简述。 */
function relativeFireTime(iso: string, t: (zh: string, en: string) => string): string {
  const diffMs = Date.parse(iso) - Date.now();
  if (diffMs <= 0) return t("即将触发", "Due now");
  const minutes = Math.ceil(diffMs / 60_000);
  if (minutes < 60) return t(`${minutes} 分钟后`, `in ${minutes} min`);
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return t(`${hours} 小时后`, `in ${hours} h`);
  return t(`${Math.ceil(hours / 24)} 天后`, `in ${Math.ceil(hours / 24)} d`);
}

/** 定时芯片浮层：任务列表（简述+原文/下次触发/stale/删除）+ 手动添加表单。 */
function CronPanel({ sessionId, jobs }: { sessionId: string; jobs: CronJobInfo[] }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [expression, setExpression] = useState("");
  const [prompt, setPrompt] = useState("");
  const [recurring, setRecurring] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const refresh = (): void => { void queryClient.invalidateQueries({ queryKey: ["cron", sessionId] }); };

  const remove = async (id: string): Promise<void> => {
    setError("");
    try {
      await api.deleteCronJob(sessionId, id);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const submit = async (): Promise<void> => {
    if (!expression.trim() || !prompt.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await api.createCronJob(sessionId, { cron: expression.trim(), prompt: prompt.trim(), recurring });
      setExpression("");
      setPrompt("");
      setRecurring(true);
      refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      {jobs.length === 0
        ? <div className="muted-empty chip-list-empty">{t("暂无定时任务", "No scheduled jobs")}</div>
        : (
          <div className="chip-list">
            {jobs.map((job) => (
              <div className="chip-row" key={job.id}>
                <span className="chip-row-main" title={job.prompt}>
                  {describeCron(job.cron, t) ?? job.cron}
                  <span className="chip-cron-raw">{describeCron(job.cron, t) ? ` · ${job.cron}` : ""}</span>
                </span>
                {job.stale
                  ? <span className="chip-row-status" data-status="failed">{t("最后一次", "Final run")}</span>
                  : job.nextFireAt
                    ? <span className="chip-row-status">{relativeFireTime(job.nextFireAt, t)}</span>
                    : null}
                <button
                  type="button"
                  className="chip-cron-delete"
                  aria-label={t("删除定时任务", "Delete cron job")}
                  onClick={() => void remove(job.id)}
                >
                  <Icon name="trash" size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
      <form
        className="chip-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <input
          className="input"
          type="text"
          value={expression}
          placeholder={t("cron 表达式，如 */30 * * * *", "cron expression, e.g. */30 * * * *")}
          aria-label={t("cron 表达式", "cron expression")}
          onChange={(event) => setExpression(event.target.value)}
        />
        <input
          className="input"
          type="text"
          value={prompt}
          placeholder={t("触发时注入的提示词", "Prompt injected when the job fires")}
          aria-label={t("提示词", "Prompt")}
          onChange={(event) => setPrompt(event.target.value)}
        />
        <div className="chip-form-actions">
          <label className="chip-form-recurring">
            <input type="checkbox" checked={recurring} onChange={(event) => setRecurring(event.target.checked)} />
            {t("重复", "Recurring")}
          </label>
          <button type="submit" className="chip-form-submit" disabled={busy || !expression.trim() || !prompt.trim()}>
            {t("添加", "Add")}
          </button>
        </div>
        {error ? <div className="chip-form-error" role="alert">{error}</div> : null}
      </form>
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
