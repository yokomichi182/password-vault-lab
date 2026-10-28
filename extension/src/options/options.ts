import { bytesToBase64 } from "../shared/base64.ts";
import {
  DEFAULT_VAULT_NAME,
  MAX_SESSION_HOURS,
  MIN_SESSION_HOURS,
  VAULT_NAME_RE,
} from "../shared/constants.ts";
import { t } from "../shared/i18n.ts";
import { clampHours, clearSession, defaultSettings, getSettings } from "../shared/storage.ts";
import { fetchVault } from "../shared/sync.ts";
import { createTokenVault } from "../shared/vault.ts";
import { openVaultItems } from "../shared/vault.ts";

// 設定画面: 同期先、保管庫の名前、トークン(マスターパスワードで鍵をかけて保存)、セッションの長さ、オンロードのオンとオフ。
// 値(トークン、マスターパスワード)は画面から読んだらすぐ欄を空にし、ログにもメッセージにも出さない。
const root = document.getElementById("root")!;

function field(label: string, input: HTMLInputElement, hint?: string): HTMLElement {
  const wrap = document.createElement("div");
  const lab = document.createElement("label");
  lab.textContent = label;
  lab.htmlFor = input.id;
  wrap.append(lab, input);
  if (hint) {
    const p = document.createElement("p");
    p.className = "hint";
    p.textContent = hint;
    wrap.append(p);
  }
  return wrap;
}

function makeInput(id: string, type: string, value = ""): HTMLInputElement {
  const i = document.createElement("input");
  i.id = id;
  i.type = type;
  i.value = value;
  i.autocomplete = "off";
  i.spellcheck = false;
  return i;
}

function messageBox(id: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.id = id;
  p.className = "msg";
  p.setAttribute("role", "status");
  return p;
}

function show(box: HTMLElement, cls: "error" | "ok" | "note", text: string): void {
  box.className = `msg ${cls}`;
  box.textContent = text;
}

/** 同期先の URL を検証して、オリジンだけにそろえる。https、または http://localhost だけ。 */
function parseSyncUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const ok = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  return ok ? url : null;
}

async function render(): Promise<void> {
  const current = (await getSettings()) ?? defaultSettings();
  const local = (await chrome.storage.local.get("tokenKdbx")) as { tokenKdbx?: string };

  // ---- 同期先 ----
  const url = makeInput("sync-url", "url", current.syncUrl);
  url.placeholder = "https://";
  const name = makeInput("vault-name", "text", current.vaultName || DEFAULT_VAULT_NAME);
  const token = makeInput("token", "password");
  const master = makeInput("master", "password");
  const syncMsg = messageBox("sync-msg");
  const saveSync = document.createElement("button");
  saveSync.type = "button";
  saveSync.id = "save-sync";
  saveSync.className = "primary";
  saveSync.textContent = t("saveSync");

  const syncSet = document.createElement("fieldset");
  const syncLegend = document.createElement("legend");
  syncLegend.textContent = t("syncSection");
  syncSet.append(
    syncLegend,
    field(t("syncUrl"), url, t("syncUrlHint")),
    field(t("vaultName"), name),
    field(t("syncToken"), token, t("syncTokenHint")),
    field(t("masterPassword"), master, t("masterHint")),
    syncMsg,
    saveSync,
  );
  if (local.tokenKdbx) show(syncMsg, "note", t("alreadyConfigured"));

  saveSync.addEventListener("click", () => {
    void (async () => {
      const parsed = parseSyncUrl(url.value);
      const vaultName = name.value.trim();
      const tokenValue = token.value;
      const masterValue = master.value;
      if (!parsed) return show(syncMsg, "error", t("errInvalidUrl"));
      if (!VAULT_NAME_RE.test(vaultName)) return show(syncMsg, "error", t("errInvalidName"));
      if (tokenValue === "") return show(syncMsg, "error", t("errNeedToken"));
      if (masterValue === "") return show(syncMsg, "error", t("errNeedMaster"));
      saveSync.disabled = true;
      show(syncMsg, "note", t("saving"));
      try {
        // 入力されたオリジンだけの権限を求める(ユーザー操作の中で最初に呼ぶ)
        const granted = await chrome.permissions.request({ origins: [`${parsed.origin}/*`] });
        if (!granted) return show(syncMsg, "error", t("errPermission"));

        const tokenKdbx = await createTokenVault(masterValue, tokenValue);
        // 一度 GET して、開けることを確かめる。開けなければ設定を保存しない。
        const outcome = await fetchVault(parsed.origin, vaultName, tokenValue);
        if (outcome.kind === "empty") return show(syncMsg, "error", t("errEmpty"));
        if (outcome.kind === "auth") return show(syncMsg, "error", t("errAuth"));
        if (outcome.kind === "unreachable") return show(syncMsg, "error", t("errUnreachable"));
        try {
          await openVaultItems(outcome.bytes, masterValue);
        } catch {
          return show(syncMsg, "error", t("errVaultUnopenable"));
        }
        const settings = { ...current, syncUrl: parsed.origin, vaultName };
        await chrome.storage.local.set({
          settings,
          tokenKdbx: bytesToBase64(tokenKdbx),
          vaultCipher: bytesToBase64(outcome.bytes),
          vaultVersion: outcome.version,
          lastSync: new Date().toISOString(),
        });
        await clearSession(); // 同期先が変わったので、いったんロックする
        show(syncMsg, "ok", t("savedSync"));
      } catch {
        show(syncMsg, "error", t("errUnknown"));
      } finally {
        token.value = "";
        master.value = "";
        saveSync.disabled = false;
      }
    })();
  });

  // ---- ふるまい ----
  const hours = makeInput("session-hours", "number", String(current.sessionHours));
  hours.min = String(MIN_SESSION_HOURS);
  hours.max = String(MAX_SESSION_HOURS);
  hours.step = "1";
  const onload = makeInput("onload", "checkbox");
  onload.checked = current.onload;
  onload.style.width = "auto";
  const onloadLabel = document.createElement("label");
  onloadLabel.htmlFor = "onload";
  onloadLabel.textContent = t("onloadFill");
  const onloadRow = document.createElement("div");
  onloadRow.className = "row";
  onloadRow.append(onload, onloadLabel);
  const behMsg = messageBox("beh-msg");
  const saveBeh = document.createElement("button");
  saveBeh.type = "button";
  saveBeh.id = "save-behavior";
  saveBeh.className = "primary";
  saveBeh.textContent = t("saveBehavior");
  const behSet = document.createElement("fieldset");
  const behLegend = document.createElement("legend");
  behLegend.textContent = t("behaviorSection");
  behSet.append(behLegend, field(t("sessionHours"), hours, t("sessionHoursHint")), onloadRow, behMsg, saveBeh);

  saveBeh.addEventListener("click", () => {
    void (async () => {
      const raw = (await chrome.storage.local.get("settings")) as { settings?: unknown };
      if (!raw.settings) return show(behMsg, "error", t("errSetupFirst"));
      const latest = (await getSettings()) ?? current;
      const n = clampHours(Number(hours.value));
      hours.value = String(n);
      await chrome.storage.local.set({ settings: { ...latest, sessionHours: n, onload: onload.checked } });
      show(behMsg, "ok", t("savedBehavior"));
    })();
  });

  const title = document.createElement("h1");
  title.textContent = t("optionsTitle");
  root.replaceChildren(title, syncSet, behSet);
}

void render();
