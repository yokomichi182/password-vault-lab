import { t } from "../shared/i18n.ts";

// 承認画面(request_fill の初回、承認リストにないオリジン)。サイトのオリジン、項目名、ユーザー名の一部、要求した AI の名前(自己申告)を出す。
// 既定は「拒否」(最初にフォーカスが当たる)。Esc も拒否。値(パスワード)はこの画面に渡らない。ログにも何も出さない。
const root = document.getElementById("root")!;
const id = new URLSearchParams(location.search).get("id") ?? "";

interface Info {
  origin: string;
  title: string;
  userHint: string;
  client: string;
}

function row(label: string, value: string, extra = ""): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "approve-row";
  const l = document.createElement("div");
  l.className = "approve-label";
  l.textContent = label;
  const v = document.createElement("div");
  v.className = "approve-value";
  v.textContent = value + extra;
  wrap.append(l, v);
  return wrap;
}

async function loadInfo(): Promise<Info | null> {
  // 窓ができた直後は service worker が窓の番号を持つ前のことがあるので、少し待って尋ね直す
  for (let i = 0; i < 10; i++) {
    const res = (await chrome.runtime.sendMessage({ type: "approve-info", id })) as Info | null;
    if (res) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

async function decide(approve: boolean): Promise<void> {
  for (const b of document.querySelectorAll("button")) b.disabled = true;
  try {
    await chrome.runtime.sendMessage({ type: "approve-decision", id, approve });
  } catch {
    // 窓が閉じられた
  }
  window.close();
}

async function main(): Promise<void> {
  const info = await loadInfo();
  if (!info) {
    window.close();
    return;
  }
  document.title = t("approveWindowTitle");
  const h = document.createElement("h1");
  h.textContent = t("approveHeading");
  const rows = document.createElement("div");
  rows.id = "approve-rows";
  rows.append(
    row(t("approveSite"), info.origin),
    row(t("approveItem"), info.title),
    row(t("approveUser"), info.userHint),
    row(t("approveClient"), info.client, t("approveSelfReported")),
  );
  const note = document.createElement("p");
  note.className = "hint";
  note.textContent = t("approveNote");

  // 拒否を先に置く(最初のフォーカスと Enter は拒否)
  const deny = document.createElement("button");
  deny.type = "button";
  deny.id = "approve-deny";
  deny.textContent = t("approveDeny");
  deny.addEventListener("click", () => void decide(false));
  const allow = document.createElement("button");
  allow.type = "button";
  allow.id = "approve-allow";
  allow.className = "primary";
  allow.textContent = t("approveAllow");
  allow.addEventListener("click", () => void decide(true));
  const actions = document.createElement("div");
  actions.className = "row approve-actions";
  actions.append(deny, allow);

  root.replaceChildren(h, rows, note, actions);
  deny.focus();
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") void decide(false);
  });
}

void main();
