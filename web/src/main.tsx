import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { AuthGate } from "./components/AuthGate";
import { I18nProvider } from "./i18n";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/chat-list.css";
import "./styles/chat-cards.css";
import "./styles/composer.css";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><I18nProvider><AuthGate><App /></AuthGate></I18nProvider></QueryClientProvider></StrictMode>,
);
