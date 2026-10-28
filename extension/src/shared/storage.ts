import { DEFAULT_SESSION_HOURS, DEFAULT_VAULT_NAME, MAX_SESSION_HOURS, MIN_SESSION_HOURS } from "./constants.ts";
import type { LocalState, Settings } from "./unlock.ts";
import type { VaultItem } from "./vault.ts";

export function defaultSettings(): Settings {
  return { syncUrl: "", vaultName: DEFAULT_VAULT_NAME, sessionHours: DEFAULT_SESSION_HOURS, onload: true };
}

export function clampHours(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_SESSION_HOURS;
  return Math.min(MAX_SESSION_HOURS, Math.max(MIN_SESSION_HOURS, Math.round(n)));
}

export async function getLocal(): Promise<LocalState> {
  const raw = (await chrome.storage.local.get(null)) as LocalState;
  return raw;
}

export async function getSettings(): Promise<Settings | undefined> {
  const raw = (await chrome.storage.local.get("settings")) as { settings?: Partial<Settings> };
  if (!raw.settings) return undefined;
  const d = defaultSettings();
  return {
    syncUrl: typeof raw.settings.syncUrl === "string" ? raw.settings.syncUrl : d.syncUrl,
    vaultName: typeof raw.settings.vaultName === "string" ? raw.settings.vaultName : d.vaultName,
    sessionHours: clampHours(Number(raw.settings.sessionHours ?? d.sessionHours)),
    onload: raw.settings.onload !== false,
  };
}

/** chrome.storage.session に置くもの(設計書 §6、実装指示 3-3)。マスターパスワード、複合鍵、トークンは置かない。 */
export interface Session {
  items: VaultItem[];
  expiresAt: number;
  source: "server" | "cache";
  lastSync?: string;
}

const SESSION_KEY = "session";
export const SESSION_ALARM = "session-expire";

export async function setSession(session: Session): Promise<void> {
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  await chrome.alarms.create(SESSION_ALARM, { when: session.expiresAt });
}

/** 値を使う前に毎回呼ぶ。時刻を過ぎていたら(alarm が遅れていても)空にして null を返す。 */
export async function getSession(now: number = Date.now()): Promise<Session | null> {
  const raw = (await chrome.storage.session.get(SESSION_KEY)) as { [SESSION_KEY]?: Session };
  const s = raw[SESSION_KEY];
  if (!s || typeof s.expiresAt !== "number" || !Array.isArray(s.items)) return null;
  if (now >= s.expiresAt) {
    await clearSession();
    return null;
  }
  return s;
}

export async function clearSession(): Promise<void> {
  await chrome.storage.session.clear();
  await chrome.alarms.clear(SESSION_ALARM);
}
