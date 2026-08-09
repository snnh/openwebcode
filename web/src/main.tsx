import { StrictMode, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { useRoute } from "./app/router";
import { ShareView } from "./chat-mode/ShareView";
import { AuthGate } from "./components/AuthGate";
import { I18nProvider } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/chat-list.css";
import "./styles/chat-cards.css";
import "./styles/chat-mode.css";
import "./styles/composer.css";
import "./styles/sidebar.css";
import "./styles/panels.css";
import "./styles/editor.css";
import "./styles/dialogs.css";
import "./styles/settings.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function Root(): ReactElement {
  const route = useRoute();
  if (route.name === "share") {
    // share 路由公开访问，绕过 AuthGate；ShareView 用 useI18n 故同样需要 I18nProvider
    return <I18nProvider><ShareView shareId={route.shareId} slug={route.slug} /></I18nProvider>;
  }
  return (
    <I18nProvider><AuthGate><App /></AuthGate></I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><Root /></QueryClientProvider></StrictMode>,
);
