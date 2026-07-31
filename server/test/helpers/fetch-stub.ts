export type FetchRoute = { match: string | RegExp; body: unknown; status?: number };

/**
 * 路由表 fetch mock：按 url 前缀（string）或正则（RegExp）匹配，命中返回 JSON body；
 * 未命中返回 404。seen 传入时记录每个请求 url。
 */
export function fetchStub(routes: FetchRoute[], seen?: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen?.push(url);
    for (const route of routes) {
      const hit = typeof route.match === "string" ? url.startsWith(route.match) : route.match.test(url);
      if (hit) {
        return new Response(JSON.stringify(route.body), { status: route.status ?? 200, headers: { "content-type": "application/json" } });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}
