import { useEffect, useRef, useState, type ReactElement } from "react";
import { AnimatePresence, m } from "motion/react";
import { useMotionPreference } from "../../lib/motion-pref";
import { useI18n } from "../../i18n";

type Scene = "popover" | "message" | "tool" | "micro";

const SCENES: Array<{ id: Scene; zh: string; en: string }> = [
  { id: "popover", zh: "弹层", en: "Overlay" },
  { id: "message", zh: "消息", en: "Message" },
  { id: "tool", zh: "工具轨道", en: "Tool row" },
  { id: "micro", zh: "微交互", en: "Micro" },
];

/**
 * 动画模式预览：单幕循环，四幕可切换。
 * 标准模式按 --dur-3 演示；精简模式 duration=0（即时切变），真实反映降级效果。
 * 默认不循环，切模式/切幕时自动重播一次。
 */
export function MotionPreview(): ReactElement {
  const { t } = useI18n();
  const { reduced } = useMotionPreference();
  const [scene, setScene] = useState<Scene>("popover");
  const [loop, setLoop] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [playing, setPlaying] = useState(true);
  const timer = useRef<number | undefined>(undefined);

  const dur = reduced ? 0 : 0.24;

  const replay = (): void => {
    setNonce((value) => value + 1);
  };

  // 切幕 / 切模式：重播当前幕一次
  useEffect(() => {
    setPlaying(true);
    setNonce((value) => value + 1);
  }, [scene, reduced]);

  // 循环：每 2.2s 重播（仅播放态）
  useEffect(() => {
    if (!loop) return undefined;
    timer.current = window.setInterval(() => setNonce((value) => value + 1), 2200);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [loop]);

  return (
    <div className="motion-preview">
      <div className="motion-preview-bar">
        <div className="motion-preview-scenes" role="tablist" aria-label={t("预览场景", "Preview scene")}>
          {SCENES.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={scene === item.id}
              className={`motion-scene${scene === item.id ? " active" : ""}`}
              onClick={() => setScene(item.id)}
            >
              {t(item.zh, item.en)}
            </button>
          ))}
        </div>
        <div className="motion-preview-actions">
          <label className="motion-loop">
            <input type="checkbox" checked={loop} onChange={(event) => setLoop(event.target.checked)} />
            {t("循环", "Loop")}
          </label>
          <button type="button" className="btn small" onClick={() => { setPlaying(true); replay(); }}>
            {t("播放", "Play")}
          </button>
        </div>
      </div>
      <div className="motion-preview-stage" aria-live="polite">
        {playing && (
          <SceneStage key={`${scene}-${nonce}`} scene={scene} dur={dur} reduced={reduced} />
        )}
      </div>
      <p className="motion-preview-note">
        {reduced
          ? t("精简模式：过渡即时完成，仅保留颜色与状态变化。", "Reduced: transitions complete instantly; only color and state changes remain.")
          : t("标准模式：使用统一的时长与缓动曲线。", "Standard: unified duration and easing curves.")}
      </p>
    </div>
  );
}

function SceneStage({ scene, dur, reduced }: { scene: Scene; dur: number; reduced: boolean }): ReactElement {
  if (scene === "popover") return <PopoverScene dur={dur} />;
  if (scene === "message") return <MessageScene dur={dur} reduced={reduced} />;
  if (scene === "tool") return <ToolScene dur={dur} />;
  return <MicroScene dur={dur} reduced={reduced} />;
}

function PopoverScene({ dur }: { dur: number }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    const close = window.setTimeout(() => setOpen(false), 1300);
    return () => window.clearTimeout(close);
  }, []);
  return (
    <div className="scene-popover">
      <button type="button" className="btn" onClick={() => setOpen((value) => !value)}>
        {t("切换弹层", "Toggle overlay")}
      </button>
      <AnimatePresence>
        {open && (
          <m.div
            className="scene-popover-panel"
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: dur, ease: [0.2, 0, 0, 1] }}
          >
            <strong>{t("弹层标题", "Overlay title")}</strong>
            <span>{t("240ms 进入 / 160ms 退出", "240ms in / 160ms out")}</span>
          </m.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function MessageScene({ dur, reduced }: { dur: number; reduced: boolean }): ReactElement {
  const { t } = useI18n();
  return (
    <div className="scene-messages">
      <m.div
        className="scene-bubble user"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: dur, ease: [0, 0, 0.2, 1] }}
      >
        {t("帮我优化一下界面", "Polish the interface")}
      </m.div>
      <m.div
        className="scene-bubble assistant"
        initial={reduced ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: dur, delay: reduced ? 0 : 0.12, ease: [0, 0, 0.2, 1] }}
      >
        {t("正在应用新的 token 与动效。", "Applying the new tokens and motion.")}
      </m.div>
    </div>
  );
}

function ToolScene({ dur }: { dur: number }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(() => setOpen(true), 250);
    return () => window.clearTimeout(id);
  }, []);
  return (
    <div className="scene-tool">
      <button type="button" className="scene-tool-row" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <span className="scene-tool-dot" />
        <b>bash</b>
        <span className="scene-tool-summary mono">npm run build</span>
        <span className="scene-tool-meta mono">exit 0 · 15s</span>
      </button>
      <m.div
        className="scene-tool-body"
        initial={false}
        animate={{ height: open ? 96 : 0, opacity: open ? 1 : 0 }}
        transition={{ duration: dur, ease: [0.2, 0, 0, 1] }}
      >
        <pre className="mono">{t("构建完成：134 个文件，入口 278KB。", "Build complete: 134 files, 278KB entry.")}</pre>
      </m.div>
    </div>
  );
}

function MicroScene({ dur, reduced }: { dur: number; reduced: boolean }): ReactElement {
  const { t } = useI18n();
  const [on, setOn] = useState(false);
  const [pressed, setPressed] = useState(false);
  useEffect(() => {
    const onTimer = window.setTimeout(() => { setOn(true); setPressed(true); }, 300);
    // 按下态只演示一小段，不然后续一直停在 scale(0.96)。
    const releaseTimer = window.setTimeout(() => setPressed(false), 520);
    return () => { window.clearTimeout(onTimer); window.clearTimeout(releaseTimer); };
  }, []);
  return (
    <div className="scene-micro">
      <m.button
        type="button"
        className="btn small"
        animate={{ scale: pressed && !reduced ? 0.96 : 1 }}
        transition={{ duration: dur }}
        onClick={() => { setPressed(false); setOn((value) => !value); }}
      >
        {t("悬停与按下", "Hover & press")}
      </m.button>
      <button type="button" className={`scene-switch${on ? " on" : ""}`} role="switch" aria-checked={on} onClick={() => setOn((value) => !value)}>
        <span />
      </button>
      <span className="scene-micro-label">{on ? t("已开启", "On") : t("已关闭", "Off")}</span>
    </div>
  );
}
