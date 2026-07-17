import { useEffect, useRef, type ReactElement } from "react";
import type { ModelProfile, SessionDetail } from "../lib/contracts";
import type { SendKey } from "../lib/prefs";
import { Icon } from "./Icon";

export function Composer({ current, model, models, draft, setDraft, onSend, onConfig, running, sendKey }: {
  current: SessionDetail;
  model?: ModelProfile;
  models: ModelProfile[];
  draft: string;
  setDraft(value: string): void;
  onSend(): void;
  onConfig(body: Record<string, unknown>): void;
  running: boolean;
  sendKey: SendKey;
}): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // 随内容自动增高，上限由 CSS max-height 控制
  useEffect(() => {
    const element = textareaRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [draft]);

  const thinkingModes = model?.capabilities.thinking ?? ["disabled"];
  const efforts = model?.capabilities.effort ?? [];

  return (
    <footer className="composer">
      <div className="config-row">
        <label>
          模型
          <select value={current.model} disabled={running} onChange={(event) => onConfig({ model: event.target.value })}>
            {(() => {
              const available = models.filter((item) => item.provider === current.provider);
              // 当前 provider 无模型档案（如 development）时至少显示当前模型，避免空 select
              const options = available.length > 0 ? available : [{ id: current.model, displayName: current.model } as ModelProfile];
              return options.map((item) => <option key={item.id} value={item.id}>{item.displayName}</option>);
            })()}
          </select>
        </label>
        <label>
          思考
          <select
            value={current.thinking ?? "disabled"}
            disabled={running}
            onChange={(event) => onConfig({ thinking: event.target.value === "disabled" ? null : event.target.value })}
          >
            {thinkingModes.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {efforts.length > 0 && (
          <label>
            力度
            <select
              value={current.effort ?? efforts[0]}
              disabled={running}
              onChange={(event) => onConfig({ effort: event.target.value })}
            >
              {efforts.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </label>
        )}
        <label>
          权限
          <select
            value={current.permissionMode ?? "ask"}
            disabled={running}
            onChange={(event) => onConfig({ permissionMode: event.target.value })}
          >
            <option value="ask">每次确认</option>
            <option value="acceptEdits">接受编辑</option>
            <option value="yolo">YOLO</option>
          </select>
        </label>
        {running && <span className="steering-hint">运行中 · 发送将进入 Steering 队列</span>}
      </div>
      <div className="composer-input">
        <textarea
          ref={textareaRef}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // 输入法组合中的 Enter 不触发发送；发送键可在设置中切换
            if (event.nativeEvent.isComposing || event.key !== "Enter") return;
            const shouldSend = sendKey === "enter"
              ? !event.shiftKey && !event.ctrlKey && !event.metaKey
              : event.ctrlKey || event.metaKey;
            if (shouldSend) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder={running
            ? "向正在执行的作业补充指令…"
            : sendKey === "enter" ? "描述要完成的编码任务…（Enter 发送，Shift+Enter 换行）" : "描述要完成的编码任务…（Ctrl+Enter 发送）"}
        />
        <button className="btn primary send" disabled={!draft.trim()} onClick={onSend}>
          <Icon name="send" size={13} />
          {running ? "加入队列" : "发送"}
        </button>
      </div>
    </footer>
  );
}
