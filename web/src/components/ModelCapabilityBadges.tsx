import type { ReactElement } from "react";
import type { ModelCapabilities } from "../lib/contracts";
import { useI18n } from "../i18n";
import { Icon } from "./Icon";

/** Compact, read-only capability markers for a model profile. */
export function ModelCapabilityBadges({ capabilities, empty = "dash" }: {
  capabilities: ModelCapabilities;
  empty?: "dash" | "hidden";
}): ReactElement | null {
  const { t } = useI18n();
  const badges: ReactElement[] = [];

  if (capabilities.modalities.includes("image")) {
    badges.push(
      <span className="capability-badge capability-badge-image" key="image-input" title={t("图片输入", "Image input")}>
        <Icon name="image" size={11} />
        {t("图片输入", "Image in")}
      </span>,
    );
  }
  if (capabilities.modalities.includes("video")) {
    badges.push(
      <span className="capability-badge capability-badge-video" key="video-input" title={t("视频输入", "Video input")}>
        <Icon name="video" size={11} />
        {t("视频输入", "Video in")}
      </span>,
    );
  }
  if (capabilities.imageOutput) {
    badges.push(
      <span className="capability-badge capability-badge-image-output" key="image-output" title={t("图片输出", "Image output")}>
        <Icon name="image" size={11} />
        {t("图片输出", "Image out")}
      </span>,
    );
  }

  if (badges.length === 0) return empty === "dash" ? <span className="capability-none">—</span> : null;
  return <span className="capability-badges">{badges}</span>;
}
