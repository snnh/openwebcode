import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import type { ReactElement } from "react";
import { App } from "../../App";

/** 测试用 QueryClient（关闭重试，queries staleTime Infinity）。 */
export function makeTestClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
}

/** 包一层 QueryClientProvider 渲染任意组件。 */
export function renderWithClient(node: ReactElement, client: QueryClient = makeTestClient()) {
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** 渲染完整 App（App 级集成测试用）。 */
export function renderApp(client: QueryClient = makeTestClient()) {
  return renderWithClient(<App />, client);
}
