import type { ReactElement } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n";
import type { PendingImage } from "./drafts";

/**
 * Composer 输入卡片内的两类 chips：
 * - AttachmentStrip：待发送图片附件缩略图（角标 × 移除）
 * - MentionStrip：草稿中 @ 引用的工作区文件（× 移除并回写草稿）
 * 纯展示组件，数据与回调由 Composer 提供。
 */

export function AttachmentStrip({ attachments, onRemove }: {
  attachments: PendingImage[];
  onRemove(index: number): void;
}): ReactElement | null {
  const { t } = useI18n();
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-strip" aria-label={t("图片附件", "Image attachments")}>
      {attachments.map((image, index) => (
        <span className="attachment" key={`${index}-${image.data.length}`}>
          <img src={image.previewUrl} alt={t(`附件 ${index + 1}`, `Attachment ${index + 1}`)} />
          <button
            className="attachment-remove"
            aria-label={t(`移除附件 ${index + 1}`, `Remove attachment ${index + 1}`)}
            onClick={() => onRemove(index)}
          >
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}

export function MentionStrip({ paths, onRemove }: {
  paths: string[];
  onRemove(path: string): void;
}): ReactElement | null {
  const { t } = useI18n();
  if (paths.length === 0) return null;
  return (
    <div className="mention-strip" aria-label={t("文件引用", "File references")}>
      {paths.map((filePath) => (
        <span className="mention-chip" key={filePath}>
          <Icon name="file" size={10} />
          <span className="mention-chip-path">@{filePath}</span>
          <button
            type="button"
            className="mention-remove"
            aria-label={t(`移除引用 @${filePath}`, `Remove reference @${filePath}`)}
            onClick={() => onRemove(filePath)}
          >
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
    </div>
  );
}
