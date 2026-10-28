import { checkBreach } from "../shared/breach.ts";
import { bytesToBase64 } from "../shared/base64.ts";
import { CLIPBOARD_CLEAR_MS } from "../shared/constants.ts";
import { isFillableOrigin, isLoginType, matchItems, normalizeOrigin } from "../shared/match.ts";
import type {
  BreachResponse,
  CandidateResponse,
  FillResponse,
  ListResponse,
  OkResponse,
  PopupRequest,
  StateResponse,
  TabFillResponse,
  UnlockResponse,
  WhoamiResponse,
} from "../shared/messages.ts";
import {
  SESSION_ALARM,
  clampHours,
  clearSession,
  getLocal,
  getSession,
  getSettings,
  setSession,
} from "../shared/storage.ts";
import { performUnlock } from "../shared/unlock.ts";

// ログに出してよいのは例外の型の名前と件数まで(実装指示 3-8)。値・URL・ユーザー名は出さない。
const CLIP_ALARM = "clipboard-clear";

const selfOrigin = () => `chrome-extension://${chrome.runtime.id}`;

function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === "string" && sender.url.startsWith(`${selfOrigin()}/`);
}

/** コンテンツスクリプトの要求: 自分の拡張で、最上位のフレームから。ページのオリジンは sender.origin から取る(メッセージの中身は見ない)。 */
function contentSenderOrigin(sender: chrome.runtime.MessageSender): { origin: string; tabId: number } | null {
  if (sender.id !== chrome.runtime.id) return null;
  if (sender.frameId !== 0) return null;
  if (!sender.tab || sender.tab.id === undefined) return null;
  if (typeof sender.origin !== "string" || sender.origin === selfOrigin()) return null;
  const origin = normalizeOrigin(sender.origin);
  if (origin === null || !isFillableOrigin(origin)) return null;
  return { origin, tabId: sender.tab.id };
}

async function setBadge(tabId: number, text: string): Promise<void> {
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (text !== "") await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1a56db" });
  } catch {
    // タブが閉じたなど。何もしない。
  }
}

async function handleCandidate(sender: chrome.runtime.MessageSender): Promise<CandidateResponse> {
  const page = contentSenderOrigin(sender);
  if (!page) return { fill: null };
  const settings = await getSettings();
  if (!settings || !settings.onload) {
    await setBadge(page.tabId, "");
    return { fill: null };
  }
  const session = await getSession();
  if (!session) {
    await setBadge(page.tabId, "");
    return { fill: null };
  }
  const matches = matchItems(session.items, page.origin);
  if (matches.length === 1) {
    await setBadge(page.tabId, "");
    const m = matches[0]!;
    return { fill: { username: m.username, password: m.password } };
  }
  // 2件以上: 自動では入力せず、アイコンのバッジに件数を出す(ポップアップで選ぶ)
  await setBadge(page.tabId, matches.length > 1 ? String(matches.length) : "");
  return { fill: null };
}

async function activeTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const id = tabs[0]?.id;
  return id === undefined ? null : id;
}

/** 今のタブ(最上位のフレーム)のオリジン。コンテンツスクリプトに尋ねる。入力してよいページでなければ null。 */
async function tabOrigin(tabId: number): Promise<string | null> {
  try {
    const res = (await chrome.tabs.sendMessage(tabId, { type: "whoami" }, { frameId: 0 })) as WhoamiResponse | undefined;
    const origin = res?.origin ? normalizeOrigin(res.origin) : null;
    if (origin === null || !isFillableOrigin(origin)) return null;
    // chrome.tabs.get で URL を確かめ直す(URL が見える権限があるときだけ値が入る)
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab.url === "string" && tab.url !== "") {
      if (normalizeOrigin(tab.url) !== origin) return null;
    }
    return origin;
  } catch {
    return null;
  }
}

async function handleState(): Promise<StateResponse> {
  const local = await getLocal();
  const session = await getSession();
  const settings = await getSettings();
  return {
    configured: Boolean(local.settings && local.tokenKdbx),
    unlocked: session !== null,
    onload: settings?.onload ?? true,
    expiresAt: session?.expiresAt,
    source: session?.source,
    lastSync: session?.source === "cache" ? session.lastSync : local.lastSync,
  };
}

async function handleUnlock(master: string): Promise<UnlockResponse> {
  const local = await getLocal();
  const result = await performUnlock(master, local);
  if (!result.ok) return { ok: false, error: result.error };
  const hours = clampHours(local.settings?.sessionHours ?? 8);
  let lastSync = result.lastSync;
  if (result.newCipher) {
    lastSync = result.newCipher.at;
    await chrome.storage.local.set({
      vaultCipher: bytesToBase64(result.newCipher.bytes),
      vaultVersion: result.newCipher.version,
      lastSync,
    });
  }
  await setSession({
    items: result.items,
    expiresAt: Date.now() + hours * 3600_000,
    source: result.source,
    lastSync,
  });
  return { ok: true, source: result.source, lastSync, note: result.note };
}

async function handleList(): Promise<ListResponse> {
  const session = await getSession();
  if (!session) return { unlocked: false, items: [] };
  let matched = new Set<string>();
  const tabId = await activeTabId();
  if (tabId !== null) {
    const origin = await tabOrigin(tabId);
    if (origin !== null) matched = new Set(matchItems(session.items, origin).map((i) => i.id));
  }
  return {
    unlocked: true,
    items: session.items.map((i) => ({
      id: i.id,
      title: i.title,
      username: i.username,
      url: i.url,
      isLogin: isLoginType(i.itemType),
      matches: matched.has(i.id),
    })),
  };
}

async function handleFill(id: string): Promise<FillResponse> {
  const session = await getSession();
  if (!session) return { ok: false, error: "locked" };
  const item = session.items.find((i) => i.id === id);
  if (!item || !isLoginType(item.itemType)) return { ok: false, error: "no-match" };
  const tabId = await activeTabId();
  if (tabId === null) return { ok: false, error: "no-tab" };
  const origin = await tabOrigin(tabId);
  if (origin === null) return { ok: false, error: "no-tab" };
  if (matchItems([item], origin).length !== 1) return { ok: false, error: "no-match" };
  try {
    const res = (await chrome.tabs.sendMessage(
      tabId,
      { type: "fill", expectedOrigin: origin, username: item.username, password: item.password },
      { frameId: 0 },
    )) as TabFillResponse | undefined;
    return res?.ok ? { ok: true } : { ok: false, error: "no-field" };
  } catch {
    return { ok: false, error: "failed" };
  }
}

async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT] });
  if (contexts.length > 0) return;
  try {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: [chrome.offscreen.Reason.CLIPBOARD],
      justification: "Copy a username or password and clear the clipboard afterwards.",
    });
  } catch {
    // 同時に作ろうとして失敗したときは、もう存在する
  }
}

async function copyToClipboard(text: string): Promise<boolean> {
  await ensureOffscreen();
  const res = (await chrome.runtime.sendMessage({ target: "offscreen", type: "copy", text })) as OkResponse | undefined;
  return res?.ok === true;
}

async function handleCopy(id: string, field: "username" | "password"): Promise<OkResponse> {
  const session = await getSession();
  if (!session) return { ok: false };
  const item = session.items.find((i) => i.id === id);
  if (!item) return { ok: false };
  const ok = await copyToClipboard(field === "username" ? item.username : item.password);
  if (ok) await chrome.alarms.create(CLIP_ALARM, { when: Date.now() + CLIPBOARD_CLEAR_MS });
  return { ok };
}

async function handleBreach(id: string): Promise<BreachResponse> {
  const session = await getSession();
  if (!session) return { status: "locked" };
  const item = session.items.find((i) => i.id === id);
  if (!item) return { status: "not-applicable" };
  return checkBreach(item, __BREACH_BASE__);
}

async function handlePopup(req: PopupRequest): Promise<unknown> {
  switch (req.type) {
    case "state":
      return handleState();
    case "unlock":
      return handleUnlock(req.master);
    case "lock":
      await clearSession();
      return { ok: true };
    case "list":
      return handleList();
    case "fill":
      return handleFill(req.id);
    case "copy":
      return handleCopy(req.id, req.field);
    case "breach":
      return handleBreach(req.id);
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const msg = message as { type?: string; target?: string } | null;
  if (!msg || typeof msg.type !== "string" || msg.target === "offscreen") return false;
  let work: Promise<unknown>;
  if (isExtensionPage(sender)) {
    work = handlePopup(message as PopupRequest);
  } else if (msg.type === "candidate") {
    work = handleCandidate(sender);
  } else {
    return false;
  }
  work.then(sendResponse).catch((e: unknown) => {
    console.error("handler failed", e instanceof Error ? e.name : typeof e);
    sendResponse(null);
  });
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SESSION_ALARM) {
    void clearSession();
  } else if (alarm.name === CLIP_ALARM) {
    void (async () => {
      await ensureOffscreen();
      await chrome.runtime.sendMessage({ target: "offscreen", type: "clear" });
    })();
  }
});

// 起動時にも期限を確かめる(alarm が遅れた場合に備える)
void getSession();
