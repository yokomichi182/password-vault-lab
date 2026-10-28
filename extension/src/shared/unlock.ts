import { base64ToBytes } from "./base64.ts";
import { fetchVault } from "./sync.ts";
import { openTokenVault, openVaultItems, type VaultItem } from "./vault.ts";

/** chrome.storage.local に置くもの。トークンはマスターパスワードで鍵をかけた KDBX の形でだけ置く。 */
export interface Settings {
  syncUrl: string;
  vaultName: string;
  sessionHours: number;
  onload: boolean;
}

export interface LocalState {
  settings?: Settings;
  /** base64。トークン入れの KDBX。 */
  tokenKdbx?: string;
  /** base64。保管庫の暗号文。通信できないときに使う。 */
  vaultCipher?: string;
  vaultVersion?: number;
  /** ISO 8601。 */
  lastSync?: string;
}

export type UnlockError =
  | "not-configured"
  | "wrong-master"
  | "empty"
  | "vault-unopenable"
  | "unreachable"
  | "auth";

export type UnlockResult =
  | {
      ok: true;
      items: VaultItem[];
      source: "server" | "cache";
      /** 取得に成功したときだけ。呼び出し側が chrome.storage.local に書く(暗号文なのでディスクに置いてよい)。 */
      newCipher?: { bytes: Uint8Array; version: number; at: string };
      /** cache のとき: 前回の同期の日時。 */
      lastSync?: string;
      /** cache になった理由(通信できない、またはトークンが受け付けられない)。 */
      note?: "offline" | "auth";
    }
  | { ok: false; error: UnlockError };

/**
 * 設計書 §4 の6 と実装指示 3-3 の流れ。
 * マスターパスワードとトークンはこの関数の中の変数にだけ置き、戻り値に入れない。
 */
export async function performUnlock(
  master: string,
  local: LocalState,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): Promise<UnlockResult> {
  const { settings, tokenKdbx } = local;
  if (!settings || !tokenKdbx) return { ok: false, error: "not-configured" };

  let token: string;
  try {
    token = await openTokenVault(base64ToBytes(tokenKdbx), master);
  } catch {
    return { ok: false, error: "wrong-master" };
  }

  const outcome = await fetchVault(settings.syncUrl, settings.vaultName, token, fetchImpl);
  token = "";

  if (outcome.kind === "empty") return { ok: false, error: "empty" };

  if (outcome.kind === "ok") {
    try {
      const items = await openVaultItems(outcome.bytes, master);
      return {
        ok: true,
        items,
        source: "server",
        newCipher: { bytes: outcome.bytes, version: outcome.version, at: now().toISOString() },
      };
    } catch {
      // サーバーの版が開けないときは、手元の暗号文を上書きしない(設計書 §4 の6)。解除もしない。
      return { ok: false, error: "vault-unopenable" };
    }
  }

  // 通信できない、またはトークンが受け付けられない: 前回の暗号文で開く
  if (!local.vaultCipher) return { ok: false, error: outcome.kind };
  try {
    const items = await openVaultItems(base64ToBytes(local.vaultCipher), master);
    return {
      ok: true,
      items,
      source: "cache",
      lastSync: local.lastSync,
      note: outcome.kind === "auth" ? "auth" : "offline",
    };
  } catch {
    return { ok: false, error: "vault-unopenable" };
  }
}
