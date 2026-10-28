import { WAIT_FOR_FORM_MS } from "../shared/constants.ts";
import { isFillableOrigin } from "../shared/match.ts";
import type { CandidateResponse, TabFillResponse, TabRequest, WhoamiResponse } from "../shared/messages.ts";
import { fillFields, findLoginFields } from "./fields.ts";

// コンテンツスクリプトに渡るのは、入力する1件のユーザー名とパスワードだけ。値はログに出さない。
// 最上位のフレームにだけ入る(manifest の all_frames: false)。

const pageOrigin = location.origin;
const fillablePage = isFillableOrigin(pageOrigin);

if (__TEST__) {
  // テスト用: コンテンツスクリプトから chrome.storage.session が読めないことを確かめる。通常のビルドには入らない。
  void (async () => {
    let result = "unknown";
    try {
      await chrome.storage.session.get(null);
      result = "allowed";
    } catch {
      result = "denied";
    }
    document.documentElement.dataset.pwvSessionProbe = result;
  })();
}

if (fillablePage) {
  // popup からの問い合わせと入力(サービスワーカー経由)。自分の拡張からのメッセージだけに応じる。
  chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    const msg = message as TabRequest | null;
    if (!msg) return false;
    if (msg.type === "whoami") {
      const res: WhoamiResponse = { origin: pageOrigin };
      sendResponse(res);
      return false;
    }
    if (msg.type === "fill") {
      // 送り先でもオリジンを確かめ直す(期待したオリジンと、入力してよいページ)
      let ok = false;
      if (msg.expectedOrigin === location.origin && isFillableOrigin(location.origin)) {
        const fields = findLoginFields();
        if (fields) {
          fillFields(fields, String(msg.username), String(msg.password));
          ok = true;
        }
      }
      const res: TabFillResponse = { ok };
      sendResponse(res);
      return false;
    }
    return false;
  });

  startAutofill();
}

/** テスト用: 自動入力の進み具合の目印(値は含まない)。通常のビルドでは何もしない。 */
function mark(state: string): void {
  if (__TEST__) document.documentElement.dataset.pwvAutofill = state;
}

function startAutofill(): void {
  let done = false;
  let observer: MutationObserver | null = null;
  let timer: number | undefined;

  const finish = () => {
    done = true;
    observer?.disconnect();
    observer = null;
    if (timer !== undefined) window.clearTimeout(timer);
  };

  const attempt = async () => {
    if (done) return;
    const fields = findLoginFields();
    if (!fields) return;
    // 欄が見つかったら、1回だけ service worker に「入力の候補をください」とだけ送る(URL や欄の情報は送らない)
    finish();
    mark("asked");
    let res: CandidateResponse | null | undefined;
    try {
      res = (await chrome.runtime.sendMessage({ type: "candidate" })) as CandidateResponse | null;
    } catch {
      mark("declined");
      return;
    }
    if (!res || !res.fill) {
      mark("declined");
      return;
    }
    // 返事を待つ間に欄が変わった場合に備え、探し直してから入れる
    const latest = findLoginFields();
    if (latest) fillFields(latest, res.fill.username, res.fill.password);
    mark("filled");
  };

  mark("watching");
  void attempt();
  if (done) return;

  // 文書の読み込みから 10 秒まで待つ。同じ文書で入力するのは1回だけ。
  const remaining = WAIT_FOR_FORM_MS - performance.now();
  if (remaining <= 0) {
    mark("gave-up");
    return;
  }
  observer = new MutationObserver(() => {
    void attempt();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "class", "hidden", "type", "disabled", "readonly"],
  });
  timer = window.setTimeout(() => {
    if (!done) mark("gave-up");
    finish();
  }, remaining);
}
