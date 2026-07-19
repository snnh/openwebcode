import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type ReactElement } from "react";
import type { ModelProfile, SessionDetail, SkillInfo } from "../lib/contracts";
import type { SendKey } from "../lib/prefs";
import { Icon } from "./Icon";

export interface PendingImage {
  mediaType: string;
  data: string;
  previewUrl: string;
}

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;

export function Composer({ current, model, models, draft, setDraft, onSend, onConfig, running, sendKey, skills, attachments, setAttachments, supportsImages, onNotice }: {
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
  attachments: PendingImage[];
  setAttachments(value: PendingImage[] | ((prev: PendingImage[]) => PendingImage[])): void;
  supportsImages: boolean;
  onNotice(message: string): void;
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

  const addFiles = (files: File[]): void => {
    const images = files.filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    if (!supportsImages) {
      onNotice("当前模型不支持图片输入");
      return;
    }
    const room = MAX_ATTACHMENTS - attachments.length;
    if (room <= 0) {
      onNotice(`最多附带 ${MAX_ATTACHMENTS} 张图片`);
      return;
    }
    for (const file of images.slice(0, room)) {
      if (!IMAGE_TYPES.has(file.type)) {
        onNotice(`仅支持 png/jpeg/webp/gif 图片（${file.type || "未知类型"}）`);
        continue;
      }
      if (file.size > MAX_IMAGE_BYTES) {
        onNotice(`图片「${file.name || "剪贴板图片"}」超过 5MB 限制`);
        continue;
      }
      const mediaType = file.type;
      const reader = new FileReader();
      reader.onload = () => {
        const url = String(reader.result);
        const data = url.slice(url.indexOf(",") + 1);
        setAttachments((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, { mediaType, data, previewUrl: url }]));
      };
      reader.readAsDataURL(file);
    }
  };

  const onPaste = (event: ReactClipboardEvent): void => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.some((file) => file.type.startsWith("image/"))) {
      event.preventDefault();
      addFiles(files);
    }
  };

  const onDrop = (event: ReactDragEvent): void => {
    if ([...(event.dataTransfer?.files ?? [])].some((file) => file.type.startsWith("image/"))) {
      event.preventDefault();
      addFiles([...event.dataTransfer.files]);
    }
  };

  const thinkingModes = model?.capabilities.thinking ?? ["disabled"];
  const efforts = model?.capabilities.effort ?? [];

  return (
    <footer className="composer" onDrop={onDrop} onDragOver={(event) => event.preventDefault()}>
      {attachments.length > 0 && (
        <div className="attachment-strip" aria-label="图片附件">
          {attachments.map((image, index) => (
            <span className="attachment" key={`${index}-${image.data.length}`}>
              <img src={image.previewUrl} alt={`附件 ${index + 1}`} />
              <button
                className="attachment-remove"
                aria-label={`移除附件 ${index + 1}`}
                onClick={() => setAttachments((prev) => prev.filter((_, item) => item !== index))}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="config-row">
        <label>
          模式
          <select
            value={current.agentMode ?? "build"}
            disabled={running}
            onChange={(event) => onConfig({ agentMode: event.target.value === "build" ? null : "plan" })}
          >
            <option value="build">构建模式（Build）</option>
            <option value="plan">计划模式（Plan）</option>
          </select>
        </label>
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
          onPaste={onPaste}
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
      {supportsImages && <div className="composer-hint">支持粘贴/拖拽图片（≤4 张，每张 ≤5MB）</div>}
    </footer>
  );
}
