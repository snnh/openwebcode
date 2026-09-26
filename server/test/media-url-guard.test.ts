import { describe, expect, it } from "vitest";
import { fetchChatImage } from "../src/chat/chat-media.js";
import { requireReleaseVersion } from "../src/update-checker.js";

/** SSRF / 注入网关回归：模型可控图源 URL 与 release tag 派生的版本号。 */

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const imageResponse = (): Response => new Response(png, { headers: { "content-type": "image/png" } });
const lookupOf = (address: string) => async () => [{ address, family: 4 }];

describe("chat 图源 SSRF 网关", () => {
  it("域名解析到回环/内网时拒绝，且不发请求", async () => {
    let called = false;
    const fetchImpl = (async () => { called = true; return imageResponse(); }) as typeof fetch;
    await expect(fetchChatImage("https://cdn.example.com/a.png", { fetchImpl, lookupImpl: lookupOf("127.0.0.1") }))
      .rejects.toThrow(/Local or private network/);
    expect(called).toBe(false);
  });

  it("公网域名取回图片并按 base64 返回", async () => {
    const fetchImpl = (async () => imageResponse()) as typeof fetch;
    const result = await fetchChatImage("https://cdn.example.com/a.png", { fetchImpl, lookupImpl: lookupOf("93.184.216.34") });
    expect(result).toEqual({ data: Buffer.from(png).toString("base64"), mediaType: "image/png" });
  });

  it("重定向目标逐跳复验 DNS", async () => {
    const fetchImpl = (async (url: URL | string) => {
      const href = String(url);
      return href.includes("example.com") ? new Response(null, { status: 302, headers: { location: "https://evil.test/a.png" } }) : imageResponse();
    }) as typeof fetch;
    const lookupImpl = async (hostname: string) => [{ address: hostname === "evil.test" ? "10.0.0.5" : "93.184.216.34", family: 4 }];
    await expect(fetchChatImage("https://cdn.example.com/a.png", { fetchImpl, lookupImpl }))
      .rejects.toThrow(/Local or private network/);
  });
});

describe("更新版本号白名单", () => {
  it("接受 semver 形状（含预发布）", () => {
    expect(requireReleaseVersion("v1.12.0")).toBe("1.12.0");
    expect(requireReleaseVersion("1.12.0-beta.2")).toBe("1.12.0-beta.2");
  });

  it("拒绝路径穿越与命令注入载荷", () => {
    for (const bad of ["../../evil", '1.2.3"; rm -rf /', "1.2.3/../x", "latest", ""]) {
      expect(() => requireReleaseVersion(bad)).toThrow(/不合法/);
    }
  });
});
