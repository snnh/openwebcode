// 输入区：自适应高度 textarea，Enter 发送 / Shift+Enter 换行；停止按钮仅运行中显示。
// 图片附件：≤2MB 直接 base64 内嵌进消息 content；>2MB 且 ≤10MB 发送前先 POST uploads 拿 ref 再发引用块；>10MB 拒绝。单消息 ≤3 张。
import { useEffect, useRef, useState, type ReactElement, type KeyboardEvent, type ClipboardEvent, type MutableRefObject } from "react";
import { useI18n } from "../i18n";
import { useStore } from "../app/store";
import { ui } from "../app/ui-store";
import { chatModeStore } from "../app/chat-mode-store";
import { Icon } from "../components/Icon";
import { clipboardFiles, dataUrlBase64, readFileAsDataUrl } from "../lib/file-data-url";
import { useAutosizeTextarea } from "../hooks/use-autosize-textarea";
import type { MessageContent } from "./types";

/** 与 server 对齐：内嵌上限 2MB（CHAT_INLINE_IMAGE_MAX_BYTES），上传上限 10MB（CHAT_IMAGE_MAX_BYTES），单消息 ≤3 张。 */
const INLINE_MAX_BYTES = 2 * 1024 * 1024;
const UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 3;

interface PendingImage {
  id: string;
  mediaType: string;
  /** ≤2MB 内嵌 base64；>2MB 时保留 File，发送前才上传换取 ref。 */
  data?: string;
  file?: File;
  previewUrl: string;
  /** previewUrl 为 objectURL 时需在用后 revoke。 */
  objectUrl: boolean;
}

let nextImageId = 0;

/** 供父组件注入建议文本等（ChatGPT 空态建议行）：写入草稿并聚焦输入框。 */
export interface ChatComposerApi {
  insert(text: string): void;
}

export function ChatComposer({ sessionId, ensureSession, onSent, apiRef }: {
  /** 可空：空态首页发送前经 ensureSession 先建会话（ChatGPT 首页直发风格）。 */
  sessionId?: string;
  ensureSession?: () => Promise<string | undefined>;
  onSent?: () => void;
  apiRef?: MutableRefObject<ChatComposerApi | undefined>;
}): ReactElement {
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [images, setImages] = useState<PendingImage[]>([]);
  const [sending, setSending] = useState(false);
  const running = useStore(chatModeStore, (s) => (sessionId ? (s.running[sessionId] ?? false) : false));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // 建议行注入：设草稿 + 聚焦（注册/卸载时清理）
  useEffect(() => {
    if (!apiRef) return undefined;
    apiRef.current = {
      insert: (text) => {
        setDraft(text);
        textareaRef.current?.focus();
      },
    };
    return () => {
      apiRef.current = undefined;
    };
  }, [apiRef]);

  // 自适应高度（上限 200px）
  useAutosizeTextarea(textareaRef, draft, 200);

  // 卸载时释放所有 objectURL（经 ref 取最新列表，避免在 setState updater 里做副作用）
  const imagesRef = useRef<PendingImage[]>([]);
  useEffect(() => {
    imagesRef.current = images;
  }, [images]);
  useEffect(() => {
    return () => {
      for (const image of imagesRef.current) if (image.objectUrl) URL.revokeObjectURL(image.previewUrl);
    };
  }, []);

  function removeImage(id: string): void {
    setImages((current) => {
      const target = current.find((image) => image.id === id);
      if (target?.objectUrl) URL.revokeObjectURL(target.previewUrl);
      return current.filter((image) => image.id !== id);
    });
  }

  async function addImages(files: Iterable<File>): Promise<void> {
    // 本地计数：一次批量添加多图时闭包里的 images 不会逐张刷新
    let count = images.length;
    for (const file of files) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > UPLOAD_MAX_BYTES) {
        ui.notify(t("图片超过 10MB，无法发送", "Image exceeds 10MB and cannot be sent"), "error");
        continue;
      }
      if (count >= MAX_IMAGES) {
        ui.notify(t(`单条消息最多 ${MAX_IMAGES} 张图片`, `At most ${MAX_IMAGES} images per message`), "error");
        break;
      }
      count += 1;
      if (file.size <= INLINE_MAX_BYTES) {
        const dataUrl = await readFileAsDataUrl(file);
        const image: PendingImage = {
          id: `img-${nextImageId++}`,
          mediaType: file.type,
          data: dataUrlBase64(dataUrl),
          previewUrl: dataUrl,
          objectUrl: false,
        };
        setImages((current) => (current.length >= MAX_IMAGES ? current : [...current, image]));
      } else {
        // >2MB：保留 File，发送前才上传换取 ref（避免用户放弃发送时留下孤儿文件）
        const image: PendingImage = {
          id: `img-${nextImageId++}`,
          mediaType: file.type,
          file,
          previewUrl: URL.createObjectURL(file),
          objectUrl: true,
        };
        setImages((current) => {
          if (current.length >= MAX_IMAGES) {
            URL.revokeObjectURL(image.previewUrl);
            return current;
          }
          return [...current, image];
        });
      }
    }
  }

  /** >2MB 附件发送前上传换取 ref；失败返回 undefined。 */
  async function uploadImage(sid: string, image: PendingImage): Promise<string | undefined> {
    if (!image.file) return undefined;
    try {
      const dataUrl = await readFileAsDataUrl(image.file);
      const res = await fetch(`/api/chat/sessions/${sid}/uploads`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: dataUrlBase64(dataUrl),
          mediaType: image.mediaType,
          filename: image.file.name,
        }),
      });
      if (!res.ok) {
        ui.notify(t("图片上传失败", "Image upload failed"), "error");
        return undefined;
      }
      return ((await res.json()) as { ref: string }).ref;
    } catch {
      ui.notify(t("图片上传失败", "Image upload failed"), "error");
      return undefined;
    }
  }

  async function handleSend(): Promise<void> {
    const text = draft.trim();
    if (!text || sending) return;

    setSending(true);
    try {
      // 无会话（首页空态）先建会话；建失败（如未配置模型）保留草稿
      let sid = sessionId;
      if (!sid) {
        sid = await ensureSession?.();
        if (!sid) {
          setSending(false);
          return;
        }
      }
      // 纯文本保持旧 {text} 形态；带图走 content 块数组
      let body: Record<string, unknown> = { text };
      if (images.length > 0) {
        const content: MessageContent[] = [{ type: "text", text }];
        for (const image of images) {
          if (image.data) {
            content.push({ type: "image", mediaType: image.mediaType, data: image.data });
          } else {
            const ref = await uploadImage(sid, image);
            if (!ref) {
              setSending(false);
              return; // 保留草稿与附件，用户可重试
            }
            content.push({ type: "image", mediaType: image.mediaType, ref });
          }
        }
        body = { content };
      }
      const res = await fetch(`/api/chat/sessions/${sid}/messages`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setDraft("");
        for (const image of images) if (image.objectUrl) URL.revokeObjectURL(image.previewUrl);
        setImages([]);
        onSent?.();
      } else if (images.length > 0) {
        // 带图消息失败时给出服务端原因（400 校验 / 413 超限等）
        const errorBody = (await res.json().catch(() => ({}))) as { error?: string };
        ui.notify(errorBody.error ?? t("发送失败", "Send failed"), "error");
      }
    } catch {
      // 发送失败保留草稿，用户可重试
    }
    setSending(false);
  }

  async function handleStop(): Promise<void> {
    if (!sessionId) return;
    await fetch(`/api/chat/sessions/${sessionId}/stop`, { method: "POST", credentials: "include" });
  }

  function handleKeyDown(event: KeyboardEvent): void {
    // 输入法组词中的 Enter 不触发发送（与 workbench Composer 一致）
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSend();
    }
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = clipboardFiles(event).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) {
      // 图片由附件通道接管；文本部分不 preventDefault，照常进 textarea
      void addImages(files);
    }
  }

  return (
    <div className="chat-composer-area">
      <div className="chat-composer-box">
        {images.length > 0 && (
          <div className="chat-attachment-strip">
            {images.map((image) => (
              <div key={image.id} className="chat-attachment">
                <img src={image.previewUrl} alt="" />
                <button
                  type="button"
                  className="chat-attachment-remove"
                  aria-label={t("移除图片", "Remove image")}
                  onClick={() => removeImage(image.id)}
                >
                  <Icon name="x" size={10} />
                </button>
              </div>
            ))}
          </div>
        )}
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          aria-label={t("选择图片文件", "Choose image files")}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (files.length > 0) void addImages(files);
          }}
        />
        <textarea
          ref={textareaRef}
          className="chat-composer-input"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={t("有问题，随便问", "Ask anything")}
          rows={1}
        />
        <div className="chat-composer-toolbar">
          <button
            type="button"
            className="icon-btn"
            aria-label={t("添加图片", "Add images")}
            title={t("添加图片", "Add images")}
            onClick={() => fileInputRef.current?.click()}
          >
            <Icon name="paperclip" />
          </button>
          <span className="spacer" />
          {running ? (
            <button
              type="button"
              className="chat-round-btn stop"
              aria-label={t("停止", "Stop")}
              title={t("停止", "Stop")}
              onClick={() => void handleStop()}
            >
              <Icon name="square" size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="chat-round-btn send"
              aria-label={sending ? t("发送中…", "Sending…") : t("发送", "Send")}
              title={sending ? t("发送中…", "Sending…") : t("发送", "Send")}
              onClick={() => void handleSend()}
              disabled={!draft.trim() || sending}
            >
              <Icon name="arrow-up" size={16} />
            </button>
          )}
        </div>
      </div>
      <p className="chat-composer-hint">
        {t("内容由 AI 生成，请注意甄别", "AI-generated content; please verify")}
      </p>
    </div>
  );
}
