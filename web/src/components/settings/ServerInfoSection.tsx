import { useEffect, useState, type ReactElement } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import type { ModelProfile, UpdateApplyState } from "../../lib/contracts";
import { useI18n } from "../../i18n";

export function ServerInfoSection({ providers, models }: {
  providers: string[];
  models: ModelProfile[];
}): ReactElement {
  const { t } = useI18n();
  const health = useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: 15_000 });
  const version = useQuery({ queryKey: ["version"], queryFn: api.version, staleTime: 60_000 });
  const updateCheck = useQuery({ queryKey: ["update-check"], queryFn: api.updateCheck, staleTime: 60_000 });
  const refreshMutation = useMutation({
    mutationFn: api.refreshUpdateCheck,
    onSuccess: () => updateCheck.refetch(),
  });
  const snapshot = updateCheck.data?.snapshot ?? version.data?.latestRelease;
  const latest = snapshot ? {
    version: "latestVersion" in snapshot ? snapshot.latestVersion : snapshot.version,
    isNewer: snapshot.isNewer,
    htmlUrl: snapshot.htmlUrl,
    checkedAt: snapshot.checkedAt,
  } : undefined;

  // 在线更新：点击「立即更新」后轮询 /api/update/apply，终态（done/error）或卸载时停止
  const [applyState, setApplyState] = useState<UpdateApplyState | null>(null);
  const [applyStartError, setApplyStartError] = useState<string>();
  const applyInProgress = Boolean(applyState && applyState.status !== "idle" && applyState.status !== "done" && applyState.status !== "error");

  const startApply = async (): Promise<void> => {
    setApplyStartError(undefined);
    try {
      const { state } = await api.updateApplyStart();
      setApplyState(state);
    } catch (err) {
      setApplyStartError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    if (!applyInProgress) return;
    const timer = setInterval(() => {
      api.updateApplyStatus()
        .then(({ state }) => { if (state) setApplyState(state); })
        .catch(() => undefined);
    }, 1000);
    return () => clearInterval(timer);
  }, [applyInProgress]);

  const applyStatusText = (state: UpdateApplyState): string => {
    switch (state.status) {
      case "downloading": {
        const percent = state.progress != null ? ` ${Math.round(state.progress * 100)}%` : "";
        return t(`下载中${percent}`, `Downloading${percent}`);
      }
      case "verifying": return t("校验中…", "Verifying…");
      case "applying": return t("应用中…", "Applying…");
      case "restarting": return t("即将重启…", "Restarting…");
      case "done": return t("完成", "Done");
      case "error": return t("失败", "Failed");
      default: return state.message || t("进行中…", "In progress…");
    }
  };

  return (
    <dl className="server-info">
      <dt>{t("版本", "Version")}</dt>
      <dd>
        {version.data
          ? `Server ${version.data.server} / Core ${version.data.core}${version.data.protocolVersion ? ` (${version.data.protocolVersion})` : ""}`
          : version.isError ? t("不可达", "Unavailable") : t("检查中…", "Checking…")}
      </dd>
      <dt>{t("更新检查", "Update check")}</dt>
      <dd>
        {latest
          ? (latest.isNewer
              ? t(`最新版本 ${latest.version}（可更新）`, `Latest ${latest.version} (update available)`)
              : t(`已是最新（${latest.version}）`, `Up to date (${latest.version})`))
          : updateCheck.isError ? t("未启用", "Not enabled") : t("检查中…", "Checking…")}
        {" "}
        <button
          type="button"
          className="btn small"
          disabled={refreshMutation.isPending}
          onClick={() => refreshMutation.mutate()}
        >
          {refreshMutation.isPending ? t("检查中…", "Checking…") : t("立即检查", "Check now")}
        </button>
        {latest?.isNewer && latest.htmlUrl ? (
          <>
            {" "}
            <a href={latest.htmlUrl} target="_blank" rel="noreferrer">{t("下载", "Download")}</a>
          </>
        ) : null}
        {latest?.isNewer || applyState ? (
          <>
            {" "}
            <button
              type="button"
              className="btn small"
              disabled={applyInProgress}
              onClick={() => void startApply()}
            >
              {applyInProgress
                ? applyStatusText(applyState!)
                : applyState?.status === "error"
                  ? t("重试", "Retry")
                  : t("立即更新", "Update now")}
            </button>
          </>
        ) : null}
        {applyState?.status === "downloading" && applyState.progress != null ? (
          <div
            className="update-progress"
            role="progressbar"
            aria-valuenow={Math.round(applyState.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="update-progress-bar" style={{ width: `${Math.round(applyState.progress * 100)}%` }} />
          </div>
        ) : null}
        {applyState?.status === "restarting" ? (
          <p className="muted">{t("服务即将重启，更新后请刷新页面。", "The service is restarting; refresh the page after the update.")}</p>
        ) : null}
        {applyState?.status === "done" ? (
          <p className="muted">{t("更新已应用，请手动重启服务后刷新页面。", "Update applied. Restart the service manually, then refresh the page.")}</p>
        ) : null}
        {applyState?.status === "error" ? (
          <p className="settings-error" role="alert">{t("更新失败：", "Update failed: ")}{applyState.error ?? applyState.message}</p>
        ) : null}
        {applyStartError ? <p className="settings-error" role="alert">{applyStartError}</p> : null}
      </dd>
      <dt>{t("API 状态", "API status")}</dt>
      <dd>{health.data?.status === "ok" ? t("在线", "Online") : health.isError ? t("不可达", "Unavailable") : t("检查中…", "Checking…")}</dd>
      <dt>{t("服务商", "Providers")}</dt>
      <dd>{providers.length > 0 ? providers.join("、") : "-"}</dd>
      <dt>{t("模型档案", "Model profiles")}</dt>
      <dd>{t(`${models.length} 个`, `${models.length}`)}</dd>
    </dl>
  );
}
