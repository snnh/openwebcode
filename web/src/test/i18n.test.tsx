import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { I18nProvider, useI18n } from "../i18n";
import { EmptyState } from "../components/EmptyState";
import { SettingsDialog } from "../components/SettingsDialog";
import { renderWithClient } from "./helpers/with-client";

function Fixture() {
  const { language, setLanguage, t } = useI18n();
  return (
    <div>
      <span>{t("设置", "Settings")}</span>
      <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")}>switch</button>
    </div>
  );
}

describe("interface localization", () => {
  beforeEach(() => {
    window.localStorage.clear();
    HTMLElement.prototype.scrollTo = () => undefined;
  });

  it("loads a saved English preference and updates the document language", async () => {
    window.localStorage.setItem("owc-language", "en");
    render(<I18nProvider><Fixture /></I18nProvider>);

    expect(screen.getByText("Settings")).toBeInTheDocument();
    expect(document.documentElement.lang).toBe("en");

    fireEvent.click(screen.getByRole("button", { name: "switch" }));
    expect(screen.getByText("设置")).toBeInTheDocument();
    expect(window.localStorage.getItem("owc-language")).toBe("zh-CN");
  });

  it("renders product UI in English", () => {
    window.localStorage.setItem("owc-language", "en");
    render(<I18nProvider><EmptyState sessions={[]} onSelect={() => undefined} onCreate={() => undefined} /></I18nProvider>);

    expect(screen.getByRole("heading", { name: "Start a reversible coding job" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New session" })).toBeInTheDocument();
    expect(document.title).toBe("OpenWebCode · Coding Console");
  });

  it("switches languages from the settings UI and persists the choice", () => {
    window.localStorage.setItem("owc-language", "zh-CN");
    renderWithClient(
      <I18nProvider>
        <SettingsDialog
          open
          preference="system"
          setPreference={() => undefined}
          accent="teal"
          setAccent={() => undefined}
          sendKey="enter"
          setSendKey={() => undefined}
          desktopNotify={false}
          setDesktopNotify={() => undefined}
          defaults={{}}
          setDefaults={() => undefined}
          providers={[]}
          models={[]}
          onResetLayout={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    fireEvent.change(screen.getByLabelText("界面语言"), { target: { value: "en" } });
    expect(screen.getByRole("heading", { name: "Settings" })).toBeInTheDocument();
    expect(screen.getByLabelText("Interface language")).toHaveValue("en");
    expect(screen.getByText("Preferences")).toBeInTheDocument();
    expect(screen.getByText("AI & services")).toBeInTheDocument();

    fireEvent.keyDown(screen.getByRole("button", { name: "Appearance" }), { key: "ArrowDown" });
    expect(screen.getByRole("button", { name: "General" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("heading", { name: "General" })).toBeInTheDocument();
    expect(window.localStorage.getItem("owc-language")).toBe("en");
  });
});
