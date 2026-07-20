import { useCallback, useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from "react";
import type { ModelProfile, SessionDetail, SkillInfo } from "../lib/contracts";
import { api } from "../lib/api";
import { extractAttachmentPaths } from "../lib/attachments";
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

export function Composer({ current, model, models, draft, setDraft, onSend, onConfig, running, sendKey, skills, attachments, setAttachments, supportsImages, onNotice, sendPending = false }: {
  current: SessionDetail;
  model?: ModelProfile;
  models: ModelProfile[];
  draft: string;
  setDraft(value: string): void;
  onSend(): void;
  onConfig(body: Record<string, unknown>): void;
  running: boolean;
  /** 发送请求进行中：屏蔽重复提交（按钮禁用、Enter 不触发），运行中入队场景不受影响 */
  sendPending?: boolean;
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
  const slashActive = command !== null && !dismissed;
  const suggestions = command && !dismissed
    ? skills.filter((skill) => skill.name.toLowerCase().startsWith(command[1]!.toLowerCase()))
    : [];
  const popupOpen = slashActive;
  const hasSuggestions = suggestions.length > 0;
  useEffect(() => {
    setDismissed(false);
    setActive(0);
  }, [draft]);

  // @文件引用补全：检测光标前 `@<partial>`，防抖 200ms 调 complete-path REST
  const [mentionPartial, setMentionPartial] = useState<string | null>(null);
  const [mentionMatches, setMentionMatches] = useState<Array<{ path: string }>>([]);
  const [mentionActive, setMentionActive] = useState(0);
  const [mentionDismissed, setMentionDismissed] = useState(false);
  const [mentionFailed, setMentionFailed] = useState(false);
  // Esc 关闭后，draft 内容变化才重新打开（避免方向键移动光标反复触发）
  useEffect(() => { setMentionDismissed(false); }, [draft]);

  const updateMentionFromValue = useCallback((value: string, cursor: number, dismissed: boolean) => {
    if (dismissed) { setMentionPartial(null); return; }
    const before = value.slice(0, cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) { setMentionPartial(null); return; }
    const atIdx = before.length - match[0].length;
    // @ 必须在空白或行首之后（避免匹配 a@b 邮箱形态）
    if (atIdx > 0) {
      const prev = before[atIdx - 1];
      if (prev && !/\s/.test(prev)) { setMentionPartial(null); return; }
    }
    setMentionPartial(match[1]);
    setMentionActive(0);
  }, []);

  // 防抖调 complete-path；partial 为空（仅 @ 无字符）不调 API
  useEffect(() => {
    if (mentionPartial === null || mentionPartial === "") {
      setMentionMatches([]);
      setMentionFailed(false);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      api.completePath(current.id, mentionPartial)
        .then((res) => { if (!cancelled) { setMentionMatches(res.matches.slice(0, 20)); setMentionFailed(false); } })
        .catch(() => { if (!cancelled) { setMentionMatches([]); setMentionFailed(true); } });
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [mentionPartial, current.id]);

  const mentionOpen = !mentionDismissed && mentionPartial !== null && mentionPartial !== "";
const mentionHasMatches = mentionMatches.length > 0;

  // 方向键移动激活项时滚动保持可见（仅弹层打开时执行）
  useEffect(() => {
    if (mentionOpen && mentionHasMatches) {
      document.getElementById(`mention-option-${mentionActive}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [mentionActive, mentionOpen, mentionHasMatches]);
  useEffect(() => {
    if (popupOpen && hasSuggestions) {
      document.getElementById(`skill-option-${active}`)?.scrollIntoView({ block: "nearest" });
    }
  }, [active, popupOpen, hasSuggestions]);

  const insertMention = useCallback((filePath: string): void => {
    const el = textareaRef.current;
    const cursor = el?.selectionStart ?? draft.length;
    const before = draft.slice(0, cursor);
    const after = draft.slice(cursor);
    const match = before.match(/@([^\s@]*)$/);
    if (!match) return;
    const startIdx = before.length - match[0].length;
    const replacement = `@${filePath} `;
    const next = draft.slice(0, startIdx) + replacement + after;
    setDraft(next);
    setMentionPartial(null);
    setMentionMatches([]);
    setMentionDismissed(false);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        const pos = startIdx + replacement.length;
        node.selectionStart = pos;
        node.selectionEnd = pos;
        node.focus();
      }
    });
  }, [draft, setDraft]);

  const removeMention = (filePath: string): void => {
    const token = `@${filePath}`;
    const idx = draft.indexOf(token);
    if (idx < 0) return;
    let end = idx + token.length;
    if (draft[end] === " ") end += 1;
    setDraft(draft.slice(0, idx) + draft.slice(end));
  };

  const mentionedPaths = extractAttachmentPaths(draft);

  const syncMention = (node: HTMLTextAreaElement): void => {
    updateMentionFromValue(node.value, node.selectionStart ?? node.value.length, mentionDismissed);
  };

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
    if (!files.some((file) => file.type.startsWith("image/"))) return;
    event.preventDefault();
    addFiles(files);
    // 剪贴板常同时携带文本（路径/说明），插入光标处而非静默丢弃
    const text = event.clipboardData?.getData("text") ?? "";
    if (!text) return;
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = draft.slice(0, start) + text + draft.slice(end);
    setDraft(next);
    updateMentionFromValue(next, start + text.length, mentionDismissed);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        const pos = start + text.length;
        node.selectionStart = pos;
        node.selectionEnd = pos;
        node.focus();
      }
    });
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
          <ul id="skill-listbox" className="skill-popup" role="listbox" aria-label="技能建议">
            {hasSuggestions ? suggestions.map((skill, index) => (
              <li key={skill.name}>
                <button
                  type="button"
                  role="option"
                  id={`skill-option-${index}`}
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
            )) : (
              <li className="skill-empty"><span className="skill-desc">无技能可用（在数据目录 skills/ 放 SKILL.md，或按 Esc 关闭）</span></li>
            )}
          </ul>
        )}
        {mentionOpen && (
          <ul id="mention-listbox" className="mention-popup" role="listbox" aria-label="文件引用建议">
            {mentionHasMatches ? mentionMatches.map((item, index) => (
              <li key={item.path}>
                <button
                  type="button"
                  role="option"
                  id={`mention-option-${index}`}
                  aria-selected={index === mentionActive}
                  className={index === mentionActive ? "active" : ""}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    insertMention(item.path);
                  }}
                >
                  <Icon name="file" size={11} />
                  <span className="mention-path">{item.path}</span>
                </button>
              </li>
            )) : (
              <li className="mention-empty"><span className="mention-path">{mentionFailed ? "文件列表加载失败（继续输入重试，或按 Esc 关闭）" : "无匹配文件（继续输入或按 Esc 关闭）"}</span></li>
            )}
          </ul>
        )}
        <textarea
          ref={textareaRef}
          rows={2}
          value={draft}
          aria-label="消息输入框；输入 @ 可引用工作区文件"
          role="combobox"
          aria-expanded={mentionOpen || popupOpen}
          aria-controls={mentionOpen ? "mention-listbox" : popupOpen ? "skill-listbox" : undefined}
          aria-activedescendant={
            mentionOpen
              ? (mentionHasMatches ? `mention-option-${mentionActive}` : undefined)
              : popupOpen && hasSuggestions ? `skill-option-${active}` : undefined
          }
          aria-autocomplete="list"
          onChange={(event) => {
            setDraft(event.target.value);
            syncMention(event.target);
          }}
          onSelect={(event) => syncMention(event.currentTarget)}
          onClick={(event) => syncMention(event.currentTarget)}
          onKeyUp={(event) => syncMention(event.currentTarget)}
          onPaste={onPaste}
          onKeyDown={(event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            if (mentionOpen) {
              if (mentionHasMatches) {
                const count = mentionMatches.length;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setMentionActive((value) => (value + 1) % count);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setMentionActive((value) => (value - 1 + count) % count);
                  return;
                }
              }
              // 补全打开期间 Enter/Tab 一律拦截：有匹配则选中；无匹配（防抖加载中或真空）则关闭补全，避免误发送半成品
              if (event.key === "Tab" || event.key === "Enter") {
                event.preventDefault();
                if (mentionHasMatches) {
                  insertMention(mentionMatches[Math.min(mentionActive, mentionMatches.length - 1)]!.path);
                } else {
                  setMentionDismissed(true);
                  setMentionPartial(null);
                }
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionDismissed(true);
                setMentionPartial(null);
                return;
              }
            }
            if (popupOpen && hasSuggestions) {
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
            }
            if (popupOpen && (event.key === "Tab" || event.key === "Enter")) {
              // 无技能建议时同样拦截 Enter：关闭补全而非发送
              event.preventDefault();
              setDismissed(true);
              return;
            }
            if (popupOpen && event.key === "Escape") {
              event.preventDefault();
              setDismissed(true);
              return;
            }
            // 输入法组合中的 Enter 不触发发送；发送键可在设置中切换
            if (event.nativeEvent.isComposing || event.key !== "Enter") return;
            const shouldSend = sendKey === "enter"
              ? !event.shiftKey && !event.ctrlKey && !event.metaKey
              : event.ctrlKey || event.metaKey;
            if (shouldSend) {
              event.preventDefault();
              // 发送进行中忽略重复提交（运行中入队场景仍允许，由 running 控制）
              if (!sendPending) onSend();
            }
          }}
          placeholder={running
            ? "向正在执行的作业补充指令…"
            : sendKey === "enter" ? "描述要完成的编码任务…（Enter 发送，Shift+Enter 换行，@ 引用文件）" : "描述要完成的编码任务…（Ctrl+Enter 发送，@ 引用文件）"}
        />
        <button
          className="btn primary send"
          disabled={!draft.trim() || sendPending}
          title={sendPending ? "发送中…" : undefined}
          onClick={onSend}
        >
          <Icon name="send" size={13} />
          {draft.trimStart().startsWith("!") ? "运行" : running ? "加入队列" : "发送"}
        </button>
      </div>
      {mentionedPaths.length > 0 && (
        <div className="mention-strip" aria-label="文件引用">
          {mentionedPaths.map((filePath) => (
            <span className="mention-chip" key={filePath}>
              <Icon name="file" size={10} />
              <span className="mention-chip-path">@{filePath}</span>
              <button
                type="button"
                className="mention-remove"
                aria-label={`移除引用 @${filePath}`}
                onClick={() => removeMention(filePath)}
              >
                <Icon name="x" size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {supportsImages && <div className="composer-hint">支持粘贴/拖拽图片（≤4 张，每张 ≤5MB）；输入 @ 引用工作区文件</div>}
    </footer>
  );
}
