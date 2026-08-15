/**
 * context-saver 扩展的上下文面板段落：驱逐策略表单、选择性上下文（pin/排除）、
 * 上下文条目管理（恢复/固定/再逐出/原文）。仅当扩展启用时由 ContextPanel 渲染；
 * 对应 server 端点在扩展关闭时返回 409，此处不渲染即不会触达。
 */
import { useEffect, useState, type ReactElement } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import type { ChatMessage, ContextView } from "../lib/contracts";
import { ui } from "../app/ui-store";
import { qk } from "../app/queries";
import { useI18n } from "../i18n";
import { messageSummary } from "./context-entry-summary";

const STATE_LABELS: Record<string, [string, string]> = { full: ["保留", "Retained"], evicted: ["已逐出", "Evicted"], restored: ["已恢复", "Restored"] };

/** 驱逐策略表单（自动驱逐开关 + 策略参数）；手动压缩在核心「压缩」区，不在此列。 */
function EvictionPolicySection({ sessionId, running, policy }: { sessionId: string; running: boolean; policy: ContextView["ledger"]["policy"] }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [form, setForm] = useState({ enabled: true, strategy: "lag" as "lag" | "interval" | "off", evictionMode: "placeholder" as "placeholder" | "process", lag: "10", interval: "5", minRetainTokens: "256", readKeepLines: "50", pinExemptRounds: "5", restoreBudget: "64000" });
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!policy) return;
    setForm({ enabled: policy.enabled, strategy: policy.strategy, evictionMode: policy.evictionMode, lag: String(policy.lag), interval: String(policy.interval), minRetainTokens: String(policy.minRetainTokens), readKeepLines: String(policy.readKeepLines), pinExemptRounds: String(policy.pinExemptRounds), restoreBudget: String(policy.restoreBudget) });
  }, [policy]);
  const save = (): void => {
    const values = [form.lag, form.interval, form.minRetainTokens, form.readKeepLines, form.pinExemptRounds, form.restoreBudget];
    if (values.some((value) => !/^\d+$/.test(value))) { ui.notify(t("上下文策略数值必须为非负整数", "Context policy values must be non-negative integers"), "error"); return; }
    setBusy(true);
    api.updateContextPolicy(sessionId, {
      enabled: form.enabled,
      strategy: form.strategy,
      evictionMode: form.evictionMode,
      lag: Number(form.lag),
      interval: Number(form.interval),
      minRetainTokens: Number(form.minRetainTokens),
      readKeepLines: Number(form.readKeepLines),
      pinExemptRounds: Number(form.pinExemptRounds),
      restoreBudget: Number(form.restoreBudget),
    }).then(() => {
      void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) });
      ui.notify(t("上下文策略已更新", "Context policy updated"));
    }).catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("策略更新失败", "Policy update failed"), "error")).finally(() => setBusy(false));
  };
  return (
    <>
      <h2>{t("驱逐策略", "Eviction policy")}</h2>
      <div className="context-policy-form">
        <label><input type="checkbox" checked={form.enabled} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, enabled: event.target.checked }))} /> {t("启用自动驱逐", "Enable automatic eviction")}</label>
        <label>{t("策略", "Strategy")}<select className="input" value={form.strategy} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, strategy: event.target.value as typeof value.strategy }))}><option value="lag">{t("滚动 lag", "Rolling lag")}</option><option value="interval">{t("定期 interval", "Periodic interval")}</option><option value="off">{t("仅手动", "Manual only")}</option></select></label>
        <label>{t("驱逐模式", "Eviction mode")}<select className="input" value={form.evictionMode} disabled={running || busy} onChange={(event) => setForm((value) => ({ ...value, evictionMode: event.target.value as typeof value.evictionMode }))}><option value="placeholder">{t("默认节省（占位符）", "Default saver (placeholder)")}</option><option value="process">{t("超级节省（整轮过程驱逐）", "Super saver (whole-round eviction)")}</option></select></label>
        <label>{t("保留最近轮数", "Recent rounds to retain")}<input className="input" value={form.lag} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, lag: event.target.value }))} /></label>
        <label>{t("结果保留下限 tokens", "Min result tokens to retain")}<input className="input" value={form.minRetainTokens} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, minRetainTokens: event.target.value }))} /></label>
        <label>{t("read 头尾保留行数", "Read head/tail lines to keep")}<input className="input" value={form.readKeepLines} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, readKeepLines: event.target.value }))} /></label>
        <label>{t("批量间隔", "Batch interval")}<input className="input" value={form.interval} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, interval: event.target.value }))} /></label>
        <label>{t("回写保护轮数", "Restore protection rounds")}<input className="input" value={form.pinExemptRounds} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, pinExemptRounds: event.target.value }))} /></label>
        <label>{t("回写预算 tokens", "Restore budget (tokens)")}<input className="input" value={form.restoreBudget} disabled={running || busy} inputMode="numeric" onChange={(event) => setForm((value) => ({ ...value, restoreBudget: event.target.value }))} /></label>
        <button className="btn small" disabled={running || busy} onClick={save}>{busy ? t("处理中…", "Working…") : t("保存策略", "Save policy")}</button>
      </div>
    </>
  );
}

/** 选择性上下文（§4.4）：pin 不被驱逐；排除路径不进上下文。排除不是安全边界。 */
function SelectionSection({ sessionId, running, selection }: { sessionId: string; running: boolean; selection: { pins: string[]; excludes: string[] } }): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [pinInput, setPinInput] = useState("");
  const [excludeInput, setExcludeInput] = useState("");
  const [busy, setBusy] = useState(false);
  const save = (pins: string[], excludes: string[]): void => {
    setBusy(true);
    api.updateContextSelection(sessionId, { pins, excludes })
      .then(() => {
        void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) });
        void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
        ui.notify(t("选择性上下文已更新", "Context selection updated"));
      })
      .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("更新失败", "Update failed"), "error"))
      .finally(() => setBusy(false));
  };
  const addPin = (): void => {
    const value = pinInput.trim();
    if (!value) return;
    if (selection.pins.includes(value)) { setPinInput(""); return; }
    save([...selection.pins, value], selection.excludes);
    setPinInput("");
  };
  const addExclude = (): void => {
    const value = excludeInput.trim();
    if (!value) return;
    if (selection.excludes.includes(value)) { setExcludeInput(""); return; }
    save(selection.pins, [...selection.excludes, value]);
    setExcludeInput("");
  };
  const disabled = running || busy;
  return (
    <>
      <h2>{t("选择性上下文（pin / 排除）", "Selective context (pin / exclude)")}</h2>
      <p className="panel-note">
        {t("pin 的消息或文件不被自动驱逐；排除的路径不进入上下文组装、repo map 与索引。注意：排除不是安全边界——文件访问权限仍由路径策略与沙盒保证。", "Pinned messages or files are never auto-evicted; excluded paths stay out of the context, repo map, and index. Note: exclusion is not a security boundary — file access is still governed by path policy and the sandbox.")}
      </p>
      <h3>{t("已 pin", "Pinned")}</h3>
      {selection.pins.length === 0 && <p className="muted-empty panel-empty">{t("暂无 pin。", "No pins.")}</p>}
      {selection.pins.map((pin) => (
        <div className="context-entry" key={pin}>
          <span className="entry-summary mono" title={pin}>{pin}</span>
          <button className="btn small" disabled={disabled} onClick={() => save(selection.pins.filter((item) => item !== pin), selection.excludes)}>{t("移除", "Remove")}</button>
        </div>
      ))}
      <div className="context-actions">
        <input
          value={pinInput}
          disabled={disabled}
          placeholder={t("消息 id 或文件路径", "Message id or file path")}
          onChange={(event) => setPinInput(event.target.value)}
          aria-label={t("新增 pin", "Add pin")}
        />
        <button className="btn small" disabled={disabled || !pinInput.trim()} onClick={addPin}>{t("添加 pin", "Add pin")}</button>
      </div>
      <h3>{t("排除路径", "Excluded paths")}</h3>
      {selection.excludes.length === 0 && <p className="muted-empty panel-empty">{t("暂无排除。", "No exclusions.")}</p>}
      {selection.excludes.map((exclude) => (
        <div className="context-entry" key={exclude}>
          <span className="entry-summary mono" title={exclude}>{exclude}</span>
          <button className="btn small" disabled={disabled} onClick={() => save(selection.pins, selection.excludes.filter((item) => item !== exclude))}>{t("移除", "Remove")}</button>
        </div>
      ))}
      <div className="context-actions">
        <input
          value={excludeInput}
          disabled={disabled}
          placeholder={t("路径 glob，如 **/*.log", "Path glob, for example **/*.log")}
          onChange={(event) => setExcludeInput(event.target.value)}
          aria-label={t("新增排除路径", "Add excluded path")}
        />
        <button className="btn small" disabled={disabled || !excludeInput.trim()} onClick={addExclude}>{t("添加排除", "Add exclusion")}</button>
      </div>
    </>
  );
}

/** 上下文条目：驱逐/恢复/固定/再逐出与 artifact 原文查看。 */
function EntriesSection({ sessionId, running, context, messages }: {
  sessionId: string;
  running: boolean;
  context: ContextView;
  messages: ChatMessage[] | undefined;
}): ReactElement {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [artifact, setArtifact] = useState<{ id: string; content: string }>();
  const { entries } = context.ledger;
  const summarize = (messageId: string): string => messageSummary(messages, messageId, t);
  return (
    <>
      <h2>{t("上下文条目", "Context entries")}</h2>
      {entries.length === 0 && !messages?.some((message) => message.role === "tool") && <p className="muted-empty panel-empty">{t("暂无条目。", "No entries.")}</p>}
      {entries.map((entry) => (
        <div className="context-entry" key={`${entry.messageId}-${entry.artifactId}`}>
          <span className={`entry-state entry-${entry.state}`}>{STATE_LABELS[entry.state] ? t(...STATE_LABELS[entry.state]!) : entry.state}</span>
          <span className="entry-summary" title={entry.messageId}>{summarize(entry.messageId)}</span>
          {entry.state === "evicted" && (
            <button
              className="btn small"
              disabled={running}
              title={running ? t("运行中不可恢复", "Cannot restore while running") : t("恢复该条目到上下文", "Restore this entry to context")}
              onClick={() => {
                api.restoreContext(sessionId, entry.messageId)
                  .then(() => {
                    void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) });
                    void queryClient.invalidateQueries({ queryKey: qk.session(sessionId) });
                    ui.notify(t("已恢复上下文条目", "Context entry restored"));
                  })
                  .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("恢复失败", "Restore failed"), "error"));
              }}
            >
              {t("恢复", "Restore")}
            </button>
          )}
          {entry.state === "restored" && <>
            <button className="btn small" disabled={running} onClick={() => {
              const pinned = (entry.pinnedUntilRound ?? 0) > (context.ledger.round ?? 0);
              api.mutateContextEntry(sessionId, entry.messageId, pinned ? "unpin" : "pin")
                .then(() => { void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) }); ui.notify(pinned ? t("已取消固定", "Entry unpinned") : t("已固定条目", "Entry pinned")); })
                .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("操作失败", "Operation failed"), "error"));
            }}>{(entry.pinnedUntilRound ?? 0) > (context.ledger.round ?? 0) ? t("取消固定", "Unpin") : t("固定", "Pin")}</button>
            <button className="btn small" disabled={running} onClick={() => {
              api.mutateContextEntry(sessionId, entry.messageId, "evict")
                .then(() => { void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) }); ui.notify(t("已再次逐出条目", "Entry evicted again")); })
                .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("逐出失败", "Eviction failed"), "error"));
            }}>{t("逐出", "Evict")}</button>
          </>}
          <button className="btn small" onClick={() => {
            api.contextArtifact(sessionId, entry.artifactId)
              .then((value) => setArtifact({ id: entry.artifactId, content: value.content }))
              .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("原文读取失败", "Could not read original content"), "error"));
          }}>{t("原文", "Original")}</button>
        </div>
      ))}
      {messages?.filter((message) => message.role === "tool" && !entries.some((entry) => entry.messageId === message.id)).map((message) => (
        <div className="context-entry" key={message.id}>
          <span className="entry-state">{t("保留", "Retained")}</span>
          <span className="entry-summary" title={message.id}>{summarize(message.id)}</span>
          <button className="btn small" disabled={running} onClick={() => {
            api.mutateContextEntry(sessionId, message.id, "evict")
              .then(() => { void queryClient.invalidateQueries({ queryKey: qk.context(sessionId) }); ui.notify(t("已手动逐出条目", "Entry manually evicted")); })
              .catch((error: unknown) => ui.notify(error instanceof Error ? error.message : t("逐出失败", "Eviction failed"), "error"));
          }}>{t("逐出", "Evict")}</button>
        </div>
      ))}
      {artifact && (
        <details className="context-artifact" open>
          <summary>{t("Artifact 原文", "Artifact source")} · {artifact.id}</summary>
          <pre className="mono">{artifact.content}</pre>
          <button className="btn small" onClick={() => setArtifact(undefined)}>{t("关闭原文", "Close original")}</button>
        </details>
      )}
    </>
  );
}

/** context-saver 扩展段落汇总：驱逐策略 + 选择性上下文 + 上下文条目。 */
export function ContextSaverSections({ sessionId, running, context, messages }: {
  sessionId: string;
  running: boolean;
  context: ContextView;
  messages: ChatMessage[] | undefined;
}): ReactElement {
  return (
    <>
      <EvictionPolicySection sessionId={sessionId} running={running} policy={context.ledger.policy} />
      <SelectionSection sessionId={sessionId} running={running} selection={context.selection ?? { pins: [], excludes: [] }} />
      <EntriesSection sessionId={sessionId} running={running} context={context} messages={messages} />
    </>
  );
}
