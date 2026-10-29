import { isFillableOrigin, normalizeOrigin } from "./match.ts";

// 承認リスト(設計書 §11-3)。request_fill が入力してよいオリジン。chrome.storage.local に置く。
// 1件はオリジンと承認した時刻だけ。項目名やユーザー名は入れない。オンロード自動入力はこの一覧を見ない。
export interface Approval {
  origin: string;
  /** 承認した時刻(ISO 8601) */
  at: string;
}

export const APPROVALS_KEY = "approvals";

/** 保存されたものを確かめて読む。形が違うもの、入力してよいオリジンでないものは捨てる。 */
export function sanitizeApprovals(raw: unknown): Approval[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: Approval[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const { origin, at } = e as { origin?: unknown; at?: unknown };
    if (typeof origin !== "string" || typeof at !== "string") continue;
    const n = normalizeOrigin(origin);
    if (n === null || n !== origin || !isFillableOrigin(n) || seen.has(n)) continue;
    seen.add(n);
    out.push({ origin: n, at });
  }
  return out;
}

export async function listApprovals(): Promise<Approval[]> {
  const raw = (await chrome.storage.local.get(APPROVALS_KEY)) as { [APPROVALS_KEY]?: unknown };
  return sanitizeApprovals(raw[APPROVALS_KEY]);
}

/** オリジンの完全一致(スキーム・ホスト・ポート)。ポート違い、サブドメイン違いは別のオリジン。 */
export async function isApproved(origin: string): Promise<boolean> {
  const n = normalizeOrigin(origin);
  if (n === null) return false;
  return (await listApprovals()).some((a) => a.origin === n);
}

export async function addApproval(origin: string, now: Date = new Date()): Promise<void> {
  const n = normalizeOrigin(origin);
  if (n === null || !isFillableOrigin(n)) throw new Error("not a fillable origin");
  const list = await listApprovals();
  if (list.some((a) => a.origin === n)) return;
  await chrome.storage.local.set({ [APPROVALS_KEY]: [...list, { origin: n, at: now.toISOString() }] });
}

export async function removeApproval(origin: string): Promise<void> {
  const list = await listApprovals();
  const next = list.filter((a) => a.origin !== origin);
  if (next.length === list.length) return;
  await chrome.storage.local.set({ [APPROVALS_KEY]: next });
}
