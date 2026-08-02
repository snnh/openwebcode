import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ModelCapabilities, ModelProfile, PermissionMode } from "../lib/contracts";
import { Icon } from "./Icon";
import { ModelCapabilityBadges } from "./ModelCapabilityBadges";
import { useI18n } from "../i18n";

/**
 * Composer 底部配置弹层（参考 Kimi Code Web）：权限三档、模式开关（计划/Swarm/目标）、
 * 模型与思考程度合并选择。数据链路不变——全部经 onConfig 走既有 PUT /api/sessions/:id/config。
 */

/** 通用弹层：透明遮罩点击 / Esc 关闭；菜单 fixed 定位于触发按钮上方并 clamp 在视口内。 */
export function Popover({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }): ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null);
  // 锚定后的视口坐标；null 表示尚未测量（首帧退回 CSS 默认定位，随即被测量值覆盖）
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    // 以父容器（.composer-menu，包住触发按钮）为锚点，把菜单 clamp 进视口 8px 安全边距
    const update = (): void => {
      const menu = menuRef.current;
      const anchor = menu?.parentElement;
      if (!menu || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const menuWidth = menu.offsetWidth || 320;
      const menuHeight = menu.offsetHeight || 240;
      const maxLeft = Math.max(margin, vw - menuWidth - margin);
      const left = Math.min(Math.max(rect.left, margin), maxLeft);
      // 默认锚在触发按钮上方；上方放不下时翻到下方，仍放不下则贴视口底
      const aboveTop = rect.top - 6 - menuHeight;
      const top = aboveTop >= margin
        ? aboveTop
        : Math.min(rect.bottom + 6, Math.max(margin, vh - menuHeight - margin));
      setPosition({ left, top });
    };
    // 双帧测量：首帧内容（懒加载列表等）可能尚未撑开，第二帧再校正一次
    update();
    const raf = requestAnimationFrame(update);
    window.addEventListener("resize", update);
    return () => {
      document.removeEventListener("keydown", onKey);
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", update);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <>
      <div className="popover-overlay" aria-hidden onClick={onClose} />
      <div
        ref={menuRef}
        className={`popover-menu${position ? " popover-menu-anchored" : ""}`}
        role="menu"
        style={position ? { left: position.left, top: position.top } : undefined}
      >
        {children}
      </div>
    </>
  );
}

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: [string, string]; description: [string, string] }> = [
  { value: "ask", label: ["逐次确认", "Confirm each"], description: ["每个工具操作都需要你手动确认", "Every tool action requires your manual confirmation"] },
  { value: "acceptEdits", label: ["接受编辑", "Accept edits"], description: ["自动批准文件写入与编辑，其他工具操作仍会询问", "File writes and edits are auto-approved; other tool actions still ask"] },
  { value: "review", label: ["模型审核", "Model review"], description: ["低风险操作由快速模型自动通过，高风险仍会询问你", "Low-risk actions are auto-approved by a fast model; high-risk ones still ask you"] },
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

/** 4b：「模式」弹层——计划 / 目标（互斥的单值 agentMode）、Swarm（会话级 spawn_swarm 独立开关）。 */
export function AgentModeMenu({ agentMode, swarmEnabled, disabled, onConfig }: {
  agentMode: "plan" | "code" | "goal" | undefined;
  swarmEnabled: boolean;
  disabled: boolean;
  onConfig(body: Record<string, unknown>): void;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const planActive = agentMode === "plan";
  const goalActive = agentMode === "goal";
  const activeBadges = [planActive ? t("计划", "Plan") : undefined, goalActive ? t("目标", "Goal") : undefined, swarmEnabled ? "Swarm" : undefined].filter(Boolean).join(" · ");
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
          description={t("持续跟踪一个目标，主模型自评未完成时自动续跑（最多 10 次）", "Keep tracking a goal; auto-continue on incomplete self-evaluation (up to 10 times)")}
          checked={goalActive}
          onChange={(checked) => onConfig({ agentMode: checked ? "goal" : null })}
        />
      </Popover>
    </div>
  );
}

/** 思考档标签：关/默认/自适应 + 六档 effort（max/ultra 不翻译）。Composer 徽标与滑块共用。 */
export const THINKING_LABEL: Record<string, [string, string]> = { adaptive: ["自适应", "Adaptive"], enabled: ["默认", "Default"], disabled: ["关", "Off"] };
export const EFFORT_LABEL: Record<string, [string, string]> = {
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高", "Extra high"],
  max: ["max", "max"],
  ultra: ["ultra", "ultra"],
};

/** 4c：模型 + 思考程度合并弹层。模型按供应商分组（可折叠）；底部固定区为模型能力徽章 +
 * 思考开关（胶囊）与思考程度滑块（默认 低 中 高 极高 max ultra），不随列表滚动。 */
export function ModelMenu({ current, selectableModels, selectionUnavailable, effortLevels, thinkingOn, currentEffort, defaultOnValue, thinkingBadge, thinkingControlSupported, disabled, onSelectModel, onSelectThinking, onOpenModelSettings, capabilities }: {
  current: { provider: string; model: string };
  selectableModels: ModelProfile[];
  selectionUnavailable: boolean;
  /** 有效 effort 档位（当前模型已声明子集；未声明时全部六档）。滑块档位 = [默认, ...effortLevels]。 */
  effortLevels: string[];
  thinkingOn: boolean;
  currentEffort?: string | undefined;
  /** 滑块左端点（默认）与开关 on 的无 effort 取值（mode:enabled 或 mode:adaptive）。 */
  defaultOnValue: string;
  thinkingBadge?: [string, string] | undefined;
  thinkingControlSupported: boolean;
  disabled: boolean;
  onSelectModel(item: ModelProfile): void;
  onSelectThinking(value: string): void;
  onOpenModelSettings?(): void;
  /** 选中模型的能力徽章（底部固定区）。 */
  capabilities?: ModelCapabilities | undefined;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 分组折叠：默认只展开当前模型所在供应商组，其余收起
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const groups = useMemo(() => {
    const map = new Map<string, ModelProfile[]>();
    for (const item of selectableModels) {
      const list = map.get(item.provider) ?? [];
      list.push(item);
      map.set(item.provider, list);
    }
    return [...map.entries()];
  }, [selectableModels]);
  const stops = [THINKING_LABEL.enabled!, ...effortLevels.map((tier) => EFFORT_LABEL[tier] ?? [tier, tier])] as Array<[string, string]>;
  const sliderIndex = thinkingOn && currentEffort ? effortLevels.indexOf(currentEffort) + 1 : 0;
  const sliderDisabled = !thinkingControlSupported || !thinkingOn;
  const currentLevelText = !thinkingOn ? t(...THINKING_LABEL.disabled!) : t(...stops[sliderIndex]!);
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
        <div className="popover-scroll">
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
            {groups.map(([provider, items]) => {
              // 默认展开：单组、或包含当前模型的组；其余收起（用户可手动展开/收起）
              const isCollapsed = collapsed[provider] ?? (groups.length > 1 && !items.some((item) => item.provider === current.provider && item.id === current.model));
              return (
                <div className="popover-group" key={provider}>
                  <button
                    type="button"
                    className="popover-group-header"
                    aria-expanded={!isCollapsed}
                    onClick={() => setCollapsed((prev) => ({ ...prev, [provider]: !isCollapsed }))}
                  >
                    <span className={`popover-group-chevron${isCollapsed ? " collapsed" : ""}`} aria-hidden><Icon name="chevron-down" size={12} /></span>
                    <span className="popover-group-name">{provider}</span>
                    <span className="popover-group-count">{items.length}</span>
                  </button>
                  {!isCollapsed && items.map((item) => {
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
                        </span>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div className="popover-fixed">
          {capabilities && (
            <div className="popover-section">
              <span className="popover-section-label">{t("模型能力", "Model capabilities")}</span>
              <div className="popover-capabilities"><ModelCapabilityBadges capabilities={capabilities} /></div>
            </div>
          )}
          <div className="popover-section popover-thinking">
            <div className="popover-thinking-row">
              <span className="popover-section-label">{t("思考", "Thinking")}</span>
              <span className={`toggle-switch${thinkingOn ? " on" : ""}`}>
                <input
                  type="checkbox"
                  checked={thinkingOn}
                  disabled={!thinkingControlSupported}
                  aria-label={t("思考", "Thinking")}
                  onChange={(event) => onSelectThinking(event.target.checked ? (currentEffort ? `effort:${currentEffort}` : defaultOnValue) : "default")}
                />
                <span className="toggle-knob" aria-hidden />
              </span>
            </div>
            <div className={`thinking-slider${sliderDisabled ? " disabled" : ""}`} role="group" aria-label={t("思考程度", "Thinking effort")}>
              <div className="thinking-slider-row">
                <span className="thinking-slider-end">{t("更快", "Faster")}</span>
                <div className="thinking-cells">
                  {stops.map((label, index) => (
                    <button
                      key={label[1]}
                      type="button"
                      className={`thinking-cell${index <= sliderIndex && !sliderDisabled ? " filled" : ""}${index === sliderIndex && !sliderDisabled ? " current" : ""}`}
                      disabled={sliderDisabled}
                      aria-label={t(...label)}
                      aria-pressed={index === sliderIndex}
                      title={t(...label)}
                      onClick={() => onSelectThinking(index === 0 ? defaultOnValue : `effort:${effortLevels[index - 1]}`)}
                    />
                  ))}
                </div>
                <span className="thinking-slider-end">{t("更聪明", "Smarter")}</span>
                <span className={`thinking-slider-current${thinkingOn ? " active" : ""}`}>{currentLevelText}</span>
              </div>
            </div>
          </div>
          {onOpenModelSettings && (
            <div className="popover-section popover-footer">
              <button type="button" className="popover-more" onClick={() => { onOpenModelSettings(); setOpen(false); }}>
                {t("更多模型…", "More models…")}
              </button>
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}
