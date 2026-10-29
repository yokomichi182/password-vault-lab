import { describe, expect, it } from "vitest";
import { RECONNECT_FIRST_MS, RECONNECT_MAX_MS, nextBackoff, parseHostMessage, startBridge, type PortLike } from "../src/background/bridge.ts";
import type { FillRequest, FillResult } from "../src/background/fill.ts";

// 4-1 の 13 の続き: ネイティブのポートは差し替える。
const ID = "0123456789abcdef0123456789abcdef";

class FakePort implements PortLike {
  sent: unknown[] = [];
  private messageListeners: ((m: unknown) => void)[] = [];
  private disconnectListeners: (() => void)[] = [];
  onMessage = { addListener: (cb: (m: unknown) => void) => void this.messageListeners.push(cb) };
  onDisconnect = { addListener: (cb: () => void) => void this.disconnectListeners.push(cb) };
  postMessage(msg: unknown): void {
    this.sent.push(msg);
  }
  disconnect(): void {
    this.fireDisconnect();
  }
  fromHost(msg: unknown): void {
    for (const l of this.messageListeners) l(msg);
  }
  fireDisconnect(): void {
    for (const l of this.disconnectListeners) l();
  }
}

function setup(handle: (r: FillRequest) => Promise<FillResult> = async () => "filled") {
  const ports: FakePort[] = [];
  const scheduled: { fn: () => void; ms: number }[] = [];
  const handled: FillRequest[] = [];
  const bridge = startBridge({
    connect: () => {
      const p = new FakePort();
      ports.push(p);
      return p;
    },
    handle: async (r) => (handled.push(r), handle(r)),
    schedule: (fn, ms) => void scheduled.push({ fn, ms }),
  });
  return { bridge, ports, scheduled, handled };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("ネイティブのホストとのつなぎ", () => {
  it("つなぎ、ホストの依頼を処理して、結果を fill-result で返す", async () => {
    const s = setup();
    s.bridge.ensureConnected();
    s.bridge.ensureConnected(); // 何度呼んでも1本
    expect(s.ports).toHaveLength(1);
    s.ports[0]!.fromHost({ type: "hello" });
    s.ports[0]!.fromHost({ type: "fill", id: ID, title: "Site A", url: "https://a.example.test", client: "my-ai", at: 1, password: "ignored" });
    await settle();
    expect(s.handled).toEqual([{ id: ID, title: "Site A", url: "https://a.example.test", client: "my-ai" }]);
    expect(s.ports[0]!.sent).toEqual([{ type: "fill-result", id: ID, result: "filled" }]);
  });

  it("知らない形のメッセージは捨てる(処理しない・応答しない)", async () => {
    const s = setup();
    s.bridge.ensureConnected();
    const bad: unknown[] = [
      null,
      "fill",
      [],
      { type: "other" },
      { type: "fill", id: "not-hex", title: "t", client: "c" },
      { type: "fill", id: ID, title: "", client: "c" },
      { type: "fill", id: ID, title: "t", client: 5 },
      { type: "fill", id: ID, title: "t", client: "c", url: 5 },
      { type: "fill", id: ID, title: "x".repeat(2000), client: "c" },
      { type: "fill", title: "t", client: "c" },
    ];
    for (const m of bad) s.ports[0]!.fromHost(m);
    await settle();
    expect(s.handled).toEqual([]);
    expect(s.ports[0]!.sent).toEqual([]);
    expect(parseHostMessage({ type: "hello" })).toEqual({ type: "hello" });
  });

  it("依頼は1件ずつ処理する(承認画面を同時に2つ出さない)。処理が例外になったら unavailable を返す", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const order: string[] = [];
    const s = setup(async (r) => {
      order.push(`start ${r.title}`);
      if (r.title === "first") await gate;
      if (r.title === "boom") throw new Error("x");
      order.push(`end ${r.title}`);
      return "denied";
    });
    s.bridge.ensureConnected();
    const id = (n: number) => String(n).repeat(32).slice(0, 32);
    s.ports[0]!.fromHost({ type: "fill", id: id(1), title: "first", client: "c" });
    s.ports[0]!.fromHost({ type: "fill", id: id(2), title: "boom", client: "c" });
    await settle();
    expect(order).toEqual(["start first"]); // 2件目は待つ
    release();
    await settle();
    expect(order).toEqual(["start first", "end first", "start boom"]);
    expect(s.ports[0]!.sent).toEqual([
      { type: "fill-result", id: id(1), result: "denied" },
      { type: "fill-result", id: id(2), result: "unavailable" },
    ]);
  });

  it("切れたら間を空けてつなぎ直す(1秒から倍々で、上限 5 分)。hello でつながったと分かったら最初に戻す", async () => {
    const s = setup();
    s.bridge.ensureConnected();
    const waits: number[] = [];
    for (let i = 0; i < 12; i++) {
      s.ports.at(-1)!.fireDisconnect();
      const next = s.scheduled.at(-1)!;
      waits.push(next.ms);
      next.fn(); // 再接続
    }
    expect(waits.slice(0, 5)).toEqual([1000, 2000, 4000, 8000, 16000]);
    expect(Math.max(...waits)).toBe(RECONNECT_MAX_MS);
    expect(waits.at(-1)).toBe(RECONNECT_MAX_MS);
    expect(nextBackoff(RECONNECT_MAX_MS)).toBe(RECONNECT_MAX_MS);
    // つながって hello が来たら、次の切断の待ちは最初に戻る
    s.ports.at(-1)!.fromHost({ type: "hello" });
    s.ports.at(-1)!.fireDisconnect();
    expect(s.scheduled.at(-1)!.ms).toBe(RECONNECT_FIRST_MS);
  });

  it("connect が例外(ホストが登録されていない)でも、間を空けて再試行する。再接続の予約が重なっても接続は1本", () => {
    let fail = true;
    const scheduled: { fn: () => void; ms: number }[] = [];
    const ports: FakePort[] = [];
    const bridge = startBridge({
      connect: () => {
        if (fail) throw new Error("no host");
        const p = new FakePort();
        ports.push(p);
        return p;
      },
      handle: async () => "filled",
      schedule: (fn, ms) => void scheduled.push({ fn, ms }),
    });
    bridge.ensureConnected();
    expect(scheduled.map((x) => x.ms)).toEqual([1000]);
    scheduled[0]!.fn();
    expect(scheduled.map((x) => x.ms)).toEqual([1000, 2000]);
    fail = false;
    bridge.ensureConnected(); // service worker が起きた
    expect(ports).toHaveLength(1);
    scheduled[1]!.fn(); // 予約していた再接続が来ても、もうつながっている
    expect(ports).toHaveLength(1);
    expect(bridge.state().connected).toBe(true);
  });
});
