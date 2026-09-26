import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAttachments, useComposerSendable, useDraft, type PendingImage } from "../composer/drafts";
// 「可发送」判定：草稿非空 **或** 有待发附件（纯图片消息无文字也可发送）。
const IMAGE: PendingImage = { mediaType: "image/png", data: "aGVsbG8=", previewUrl: "blob:test" };
let sessionCounter = 0;
function Probe({ sessionId }: { sessionId: string }) {
  const sendable = useComposerSendable(sessionId);
  const [attachments, setAttachments] = useAttachments(sessionId);
  const [, setDraft] = useDraft(sessionId);
  return (
    <div>
      <output data-testid="sendable">{sendable ? "yes" : "no"}</output><output data-testid="attachment-count">{String(attachments.length)}</output>
      <button type="button" onClick={() => setAttachments([IMAGE])}>attach</button><button type="button" onClick={() => setAttachments([])}>clear-attachments</button>
      <button type="button" onClick={() => setDraft("写点东西")}>type</button><button type="button" onClick={() => setDraft("   ")}>type-blank</button>
      <button type="button" onClick={() => setDraft("")}>clear-draft</button>
    </div>
  );
}
afterEach(() => { window.sessionStorage.clear(); });
describe("useComposerSendable", () => {
  it("空草稿 + 无附件不可发送；草稿非空或只有附件即可发送；纯空白草稿不算但空白草稿 + 附件仍可发送", () => {
    render(<Probe sessionId={`sendable-session-${(sessionCounter += 1)}`} />);
    const sendable = screen.getByTestId("sendable");
    expect(sendable).toHaveTextContent("no");
    fireEvent.click(screen.getByText("attach"));
    expect(screen.getByTestId("attachment-count")).toHaveTextContent("1"); expect(sendable).toHaveTextContent("yes");
    fireEvent.click(screen.getByText("clear-attachments")); expect(sendable).toHaveTextContent("no");
    fireEvent.click(screen.getByText("type")); expect(sendable).toHaveTextContent("yes");
    fireEvent.click(screen.getByText("clear-draft")); expect(sendable).toHaveTextContent("no");
    fireEvent.click(screen.getByText("type-blank")); expect(sendable).toHaveTextContent("no");
    fireEvent.click(screen.getByText("attach")); expect(sendable).toHaveTextContent("yes");
  });
});
