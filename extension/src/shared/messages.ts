import type { BreachResult } from "./breach.ts";
import type { UnlockError } from "./unlock.ts";

// ポップアップ → service worker
export type PopupRequest =
  | { type: "state" }
  | { type: "unlock"; master: string }
  | { type: "lock" }
  | { type: "list" }
  | { type: "fill"; id: string }
  | { type: "copy"; id: string; field: "username" | "password" }
  | { type: "breach"; id: string };

/** 一覧に出す項目。パスワードの値は含めない。 */
export interface ListedItem {
  id: string;
  title: string;
  username: string;
  url: string;
  isLogin: boolean;
  /** 今のタブのオリジンに一致するログイン用の項目か。true のときだけ「入力」を出す。 */
  matches: boolean;
}

export type StateResponse = {
  configured: boolean;
  unlocked: boolean;
  onload: boolean;
  expiresAt?: number;
  source?: "server" | "cache";
  lastSync?: string;
};

export type UnlockResponse =
  | { ok: true; source: "server" | "cache"; lastSync?: string; note?: "offline" | "auth" }
  | { ok: false; error: UnlockError };

export interface ListResponse {
  unlocked: boolean;
  items: ListedItem[];
}

export type FillError = "locked" | "no-match" | "no-tab" | "no-field" | "failed";
export type FillResponse = { ok: true } | { ok: false; error: FillError };
export type BreachResponse = BreachResult | { status: "locked" };
export type OkResponse = { ok: boolean };

// コンテンツスクリプト ↔ service worker
export type ContentRequest = { type: "candidate" };
export type CandidateResponse = { fill: { username: string; password: string } | null };

/** service worker → コンテンツスクリプト */
export type TabRequest =
  | { type: "whoami" }
  | { type: "fill"; expectedOrigin: string; username: string; password: string };
export type WhoamiResponse = { origin: string | null };
export type TabFillResponse = { ok: boolean };
