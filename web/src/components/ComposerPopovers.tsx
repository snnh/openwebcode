import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { ModelCapabilities, ModelProfile, PermissionMode } from "../lib/contracts";
import { Icon } from "./Icon";
import { ModelCapabilityBadges } from "./ModelCapabilityBadges";
import { useI18n } from "../i18n";

/**
 * Composer 底部配置弹层（参考 Kimi Code Web）：权限三档、模式开关（计划/Swarm/目标）、
 * 模型与思考程度合并选择。数据链路不变——全部经 onConfig 走既有 PUT /api/sessions/:id/config。
 */

/** 通用弹层：透明遮罩点击 / Esc 关闭；菜单绝对定位于触发按钮上方。 */
export function Popover({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }): ReactElement | null {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="popover-overlay" aria-hidden onClick={onClose} />
      <div className="popover-menu" role="menu">{children}</div>
    </>
  );
}

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: [string, string]; description: [string, string] }> = [
  { value: "ask", label: ["逐条确认", "Confirm each"], description: ["每个工具操作都需要你手动确认", "Every tool action requires your manual confirmation"] },
  { value: "acceptEdits", label: ["自动通过", "Auto-approve"], description: ["自动批准工具操作，但遇到关键问题仍会询问", "Tool actions are auto-approved; key questions are still asked"] },
  { value: "yolo", label: ["完全自主", "Full autonomy"], description: ["完全自主运行，智能体自己做决定，不再询问", "Runs fully autonomously; the agent decides on its own and never asks"] },
];

/** 4a：权限模式弹层（ask/acceptEdits/yolo，带描述）。 */
export function PermissionModeMenu({ value, disabled, onChange }: { value: PermissionMode; disabled: boolean; onChange(mode: PermissionMode): void }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const current = PERMISSION_OPTIONS.find((option) => option.value === value) ?? PERMISSION_OPTIONS[0]!;
  return (
    <div className="composer-menu">
      <button
        type="button"
        className={`composer-menu-btn${open ? " open" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("权限模式", "Permission mode")}
        onClick={() => setOpen((v) => !v)}
      >
        {t(...current.label)}
        <Icon name="chevron-up" size={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        {PERMISSION_OPTIONS.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={option.value === value}
            className={`popover-item${option.value === value ? " selected" : ""}`}
            onClick={() => { onChange(option.value); setOpen(false); }}
          >
            <span className="popover-item-check" aria-hidden>{option.value === value ? <Icon name="check" size={13} /> : null}</span>
            <span className="popover-item-text">
              <span className="popover-item-label">{t(...option.label)}</span>
              <span className="popover-item-desc">{t(...option.description)}</span>
            </span>
          </button>
        ))}
      </Popover>
    </div>
  );
}

/** 模式弹层的单个开关行。 */
function ModeToggle({ icon, label, description, checked, disabled, onChange, badge }: {
  icon: "edit" | "layers" | "pin";
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange?(checked: boolean): void;
  badge?: string;
}): ReactElement {
  return (
    <div className={`popover-toggle${disabled ? " disabled" : ""}${checked ? " selected" : ""}`}>
      <span className="popover-toggle-icon" aria-hidden><Icon name={icon} size={14} /></span>
      <span className="popover-item-text">
        <span className="popover-item-label">
          {label}
          {badge && <span className="popover-item-badge">{badge}</span>}
        </span>
        <span className="popover-item-desc">{description}</span>
      </span>
      <span className={`toggle-switch${checked ? " on" : ""}`}>
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange?.(event.target.checked)}
        />
        <span className="toggle-knob" aria-hidden />
      </span>
    </div>
  );
}

/** 4b：「模式」弹层——计划（现有 agentMode）、Swarm（会话级 spawn_swarm 开关）、目标（占位禁用）。 */
export function AgentModeMenu({ agentMode, swarmEnabled, disabled, onConfig }: {
  agentMode: "plan" | "build" | undefined;
  swarmEnabled: boolean;
  disabled: boolean;
  onConfig(body: Record<string, unknown>): void;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const planActive = agentMode === "plan";
  const activeBadges = [planActive ? t("计划", "Plan") : undefined, swarmEnabled ? "Swarm" : undefined].filter(Boolean).join(" · ");
  return (
    <div className="composer-menu">
      <button
        type="button"
        className={`composer-menu-btn${open ? " open" : ""}${activeBadges ? " active" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("模式", "Mode")}
        onClick={() => setOpen((v) => !v)}
      >
        {t("模式", "Mode")}
        {activeBadges && <span className="composer-menu-badge">{activeBadges}</span>}
        <Icon name="chevron-up" size={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <ModeToggle
          icon="edit"
          label={t("计划", "Plan")}
          description={t("先让智能体梳理计划，再修改文件", "Let the agent draft a plan before modifying files")}
          checked={planActive}
          onChange={(checked) => onConfig({ agentMode: checked ? "plan" : null })}
        />
        <ModeToggle
          icon="layers"
          label="Swarm"
          description={t("并行运行多个智能体，适合大范围探索", "Run multiple agents in parallel; suited for broad exploration")}
          checked={swarmEnabled}
          onChange={(checked) => onConfig({ swarmEnabled: checked })}
        />
        <ModeToggle
          icon="pin"
          label={t("目标", "Goal")}
          description={t("持续跟踪一个目标，直到任务完成", "Keep tracking a goal until the task is done")}
          checked={false}
          disabled
          badge={t("即将推出", "Soon")}
        />
      </Popover>
    </div>
  );
}

export interface ThinkingChoice {
  value: string;
  label: [string, string];
}

const EFFORT_TIERS = ["low", "medium", "high", "xhigh", "max"] as const;

/** 4c：模型 + 思考程度合并弹层。 */
export function ModelMenu({ current, selectableModels, selectionUnavailable, thinkingChoices, thinkingSelection, efforts, thinkingControlSupported, disabled, onSelectModel, onSelectThinking, onOpenModelSettings, capabilities }: {
  current: { provider: string; model: string };
  selectableModels: ModelProfile[];
  selectionUnavailable: boolean;
  thinkingChoices: ThinkingChoice[];
  thinkingSelection: string;
  /** 当前模型支持的 effort 枚举（五档分段中不支持的灰显）。 */
  efforts: string[];
  thinkingControlSupported: boolean;
  disabled: boolean;
  onSelectModel(item: ModelProfile): void;
  onSelectThinking(value: string): void;
  onOpenModelSettings?(): void;
  /** 选中模型的能力徽章（原「高级设置」区块迁入弹层底部）。 */
  capabilities?: ModelCapabilities | undefined;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const thinkingBadge = thinkingChoices.find((choice) => choice.value === thinkingSelection)?.label;
  return (
    <div className="composer-menu">
      <button
        type="button"
        className={`composer-menu-btn model-menu-btn${open ? " open" : ""}`}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t("模型与思考程度", "Model and thinking")}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="model-menu-btn-label">
          {current.model || t("未选择模型", "No model")}
          {thinkingBadge && <span className="model-menu-btn-thinking"> · {t(...thinkingBadge)}</span>}
        </span>
        <Icon name="chevron-up" size={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="popover-section">
          {selectionUnavailable && current.model && (
            <div className="popover-item selected">
              <span className="popover-item-check" aria-hidden><Icon name="check" size={13} /></span>
              <span className="popover-item-text">
                <span className="popover-item-label mono">{current.model}【{current.provider}】</span>
                <span className="popover-item-desc">{t("当前模型不在可用清单中", "Current model is not in the available list")}</span>
              </span>
            </div>
          )}
          {selectableModels.length === 0 && !current.model && (
            <div className="popover-item disabled"><span className="popover-item-label">{t("暂无可用模型", "No model available")}</span></div>
          )}
          {selectableModels.map((item) => {
            const selected = item.provider === current.provider && item.id === current.model;
            return (
              <button
                key={`${item.provider}/${item.id}`}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                className={`popover-item${selected ? " selected" : ""}`}
                onClick={() => { onSelectModel(item); setOpen(false); }}
              >
                <span className="popover-item-check" aria-hidden>{selected ? <Icon name="check" size={13} /> : null}</span>
                <span className="popover-item-text">
                  <span className="popover-item-label mono">{item.id}</span>
                  <span className="popover-item-desc">{item.provider}</span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="popover-section popover-thinking">
          <span className="popover-section-label">{t("思考", "Thinking")}</span>
          <div className="thinking-modes">
            {thinkingChoices.filter((choice) => !choice.value.startsWith("effort:")).map((choice) => (
              <button
                key={choice.value}
                type="button"
                className={`segmented-btn${thinkingSelection === choice.value ? " active" : ""}`}
                disabled={!thinkingControlSupported}
                onClick={() => onSelectThinking(choice.value)}
              >
                {t(...choice.label)}
              </button>
            ))}
          </div>
          <div className="thinking-efforts" role="group" aria-label={t("思考程度", "Thinking effort")}>
            {EFFORT_TIERS.map((tier) => {
              const supported = efforts.includes(tier);
              const value = `effort:${tier}`;
              return (
                <button
                  key={tier}
                  type="button"
                  className={`segmented-btn${thinkingSelection === value ? " active" : ""}`}
                  disabled={!supported}
                  title={supported ? undefined : t("当前模型不支持该档位", "Not supported by the current model")}
                  onClick={() => onSelectThinking(value)}
                >
                  {tier}
                </button>
              );
            })}
          </div>
          <p className="popover-item-desc popover-hint">{t(
            "提示：切换模型或思考程度会使已有的提示词缓存失效。建议新建对话，避免额外的 token 消耗。",
            "Note: switching the model or thinking level invalidates the existing prompt cache. Start a new session to avoid extra token usage.",
          )}</p>
        </div>
        {capabilities && (
          <div className="popover-section">
            <span className="popover-section-label">{t("模型能力", "Model capabilities")}</span>
            <div className="popover-capabilities"><ModelCapabilityBadges capabilities={capabilities} /></div>
          </div>
        )}
        {onOpenModelSettings && (
          <div className="popover-section popover-footer">
            <button type="button" className="popover-more" onClick={() => { onOpenModelSettings(); setOpen(false); }}>
              {t("更多模型…", "More models…")}
            </button>
          </div>
        )}
      </Popover>
    </div>
  );
}
