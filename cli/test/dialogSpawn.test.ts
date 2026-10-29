import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

// 4-1 の 6: マスターパスワードが子のプロセスの引数と環境変数に載らない。起動の引数と環境を記録して確かめる。
const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
let script: (child: FakeChild) => void = () => undefined;

class FakeChild extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stdinText = "";
  kill = vi.fn();
  constructor() {
    super();
    this.stdin.on("data", (d: Buffer) => (this.stdinText += d.toString("utf8")));
  }
}

vi.mock("node:child_process", async (orig) => {
  const real = await orig<typeof import("node:child_process")>();
  return {
    ...real,
    spawn: (command: string, args: string[], options: Record<string, unknown>) => {
      spawned.push({ command, args, options });
      const child = new FakeChild();
      queueMicrotask(() => script(child));
      return child;
    },
  };
});

const { windowsApprovalDialog } = await import("../src/main/approveDialog.ts");

const MASTER_TEXT = ["master", "CANARY", "7f3e9a1c", "dialog-test"].join("-");
const req = { title: "Main Site", client: "c", time: "2026-10-29 10:00:00", lang: "en" as const, timeoutSec: 120 };

beforeEach(() => {
  spawned.length = 0;
});

describe("承認ダイアログの子のプロセス(PowerShell)", () => {
  it("マスターパスワードは標準出力の1行(base64)で受け取る。起動の引数にも環境にも載らない。unlock の応答を子に返し、最後の行で選択を決める", async () => {
    let seenByUnlock = "";
    let reply = "";
    script = (child) => {
      child.stdout.write("U " + Buffer.from(MASTER_TEXT, "utf8").toString("base64") + "\n");
      // node からの応答を見てから、選択を書く
      const wait = setInterval(() => {
        if (child.stdinText.split("\n").some((l) => l.startsWith("OK "))) {
          clearInterval(wait);
          reply = child.stdinText;
          child.stdout.write("R copy\n");
          child.emit("close", 0);
        }
      }, 10);
    };
    const choice = await windowsApprovalDialog.ask(req, async (master) => {
      seenByUnlock = master;
      return { type: "password", userHint: "al…" };
    });
    expect(choice).toBe("copy");
    expect(seenByUnlock).toBe(MASTER_TEXT);
    // 起動の記録: 固定のスクリプトだけ。マスターパスワードは引数にも環境にもない
    expect(spawned).toHaveLength(1);
    const rec = JSON.stringify(spawned[0]);
    expect(rec.includes(MASTER_TEXT)).toBe(false);
    expect(rec.includes(Buffer.from(MASTER_TEXT).toString("base64"))).toBe(false);
    expect(spawned[0]!.options.env).toBeUndefined(); // 環境は追加しない(親のものを引き継ぐだけ)
    expect(spawned[0]!.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand"]);
    // 子の標準入力に渡したのは、表示の文言(1行目)と unlock の結果だけ。マスターパスワードは戻さない
    expect(reply.includes(MASTER_TEXT)).toBe(false);
    expect(reply.includes(Buffer.from(MASTER_TEXT).toString("base64"))).toBe(false);
    const first = JSON.parse(Buffer.from(reply.split("\n")[0]!, "base64").toString("utf8")) as Record<string, unknown>;
    expect(first).toMatchObject({ title: "Main Site", client: "c", deny: "Deny", once: "Return once" });
  });

  it("unlock が null(誤り・項目なし)なら NG を返し、子が deny で終われば deny。2回目の U は NG", async () => {
    let unlocks = 0;
    script = (child) => {
      child.stdout.write("U " + Buffer.from("x", "utf8").toString("base64") + "\n");
      child.stdout.write("U " + Buffer.from("y", "utf8").toString("base64") + "\n");
      setTimeout(() => {
        child.stdout.write("R deny\n");
        child.emit("close", 0);
      }, 100);
    };
    let text = "";
    const origScript = script;
    script = (child) => {
      origScript(child);
      setTimeout(() => (text = child.stdinText), 90);
    };
    const choice = await windowsApprovalDialog.ask(req, async () => (unlocks++, null));
    expect(choice).toBe("deny");
    expect(unlocks).toBe(1);
    expect(text.split("\n").filter((l) => l === "NG")).toHaveLength(2);
  });

  it("最後の行が無いまま子が終わる(窓を閉じた・落ちた)、知らない選択: deny", async () => {
    script = (child) => setTimeout(() => child.emit("close", 2), 20);
    expect(await windowsApprovalDialog.ask(req, async () => null)).toBe("deny");
    script = (child) => {
      child.stdout.write("R allow-everything\n");
      setTimeout(() => child.emit("close", 0), 20);
    };
    expect(await windowsApprovalDialog.ask(req, async () => null)).toBe("deny");
  });

  it("起動できないときは例外(呼び出し側が unavailable にする)", async () => {
    script = (child) => child.emit("error", new Error("ENOENT"));
    await expect(windowsApprovalDialog.ask(req, async () => null)).rejects.toThrow();
  });
});
