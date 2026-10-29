import type { FillRequest, FillResult } from "./fill.ts";

// Native Messaging のホスト pwm-bridge とのつなぎ(実装指示_フェーズ5 の 3-6)。
// 拡張が起動のときに connectNative でつなぎ、ポートを開いたままにする(つながっているあいだ、MV3 の service worker は止まらない)。
// 切れたら、指数的に間を空けてつなぎ直す(上限 5 分)。ホストから来たメッセージは型を確かめ、知らない形は捨てる。

export const RECONNECT_FIRST_MS = 1000;
export const RECONNECT_MAX_MS = 5 * 60_000;

export const nextBackoff = (prev: number): number => Math.min(prev * 2, RECONNECT_MAX_MS);

const ID_RE = /^[0-9a-f]{32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type HostMessage = { type: "hello" } | { type: "fill"; req: FillRequest };

/** ホストから来たメッセージを確かめる。知らない形は null。 */
export function parseHostMessage(raw: unknown): HostMessage | null {
  if (!isObj(raw)) return null;
  if (raw.type === "hello") return { type: "hello" };
  if (raw.type !== "fill") return null;
  const { id, title, url, client } = raw;
  if (typeof id !== "string" || !ID_RE.test(id)) return null;
  if (typeof title !== "string" || title === "" || title.length > 1024) return null;
  if (url !== undefined && (typeof url !== "string" || url.length > 2048)) return null;
  if (typeof client !== "string" || client.length > 256) return null;
  const req: FillRequest = { id, title, client };
  if (url !== undefined && url !== "") req.url = url;
  return { type: "fill", req };
}

/** chrome.runtime.Port のうち使う部分(テストで差し替える)。 */
export interface PortLike {
  postMessage(msg: unknown): void;
  onMessage: { addListener(cb: (msg: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
  disconnect(): void;
}

export interface BridgeDeps {
  connect(): PortLike;
  /** 依頼を処理して結果を返す(承認画面の待ちを含む) */
  handle(req: FillRequest): Promise<FillResult>;
  /** 間を空けて呼ぶ(テストでは待たずに記録する) */
  schedule(fn: () => void, ms: number): void;
}

export interface Bridge {
  /** つながっていなければつなぐ(service worker が起きるたびに呼んでよい) */
  ensureConnected(): void;
  /** テスト用 */
  state(): { connected: boolean; backoffMs: number };
}

export function startBridge(deps: BridgeDeps): Bridge {
  let port: PortLike | null = null;
  let backoff = RECONNECT_FIRST_MS;
  // 依頼は1件ずつ処理する(承認画面を同時に2つ出さない)
  let chain: Promise<void> = Promise.resolve();

  const connect = (): void => {
    if (port) return;
    let p: PortLike;
    try {
      p = deps.connect();
    } catch {
      scheduleReconnect();
      return;
    }
    port = p;
    p.onMessage.addListener((raw) => {
      const m = parseHostMessage(raw);
      if (!m) return; // 知らない形は捨てる
      if (m.type === "hello") {
        backoff = RECONNECT_FIRST_MS; // つながった
        return;
      }
      const req = m.req;
      chain = chain.then(async () => {
        let result: FillResult;
        try {
          result = await deps.handle(req);
        } catch {
          result = "unavailable";
        }
        try {
          p.postMessage({ type: "fill-result", id: req.id, result });
        } catch {
          // ポートが切れていた。結果は届けられない(pwm-mcp は時間切れで unavailable にする)
        }
      });
    });
    p.onDisconnect.addListener(() => {
      if (port === p) port = null;
      scheduleReconnect();
    });
  };

  const scheduleReconnect = (): void => {
    const wait = backoff;
    backoff = nextBackoff(backoff);
    deps.schedule(connect, wait);
  };

  return {
    ensureConnected: connect,
    state: () => ({ connected: port !== null, backoffMs: backoff }),
  };
}
