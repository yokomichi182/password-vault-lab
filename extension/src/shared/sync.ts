// 同期先からの取得(読み取りだけ)。設計書 §3-2: GET /vaults/:name だけを呼ぶ。PUT は作らない。
export type FetchOutcome =
  | { kind: "ok"; bytes: Uint8Array; version: number }
  | { kind: "empty" }
  | { kind: "auth" }
  | { kind: "unreachable" };

export async function fetchVault(
  syncUrl: string,
  vaultName: string,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchOutcome> {
  try {
    const response = await fetchImpl(`${new URL(syncUrl).origin}/vaults/${vaultName}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
      cache: "no-store",
    });
    if (response.status === 404) return { kind: "empty" };
    if (response.status === 401 || response.status === 403) return { kind: "auth" };
    if (!response.ok) return { kind: "unreachable" };
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) return { kind: "unreachable" };
    const version = Number.parseInt(response.headers.get("x-vault-version") ?? "0", 10);
    return { kind: "ok", bytes, version: Number.isFinite(version) ? version : 0 };
  } catch {
    return { kind: "unreachable" };
  }
}
