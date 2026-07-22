/**
 * Adapted from `packages/coding-agent/src/core/system-prompt.ts` in
 * https://github.com/earendil-works/pi at
 * dd6bea41efa8caa7a10fe5a6401676dc5699f83f (2026-07-21).
 *
 * Upstream copyright (c) 2025 Mario Zechner. Licensed under MIT.
 * Local changes: replace the Pi product name; remove Pi-repository-specific
 * documentation paths and instructions; dynamic sections live in PromptBuilder.
 */

export const PI_PROMPT_VERSION = "pi@dd6bea41efa8caa7a10fe5a6401676dc5699f83f+owc.1";

/** The fixed Pi default prompt body, with only product-specific wording adapted. */
export const PI_BASE_SYSTEM_PROMPT = [
  "You are an expert coding assistant operating inside OpenWebCode, a coding agent harness.",
  "You help users by reading files, executing commands, editing code, and writing new files.",
  "",
  "In addition to the tools listed below, you may have access to other custom tools depending on the project.",
].join("\n");
