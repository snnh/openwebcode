import { StrictMode, lazy, Suspense, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "./app/App";
import { useRoute } from "./app/router";
import { AuthGate } from "./components/AuthGate";
import { LoadingFallback } from "./components/LoadingFallback";
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
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      // 未订阅缓存的驻留收紧到 2 分钟（默认 5）：会话详情（消息数组）与上下文视图
      // （账本+压缩历史）是大 payload，切走后尽快释放；staleTime 为 0，重挂载本就会
      // refetch，行为语义不变
      gcTime: 2 * 60_000,
    },
  },
});

// share 路由独立 chunk：只读分享页不占主入口体积
const ShareView = lazy(() => import("./chat-mode/ShareView").then((m) => ({ default: m.ShareView })));

function Root(): ReactElement {
  const route = useRoute();
  if (route.name === "share") {
    // share 路由公开访问，绕过 AuthGate；ShareView 用 useI18n 故同样需要 I18nProvider
    return (
      <I18nProvider>
        <Suspense fallback={<LoadingFallback />}>
          <ShareView shareId={route.shareId} slug={route.slug} />
        </Suspense>
      </I18nProvider>
    );
  }
  return (
    <I18nProvider><AuthGate><App /></AuthGate></I18nProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode><QueryClientProvider client={queryClient}><Root /></QueryClientProvider></StrictMode>,
);
