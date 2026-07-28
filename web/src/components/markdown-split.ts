/**
 * 将 markdown 文本按空行切分为块，供流式增量渲染：
 * 除最后一块（tail，可能仍在增长）外均为稳定块——后续文本追加不会改变它们，
 * 配合 memo 后稳定块整个流式生命周期只解析一次，避免每次提交全量重跑 markdown 管线。
 *
 * 拆分规则：
 * - 空行（可含空白字符）是分块边界；
 * - 围栏代码块（```/~~~，可带语言后缀）内部的空行不拆分；
 * - $$ 数学块（可跨空行）内部的空行不拆分（$$ 按出现次数奇偶切换状态，单行 $$x$$ 不触发）；
 * - 围栏/数学块未闭合时，从起始行起的内容全部归入末尾块；
 * - CRLF/CR 统一归一为 LF。
 * 用 "\n\n" 重新连接所有块可还原输入（连续多个空行折叠为一个，markdown 渲染等价）。
 */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;

export function splitMarkdownBlocks(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let fenceChar = "";
  let fenceLength = 0;
  let inMath = false;

  const flush = (): void => {
    if (current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
  };

  for (const line of lines) {
    if (!inMath) {
      const fence = FENCE_RE.exec(line);
      if (fence) {
        const marker = fence[1]!;
        if (fenceLength === 0) {
          fenceChar = marker[0]!;
          fenceLength = marker.length;
        } else if (marker[0] === fenceChar && marker.length >= fenceLength) {
          // 同字符且长度不小于起始围栏才算闭合；不同字符的围栏行视为块内容
          fenceChar = "";
          fenceLength = 0;
        }
      }
    }
    if (fenceLength === 0) {
      // 代码围栏内的 $$ 不计数
      const dollars = line.match(/\$\$/g);
      if (dollars && dollars.length % 2 === 1) inMath = !inMath;
    }
    if (fenceLength === 0 && !inMath && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}
