import { vi } from "vitest";
import type { ContextView, ModelProfile, SessionDetail } from "../../lib/contracts";
import { makeContextView, makeModelProfile, makeSession } from "./fixtures";

export interface AppFetchMockOptions {
  session?: SessionDetail;
  models?: ModelProfile[];
  context?: ContextView;
  /** 自定义路由：在内置路由之前匹配，返回 undefined 表示不接管。 */
  extra?: (url: string, json: (body: unknown, status?: number) => Response) => Response | undefined;
}

/**
 * App 级测试标准 fetch mock：sessions 列表/详情、context、models、providers、
 * sandbox/capabilities、steering、permissions。其余路径 404 { error: "not mocked" }。
 */
export function installAppFetchMock(options: AppFetchMockOptions = {}): void {
  const session = options.session ?? makeSession();
  const models = options.models ?? [makeModelProfile()];
  const context = options.context ?? makeContextView();
  const handler = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    const custom = options.extra?.(url, json);
    if (custom) return custom;
    if (url.endsWith("/api/sessions")) return json([{ id: session.id, cwd: session.cwd, provider: session.provider, model: session.model, title: session.title, createdAt: session.createdAt, updatedAt: session.updatedAt }]);
    if (url.includes(`/api/sessions/${session.id}/context`)) return json(context);
    if (url.endsWith("/api/models")) return json(models);
    if (url.endsWith("/api/providers")) return json([session.provider]);
    if (url.endsWith("/api/sandbox/capabilities")) return json({ platform: "win32", appcontainer: true, jobobject: true, off: true, wsb: { available: false, reason: "测试环境" }, bindLink: { available: false, reason: "测试环境" } });
    if (url.includes(`/api/sessions/${session.id}/steering`)) return json([]);
    if (url.includes(`/api/sessions/${session.id}/permissions`)) return json([]);
    if (url.match(new RegExp(`/api/sessions/${session.id}(\\?.*)?$`))) return json(session);
    return json({ error: "not mocked" }, 404);
  });
  vi.stubGlobal("fetch", handler);
}
