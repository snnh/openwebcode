/**
 * Core carries command output as base64 so it can safely transport arbitrary
 * bytes.  Most tools write UTF-8, but Windows console programs frequently use
 * the active ANSI/OEM code page when stdout or stderr is redirected to a pipe.
 * On Chinese Windows that is normally CP936/GBK.  Decode valid UTF-8 first so
 * modern tools are never reinterpreted; only malformed UTF-8 gets the Windows
 * GBK fallback.
 */
export interface EncodedProcessOutput {
  stream: string;
  data: string;
  seq: number;
}

export interface DecodedProcessOutput {
  stream: string;
  data: string;
}

const utf8Strict = new TextDecoder("utf-8", { fatal: true });
const utf8Lossy = new TextDecoder("utf-8");
const gbk = new TextDecoder("gbk");

/** Decode one complete child-process byte sequence without introducing U+FFFD for CP936 output. */
export function decodeChildProcessOutput(bytes: Uint8Array, platform: NodeJS.Platform = process.platform): string {
  try {
    return utf8Strict.decode(bytes);
  } catch {
    return platform === "win32" ? gbk.decode(bytes) : utf8Lossy.decode(bytes);
  }
}

/**
 * Decode ordered core notifications. Adjacent chunks from the same pipe are
 * combined before decoding, which also preserves a UTF-8 or GBK character that
 * happened to be split across pipe reads. Stream transitions stay in order.
 */
export function decodeProcessOutputChunks(
  chunks: readonly EncodedProcessOutput[],
  platform: NodeJS.Platform = process.platform,
): DecodedProcessOutput[] {
  const output: DecodedProcessOutput[] = [];
  let stream: string | undefined;
  let bytes: Buffer[] = [];

  const flush = (): void => {
    if (stream === undefined) return;
    output.push({ stream, data: decodeChildProcessOutput(Buffer.concat(bytes), platform) });
    stream = undefined;
    bytes = [];
  };

  for (const chunk of [...chunks].sort((left, right) => left.seq - right.seq)) {
    if (stream !== undefined && stream !== chunk.stream) flush();
    if (stream === undefined) stream = chunk.stream;
    bytes.push(Buffer.from(chunk.data, "base64"));
  }
  flush();
  return output;
}
