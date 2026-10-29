import http from "node:http";
import type { AddressInfo } from "node:net";

export interface SeenRequest {
  method: string;
  path: string;
  ifMatch: string | undefined;
  /** 認証ヘッダが付いていたか(値は残さない) */
  hasAuth: boolean;
}

/** 同期先のモック(設計書 §3-2 の GET と PUT だけ)。実際の Worker は wrangler dev の統合テストで確かめる。 */
export class MockSync {
  vaults = new Map<string, { bytes: Uint8Array; version: number }>();
  /** トークン → 読み書きできる保管庫の名前 */
  tokens = new Map<string, string>();
  requests: SeenRequest[] = [];
  /** true のとき、接続を切る(通信できない) */
  down = false;
  /** PUT の検査の直前に呼ぶ。別の端末が先に書いた状況を作るために、保管庫の版を進める */
  beforePut: ((vault: string) => void) | undefined;
  private server: http.Server | null = null;
  url = "";

  setVault(name: string, bytes: Uint8Array): number {
    const cur = this.vaults.get(name);
    const version = (cur?.version ?? 0) + 1;
    this.vaults.set(name, { bytes, version });
    return version;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      if (this.down) {
        req.socket.destroy();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => this.handle(req, res, Buffer.concat(chunks)));
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

  private handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    const m = /^\/vaults\/([a-z0-9-]{1,32})$/.exec(req.url ?? "");
    const auth = req.headers.authorization;
    this.requests.push({
      method: req.method ?? "",
      path: m ? `/vaults/${m[1]}` : "(other)",
      ifMatch: req.headers["if-match"] as string | undefined,
      hasAuth: auth !== undefined,
    });
    const json = (status: number, obj: unknown): void =>
      void res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(obj));
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
    const allowed = this.tokens.get(token);
    if (allowed === undefined) return json(401, { error: "unauthorized" });
    if (!m) return json(404, { error: "not found" });
    const name = m[1]!;
    if (allowed !== name) return json(403, { error: "forbidden" });
    if (req.method === "GET") {
      const cur = this.vaults.get(name);
      if (!cur) return json(404, { error: "empty" });
      res.writeHead(200, { "x-vault-version": String(cur.version), "cache-control": "no-store" }).end(Buffer.from(cur.bytes));
      return;
    }
    if (req.method === "PUT") {
      this.beforePut?.(name);
      const cur = this.vaults.get(name);
      const version = cur?.version ?? 0;
      if (req.headers["if-match"] !== String(version)) return json(409, { version });
      this.vaults.set(name, { bytes: new Uint8Array(body), version: version + 1 });
      return json(200, { version: version + 1 });
    }
    json(405, { error: "method" });
  }
}
