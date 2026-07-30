import { useEffect, useRef, useState, type ReactElement } from "react";
import { api } from "../lib/api";
import type { ModelProfile, SettingsTab } from "../lib/contracts";
import { Icon, type IconName } from "./Icon";
import type { SendKey, SessionDefaults } from "../lib/prefs";
import type { ThemePreference, AccentPreference } from "../theme";
import { useI18n } from "../i18n";
import { SETTING_GROUP_TAB, SETTINGS_FIELD_EN } from "./settings/shared";
import { AppearanceSection } from "./settings/AppearanceSection";
import { GeneralSection } from "./settings/GeneralSection";
import { DefaultsSection } from "./settings/DefaultsSection";
import { ShortcutsSection } from "./settings/ShortcutsSection";
import { RemoteAccessSection } from "./settings/RemoteAccessSection";
import { ProviderProfilesSection } from "./settings/ProviderProfilesSection";
import { ModelAccessSection } from "./settings/ModelAccessSection";
import { ModelCatalogSection } from "./settings/ModelCatalogSection";
import { SkillsSection } from "./settings/SkillsSection";
import { ExtensionsSection } from "./settings/ExtensionsSection";
import { PricingSection } from "./settings/PricingSection";
import { ServerSettingsFields } from "./settings/ServerSettingsFields";
import { PromptSection } from "./settings/PromptSection";
import { ServerInfoSection } from "./settings/ServerInfoSection";
import { SystemStorageSection } from "./settings/SystemStorageSection";

export type { SettingsTab } from "../lib/contracts";

// 既有外部引用（测试与 App）从本模块导入这些分区组件，拆分后保持再导出
export {
  PricingSection,
  ProviderProfilesSection,
  ServerSettingsFields,
  ModelAccessSection,
  SystemStorageSection,
  ModelCatalogSection,
  ShortcutsSection,
  RemoteAccessSection,
  ServerInfoSection,
};
export { ExtensionRow } from "./settings/ExtensionsSection";

interface SettingsTabMeta {
  id: SettingsTab;
  zh: string;
  en: string;
  descriptionZh: string;
  descriptionEn: string;
  icon: IconName;
}

const SETTINGS_GROUPS: Array<{ id: string; zh: string; en: string; tabs: SettingsTabMeta[] }> = [
  {
    id: "preferences",
    zh: "个人偏好",
    en: "Preferences",
    tabs: [
      { id: "appearance", zh: "外观", en: "Appearance", descriptionZh: "语言、主题与界面强调色", descriptionEn: "Language, theme, and interface accent", icon: "sun" },
      { id: "general", zh: "通用", en: "General", descriptionZh: "输入方式、模型语言货币与工作区布局", descriptionEn: "Input behavior, model language & currency, and workspace layout", icon: "settings" },
      { id: "defaults", zh: "会话默认", en: "Session defaults", descriptionZh: "新会话的模型与运行参数", descriptionEn: "Model and runtime defaults for new sessions", icon: "history" },
      { id: "shortcuts", zh: "快捷键", en: "Shortcuts", descriptionZh: "查看可用的键盘操作", descriptionEn: "Browse available keyboard actions", icon: "terminal" },
    ],
  },
  {
    id: "ai-services",
    zh: "AI 与服务",
    en: "AI & services",
    tabs: [
      { id: "models", zh: "模型目录", en: "Models", descriptionZh: "服务商、模型接入与可用模型能力", descriptionEn: "Providers, model access, and model capabilities", icon: "layers" },
      { id: "pricing", zh: "模型定价", en: "Pricing", descriptionZh: "管理 token 价格、计费币种与汇率", descriptionEn: "Manage token prices, billing currencies, and exchange rates", icon: "chart" },
      { id: "prompt", zh: "提示词", en: "Prompt", descriptionZh: "覆盖系统提示词基线与追加自定义指令", descriptionEn: "Override the system prompt baseline and append custom instructions", icon: "wrench" },
    ],
  },
  {
    id: "capabilities",
    zh: "能力与连接",
    en: "Capabilities",
    tabs: [
      { id: "skills", zh: "技能", en: "Skills", descriptionZh: "查看内置与工作区技能", descriptionEn: "Browse built-in and workspace skills", icon: "check" },
      { id: "extensions", zh: "扩展", en: "Extensions", descriptionZh: "安装、启用与配置扩展", descriptionEn: "Install, enable, and configure extensions", icon: "plus" },
      { id: "remote", zh: "远程访问", en: "Remote access", descriptionZh: "检查网络暴露与访问安全", descriptionEn: "Review network exposure and access security", icon: "shield" },
    ],
  },
  {
    id: "system",
    zh: "系统",
    en: "System",
    tabs: [
      { id: "info", zh: "服务信息", en: "Server info", descriptionZh: "运行状态、版本、执行器与存储", descriptionEn: "Runtime status, version, executor, and storage", icon: "alert" },
    ],
  },
];

const TAB_META = SETTINGS_GROUPS.flatMap((group) => group.tabs);

export function SettingsDialog({ open, initialTab, initialTabAt, preference, setPreference, accent, setAccent, sendKey, setSendKey, desktopNotify, setDesktopNotify, defaults, setDefaults, providers, models, onResetLayout, onClose }: {
  open: boolean;
  /** 深链入口：打开时定位到指定页签；不传则保持上次使用的页签 */
  initialTab?: SettingsTab;
  /** 深链触发序号：同一页签重复深链时随每次调用变化，强制重新定位 */
  initialTabAt?: number;
  preference: ThemePreference;
  setPreference(value: ThemePreference): void;
  accent: AccentPreference;
  setAccent(value: AccentPreference): void;
  sendKey: SendKey;
  setSendKey(value: SendKey): void;
  desktopNotify: boolean;
  setDesktopNotify(value: boolean): void;
  defaults: SessionDefaults;
  setDefaults(value: SessionDefaults): void;
  providers: string[];
  models: ModelProfile[];
  onResetLayout(): void;
  onClose(): void;
}): ReactElement | null {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<SettingsTab>("appearance");
  // 左侧导航搜索：匹配页签标题/描述、分组名与服务设置字段标签（中英文）
  const [navQuery, setNavQuery] = useState("");
  // 字段标签在打开时经 api.settings 拉取（不经 react-query，i18n 等无 Provider 的渲染也能工作）；失败按无字段匹配处理
  // tab：按 SETTING_GROUP_TAB 归属到各页签（模型目录/通用/模型定价/服务信息/远程访问）
  const [fieldLabels, setFieldLabels] = useState<Array<{ key: string; label: string; tab: SettingsTab }>>([]);
  // 服务设置/定价 JSON/提示词的未保存改动由各页签内的分区组件上报
  const serverDirtyRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    // 每次打开从干净状态开始（关闭时未保存改动已随分区组件卸载丢弃）
    serverDirtyRef.current = false;
    let cancelled = false;
    api.settings()
      .then((view) => {
        if (!cancelled) setFieldLabels(view.groups
          // 未识别分组没有对应渲染页签，不进搜索结果（否则命中后无处可跳）
          .filter((group) => SETTING_GROUP_TAB[group.id] !== undefined)
          .flatMap((group) => group.fields.map((field) => ({
            key: field.key,
            label: field.label,
            tab: SETTING_GROUP_TAB[group.id]!,
          }))));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // 深链：带 initialTab 打开时定位到对应页签；initialTabAt 变化表示同一页签被重复深链，重新定位
  useEffect(() => {
    if (open && initialTab) setActiveTab(initialTab);
    if (open) setNavQuery("");
  }, [open, initialTab, initialTabAt]);

  if (!open) return null;

  const query = navQuery.trim().toLowerCase();
  // 字段标签命中（中英文）：按字段所在分组归属到对应页签
  const fieldHit = (tabId: SettingsTab): boolean => query !== "" && fieldLabels
    .some((field) => field.tab === tabId &&
      (field.label.toLowerCase().includes(query) || (SETTINGS_FIELD_EN[field.key]?.label ?? "").toLowerCase().includes(query)));
  const tabMatches = (tab: SettingsTabMeta, group: { zh: string; en: string }): boolean => {
    if (!query) return true;
    if (tab.zh.toLowerCase().includes(query) || tab.en.toLowerCase().includes(query)) return true;
    if (tab.descriptionZh.toLowerCase().includes(query) || tab.descriptionEn.toLowerCase().includes(query)) return true;
    if (group.zh.toLowerCase().includes(query) || group.en.toLowerCase().includes(query)) return true;
    // 服务设置字段按分组挂在各自页签下（模型目录/通用/模型定价/服务信息/远程访问）
    if (fieldHit(tab.id)) return true;
    return false;
  };
  const visibleGroups = SETTINGS_GROUPS
    .map((group) => ({ group, tabs: group.tabs.filter((tab) => tabMatches(tab, group)) }))
    .filter((entry) => entry.tabs.length > 0);

  // 放弃未保存改动前的统一确认（服务设置 / 定价 JSON / 提示词）
  const confirmDiscard = (): boolean =>
    !serverDirtyRef.current || window.confirm(t("有未保存的更改，确定放弃？", "There are unsaved changes. Discard them?"));

  // 统一关闭入口：有未保存改动时先确认
  const requestClose = (): void => {
    if (!confirmDiscard()) return;
    dialogRef.current?.close();
  };

  const selectTab = (tab: SettingsTab): void => {
    // 切换页签会卸载当前分区（key 重挂载），有未保存改动时先确认
    if (tab !== activeTab && !confirmDiscard()) return;
    setActiveTab(tab);
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    contentRef.current?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  };

  const activeMeta = TAB_META.find((tab) => tab.id === activeTab) ?? TAB_META[0];

  return (
    <dialog
      ref={dialogRef}
      className="session-dialog settings-dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) requestClose();
      }}
    >
      <div className="settings-body">
        <header className="settings-dialog-header">
          <div className="settings-dialog-title">
            <span className="settings-title-icon"><Icon name="settings" size={18} /></span>
            <div>
              <h2>{t("设置", "Settings")}</h2>
              <p>{t("个性化 OpenWebCode，并管理模型与服务", "Personalize OpenWebCode and manage models and services")}</p>
            </div>
          </div>
          <button className="icon-btn settings-close" aria-label={t("关闭", "Close")} title={t("关闭", "Close")} onClick={requestClose}>
            <Icon name="x" size={16} />
          </button>
        </header>
        <div className="settings-layout">
          <nav className="settings-nav" aria-label={t("设置分类", "Settings categories")}>
            <span className="settings-search-wrap">
              <Icon name="search" size={13} />
              <input
                className="settings-search"
                value={navQuery}
                onChange={(event) => setNavQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setNavQuery("");
                }}
                placeholder={t("搜索设置", "Search settings")}
                aria-label={t("搜索设置", "Search settings")}
              />
            </span>
            {visibleGroups.map(({ group, tabs }) => (
              <div className="settings-nav-group" key={group.id}>
                <span className="settings-nav-label">{t(group.zh, group.en)}</span>
                {tabs.map((tab) => (
                  <button
                    key={tab.id}
                    type="button"
                    data-settings-tab={tab.id}
                    className={`settings-tab${activeTab === tab.id ? " active" : ""}`}
                    aria-current={activeTab === tab.id ? "page" : undefined}
                    onClick={() => selectTab(tab.id)}
                    onKeyDown={(event) => {
                      if (!["ArrowDown", "ArrowUp", "ArrowRight", "ArrowLeft"].includes(event.key)) return;
                      event.preventDefault();
                      const index = TAB_META.findIndex((item) => item.id === tab.id);
                      const offset = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1;
                      const next = TAB_META[(index + offset + TAB_META.length) % TAB_META.length];
                      selectTab(next.id);
                      dialogRef.current?.querySelector<HTMLElement>(`[data-settings-tab="${next.id}"]`)?.focus();
                    }}
                  >
                    <Icon name={tab.icon} size={15} />
                    <span>{t(tab.zh, tab.en)}</span>
                  </button>
                ))}
              </div>
            ))}
            {query && visibleGroups.length === 0 && <p className="settings-nav-empty">{t("无匹配", "No matches")}</p>}
          </nav>
          <main className="settings-content">
            <header className="settings-content-header">
              <span className="settings-section-icon"><Icon name={activeMeta.icon} size={18} /></span>
              <div>
                <h3 id="settings-section-title">{t(activeMeta.zh, activeMeta.en)}</h3>
                <p>{t(activeMeta.descriptionZh, activeMeta.descriptionEn)}</p>
              </div>
            </header>
            <div ref={contentRef} className="settings-panel" key={activeTab} aria-labelledby="settings-section-title">
          {activeTab === "appearance" && (
            <section>
              <AppearanceSection preference={preference} setPreference={setPreference} accent={accent} setAccent={setAccent} />
            </section>
          )}
          {activeTab === "general" && (
            <section>
              <GeneralSection sendKey={sendKey} setSendKey={setSendKey} desktopNotify={desktopNotify} setDesktopNotify={setDesktopNotify} onResetLayout={onResetLayout} onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
            </section>
          )}
          {activeTab === "defaults" && (
            <section>
              <h3>{t("会话默认", "Session defaults")}</h3>
              <p className="settings-note">{t("新建会话时预填的取值，可在对话框中再改。", "These values prefill the new-session dialog and can still be changed there.")}</p>
              <DefaultsSection defaults={defaults} setDefaults={setDefaults} providers={providers} models={models} />
            </section>
          )}
          {activeTab === "shortcuts" && (
            <section>
              <h3>{t("键盘快捷方式", "Keyboard Shortcuts")}</h3>
              <ShortcutsSection />
            </section>
          )}
          {activeTab === "remote" && (
            <section>
              <h3>{t("远程访问", "Remote access")}</h3>
              <RemoteAccessSection onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
            </section>
          )}
          {activeTab === "models" && (
            <section>
              <h3>{t("模型目录", "Model catalog")}</h3>
              <ProviderProfilesSection />
              <ModelAccessSection onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
              <ModelCatalogSection />
            </section>
          )}
          {activeTab === "skills" && (
            <section>
              <h3>{t("技能", "Skills")}</h3>
              <SkillsSection />
            </section>
          )}
          {activeTab === "extensions" && (
            <section>
              <h3>{t("扩展管理", "Extension management")}</h3>
              <ExtensionsSection />
            </section>
          )}
          {activeTab === "pricing" && (
            <section>
              <h3>{t("模型定价", "Model pricing")}</h3>
              <PricingSection onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
              <h3>{t("汇率", "Exchange rate")}</h3>
              <ServerSettingsFields
                showGroup={(groupId) => groupId === "exchangeRate"}
                onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }}
              />
            </section>
          )}
          {activeTab === "prompt" && (
            <section>
              <h3>{t("提示词", "System prompt")}</h3>
              <PromptSection onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
            </section>
          )}
          {activeTab === "info" && (
            <section>
              <h3>{t("服务信息", "Server information")}</h3>
              <ServerInfoSection providers={providers} models={models} />
              <h3>{t("系统与存储", "System and storage")}</h3>
              <SystemStorageSection onDirtyChange={(dirty) => { serverDirtyRef.current = dirty; }} />
            </section>
          )}
            </div>
            <div className="dialog-actions settings-actions">
              <button className="btn" onClick={requestClose}>{t("完成", "Done")}</button>
            </div>
          </main>
        </div>
      </div>
    </dialog>
  );
}
