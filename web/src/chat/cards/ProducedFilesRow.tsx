import type { ReactElement } from "react";
import { useI18n } from "../../i18n";
import { Icon } from "../../components/Icon";
import type { ProducedFile } from "../message-groups";
import { useChatActions } from "../types";

/**
 * 「本轮产出文件」行：一轮中 write_file/edit_file 触及的文件汇总（按 path 去重），
 * 渲染在该轮末尾（折叠段之后）。文件 chip 点击在编辑器中打开该文件；
 * ChatActions.onOpenFile 未提供时 chip 降级为静态文本。
 */
export function ProducedFilesRow({ files }: { files: ProducedFile[] }): ReactElement {
  const { t } = useI18n();
  const { onOpenFile } = useChatActions();
  return (
    <div className="produced-files-row">
      <span className="produced-files-label">
        <Icon name="file" size={11} />
        {t(`本轮产出 ${files.length} 个文件`, `${files.length} file${files.length > 1 ? "s" : ""} produced`)}
      </span>
      {files.map((file) => (
        onOpenFile ? (
          <button
            key={file.path}
            type="button"
            className="produced-file-chip mono"
            title={t(`在编辑器中打开 ${file.path}`, `Open ${file.path} in the editor`)}
            onClick={() => onOpenFile(file.path)}
          >
            <span className={`produced-file-action produced-file-${file.action}`}>
              {file.action === "write" ? t("写入", "write") : t("编辑", "edit")}
            </span>
            {file.path}
          </button>
        ) : (
          <span key={file.path} className="produced-file-chip mono produced-file-static">
            <span className={`produced-file-action produced-file-${file.action}`}>
              {file.action === "write" ? t("写入", "write") : t("编辑", "edit")}
            </span>
            {file.path}
          </span>
        )
      ))}
    </div>
  );
}
