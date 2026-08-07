import { useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import type { ModelCapabilities, ModelProfile, PermissionMode } from "../lib/contracts";
import { Icon } from "../components/Icon";
import { ModelCapabilityBadges } from "../components/ModelCapabilityBadges";
import { useI18n } from "../i18n";

/**
 * Composer 底栏的配置上弹层：权限模式（ask/acceptEdits/review/yolo）、
 * 模式开关（计划/Swarm/目标）、模型与思考程度合并选择。
 * 数据链路：选择统一经 onConfig 走 PUT /api/sessions/:id/config。
 */

/** 通用弹层：透明遮罩点击 / Esc 关闭；菜单以触发按钮（父容器 .composer-menu）为锚 fixed 定位并 clamp 进视口。 */
export function Popover({ open, onClose, children }: { open: boolean; onClose(): void; children: ReactNode }): ReactElement | null {
  const menuRef = useRef<HTMLDivElement>(null);
  // null = 尚未测量，首帧不可见（CSS visibility:hidden），测量后 fixed 定位
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    const onKey = (event: KeyboardEvent): void => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    const update = (): void => {
      const menu = menuRef.current;
      const anchor = menu?.parentElement;
      if (!menu || !anchor) return;
      const rect = anchor.getBoundingClientRect();
      const margin = 8;
      const menuWidth = menu.offsetWidth || 320;
      const menuHeight = menu.offsetHeight || 240;
      const left = Math.min(Math.max(rect.left, margin), Math.max(margin, window.innerWidth - menuWidth - margin));
      // 默认弹在按钮上方；上方放不下时翻到下方，仍放不下则贴视口底
      const above = rect.top - 6 - menuHeight;
      const top = above >= margin ? above : Math.min(rect.bottom + 6, Math.max(margin, window.innerHeight - menuHeight - margin));
      setPosition({ left, top });
    };
    // 双帧测量：懒加载内容第二帧再校正一次
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

/** 带勾选列的菜单项（menuitemradio）：当前值 selected + check 图标。 */
function MenuOption({ selected, label, description, onSelect }: {
  selected: boolean;
  label: string;
  description?: string;
  onSelect(): void;
}): ReactElement {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={selected}
      className={`popover-item${selected ? " selected" : ""}`}
      onClick={onSelect}
    >
      <span className="popover-item-check" aria-hidden>{selected ? <Icon name="check" size={13} /> : null}</span>
      <span className="popover-item-text">
        <span className="popover-item-label">{label}</span>
        {description ? <span className="popover-item-desc">{description}</span> : null}
      </span>
    </button>
  );
}

const PERMISSION_OPTIONS: Array<{ value: PermissionMode; label: [string, string]; description: [string, string] }> = [
  { value: "ask", label: ["逐次确认", "Confirm each"], description: ["每个工具操作都需要你手动确认", "Every tool action requires your manual confirmation"] },
  { value: "acceptEdits", label: ["接受编辑", "Accept edits"], description: ["自动批准文件写入与编辑，其他工具操作仍会询问", "File writes and edits are auto-approved; other tool actions still ask"] },
  { value: "review", label: ["模型审核", "Model review"], description: ["低风险操作由快速模型自动通过，高风险仍会询问你", "Low-risk actions are auto-approved by a fast model; high-risk ones still ask you"] },
  { value: "yolo", label: ["完全自主", "Full autonomy"], description: ["完全自主运行，智能体自己做决定，不再询问", "Runs fully autonomously; the agent decides on its own and never asks"] },
];

/** 权限模式弹层（运行中禁用，由调用方控制）。 */
export function PermissionModeMenu({ value, disabled, onChange }: {
  value: PermissionMode;
  disabled: boolean;
  onChange(mode: PermissionMode): void;
}): ReactElement {
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
          <MenuOption
            key={option.value}
            selected={option.value === value}
            label={t(...option.label)}
            description={t(...option.description)}
            onSelect={() => { onChange(option.value); setOpen(false); }}
          />
        ))}
      </Popover>
    </div>
  );
}

/** 模式弹层的单个开关行（图标 + 文案 + toggle）。 */
function ModeToggle({ icon, label, description, checked, onChange }: {
  icon: "edit" | "layers" | "pin";
  label: string;
  description: string;
  checked: boolean;
  onChange(checked: boolean): void;
}): ReactElement {
  return (
    <div className={`popover-toggle${checked ? " selected" : ""}`}>
      <span className="popover-toggle-icon" aria-hidden><Icon name={icon} size={14} /></span>
      <span className="popover-item-text">
        <span className="popover-item-label">{label}</span>
        <span className="popover-item-desc">{description}</span>
      </span>
      <span className={`toggle-switch${checked ? " on" : ""}`}>
        <input
          type="checkbox"
          checked={checked}
          aria-label={label}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span className="toggle-knob" aria-hidden />
      </span>
    </div>
  );
}

/** 「模式」弹层：计划 / 目标（互斥单值 agentMode）+ Swarm（独立布尔开关）。 */
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
  const activeBadges = [planActive ? t("计划", "Plan") : "", goalActive ? t("目标", "Goal") : "", swarmEnabled ? "Swarm" : ""].filter(Boolean).join(" · ");
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
        {activeBadges ? <span className="pill small accent composer-menu-badge">{activeBadges}</span> : null}
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

/** 思考档标签：关/默认/自适应 + 六档 effort（max/ultra 不翻译）。徽标与滑块共用。 */
export const THINKING_LABEL: Record<string, [string, string]> = { adaptive: ["自适应", "Adaptive"], enabled: ["默认", "Default"], disabled: ["关", "Off"] };
export const EFFORT_LABEL: Record<string, [string, string]> = {
  low: ["低", "Low"],
  medium: ["中", "Medium"],
  high: ["高", "High"],
  xhigh: ["极高", "Extra high"],
  max: ["max", "max"],
  ultra: ["ultra", "ultra"],
};

/** 模型 + 思考程度合并弹层：模型按供应商分组（可折叠），底部固定区为能力徽章 + 思考开关/程度滑块 + 「更多模型…」。 */
export function ModelMenu({ current, selectableModels, selectionUnavailable, effortLevels, thinkingOn, currentEffort, defaultOnValue, thinkingBadge, thinkingControlSupported, disabled, onSelectModel, onSelectThinking, onOpenModelSettings, capabilities }: {
  current: { provider: string; model: string };
  selectableModels: ModelProfile[];
  /** 当前会话模型不在可用清单中（provider 未配置等）：顶部固定展示一条选中态 */
  selectionUnavailable: boolean;
  /** 有效 effort 档位（模型已声明子集；未声明时全部六档）。滑块档位 = [默认, ...effortLevels] */
  effortLevels: string[];
  thinkingOn: boolean;
  currentEffort?: string | undefined;
  /** 滑块左端点（默认）与开关 on 的无 effort 取值（mode:enabled 或 mode:adaptive） */
  defaultOnValue: string;
  thinkingBadge?: [string, string] | undefined;
  thinkingControlSupported: boolean;
  disabled: boolean;
  onSelectModel(item: ModelProfile): void;
  onSelectThinking(value: string): void;
  onOpenModelSettings(): void;
  capabilities?: ModelCapabilities | undefined;
}): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // 分组折叠：默认只展开当前模型所在供应商组（单组时展开），其余收起
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
          {thinkingBadge ? <span className="model-menu-btn-thinking"> · {t(...thinkingBadge)}</span> : null}
        </span>
        <Icon name="chevron-up" size={11} />
      </button>
      <Popover open={open} onClose={() => setOpen(false)}>
        <div className="popover-scroll">
          <div className="popover-section">
            {selectionUnavailable && current.model ? (
              <div className="popover-item selected">
                <span className="popover-item-check" aria-hidden><Icon name="check" size={13} /></span>
                <span className="popover-item-text">
                  <span className="popover-item-label mono">{t(`${current.model}【${current.provider}】`, `${current.model} (${current.provider})`)}</span>
                  <span className="popover-item-desc">{t("当前模型不在可用清单中", "Current model is not in the available list")}</span>
                </span>
              </div>
            ) : null}
            {selectableModels.length === 0 && !current.model ? (
              <div className="popover-item disabled"><span className="popover-item-label">{t("暂无可用模型", "No model available")}</span></div>
            ) : null}
            {groups.map(([provider, items]) => {
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
                      <MenuOption
                        key={`${item.provider}/${item.id}`}
                        selected={selected}
                        label={item.id}
                        onSelect={() => { onSelectModel(item); setOpen(false); }}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
        <div className="popover-fixed">
          {capabilities ? (
            <div className="popover-section">
              <span className="popover-section-label">{t("模型能力", "Model capabilities")}</span>
              <div className="popover-capabilities"><ModelCapabilityBadges capabilities={capabilities} /></div>
            </div>
          ) : null}
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
          <div className="popover-section popover-footer">
            <button type="button" className="popover-more" onClick={() => { onOpenModelSettings(); setOpen(false); }}>
              {t("更多模型…", "More models…")}
            </button>
          </div>
        </div>
      </Popover>
    </div>
  );
}
