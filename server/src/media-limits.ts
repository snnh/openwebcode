/**
 * 媒体字节上限的单一来源：消息带图（sessions-run）、扩展读图（extension-manager）、
 * read_media 工具（agent-runner）同口径，避免三处字面量漂移。
 */

/** 图片 base64 字符上限（≈5MB 原始字节）。 */
export const MAX_IMAGE_BASE64_CHARS = 7_000_000;

/** 视频原始字节上限：与 core fs.readBase64 的 20 MiB 读取上限一致（超出即 truncated）。 */
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;
