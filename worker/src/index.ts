const MAX_BODY_BYTES = 1_900_000;
const KEEP_VERSIONS = 50;
const NAME_RE = /^[a-z0-9-]{1,32}$/;

function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}

function err(status: number, message: string, extra: Record<string, string> = {}): Response {
  return json({ error: message }, status, extra);
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

type Auth = { ok: true; vault: string } | { ok: false; status: 401 | 500 };

/** トークンの SHA-256 を、TOKENS の各キーと定数時間で比較する。 */
async function authenticate(request: Request, env: Env): Promise<Auth> {
  const header = request.headers.get("Authorization");
  if (!header) return { ok: false, status: 401 };
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return { ok: false, status: 401 };

  let table: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(env.TOKENS);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 500 };
    }
    table = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, status: 500 };
  }

  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(m[1]!)),
  );
  let found: string | null = null;
  for (const [keyHex, vault] of Object.entries(table)) {
    const key = hexToBytes(keyHex);
    if (!key || key.length !== digest.length || typeof vault !== "string") continue;
    // 見つかっても最後まで回す。
    if (crypto.subtle.timingSafeEqual(digest, key)) found = vault;
  }
  return found === null ? { ok: false, status: 401 } : { ok: true, vault: found };
}

function toBytes(value: unknown): Uint8Array<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(
      new Uint8Array(value.buffer as ArrayBuffer, value.byteOffset, value.byteLength),
    );
  }
  throw new Error("unsupported blob type");
}

async function latestVersion(db: D1Database, vault: string): Promise<number> {
  const row = await db
    .prepare("SELECT MAX(version) AS v FROM vault_versions WHERE vault = ?1")
    .bind(vault)
    .first<{ v: number | null }>();
  return row?.v ?? 0;
}

function blobResponse(blob: unknown, version: number): Response {
  return new Response(toBytes(blob), {
    status: 200,
    headers: {
      "content-type": "application/octet-stream",
      "x-vault-version": String(version),
      "cache-control": "no-store",
    },
  });
}

async function getLatest(env: Env, vault: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT version, blob FROM vault_versions WHERE vault = ?1 ORDER BY version DESC LIMIT 1",
  )
    .bind(vault)
    .first<{ version: number; blob: unknown }>();
  if (!row) return err(404, "empty vault");
  return blobResponse(row.blob, row.version);
}

async function getHistory(env: Env, vault: string): Promise<Response> {
  const { results } = await env.DB.prepare(
    "SELECT version, sha256, device, created_at, length(blob) AS size FROM vault_versions WHERE vault = ?1 ORDER BY version DESC",
  )
    .bind(vault)
    .all();
  return json(results);
}

async function getVersion(env: Env, vault: string, version: number): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT blob FROM vault_versions WHERE vault = ?1 AND version = ?2",
  )
    .bind(vault, version)
    .first<{ blob: unknown }>();
  if (!row) return err(404, "no such version");
  return blobResponse(row.blob, version);
}

async function readBody(request: Request): Promise<Uint8Array<ArrayBuffer> | Response> {
  const cl = request.headers.get("Content-Length");
  if (cl !== null) {
    if (!/^\d+$/.test(cl)) return err(400, "invalid Content-Length");
    if (Number(cl) > MAX_BODY_BYTES) return err(413, "body too large");
  }
  if (!request.body) return err(400, "empty body");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel();
      return err(413, "body too large");
    }
    chunks.push(value);
  }
  if (total === 0) return err(400, "empty body");
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : "";
  return /UNIQUE constraint failed/i.test(msg);
}

async function putVault(request: Request, env: Env, vault: string): Promise<Response> {
  const ifMatch = request.headers.get("If-Match");
  if (ifMatch === null) return err(428, "If-Match required");
  if (!/^\d{1,15}$/.test(ifMatch)) return err(400, "invalid If-Match");
  const expected = Number(ifMatch);

  let device = "unknown";
  const dev = request.headers.get("X-Device-Name");
  if (dev !== null) {
    if (dev.length < 1 || dev.length > 64) return err(400, "invalid X-Device-Name");
    device = dev;
  }

  const body = await readBody(request);
  if (body instanceof Response) return body;

  const sha256 = bytesToHex(await crypto.subtle.digest("SHA-256", body));
  const next = expected + 1;
  const createdAt = new Date().toISOString();

  let insertChanges = 0;
  try {
    const [insertResult] = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO vault_versions (vault, version, blob, sha256, device, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE COALESCE((SELECT MAX(version) FROM vault_versions WHERE vault = ?1), 0) = ?7`,
      ).bind(vault, next, body, sha256, device, createdAt, expected),
      env.DB.prepare(
        `DELETE FROM vault_versions
         WHERE vault = ?1 AND version <= ?2 AND changes() = 1`,
      ).bind(vault, next - KEEP_VERSIONS),
    ]);
    insertChanges = insertResult?.meta.changes ?? 0;
  } catch (e) {
    if (!isUniqueViolation(e)) throw e;
  }

  if (insertChanges !== 1) {
    return json({ version: await latestVersion(env.DB, vault) }, 409);
  }

  return json({ version: next });
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const auth = await authenticate(request, env);
  if (!auth.ok) {
    return err(auth.status, auth.status === 401 ? "unauthorized" : "server misconfigured");
  }

  const parts = url.pathname.split("/").slice(1); // 先頭の "" を除く。末尾スラッシュは "" が残り 404 になる。
  if (parts[0] !== "vaults" || parts.length < 2 || parts.length > 4) return err(404, "not found");
  const name = parts[1]!;
  const rest = parts.slice(2);

  let route: "vault" | "history" | "version";
  let version = 0;
  if (rest.length === 0) route = "vault";
  else if (rest.length === 1 && rest[0] === "history") route = "history";
  else if (rest.length === 2 && rest[0] === "history" && /^[1-9]\d{0,14}$/.test(rest[1]!)) {
    route = "version";
    version = Number(rest[1]);
  } else return err(404, "not found");

  if (!NAME_RE.test(name)) return err(400, "invalid vault name");

  const allowed = route === "vault" ? ["GET", "PUT"] : ["GET"];
  if (!allowed.includes(request.method)) {
    return err(405, "method not allowed", { allow: allowed.join(", ") });
  }

  if (auth.vault !== name) return err(403, "forbidden");

  switch (route) {
    case "vault":
      return request.method === "GET" ? getLatest(env, name) : putVault(request, env, name);
    case "history":
      return getHistory(env, name);
    case "version":
      return getVersion(env, name, version);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch {
      // 例外の中身（本文やトークンを含みうる）はログにも応答にも出さない。
      return err(500, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;
