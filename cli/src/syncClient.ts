// 同期先への PUT(読み取りの GET は拡張の shared/sync.ts を使う)。pwm-mcp は import しない。
export type PutOutcome =
  | { kind: "ok"; version: number }
  | { kind: "conflict" }
  | { kind: "auth" }
  | { kind: "rejected"; status: number }
  | { kind: "unreachable" };

export const DEVICE_NAME = "pwm-cli";

export async function putVault(
  syncUrl: string,
  vaultName: string,
  token: string,
  bytes: Uint8Array,
  ifMatch: number,
  fetchImpl: typeof fetch = fetch,
): Promise<PutOutcome> {
  try {
    const response = await fetchImpl(`${new URL(syncUrl).origin}/vaults/${vaultName}`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "If-Match": String(ifMatch),
        "X-Device-Name": DEVICE_NAME,
        "Content-Type": "application/octet-stream",
      },
      body: Buffer.from(bytes),
    });
    if (response.status === 409) return { kind: "conflict" };
    if (response.status === 401 || response.status === 403) return { kind: "auth" };
    if (response.status >= 500) return { kind: "unreachable" };
    if (!response.ok) return { kind: "rejected", status: response.status };
    let version = 0;
    try {
      const j = (await response.json()) as { version?: unknown };
      if (typeof j.version === "number") version = j.version;
    } catch {
      // 版の番号が読めなくても、書き込みは通っている
    }
    return { kind: "ok", version };
  } catch {
    return { kind: "unreachable" };
  }
}
