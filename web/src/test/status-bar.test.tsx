import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { StatusBar } from "../components/StatusBar";
import type { SessionDetail } from "../lib/contracts";

const session: SessionDetail = {
  id: "s1", title: "Status test", cwd: "D:/work/demo", provider: "openai", model: "gpt-5", agentMode: "build",
  sandboxMode: "appcontainer", thinking: "adaptive", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", messages: [],
};

describe("StatusBar", () => {
  it("reports current session configuration and an actionable run state", () => {
    render(<I18nProvider><StatusBar session={session} state="waiting_permission" tokens={1234} costLabel="$0.02" /></I18nProvider>);
    expect(screen.getByLabelText("Session status")).toHaveTextContent("D:/work/demo");
    expect(screen.getByLabelText("Session status")).toHaveTextContent("Waiting for approval");
    expect(screen.getByLabelText("Session status")).toHaveTextContent("1,234 tokens");
  });
});
