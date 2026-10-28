import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import * as kdbxwebNs from "kdbxweb";
import { setupArgon2 } from "../src/shared/vault.ts";

const kdbxweb = ((kdbxwebNs as unknown as { default?: typeof kdbxwebNs }).default ?? kdbxwebNs) as typeof kdbxwebNs;

// 本体用の目印(AGENTS.md)。ソースに文字列そのものを置かず、実行時に組み立てる。
export const CANARY = ["CANARY", "7f3e9a1c"].join("-");

export const root = path.resolve(import.meta.dirname, "..", "..");
export const pagesDir = path.join(root, "tests", "extension", "pages");

export const PORT_A = Number(process.env.PWV_E2E_PORT_A ?? 18701);
export const PORT_B = Number(process.env.PWV_E2E_PORT_B ?? 18702);
export const WRANGLER_PORT = Number(process.env.PWV_E2E_WRANGLER_PORT ?? 18788);
export const BREACH_PORT = Number(process.env.PWV_BREACH_PORT ?? 18999);
export const SYNC_URL = `http://localhost:${WRANGLER_PORT}`;

// 架空のトークンとマスターパスワード
export const MASTER = `e2e-master-${CANARY}-dummy`;
export const TOKEN_MAIN = `${CANARY}-e2e-token-main`;
export const TOKEN_ANDROID = `${CANARY}-e2e-token-android`;

export interface FakeItem {
  id: number;
  title: string;
  username: string;
  password: string;
  url: string;
  itemType?: string;
}

const uuidOf = (n: number) => Buffer.from(`00000000-0000-0000-0000-${n.toString(16).padStart(12, "0")}`.replaceAll("-", ""), "hex").toString("base64");

/** 架空の保管庫(KDBX4)を作る。Argon2id は速く開けるよう小さくする。 */
export async function makeVault(master: string, items: FakeItem[]): Promise<Uint8Array> {
  setupArgon2();
  const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(master)), "e2e");
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
  db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1));
  db.header.kdfParameters!.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 1);
  for (const it of items) {
    const e = db.createEntry(db.getDefaultGroup());
    e.uuid = new kdbxweb.KdbxUuid(uuidOf(it.id));
    e.fields.set("Title", it.title);
    e.fields.set("UserName", it.username);
    e.fields.set("Password", kdbxweb.ProtectedValue.fromString(it.password));
    e.fields.set("URL", it.url);
    if (it.itemType) e.fields.set("ItemType", it.itemType);
  }
  return new Uint8Array(await db.save());
}

// ---- 小さなサーバー ----

function serveStatic(dir: string): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    const file = path.join(dir, path.normalize(url.pathname).replace(/^([/\\])+/, ""));
    if (!file.startsWith(dir) || !existsSync(file) || !(await stat(file)).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    createReadStream(file).pipe(res);
  });
}

export async function listen(server: http.Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve()); // ホストを指定しない(IPv4 と IPv6 の両方)
  });
}

export async function close(server: http.Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function startPageServers(): Promise<http.Server[]> {
  const servers = [serveStatic(pagesDir), serveStatic(pagesDir)];
  return Promise.all([listen(servers[0]!, PORT_A), listen(servers[1]!, PORT_B)]).then(() => servers);
}

/** ローカルのモック(Pwned Passwords の range API)。SHA-1 の先頭5文字ごとに、末尾:回数の行を返す。 */
export class BreachMock {
  server: http.Server | null = null;
  /** 先頭5文字 → 行(`末尾:回数`)の配列 */
  table = new Map<string, string[]>();
  /** 受けた要求(パスと Add-Padding の値だけ。パスワードやハッシュの残りは入らない) */
  requests: { path: string; padding: string | undefined }[] = [];

  add(sha1Upper: string, count: number): void {
    const prefix = sha1Upper.slice(0, 5);
    const rows = this.table.get(prefix) ?? [];
    rows.push(`${sha1Upper.slice(5)}:${count}`);
    this.table.set(prefix, rows);
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => {
      const m = /^\/range\/([0-9A-Fa-f]{5})$/.exec(req.url ?? "");
      this.requests.push({ path: m ? `/range/${m[1]}` : "(other)", padding: req.headers["add-padding"] as string | undefined });
      if (!m) {
        res.writeHead(404).end();
        return;
      }
      const rows = [...(this.table.get(m[1]!.toUpperCase()) ?? []), "0000000000000000000000000000000000A:0"];
      res.writeHead(200, { "content-type": "text/plain" }).end(rows.join("\r\n"));
    });
    await listen(this.server, BREACH_PORT);
  }

  async stop(): Promise<void> {
    if (this.server) await close(this.server);
    this.server = null;
  }
}

export function sha1Upper(text: string): string {
  return createHash("sha1").update(text).digest("hex").toUpperCase();
}

// ---- ローカルの wrangler dev(.dev.vars は読まない) ----

export interface Wrangler {
  dir: string;
  stop(): Promise<void>;
  /** 標準出力と標準エラー(カナリアの探査用)。 */
  output(): string;
}

async function waitPort(port: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, "127.0.0.1");
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("wrangler dev did not start");
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    p.on("exit", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}`))));
  });
}

/**
 * 設定ファイルを作業フォルダの外の一時フォルダに置いて wrangler dev を動かす。
 * worker/ で動かすと .dev.vars を自動で読んでしまうため、別の場所から worker/src を指す。
 */
export async function startWrangler(): Promise<Wrangler> {
  const dir = path.join(os.tmpdir(), `pwv-e2e-wrangler-${process.pid}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const worker = path.join(root, "worker").replaceAll("\\", "/");
  await writeFile(
    path.join(dir, "wrangler.jsonc"),
    JSON.stringify({
      name: "pwm-worker",
      main: `${worker}/src/index.ts`,
      compatibility_date: "2026-08-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "pwm",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: `${worker}/migrations`,
        },
      ],
    }),
  );
  const bin = path.join(root, "worker", "node_modules", "wrangler", "bin", "wrangler.js");
  const env = { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
  const state = path.join(dir, "state");
  await run(process.execPath, [bin, "d1", "migrations", "apply", "pwm", "--local", "--persist-to", state], dir, env);

  const sha = (s: string) => createHash("sha256").update(s).digest("hex");
  const tokens = JSON.stringify({ [sha(TOKEN_MAIN)]: "main", [sha(TOKEN_ANDROID)]: "android" });
  const child: ChildProcess = spawn(
    process.execPath,
    [bin, "dev", "--port", String(WRANGLER_PORT), "--ip", "127.0.0.1", "--persist-to", state, "--var", `TOKENS:${tokens}`],
    { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  await waitPort(WRANGLER_PORT, 90_000);
  return {
    dir,
    output: () => log,
    async stop() {
      child.kill();
      await new Promise((r) => setTimeout(r, 500));
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

export async function putVault(vaultName: string, token: string, bytes: Uint8Array): Promise<void> {
  const base = `${SYNC_URL}/vaults/${vaultName}`;
  const auth = { Authorization: `Bearer ${token}` };
  const cur = await fetch(base, { headers: auth });
  const version = cur.status === 404 ? 0 : Number(cur.headers.get("x-vault-version"));
  await cur.arrayBuffer();
  const res = await fetch(base, {
    method: "PUT",
    headers: { ...auth, "If-Match": String(version), "X-Device-Name": "e2e" },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(`PUT failed: ${res.status}`);
}

// ---- 作業フォルダの外の探査(Chrome の一時プロファイルなど) ----

export async function dirContainsBytes(dir: string, needles: Buffer[]): Promise<string[]> {
  const found: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        try {
          const data = await readFile(p);
          if (needles.some((n) => data.includes(n))) found.push(path.relative(dir, p));
        } catch {
          // 使用中で読めないファイルは飛ばす(件数は呼び出し側で数えない)
        }
      }
    }
  }
  await walk(dir);
  return found;
}
