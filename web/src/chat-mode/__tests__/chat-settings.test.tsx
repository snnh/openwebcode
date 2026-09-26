// ChatSettings 能力模型：候选过滤、主模型能力驱动的工具开关显隐、未配置 pill、PUT 保存形状。
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSettings } from "../ChatSettings";
const BASE_META = { id: "s1", title: "对话", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", provider: "p1", model: "m-text", enabledTools: [] };
const MODELS = [
  { provider: "p1", models: [{ id: "m-text", modalities: ["text"], imageOutput: false }, { id: "m-vision", modalities: ["text", "image"], imageOutput: false }, { id: "m-gen", modalities: ["text"], imageOutput: true }] },
  { provider: "p2", models: [{ id: "other-vision", modalities: ["image"], imageOutput: false }] },
];
function mockFetch(meta: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (status: number, body?: unknown) => ({ ok: status < 300, status, json: async () => body }) as Response;
    if (url.includes("/api/chat/sessions/")) return reply(200, { ...BASE_META, ...meta });
    if (url.includes("/api/chat/assistants")) return reply(200, []);
    if (url.includes("/api/chat/models")) return reply(200, MODELS);
    if (url.includes("/api/chat/config")) return init?.method === "PUT" ? reply(200, JSON.parse(String(init.body))) : reply(200, config);
    return reply(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const optionTexts = (select: HTMLElement): string[] => Array.from(select.querySelectorAll("option")).map((option) => option.textContent ?? "");
/** 取最近一次 PUT /api/chat/config 调用。 */
function lastPut(fetchMock: ReturnType<typeof vi.fn>): [string, RequestInit] {
  return fetchMock.mock.calls.filter(([input, init]) => String(input).includes("/api/chat/config") && (init as RequestInit | undefined)?.method === "PUT").at(-1) as [string, RequestInit];
}
describe("ChatSettings 能力模型", () => {
  it("vision/image_gen 候选按 modalities 与 imageOutput 过滤；未配置 pill 数量随 config 变化", async () => {
    mockFetch();
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    expect(optionTexts(await view.findByLabelText("vision 模型（图像理解）"))).toEqual(["未配置", "p1/m-vision", "p2/other-vision"]);
    expect(optionTexts(await view.findByLabelText("image_gen 模型（生图）"))).toEqual(["未配置", "p1/m-gen"]);
    await view.findByLabelText("image_gen");
    expect(view.getAllByText("未配置能力模型")).toHaveLength(2);
    cleanup();
    mockFetch({}, { visionModel: { provider: "p1", model: "m-vision" } });
    const configured = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await configured.findByLabelText("vision");
    expect(configured.getAllByText("未配置能力模型")).toHaveLength(1);
  });
  it("主模型已具备某能力时隐藏对应开关", async () => {
    mockFetch({ model: "m-vision" });
    let view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await view.findByLabelText("image_gen"); expect(view.queryByLabelText("vision")).toBeNull();
    cleanup();
    mockFetch({ model: "m-gen" });
    view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await view.findByLabelText("vision"); expect(view.queryByLabelText("image_gen")).toBeNull();
  });
  it("选择后 PUT /api/chat/config（合并已有配置、带凭据）；选回未配置时从提交体删除该字段", async () => {
    const fetchMock = mockFetch({}, { defaultProvider: "p1", imageGenModel: { provider: "p1", model: "m-gen" } });
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    fireEvent.change(await view.findByLabelText("vision 模型（图像理解）"), { target: { value: "p2/other-vision" } });
    await waitFor(() => expect(JSON.parse(String(lastPut(fetchMock)[1].body))).toMatchObject({ visionModel: { provider: "p2", model: "other-vision" }, defaultProvider: "p1" }));
    expect(lastPut(fetchMock)[1].credentials).toBe("include");
    fireEvent.change(view.getByLabelText("image_gen 模型（生图）"), { target: { value: "" } });
    await waitFor(() => expect("imageGenModel" in (JSON.parse(String(lastPut(fetchMock)[1].body)) as Record<string, unknown>)).toBe(false));
  });
});
