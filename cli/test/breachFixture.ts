// 漏洩チェックのテスト用の部品: 架空のパスワードの SHA-1 を引く表、差し替える fetch、ローカルのモックサーバー。
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

export function sha1Upper(text: string): string {
  return createHash("sha1").update(text, "utf8").digest("hex").toUpperCase();
}
export const prefixOf = (password: string): string => sha1Upper(password).slice(0, 5);
export const suffixOf = (password: string): string => sha1Upper(password).slice(5);

/** 先頭5文字 → `SUFFIX:COUNT` の行。実際の API のように、別のハッシュの行と、回数 0 のパディングの行を混ぜて返す。 */
export class BreachTable {
  private readonly lines = new Map<string, string[]>();

  /** 漏洩済みとして扱う架空のパスワード。 */
  addPwned(password: string, count: number): void {
    this.push(prefixOf(password), `${suffixOf(password)}:${count}`);
  }
  /** パディングの行(回数 0)だけを、このパスワードの末尾で返す。一致にしてはいけない。 */
  addPaddingFor(password: string): void {
    this.push(prefixOf(password), `${suffixOf(password)}:0`);
  }
  private push(prefix: string, line: string): void {
    const cur = this.lines.get(prefix) ?? [];
    cur.push(line);
    this.lines.set(prefix, cur);
  }

  body(prefix: string): string {
    // 別のハッシュの末尾(35文字)と、回数 0 のパディングの行を混ぜる
    const decoys = [`${"0".repeat(34)}1:3`, `${"F".repeat(34)}E:12`, `${"A".repeat(35)}:0`, `${"B".repeat(35)}:0`];
    return [...(this.lines.get(prefix) ?? []), ...decoys].join("\r\n") + "\r\n";
  }
}

export interface SeenCall {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  hasBody: boolean;
  init: RequestInit | undefined;
}

/** 差し替える fetch。呼ばれた URL とヘッダーを記録する。events には呼ばれた順に "fetch" を足す(待ち時間との順序の確認用)。 */
export class FakeBreachFetch {
  calls: SeenCall[] = [];
  events: string[] = [];
  /** ok: 表のとおり / throw: 通信できない / status: その状態を返す */
  mode: { kind: "ok" } | { kind: "throw" } | { kind: "status"; status: number } = { kind: "ok" };
  /** この先頭5文字の要求だけ、通信できないことにする */
  failPrefixes = new Set<string>();
  constructor(readonly table: BreachTable) {}

  readonly fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    this.calls.push({ url, method: init?.method, headers, hasBody: init?.body !== undefined && init?.body !== null, init });
    this.events.push("fetch");
    if (this.mode.kind === "throw") throw new Error("offline");
    if (this.failPrefixes.has(url.slice(url.lastIndexOf("/") + 1))) throw new Error("offline");
    if (this.mode.kind === "status") return new Response("", { status: this.mode.status });
    const prefix = url.slice(url.lastIndexOf("/") + 1);
    return new Response(this.table.body(prefix), { status: 200 });
  };
}

export interface SeenHttp {
  method: string;
  path: string;
  /** 受け取ったヘッダー(名前は小文字)。値のカナリア探査用に全部残す */
  headers: Record<string, string>;
  bodyLength: number;
}

/** 127.0.0.1 のモックサーバー。`/range/<5文字>` に表の行を返し、受け取った要求を記録する。 */
export class MockBreachServer {
  requests: SeenHttp[] = [];
  /** true のとき、接続を切る(通信できない) */
  down = false;
  private server: http.Server | null = null;
  url = "";
  constructor(readonly table: BreachTable) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : (v ?? "");
        this.requests.push({ method: req.method ?? "", path: req.url ?? "", headers, bodyLength: Buffer.concat(chunks).length });
        const m = /^\/range\/([0-9A-F]{5})$/.exec(req.url ?? "");
        if (req.method !== "GET" || !m) {
          res.writeHead(404).end();
          return;
        }
        res.writeHead(200, { "content-type": "text/plain" }).end(this.table.body(m[1]!));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }
}

/** 127.0.0.1 と localhost 以外への要求を拒否する fetch(同期先のモックなど、ローカルのサーバーだけに届かせる)。 */
export const localOnlyFetch: typeof fetch = (input, init) => {
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(raw).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") return Promise.reject(new Error("only local servers are reachable in tests"));
  return fetch(input, init);
};
