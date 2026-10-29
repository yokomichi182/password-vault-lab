import type { ApprovalAsk } from "./fill.ts";

// 承認画面(設計書 §11-3、実装指示_フェーズ5 の 3-4)。chrome.windows.create({ type: "popup" }) で拡張のページ approve.html を開く。
// 承認の答えは、その窓のページからだけ受け付ける。窓を閉じたとき、55秒たったときは拒否として扱う。
// ここから先のログにも、項目名・ユーザー名・オリジンを出さない。

export const APPROVAL_TIMEOUT_MS = 55_000;

export interface ApprovalInfo {
  origin: string;
  title: string;
  userHint: string;
  client: string;
}

interface Pending {
  info: ApprovalInfo;
  windowId?: number;
  done: (approved: boolean) => void;
}

const pending = new Map<string, Pending>();

/** 承認画面を出して、本人の答えを待つ。 */
export function askApproval(ask: ApprovalAsk): Promise<boolean> {
  const id = crypto.randomUUID();
  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const entry: Pending = {
      info: { origin: ask.origin, title: ask.title, userHint: ask.userHint, client: ask.client },
      done: (approved) => {
        if (!pending.delete(id)) return;
        if (timer !== undefined) clearTimeout(timer);
        if (entry.windowId !== undefined) void chrome.windows.remove(entry.windowId).catch(() => undefined);
        resolve(approved);
      },
    };
    pending.set(id, entry);
    timer = setTimeout(() => entry.done(false), APPROVAL_TIMEOUT_MS);
    chrome.windows
      .create({ type: "popup", url: chrome.runtime.getURL(`approve.html?id=${id}`), width: 480, height: 460, focused: true })
      .then((w) => {
        if (!w || w.id === undefined) return entry.done(false);
        entry.windowId = w.id;
        if (!pending.has(id)) void chrome.windows.remove(w.id).catch(() => undefined); // 作っている間に答えが出ていた
      })
      .catch(() => entry.done(false));
  });
}

chrome.windows.onRemoved.addListener((windowId) => {
  for (const entry of [...pending.values()]) if (entry.windowId === windowId) entry.done(false); // 窓を閉じたときも拒否
});

/** 承認画面のページが、自分の窓の内容を尋ねる。窓が違う、ID が違うときは null。 */
export function approvalInfo(id: unknown, windowId: number | undefined): ApprovalInfo | null {
  if (typeof id !== "string") return null;
  const e = pending.get(id);
  if (!e || e.windowId === undefined || e.windowId !== windowId) return null;
  return e.info;
}

/** 承認画面のページの答え。その窓のページからだけ受け付ける。 */
export function approvalDecision(id: unknown, approve: unknown, windowId: number | undefined): boolean {
  if (typeof id !== "string" || typeof approve !== "boolean") return false;
  const e = pending.get(id);
  if (!e || e.windowId === undefined || e.windowId !== windowId) return false;
  e.done(approve);
  return true;
}
