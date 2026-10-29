// Native Messaging のホスト pwm-bridge の中身(実装指示_フェーズ5 の 3-6)。入出力は呼び出し側から受け取る(テストで差し替える)。
// このモジュールと、束ねた pwm-bridge.mjs には、本体の保管庫のファイル名、本体用のモジュール、同期の処理、fetch を入れない。
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  FILL_RESULTS,
  ID_RE,
  REQ_RE,
  RES_RE,
  STALE_MS,
  bridgeDir,
  parseFillRequest,
  readText,
  reqName,
  resName,
  writeAtomic,
  type FillResult,
} from "./files.ts";

/** ホスト → 拡張 */
export type HostToExt = { type: "hello" } | { type: "fill"; id: string; title: string; url?: string; client: string; at: number };

export interface HostDeps {
  /** <PWM_HOME>\bridge\ */
  dir: string;
  /** 拡張へメッセージを送る(Native Messaging の標準出力) */
  send(msg: HostToExt): void;
  now(): number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export class BridgeHost {
  /** 拡張に渡して、結果待ちの依頼の ID */
  private readonly pending = new Map<string, number>();
  private scanning = false;

  constructor(private readonly deps: HostDeps) {}

  hello(): void {
    this.deps.send({ type: "hello" });
  }

  /** 置き場を見直す。依頼を拾って拡張に渡し、古い依頼・応答と、読まれないまま残った応答を消す。 */
  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      let names: string[];
      try {
        names = await readdir(this.deps.dir);
      } catch {
        return; // 置き場がまだ無い
      }
      const now = this.deps.now();
      for (const [id, at] of this.pending) if (now - at > STALE_MS) this.pending.delete(id);
      for (const name of names) {
        const file = path.join(this.deps.dir, name);
        const req = REQ_RE.exec(name);
        if (req) {
          await this.pickUp(file, req[1]!, now);
          continue;
        }
        if (RES_RE.test(name)) {
          // 読まれないまま残った応答(pwm-mcp が待ちをやめたあとに書いたもの)は、古くなったら消す
          const st = await stat(file).catch(() => null);
          if (st && now - st.mtimeMs > STALE_MS) await rm(file, { force: true }).catch(() => undefined);
        }
      }
    } finally {
      this.scanning = false;
    }
  }

  private async pickUp(file: string, id: string, now: number): Promise<void> {
    const text = await readText(file);
    if (text === null) return;
    // 読んだら、中身が正しくてもなくても消す(同じ依頼を二度拾わない。入力の二重実行を避ける)
    await rm(file, { force: true }).catch(() => undefined);
    const req = parseFillRequest(text, id);
    if (!req) return; // 知らない形は捨てる
    if (now - req.at > STALE_MS) return; // 古い依頼は捨てる
    if (this.pending.has(id)) return;
    this.pending.set(id, now);
    this.deps.send({ type: "fill", id: req.id, title: req.title, ...(req.url !== undefined ? { url: req.url } : {}), client: req.client, at: req.at });
  }

  /** 拡張からのメッセージ。型を確かめ、知らない形は捨てる。 */
  async onExtensionMessage(msg: unknown): Promise<void> {
    if (!isObj(msg) || msg.type !== "fill-result") return;
    const { id, result } = msg;
    if (typeof id !== "string" || !ID_RE.test(id) || !this.pending.has(id)) return;
    if (!(FILL_RESULTS as readonly unknown[]).includes(result)) return;
    this.pending.delete(id);
    await writeAtomic(path.join(this.deps.dir, resName(id)), JSON.stringify({ v: 1, id, result: result as FillResult }));
  }

  /** テスト用: 結果待ちの件数 */
  pendingCount(): number {
    return this.pending.size;
  }
}

export { bridgeDir, reqName };
