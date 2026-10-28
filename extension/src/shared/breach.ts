import { isLoginType } from "./match.ts";

// 設計書 §14 と AGENTS.md の決まり: 送るのは SHA-1 の先頭 5 文字だけ。Add-Padding を付ける。結果は保存しない。

export type BreachResult =
  | { status: "pwned"; count: number }
  | { status: "clean" }
  /** 通信できなかった、または応答を読めなかった。「漏洩なし」にはしない。 */
  | { status: "error" }
  /** ログイン用でない項目(API キーと知らない種類)。ハッシュも送らない。 */
  | { status: "not-applicable" };

export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
}

/** 応答の本文(`SUFFIX:COUNT` の行)から、末尾に一致する出現回数を返す。回数 0 の行(パディング)は無視する。 */
export function countFromRange(body: string, suffix: string): number {
  for (const line of body.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    if (line.slice(0, idx).trim().toUpperCase() !== suffix) continue;
    const count = Number.parseInt(line.slice(idx + 1).trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }
  return 0;
}

export interface BreachTarget {
  itemType: string;
  password: string;
}

/**
 * 1項目を調べる。baseUrl は束ねるときの定数(通常は https://api.pwnedpasswords.com)。
 * 例外のメッセージにも結果にも、パスワードやハッシュを入れない。
 */
export async function checkBreach(
  target: BreachTarget,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<BreachResult> {
  if (!isLoginType(target.itemType)) return { status: "not-applicable" };
  if (target.password === "") return { status: "not-applicable" };
  try {
    const hash = await sha1Hex(target.password);
    const prefix = hash.slice(0, 5);
    const suffix = hash.slice(5);
    const response = await fetchImpl(`${baseUrl}/range/${prefix}`, {
      method: "GET",
      headers: { "Add-Padding": "true" },
      credentials: "omit",
      cache: "no-store",
    });
    if (!response.ok) return { status: "error" };
    const count = countFromRange(await response.text(), suffix);
    return count > 0 ? { status: "pwned", count } : { status: "clean" };
  } catch {
    return { status: "error" };
  }
}
