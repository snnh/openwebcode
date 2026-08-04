/**
 * 命令面板（Ctrl/Cmd+Shift+P，0.4.0 Phase 5a）：
 * 列出注册表中 when 满足的命令，模糊过滤（中英标题 + 命令 id），
 * 右侧如实展示键位。Enter 执行，Esc 关闭。
 */
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { listCommands, runCommand, type Command, type WhenContext } from "../commands/registry";
import { DEFAULT_KEYBINDINGS, formatCombo, isMacPlatform } from "../commands/keybindings";
import { filterAndRank } from "../lib/fuzzy";
import { useI18n } from "../i18n";
import { Overlay } from "./Overlay";

export function CommandPalette({ open, context, onClose }: {
  open: boolean;
  context: WhenContext;
  onClose(): void;
}): ReactElement | null {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const isMac = useMemo(isMacPlatform, []);

  const keyLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const binding of DEFAULT_KEYBINDINGS) {
      if (!map.has(binding.command)) map.set(binding.command, formatCombo(binding.key, isMac));
    }
    return map;
  }, [isMac]);

  // 打开时重置查询与选中项（聚焦由 Overlay 的 initialFocus 承担）
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const available = useMemo(() => (open ? listCommands(context) : []), [open, context]);
  const filtered = useMemo(
    () => filterAndRank(query, available, (command) => `${command.title.zh} ${command.title.en} ${command.id}`),
    [query, available],
  );

  const execute = (command: Command): void => {
    onClose();
    // 关闭后再执行，避免 handler 打开新对话框时焦点被面板抢占
    queueMicrotask(() => runCommand(command.id, context));
  };

  return (
    <Overlay open={open} label={t("命令面板", "Command Palette")} className="command-palette" initialFocus=".wb-overlay-input" onClose={onClose}>
      <input
        className="wb-overlay-input"
        value={query}
        onChange={(event) => { setQuery(event.target.value); setActive(0); }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, filtered.length - 1)); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
          else if (event.key === "Enter" && filtered[active]) { event.preventDefault(); execute(filtered[active]); }
        }}
        placeholder={t("输入命令名称", "Type a command name")}
        aria-label={t("命令搜索", "Command search")}
        role="combobox"
        aria-expanded="true"
        aria-controls="command-listbox"
        aria-activedescendant={filtered[active] ? `command-option-${active}` : undefined}
      />
      <ul className="wb-overlay-list" id="command-listbox" role="listbox" aria-label={t("命令", "Commands")}>
        {filtered.map((command, index) => (
          <li key={command.id}>
            <button
              id={`command-option-${index}`}
              role="option"
              aria-selected={index === active}
              className={`wb-overlay-item${index === active ? " active" : ""}`}
              onMouseEnter={() => setActive(index)}
              onClick={() => execute(command)}
            >
              <span className="wb-overlay-item-title">{t(command.title.zh, command.title.en)}</span>
              {keyLabels.get(command.id) && <kbd>{keyLabels.get(command.id)}</kbd>}
            </button>
          </li>
        ))}
        {filtered.length === 0 && <li className="muted-empty wb-overlay-empty">{t("无匹配命令", "No matching commands")}</li>}
      </ul>
    </Overlay>
  );
}
