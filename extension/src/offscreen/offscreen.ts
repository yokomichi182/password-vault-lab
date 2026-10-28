// クリップボードの書き込みと消去。service worker からのメッセージだけに応じる。
function writeClipboard(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;
  const msg = message as { target?: string; type?: string; text?: string } | null;
  if (!msg || msg.target !== "offscreen") return false;
  if (msg.type === "copy" && typeof msg.text === "string") {
    sendResponse({ ok: writeClipboard(msg.text) });
  } else if (msg.type === "clear") {
    // 空文字のコピーは環境によって無視されるため、空白1つで上書きする
    sendResponse({ ok: writeClipboard(" ") });
  }
  return false;
});
