import { useEffect, useRef, useState, type ReactElement } from "react";
import type { ModelProfile, SessionDetail, SkillInfo } from "../lib/contracts";
import type { SendKey } from "../lib/prefs";
import { Icon } from "./Icon";

export function Composer({ current, model, models, draft, setDraft, onSend, onConfig, running, sendKey, skills }: {
  current: SessionDetail;
  model?: ModelProfile;
  models: ModelProfile[];
  draft: string;
  setDraft(value: string): void;
  onSend(): void;
  onConfig(body: Record<string, unknown>): void;
  running: boolean;
  sendKey: SendKey;
  skills: SkillInfo[];
}): ReactElement {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [dismissed, setDismissed] = useState(false);
  const [active, setActive] = useState(0);
  // 随内容自动增高，上限由 CSS max-height 控制
  useEffect(() => {
    const element = textareaRef.current;
    if (element) {
      element.style.height = "auto";
      element.style.height = `${element.scrollHeight}px`;
    }
  }, [draft]);

  // 输入 /前缀 时呼出技能补全；Esc 暂时关闭，内容变化后重新打开
  const command = draft.match(/^\/([\w-]*)$/);
  const suggestions = command && !dismissed
    ? skills.filter((skill) => skill.name.toLowerCase().startsWith(command[1]!.toLowerCase()))
    : [];
  const popupOpen = suggestions.length > 0;
  useEffect(() => {
    setDismissed(false);
    setActive(0);
  }, [draft]);

  const pick = (skill: SkillInfo): void => {
    setDraft(`/${skill.name} `);
    textareaRef.current?.focus();
  };

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
              return options.map((item) => <option key={item.id} value={item.id}>{item.displayName ?? item.id}</option>);
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
        {popupOpen && (
          <ul className="skill-popup" role="listbox" aria-label="技能建议">
            {suggestions.map((skill, index) => (
              <li key={skill.name}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  className={index === active ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    pick(skill);
                  }}
                >
                  <span className="skill-name">/{skill.name}</span>
                  <span className="skill-desc">{skill.description}</span>
                  <span className="skill-source">{skill.source === "project" ? "项目" : "全局"}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (popupOpen) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive((value) => (value + 1) % suggestions.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive((value) => (value - 1 + suggestions.length) % suggestions.length);
                return;
              }
              if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                pick(suggestions[Math.min(active, suggestions.length - 1)]!);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(true);
                return;
              }
            }
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
