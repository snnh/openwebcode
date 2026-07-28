/**
 * agent.error 的可操作提示（0.7.x）：
 * 把服务端分类的 ProviderError kind 映射为一句可执行的建议 + 设置深链页签 / 重试动作。
 * 原始错误文本仍保留在错误卡中（折叠展示），这里只产出简短引导文案。
 */
import type { AgentErrorPayload } from "./contracts";

export type I18nFn = (zh: string, en: string) => string;

/** 错误卡的可操作指引：hint 文案、可选设置深链页签、是否展示重试按钮 */
export interface AgentErrorGuidance {
  hint?: string;
  settingsTab?: "models";
  retryable: boolean;
}

export function agentErrorGuidance(error: Pick<AgentErrorPayload, "kind" | "retryable">, t: I18nFn): AgentErrorGuidance {
  switch (error.kind) {
    case "authentication":
    case "permission":
      return {
        hint: t("认证失败：请检查 设置 → 模型目录 中的 API Key", "Authentication failed: check the API Key in Settings → Models"),
        settingsTab: "models",
        retryable: error.retryable === true,
      };
    case "not_found":
      return {
        hint: t("接口不存在：请检查 Base URL 或模型 ID", "Endpoint not found: check the Base URL or model ID"),
        settingsTab: "models",
        retryable: error.retryable === true,
      };
    case "invalid_request":
      return {
        hint: t("请求被拒绝：请检查模型 ID 与参数配置", "Request rejected: check the model ID and parameter configuration"),
        settingsTab: "models",
        retryable: error.retryable === true,
      };
    case "rate_limit":
    case "overloaded":
      return {
        hint: t("服务限流/过载，稍后重试", "The service is rate-limited/overloaded; try again later"),
        retryable: true,
      };
    default:
      // 无 kind（如 server_restarted）或未分类错误：仅按 retryable 决定是否给重试按钮
      return { retryable: error.retryable === true };
  }
}

/** toast 用的一句话摘要：按 kind 给出短文案，避免粘贴冗长的 provider 原始 JSON */
export function agentErrorToastText(error: { kind?: AgentErrorPayload["kind"]; message?: string }, t: I18nFn): string {
  const summary = ((): string => {
    switch (error.kind) {
      case "authentication":
      case "permission":
        return t("认证失败，请检查 API Key", "authentication failed; check the API Key");
      case "not_found":
        return t("接口不存在，请检查 Base URL 或模型 ID", "endpoint not found; check the Base URL or model ID");
      case "invalid_request":
        return t("请求被拒绝，请检查模型与参数配置", "request rejected; check the model and parameter configuration");
      case "rate_limit":
      case "overloaded":
        return t("服务限流/过载，可稍后重试", "rate-limited/overloaded; retry later");
      case "network":
      case "stream_interrupted":
        return t("连接中断，可稍后重试", "connection interrupted; retry later");
      default: {
        // 未分类错误保留原始信息，但截断超长 JSON blob
        const message = error.message ?? t("未知错误", "unknown error");
        return message.length > 120 ? `${message.slice(0, 120)}…` : message;
      }
    }
  })();
  return t(`任务失败：${summary}`, `Task failed: ${summary}`);
}
