import { ItemTypes } from "./constants.ts";

/** 自動入力と漏洩チェックの対象か。ItemType が空か password のときだけ true(設計書 §2-1)。知らない種類は false。 */
export function isLoginType(itemType: string): boolean {
  return itemType === "" || itemType === ItemTypes.PASSWORD;
}

/**
 * 項目の URL をオリジンにそろえる。スキームが無ければ https:// を補う。
 * 解釈できない URL、http と https 以外(androidapp:// など)は null。
 */
export function itemOrigin(rawUrl: string): string | null {
  const raw = rawUrl.trim();
  if (raw === "") return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  // "example.com:8443" のような「ホスト:ポート」はスキームではない。"://" を伴うものだけをスキームとみなす。
  const candidate = hasScheme ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.hostname === "") return null;
  return url.origin;
}

/** ページのオリジン(sender.origin など)を URL で正規化する。解釈できなければ null。 */
export function normalizeOrigin(origin: string): string | null {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return url.origin;
}

function isLocalhostName(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost");
}

/**
 * 入力してよいページか。https:、または http: でホストが localhost か *.localhost(設計書 §6)。
 * 127.0.0.1 を含むそれ以外の http:、file:、chrome: などは false。
 */
export function isFillableOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return url.hostname !== "";
  if (url.protocol === "http:") return isLocalhostName(url.hostname);
  return false;
}

/** 照合に必要な項目の部分。 */
export interface MatchableItem {
  url: string;
  itemType: string;
}

/**
 * ページのオリジンに一致する、ログイン用の項目だけを返す。
 * 種類の絞り込みを先に行い、オリジンはスキーム・ホスト・ポートの完全一致で比べる。
 */
export function matchItems<T extends MatchableItem>(items: readonly T[], pageOrigin: string): T[] {
  const page = normalizeOrigin(pageOrigin);
  if (page === null) return [];
  return items.filter((item) => {
    if (!isLoginType(item.itemType)) return false;
    return itemOrigin(item.url) === page;
  });
}
