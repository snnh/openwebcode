// ChatSettings 能力模型：models 新结构（{id, modalities, imageOutput}）下的候选过滤、
// 主模型能力驱动的工具开关显隐、未配置 pill、PUT /api/chat/config 保存形状。
import { fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatSettings } from "../ChatSettings";

const BASE_META = {
  id: "s1",
  title: "对话",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  provider: "p1",
  model: "m-text",
  enabledTools: [],
};

const MODELS = [
  {
    provider: "p1",
    models: [
      { id: "m-text", modalities: ["text"], imageOutput: false },
      { id: "m-vision", modalities: ["text", "image"], imageOutput: false },
      { id: "m-gen", modalities: ["text"], imageOutput: true },
    ],
  },
  {
    provider: "p2",
    models: [{ id: "other-vision", modalities: ["image"], imageOutput: false }],
  },
];

interface Fixture {
  meta?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

function mockFetch({ meta, config }: Fixture = {}) {
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const reply = (status: number, body?: unknown) => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as Response;
    if (url.includes("/api/chat/sessions/")) return reply(200, { ...BASE_META, ...(meta ?? {}) });
    if (url.includes("/api/chat/assistants")) return reply(200, []);
    if (url.includes("/api/chat/models")) return reply(200, MODELS);
    if (url.includes("/api/chat/config")) {
      if (init?.method === "PUT") return reply(200, JSON.parse(String(init.body)));
      return reply(200, config ?? {});
    }
    return reply(404, { error: "not found" });
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** 取某下拉的全部选项文本（首个为占位「未配置」）。 */
function optionTexts(select: HTMLElement): string[] {
  return Array.from(select.querySelectorAll("option")).map((option) => option.textContent ?? "");
}

describe("ChatSettings 能力模型", () => {
  it("vision/image_gen 候选按 modalities 与 imageOutput 过滤", async () => {
    mockFetch();
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    const visionSelect = await view.findByLabelText("vision 模型（图像理解）");
    const imageGenSelect = await view.findByLabelText("image_gen 模型（生图）");

    expect(optionTexts(visionSelect)).toEqual(["未配置", "p1/m-vision", "p2/other-vision"]);
    expect(optionTexts(imageGenSelect)).toEqual(["未配置", "p1/m-gen"]);
  });

  it("主模型 modalities 含 image 时隐藏 vision 开关，其余开关保留", async () => {
    mockFetch({ meta: { model: "m-vision" } });
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await view.findByLabelText("image_gen");
    expect(view.queryByLabelText("vision")).toBeNull();
  });

  it("主模型 imageOutput 为 true 时隐藏 image_gen 开关", async () => {
    mockFetch({ meta: { model: "m-gen" } });
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await view.findByLabelText("vision");
    expect(view.queryByLabelText("image_gen")).toBeNull();
  });

  it("主模型无对应能力时两个开关都显示，未配置时挂琥珀色提示", async () => {
    mockFetch();
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await view.findByLabelText("vision");
    await view.findByLabelText("image_gen");
    expect(view.getAllByText("未配置能力模型")).toHaveLength(2);
  });

  it("已配置的侧不再显示未配置提示", async () => {
    mockFetch({ config: { visionModel: { provider: "p1", model: "m-vision" } } });
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    await view.findByLabelText("vision");
    expect(view.getAllByText("未配置能力模型")).toHaveLength(1);
  });

  it("选择后 PUT /api/chat/config（合并已有配置整体提交）", async () => {
    const fetchMock = mockFetch({ config: { defaultProvider: "p1" } });
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    const visionSelect = await view.findByLabelText("vision 模型（图像理解）");

    fireEvent.change(visionSelect, { target: { value: "p2/other-vision" } });
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).includes("/api/chat/config") && (init as RequestInit | undefined)?.method === "PUT");
      expect(putCall).toBeDefined();
      const body = JSON.parse(String((putCall![1] as RequestInit).body)) as Record<string, unknown>;
      expect(body.visionModel).toEqual({ provider: "p2", model: "other-vision" });
      expect(body.defaultProvider).toBe("p1");
      expect((putCall![1] as RequestInit).credentials).toBe("include");
    });
  });

  it("选回未配置时从提交体中删除该字段", async () => {
    const fetchMock = mockFetch({ config: { imageGenModel: { provider: "p1", model: "m-gen" } } });
    const view = render(<ChatSettings sessionId="s1" onClose={() => {}} />);
    const imageGenSelect = await view.findByLabelText("image_gen 模型（生图）");

    fireEvent.change(imageGenSelect, { target: { value: "" } });
    await waitFor(() => {
      const putCall = fetchMock.mock.calls.find(([input, init]) =>
        String(input).includes("/api/chat/config") && (init as RequestInit | undefined)?.method === "PUT");
      expect(putCall).toBeDefined();
      const body = JSON.parse(String((putCall![1] as RequestInit).body)) as Record<string, unknown>;
      expect("imageGenModel" in body).toBe(false);
    });
  });
});
