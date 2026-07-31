import { describe, expect, it } from "vitest";
import { groupContentBlocks } from "../lib/content-groups";
import type { MessageContent } from "../lib/contracts";

const text = (value: string): MessageContent => ({ type: "text", text: value });
const thinking = (value: string): MessageContent => ({ type: "thinking", text: value });
const call = (id: string, name = "read_file"): MessageContent => ({ type: "tool_call", id, name, input: { path: `${id}.ts` } });
const result = (callId: string): MessageContent => ({ type: "tool_result", toolCallId: callId, content: "ok" });

describe("groupContentBlocks", () => {
  it("相邻 ≥2 个调用（含配对结果）合并为一组", () => {
    const groups = groupContentBlocks([call("c1"), result("c1"), call("c2"), result("c2")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("tool-group");
    if (groups[0]?.kind === "tool-group") {
      expect(groups[0].blocks.map((block) => block.type)).toEqual(["tool_call", "tool_result", "tool_call", "tool_result"]);
    }
  });

  it("单个孤立调用不合组，按原位单块渲染", () => {
    const blocks = [text("前"), call("c1"), result("c1"), text("后")];
    const groups = groupContentBlocks(blocks);
    expect(groups.map((group) => group.kind)).toEqual(["single", "single", "single", "single"]);
  });

  it("text/thinking 打断相邻性：两侧各不足 2 个调用时均不合组", () => {
    const blocks = [call("c1"), thinking("想一下"), call("c2")];
    const groups = groupContentBlocks(blocks);
    expect(groups.map((group) => group.kind)).toEqual(["single", "single", "single"]);
  });

  it("thinking/text 原位保留在组间", () => {
    const blocks = [text("开头"), call("c1"), call("c2"), thinking("再想"), call("c3"), call("c4"), text("结尾")];
    const groups = groupContentBlocks(blocks);
    expect(groups.map((group) => group.kind)).toEqual(["single", "tool-group", "single", "tool-group", "single"]);
    if (groups[1]?.kind === "tool-group") expect(groups[1].blocks).toHaveLength(2);
    if (groups[3]?.kind === "tool-group") expect(groups[3].blocks).toHaveLength(2);
  });

  it("spawn_task/spawn_swarm 调用不进组且打断相邻性", () => {
    const blocks = [call("c1"), call("c2", "spawn_task"), call("c3")];
    const groups = groupContentBlocks(blocks);
    expect(groups.map((group) => group.kind)).toEqual(["single", "single", "single"]);
  });

  it("携带子代理转录的 spawn 结果不进组且打断相邻性", () => {
    const spawnResult: MessageContent = { type: "tool_result", toolCallId: "c2", content: "结论", subagentTaskIds: ["task-1"] };
    const blocks = [call("c1"), call("c2", "spawn_task"), spawnResult, call("c3")];
    const groups = groupContentBlocks(blocks);
    expect(groups.map((group) => group.kind)).toEqual(["single", "single", "single", "single"]);
  });

  it("调用与配对结果归属同一组；无结果的调用也可合组", () => {
    const groups = groupContentBlocks([call("c1"), call("c2"), result("c1"), result("c2")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.kind).toBe("tool-group");
  });

  it("纯结果序列（0 个调用）不合组", () => {
    const groups = groupContentBlocks([result("c1"), result("c2")]);
    expect(groups.map((group) => group.kind)).toEqual(["single", "single"]);
  });

  it("image 块打断相邻性", () => {
    const image: MessageContent = { type: "image", mediaType: "image/png", data: "base64" };
    const groups = groupContentBlocks([call("c1"), image, call("c2")]);
    expect(groups.map((group) => group.kind)).toEqual(["single", "single", "single"]);
  });
});
