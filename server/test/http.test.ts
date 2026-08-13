import { afterEach, describe, expect, it } from "vitest";
import { fetchJson, withUserAgent } from "../src/http.js";
import { buildUserAgent, getUserAgent, setSimulatedUserAgent } from "../src/user-agent.js";
import { setServerVersion } from "../src/version.js";

afterEach(() => {
  // 恢复到一个稳定的已知状态，避免测试间相互污染
  setServerVersion("0.0.0");
  setSimulatedUserAgent(null);
});

describe("http user-agent", () => {
  it("builds UA in the owc/openwebcode{version} format", () => {
    expect(buildUserAgent("0.5.2")).toBe("owc/openwebcode0.5.2");
    // 同一 UA 契约：getUserAgent 反映已解析的 server 版本（全局态路径）
    setServerVersion("9.9.9");
    expect(getUserAgent()).toBe("owc/openwebcode9.9.9");
  });

  it("withUserAgent merges UA ahead of caller headers", () => {
    setServerVersion("1.2.3");
    const headers = withUserAgent({ Accept: "application/json" });
    expect(headers["User-Agent"]).toBe("owc/openwebcode1.2.3");
    expect(headers.Accept).toBe("application/json");
  });

  it("fetchJson injects the UA header and parses JSON", async () => {
    setServerVersion("2.0.0");
    let seen: HeadersInit | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen = init?.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      const result = await fetchJson("https://example.test/data");
      expect(result).toEqual({ ok: true });
      expect((seen as Record<string, string>)["User-Agent"]).toBe("owc/openwebcode2.0.0");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("fetchJson injects the simulated UA when env-sim simulation is active", async () => {
    setServerVersion("2.0.0");
    setSimulatedUserAgent("kimi-code/1.0.0");
    let seen: HeadersInit | undefined;
    const fetchImpl = async (_url: string, init?: RequestInit): Promise<Response> => {
      seen = init?.headers;
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      await fetchJson("https://example.test/data");
      expect((seen as Record<string, string>)["User-Agent"]).toBe("kimi-code/1.0.0");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("fetchJson throws on non-2xx responses", async () => {
    const fetchImpl = async (): Promise<Response> => new Response("nope", { status: 500, statusText: "Internal Server Error" });
    const original = globalThis.fetch;
    globalThis.fetch = fetchImpl as typeof fetch;
    try {
      await expect(fetchJson("https://example.test/data")).rejects.toThrow(/HTTP 500/);
    } finally {
      globalThis.fetch = original;
    }
  });
});
