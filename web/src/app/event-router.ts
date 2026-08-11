import type { QueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type {
  AgentErrorPayload, AppEvent, BackgroundTaskInfo, ContextUsage, ContextWatermark,
  ModelFallbackPayload, Session, TodoItem,
} from "../lib/contracts";
import { agentErrorToastText } from "../lib/agent-error";
import { isBusyState } from "../lib/agent-state";
import type { NotificationKind, NotificationTarget } from "../lib/notifications";
import { qk } from "./queries";
import { sessionMeta } from "./session-store";
import type { StreamBuffer } from "../chat/stream-buffer";

export interface EventRouterDeps {
  queryClient: QueryClient;
  getCurrentSessionId(): string | undefined;
  /** 会话列表快照（完成通知/桌面通知的标题来源） */
  getSessions(): Session[] | undefined;
  t(chinese: string, english: string): string;
  notify(text: string, kind?: NotificationKind): void;
  pushEventNotification(text: string, kind: NotificationKind, target?: NotificationTarget): void;
  /** 页面失焦时的系统通知（权限待批/交互待答/run 终态）；失焦门控与权限检查在装配层 */
  desktopNotify?(info: { sessionId: string; title: string; body: string }): void;
  applyRunEvent(event: AppEvent): void;
  applyActivityEvent(event: AppEvent): void;
  applySubagentEvent(event: AppEvent): void;
  stream: StreamBuffer;
  /** resync 命中当前会话时的附加清理（分页缓存等，由聊天视图装配注入） */
  onResyncCurrent?(sessionId: string): void;
}

export interface EventRouter {
  route(event: AppEvent): void;
  /** 会话删除后清理完成检测残留 */
  forgetSession(sessionId: string): void;
}

/**
 * WS 事件 → 应用副作用的路由（旧 App.handleSessionEvent 的框架无关移植）：
 * queryClient 失效/直写、session-store 运行态、流式缓冲、通知。
 * 全局订阅：服务端在未传 sessionId 时全量推送，这里按 event.sessionId 分发。
 */
export function createEventRouter(deps: EventRouterDeps): EventRouter {
  const { queryClient, t } = deps;
  // agent 完成检测（通知中心）：记录每个会话上一状态，busy→idle 视为一轮任务完成
  const lastStates: Record<string, string> = {};

  const sessionTitle = (sessionId: string): string =>
    deps.getSessions()?.find((session) => session.id === sessionId)?.title ?? sessionId;

  const route = (event: AppEvent): void => {
    const currentId = deps.getCurrentSessionId();
    deps.applyRunEvent(event);
    deps.applyActivityEvent(event);

    if (event.type === "resync.required") {
      // 事件流为全局订阅：按事件所属会话刷新，缺省回退当前会话。
      const targetId = event.sessionId ?? currentId;
      if (targetId === currentId) {
        // 本地即时权限卡清掉，由服务端待决列表（invalidate 后重取）重建
        sessionMeta.clearPermissions();
        if (targetId) deps.onResyncCurrent?.(targetId);
      }
      queryClient.invalidateQueries({ queryKey: qk.session(targetId ?? "") });
      queryClient.invalidateQueries({ queryKey: ["context", targetId] });
      queryClient.invalidateQueries({ queryKey: ["checkpoints", targetId] });
      queryClient.invalidateQueries({ queryKey: ["todos", targetId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", targetId] });
      queryClient.invalidateQueries({ queryKey: ["diagnostics", targetId] });
      queryClient.invalidateQueries({ queryKey: ["scm-status", targetId] });
      queryClient.invalidateQueries({ queryKey: ["scm-worktrees", targetId] });
      queryClient.invalidateQueries({ queryKey: ["permissions", targetId] });
      queryClient.invalidateQueries({ queryKey: ["interactions", targetId] });
      queryClient.invalidateQueries({ queryKey: ["queue", targetId] });
      if (targetId) {
        queryClient.invalidateQueries({ queryKey: qk.run(targetId) });
        // 幽灵运行态修复：resync（事件缺口/服务端重启）后以服务端真相对齐本地
        // agentStates 与 run 缓存；服务端无活跃 run（404）时清掉本地残留的 busy 态。
        const reconcileId = targetId;
        api.run(reconcileId)
          .then((run) => {
            queryClient.setQueryData(qk.run(reconcileId), run);
            sessionMeta.setAgentState(reconcileId, run.state);
          })
          .catch(() => {
            queryClient.setQueryData(qk.run(reconcileId), undefined);
            sessionMeta.clearAgentStateIfIdle(reconcileId);
          });
      }
      return;
    }

    // agent.state 跨会话跟踪：驱动侧栏运行标记与头部状态徽章
    if (event.type === "agent.state" && event.sessionId) {
      const state = (event.payload as { state?: string }).state;
      if (state) {
        const previousState = lastStates[event.sessionId];
        lastStates[event.sessionId] = state;
        if (state === "idle" && previousState && isBusyState(previousState)) {
          deps.pushEventNotification(
            t(`会话任务已完成（${sessionTitle(event.sessionId)}）`, `Run finished (${sessionTitle(event.sessionId)})`),
            "info",
            { sessionId: event.sessionId, view: "sessions" },
          );
        }
        sessionMeta.setAgentState(event.sessionId, state);
        if (state === "thinking" || state === "starting" || state === "preparing_context") {
          sessionMeta.clearRunFailure(event.sessionId);
        }
      }
    }

    // 桌面通知：页面失焦时，权限待批/交互待答/run 终态弹系统通知（跨会话）
    if (event.sessionId && ["permission.request", "interaction.requested", "run.completed", "run.failed"].includes(event.type)) {
      const title0 = sessionTitle(event.sessionId);
      let title: string;
      let body = title0;
      if (event.type === "permission.request") {
        const tool = (event.payload as { tool?: string }).tool ?? "";
        title = t("权限待批准", "Permission needed");
        body = `${title0}：${tool}`;
      } else if (event.type === "interaction.requested") {
        const interactionTitle = (event.payload as { title?: string }).title ?? "";
        title = t("等待你的回复", "Input needed");
        body = `${title0}：${interactionTitle}`;
      } else if (event.type === "run.completed") {
        title = t("任务完成", "Run completed");
      } else {
        title = t("任务失败", "Run failed");
        const message = (event.payload as { error?: { message?: string } }).error?.message;
        body = message ? `${title0}：${message}` : title0;
      }
      deps.desktopNotify?.({ sessionId: event.sessionId, title, body });
    }

    // 上下文窗口水位跨会话跟踪：驱动会话头与上下文面板的占用 meter
    if (event.type === "context.watermark" && event.sessionId) {
      sessionMeta.setWatermark(event.sessionId, event.payload as ContextWatermark);
    }
    if (event.type === "context.usage" && event.sessionId) {
      sessionMeta.setUsage(event.sessionId, event.payload as ContextUsage);
    }
    // 子代理生命周期跨会话跟踪：驱动消息轨道实时卡片与子代理面板（终态保留）
    deps.applySubagentEvent(event);
    if (event.type === "run.accepted" && event.sessionId) {
      sessionMeta.clearRunFailure(event.sessionId);
    }
    // 诊断更新：刷新 Problems 视图数据并更新角标；不弹窗不打断
    if (event.type === "diagnostics.updated" && event.sessionId) {
      queryClient.invalidateQueries({ queryKey: ["diagnostics", event.sessionId] });
      const failed = (event.payload as { summary?: { failed?: number } }).summary?.failed ?? 0;
      sessionMeta.bumpProblemsBadge(event.sessionId, failed);
      if (failed > 0) {
        deps.pushEventNotification(t(`诊断更新：${failed} 项失败`, `Diagnostics updated: ${failed} failure(s)`), "error", { sessionId: event.sessionId, view: "problems" });
      }
    }
    // SCM 更新：刷新源代码管理面板数据；不弹窗不打断
    if (event.type === "scm.updated" && event.sessionId) {
      queryClient.invalidateQueries({ queryKey: ["scm-status", event.sessionId] });
      queryClient.invalidateQueries({ queryKey: ["scm-worktrees", event.sessionId] });
      queryClient.invalidateQueries({ queryKey: ["scm-diff", event.sessionId] });
      deps.pushEventNotification(t("源代码管理状态已更新", "Source control state updated"), "info", { sessionId: event.sessionId, view: "scm" });
    }
    if (event.type === "agent.error" && event.sessionId) {
      const payload = event.payload as Partial<AgentErrorPayload>;
      sessionMeta.setRunFailure(event.sessionId, {
        message: payload.message ?? t("未知错误", "unknown error"),
        ...(payload.kind ? { kind: payload.kind } : {}),
        retryable: payload.retryable === true,
      });
    }
    // 全局配置/目录事件无 sessionId，必须在按会话过滤之前处理。
    if (event.type === "server.settings_updated") {
      queryClient.invalidateQueries({ queryKey: qk.providers });
      queryClient.invalidateQueries({ queryKey: qk.settings });
      queryClient.invalidateQueries({ queryKey: qk.health });
      if (currentId) queryClient.invalidateQueries({ queryKey: ["context", currentId] });
    }
    if (event.type === "models.updated") {
      queryClient.invalidateQueries({ queryKey: qk.models });
      queryClient.invalidateQueries({ queryKey: qk.settings });
    }
    if (event.type === "provider_profiles.updated") {
      queryClient.invalidateQueries({ queryKey: qk.providerProfiles });
      queryClient.invalidateQueries({ queryKey: qk.providers });
      queryClient.invalidateQueries({ queryKey: qk.models });
      queryClient.invalidateQueries({ queryKey: qk.settings });
    }
    // MCP server 连接失败降级：该 server 工具未注入，给出告警
    if (event.type === "mcp.degraded" && event.sessionId === currentId) {
      deps.notify((event.payload as { message?: string }).message ?? t("MCP server 降级", "MCP server degraded"), "error");
    }
    // 上下文清空（/clear 命令）：刷新会话详情与上下文面板并提示
    if (event.type === "context.cleared" && event.sessionId && event.sessionId === currentId) {
      deps.notify(t("上下文已清空（历史保留）", "Context cleared (history retained)"));
    }
    // 上下文压缩开始（手动/85% 强制）：压缩可能耗时（vault 多次快速模型调用），先给即时反馈
    if (event.type === "context.compacting" && event.sessionId === currentId) {
      const payload = event.payload as { mode?: string; forced?: boolean };
      const modeLabel = payload.mode === "vault" ? t("档案库", "vault") : payload.mode === "toolcalls" ? t("工具调用", "tool calls") : t("概览", "overview");
      deps.notify(t(`正在压缩上下文（${payload.forced ? "85% 水位强制 · " : ""}${modeLabel}）…`, `Compacting context (${payload.forced ? "forced at 85% · " : ""}${modeLabel})…`));
    }
    // 上下文压缩（手动/85% 强制）：刷新上下文面板并提示
    if (event.type === "context.compacted" && event.sessionId === currentId) {
      const payload = event.payload as { mode?: string; forced?: boolean };
      const modeLabel = payload.mode === "overview" ? t("概览", "overview") : payload.mode === "toolcalls" ? t("工具调用", "tool calls") : payload.mode === "vault" ? t("档案库", "vault") : t("规则截断", "rule-based truncation");
      deps.notify(t(`已压缩上下文（${payload.forced ? "85% 水位强制 · " : ""}${modeLabel}）`, `Context compacted (${payload.forced ? "forced at 85% · " : ""}${modeLabel})`));
    }
    if (event.type === "context.compact_failed" && event.sessionId === currentId) {
      deps.notify(t(`上下文压缩失败：${(event.payload as { message?: string }).message ?? "未知错误"}`, `Context compaction failed: ${(event.payload as { message?: string }).message ?? "unknown error"}`), "error");
    }
    // 会话显示属性变更（重命名/置顶，可能来自其他客户端）：任何会话都刷新列表；详情仅当前会话
    if (event.type === "session.updated" && event.sessionId) {
      queryClient.invalidateQueries({ queryKey: qk.sessions });
      if (event.sessionId === currentId) queryClient.invalidateQueries({ queryKey: qk.session(event.sessionId) });
    }
    // 权限挂起消失（本客户端或其他客户端 respond / 中断 abort / 会话停止）：
    // 撤掉本地即时权限卡并刷新服务端待决列表，避免权限卡悬挂。
    if (event.type === "permission.resolved" && event.sessionId) {
      const resolved = event.payload as { requestId?: string };
      if (resolved.requestId) sessionMeta.removePermission(resolved.requestId);
      queryClient.invalidateQueries({ queryKey: ["permissions", event.sessionId] });
    }

    if (!event.sessionId || event.sessionId !== currentId) return;

    if (event.type === "checkpoint.failed") {
      const message = (event.payload as { message?: string }).message ?? t("未知错误", "unknown error");
      deps.notify(t(
        `自动快照失败，但本次消息仍会继续发送：${message}。可切换为“仅手动”，或使用具备快照权限的账户重试。`,
        `Automatic snapshot failed, but this message will still be sent: ${message}. Switch to Manual only or retry with an account that has snapshot permission.`,
      ), "error");
    }
    if (event.type === "agent.error") {
      // toast 只给一句话摘要（按 kind 分类），原始错误细节留在轨道上的错误卡中
      deps.notify(agentErrorToastText(event.payload as Partial<AgentErrorPayload>, t), "error");
    }
    // 模型 fallback 切换：run 继续，提示新生效模型与原因
    if (event.type === "agent.model_fallback") {
      const fallback = event.payload as ModelFallbackPayload;
      deps.notify(t(
        `模型已切换：${fallback.from.provider}/${fallback.from.model} → ${fallback.to.provider}/${fallback.to.model}（${fallback.message}）`,
        `Model switched: ${fallback.from.provider}/${fallback.from.model} → ${fallback.to.provider}/${fallback.to.model} (${fallback.message})`,
      ));
    }
    if (event.type === "todos.updated") {
      queryClient.setQueryData<TodoItem[]>(["todos", event.sessionId], (event.payload as { items?: TodoItem[] }).items ?? []);
    }
    if (event.type === "message.delta") {
      const text = (event.payload as { text?: string }).text ?? "";
      deps.stream.queueDelta(event.sessionId, text);
    }
    if (event.type === "message.thinking_delta") {
      const text = (event.payload as { text?: string }).text ?? "";
      deps.stream.queueDelta(event.sessionId, text, true);
    }
    if (event.type === "message.tool_call_delta") {
      const payload = event.payload as { id?: string; name?: string; text?: string };
      if (payload.id) deps.stream.queueToolCallDelta(event.sessionId, payload.id, payload.name, payload.text ?? "");
    }
    // provider 重试：上一 attempt 的增量作废，清空该会话的流式缓冲
    if (event.type === "message.stream_reset") {
      deps.stream.clear(event.sessionId);
    }
    if (event.type === "permission.request") {
      const req = event.payload as { requestId: string; tool: string; input: Record<string, unknown> };
      sessionMeta.upsertPermission(req);
      queryClient.invalidateQueries({ queryKey: ["permissions", event.sessionId] });
    }
    // 模型审核（review 模式）：低风险自动通过的通知进通知流，不弹 toast
    if (event.type === "permission.reviewed") {
      const reviewed = event.payload as { tool?: string; verdict?: string };
      if (reviewed.verdict === "low") {
        deps.pushEventNotification(t(`${reviewed.tool ?? ""} 经模型审核自动通过`, `${reviewed.tool ?? ""} auto-approved by model review`), "info");
      }
    }
    if (event.type.startsWith("queue.") || event.type.startsWith("steering.")) {
      queryClient.invalidateQueries({ queryKey: ["queue", event.sessionId] });
    }
    if (event.type.startsWith("interaction.")) queryClient.invalidateQueries({ queryKey: ["interactions", event.sessionId] });
    // 后台任务完成通知：刷新任务列表
    if (event.type === "task.finished") {
      const task = event.payload as BackgroundTaskInfo;
      deps.notify(t(`后台任务 ${task.taskId} 已结束（exit ${task.exitCode ?? "?"}）`, `Background task ${task.taskId} finished (exit ${task.exitCode ?? "?"})`));
      queryClient.invalidateQueries({ queryKey: ["tasks", currentId] });
    }
    const refreshDetail = ["agent.state", "tool.end", "agent.error", "session.config_updated", "subagent.finished"].includes(event.type);
    const refreshContext = ["context.usage", "context.budget_updated", "context.restored", "context.evicted", "context.compacted", "context.cleared"].includes(event.type);
    const refreshCheckpoints = ["checkpoint.created", "checkpoint.restored", "checkpoint.deleted", "checkpoint.failed"].includes(event.type);
    if (refreshDetail || refreshContext || refreshCheckpoints) {
      const detailRefresh = refreshDetail
        ? queryClient.invalidateQueries({ queryKey: qk.session(event.sessionId) })
        : Promise.resolve();
      if (refreshContext) queryClient.invalidateQueries({ queryKey: ["context", event.sessionId] });
      if (refreshCheckpoints) queryClient.invalidateQueries({ queryKey: ["checkpoints", event.sessionId] });
      // 完整回滚会截断消息并替换账本：同时刷新消息列表与上下文视图，避免展示回退前的旧历史
      if (event.type === "checkpoint.restored") {
        void queryClient.invalidateQueries({ queryKey: qk.session(event.sessionId) });
        void queryClient.invalidateQueries({ queryKey: ["context", event.sessionId] });
      }
      if (event.type === "agent.state" && (event.payload as { state?: string }).state === "idle") {
        deps.stream.flush();
        // 等持久化消息重新拉取完成后再撤掉临时流，避免思考/正文在切换到历史卡片时闪烁或消失。
        void detailRefresh.finally(() => deps.stream.clear(event.sessionId!));
      }
    }
  };

  return {
    route,
    forgetSession(sessionId) {
      delete lastStates[sessionId];
    },
  };
}
