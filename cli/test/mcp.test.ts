import { spawn, spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { windowsDpapi } from "../src/dpapi.ts";
import { CONCEALED } from "../src/run.ts";
import { createKeyFile, openWithKeyFile, openWithPassword } from "../src/kdbx.ts";
import { runPwm } from "../src/pwm.ts";
import { FILES } from "../src/store.ts";
import { CANARY_AUTOM, CANARY_MAIN, MASTER, hasMarker, makeCtx, makeHome, makeKdbx, registerHomeScan, tmpHome, type TestItem } from "./helpers.ts";

registerHomeScan();

const ROOT = path.resolve(import.meta.dirname, "..");
const MCP_JS = path.join(ROOT, "dist", "pwm-mcp.mjs");
const PWM_JS = path.join(ROOT, "dist", "pwm.mjs");
const CHILD = path.join(import.meta.dirname, "child.cjs");
const BLOCK = pathToFileURL(path.join(import.meta.dirname, "block-net.mjs")).href;

const SECRET = `${CANARY_AUTOM}-mcp-secret`;
const ITEMS: TestItem[] = [
  { title: "web", username: "alice", password: `${CANARY_AUTOM}-web`, url: "https://web.example.test/", notes: "n1" },
  { title: "svc", username: "bot", password: SECRET, type: "apikey", environment: "prod", expires: new Date(2031, 4, 20, 23, 59, 59) },
  { title: "dup", password: "d1" },
  { title: "dup", password: "d2" },
];

/** 本物の DPAPI で守った PWM_HOME(pwm-mcp は別のプロセスで本物の DPAPI を呼ぶ)。 */
const realHome = (items: TestItem[] = ITEMS) => makeHome(items, { protector: windowsDpapi });

async function connect(home: string, opts: { lang?: string; execArgv?: string[] } = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [...(opts.execArgv ?? []), MCP_JS],
    env: { PWM_HOME: home, PWM_LANG: opts.lang ?? "en" },
    stderr: "pipe",
  });
  const stderr: Buffer[] = [];
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  transport.stderr?.on("data", (d: Buffer) => stderr.push(d));
  return { client, stderr: () => Buffer.concat(stderr).toString("utf8"), close: () => client.close() };
}

type Text = { content: { type: string; text: string }[]; isError?: boolean };
const textOf = (r: unknown): string => (r as Text).content.map((c) => c.text).join("");
const call = (c: Client, name: string, args: Record<string, unknown> = {}) => c.callTool({ name, arguments: args });

describe("9. MCP: ツールの一覧と応答", () => {
  it("ツールの一覧がちょうど list_titles、read_credential、run の3つ。それぞれが表のとおり返す", async () => {
    const h = await realHome();
    const m = await connect(h.dir);
    try {
      const tools = await m.client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual(["list_titles", "read_credential", "run"]);
      // API キーは read_credential でなく run で渡す使い方を勧める(設計書 §11-2)
      const rc = tools.tools.find((t) => t.name === "read_credential")!;
      expect(rc.description).toContain("prefer the `run` tool");

      const titles = JSON.parse(textOf(await call(m.client, "list_titles"))) as { title: string; type: string; environment: string }[];
      expect(titles.map((t) => `${t.title}|${t.type}|${t.environment}`).sort()).toEqual(["dup|password|", "dup|password|", "svc|apikey|prod", "web|password|"]);
      for (const t of titles) expect(Object.keys(t).sort()).toEqual(["environment", "title", "type"]);

      const web = JSON.parse(textOf(await call(m.client, "read_credential", { title: "web" })));
      expect(web).toEqual({ username: "alice", password: `${CANARY_AUTOM}-web`, url: "https://web.example.test/", notes: "n1", type: "password", environment: "", expires: "" });
      const svc = JSON.parse(textOf(await call(m.client, "read_credential", { title: "svc" })));
      expect(svc).toMatchObject({ password: SECRET, type: "apikey", environment: "prod", expires: "2031-05-20" });

      const ran = JSON.parse(
        textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "check", "K", SECRET], env: { K: "svc/password" } })),
      ) as Record<string, unknown>;
      expect(ran).toEqual({ exit_code: 0, stdout: "match", stderr: "", stdout_truncated: false, stderr_truncated: false });
      const code = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "exit", "7"], env: { K: "svc" } })));
      expect(code.exit_code).toBe(7);
      const echo = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "echo", "K"], env: { K: "svc" } })));
      expect(echo.stdout).toBe(`out:${CONCEALED}:end\n`);
      expect(echo.stderr).toBe(`err:${CONCEALED}:end\n`);

      // 見つからない・2件以上・不正な参照はエラー
      const none = (await call(m.client, "read_credential", { title: "nope" })) as Text;
      expect(none.isError).toBe(true);
      expect(textOf(none)).toBe("No matching item.");
      expect(((await call(m.client, "read_credential", { title: "dup" })) as Text).isError).toBe(true);
      expect(((await call(m.client, "run", { command: [process.execPath, CHILD, "exit", "0"], env: { K: "svc/nofield" } })) as Text).isError).toBe(true);
    } finally {
      await m.close();
    }
  });
});

describe("18. MCP の run の上限", () => {
  it("出力の上限で切れる。timeout_seconds の上限を超える指定はエラー。時間切れは 124", async () => {
    const h = await realHome();
    const m = await connect(h.dir);
    try {
      const big = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "big", "200000"], env: { K: "svc" } })));
      expect(big.stdout.length).toBe(64 * 1024);
      expect(big.stdout_truncated).toBe(true);
      expect(big.stderr_truncated).toBe(false);
      const small = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "big", "1000"], env: { K: "svc" } })));
      expect(small.stdout.length).toBe(1000);
      expect(small.stdout_truncated).toBe(false);

      for (const bad of [601, 100000, 0, -1]) {
        const r = (await call(m.client, "run", { command: [process.execPath, CHILD, "exit", "0"], env: { K: "svc" }, timeout_seconds: bad })) as Text;
        expect(r.isError, String(bad)).toBe(true);
        expect(textOf(r)).toContain("600");
      }
      const edge = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "exit", "0"], env: { K: "svc" }, timeout_seconds: 600 })));
      expect(edge.exit_code).toBe(0);

      const slow = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "sleep"], env: { K: "svc" }, timeout_seconds: 1 })));
      expect(slow.exit_code).toBe(124);

      // 子の標準入力は空(待たずに終わる)
      const stdin = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "stdin"], env: { K: "svc" } })));
      expect(stdin.stdout).toBe("stdin:0");
    } finally {
      await m.close();
    }
  }, 120_000);
});

describe("11. 鍵の分離(設計書 §13-2 の逆試算)", () => {
  it("本体のマスターパスワードで自動処理用の保管庫が開けない。自動処理用のキーファイルで本体の保管庫が開けない", async () => {
    const keyFile = await createKeyFile();
    const automation = await makeKdbx({ keyFile }, [{ title: "a", password: `${CANARY_AUTOM}-a` }]);
    const main = await makeKdbx({ master: MASTER }, [{ title: "m", password: `${CANARY_MAIN}-m` }]);
    await expect(openWithPassword(automation, MASTER)).rejects.toMatchObject({ code: "InvalidKey" });
    await expect(openWithKeyFile(main, keyFile)).rejects.toMatchObject({ code: "InvalidKey" });
    // 本体の保管庫を開く鍵(マスターパスワード)と、キーファイルの両方が要る保管庫でもない
    await expect(openWithKeyFile(automation, await createKeyFile())).rejects.toMatchObject({ code: "InvalidKey" });
  });

  it("本体の保管庫の暗号文を automation.kdbx の場所に置いても、pwm read と read_credential は開けずにエラーになり、本体の目印を出さない", async () => {
    const h = await realHome();
    const main = await makeKdbx({ master: MASTER }, [{ title: "m", password: `${CANARY_MAIN}-m` }]);
    await writeFile(path.join(h.dir, FILES.automationKdbx), main);

    const t = makeCtx(h.dir, { protector: windowsDpapi, tty: false });
    expect(await runPwm(["read", "m"], t.ctx)).not.toBe(0);
    expect(t.stdout()).toBe("");
    expect(hasMarker(t.stderr())).toBe(false);
    const t2 = makeCtx(h.dir, { protector: windowsDpapi, tty: false });
    expect(await runPwm(["auto", "list"], t2.ctx)).not.toBe(0);
    expect(hasMarker(t2.stdout() + t2.stderr())).toBe(false);

    const m = await connect(h.dir);
    try {
      for (const [name, args] of [
        ["read_credential", { title: "m" }],
        ["list_titles", {}],
        ["run", { command: [process.execPath, CHILD, "echo", "K"], env: { K: "m" } }],
      ] as const) {
        const r = (await call(m.client, name, args)) as Text;
        expect(r.isError, name).toBe(true);
        expect(hasMarker(textOf(r)), name).toBe(false);
      }
      expect(hasMarker(m.stderr())).toBe(false);
    } finally {
      await m.close();
    }
  });
});

describe("12. 本体の保管庫を読みに行かない", () => {
  it("PWM_HOME に本体のファイルだけがあるとき、pwm read・pwm run(--main なし)・read_credential は「自動処理用の保管庫がありません」", async () => {
    const dir = await tmpHome();
    await writeFile(path.join(dir, "main.kdbx"), await makeKdbx({ master: MASTER }, [{ title: "main-pw", password: `${CANARY_MAIN}-1` }]));
    await writeFile(path.join(dir, "main.token.kdbx"), new Uint8Array([1, 2, 3]));
    await writeFile(path.join(dir, FILES.config), JSON.stringify({ syncUrl: "http://127.0.0.1:9", mainVault: "main" }));

    const t = makeCtx(dir, { lang: "ja", tty: true });
    expect(await runPwm(["read", "main-pw"], t.ctx)).not.toBe(0);
    expect(t.stderr()).toContain("自動処理用の保管庫がありません");
    expect(t.asked).toEqual([]);
    const t2 = makeCtx(dir, { lang: "ja", tty: true });
    expect(await runPwm(["run", "--env", "K=main-pw", "--", process.execPath, CHILD, "exit", "0"], t2.ctx)).not.toBe(0);
    expect(t2.stderr()).toContain("自動処理用の保管庫がありません");
    expect(t2.asked).toEqual([]);

    const m = await connect(dir, { lang: "ja" });
    try {
      const r = (await call(m.client, "read_credential", { title: "main-pw" })) as Text;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("自動処理用の保管庫がありません");
    } finally {
      await m.close();
    }
  });

  it("本体の保管庫にだけあるタイトル(パスワードと API キーの両方)を read_credential に渡すと「該当なし」", async () => {
    const h = await realHome();
    // 本体のファイルが同じフォルダにあっても読みに行かない
    await writeFile(
      path.join(h.dir, "main.kdbx"),
      await makeKdbx({ master: MASTER }, [
        { title: "main-only-password", password: `${CANARY_MAIN}-p` },
        { title: "main-only-apikey", password: `${CANARY_MAIN}-k`, type: "apikey", environment: "prod" },
      ]),
    );
    const m = await connect(h.dir, { lang: "ja" });
    try {
      for (const title of ["main-only-password", "main-only-apikey"]) {
        const r = (await call(m.client, "read_credential", { title })) as Text;
        expect(r.isError).toBe(true);
        expect(textOf(r)).toBe("該当なし");
      }
      const titles = textOf(await call(m.client, "list_titles"));
      expect(titles).not.toContain("main-only");
    } finally {
      await m.close();
    }
  });
});

describe("13. 束ねた pwm-mcp.mjs に本体の入口が入っていない", () => {
  it("本体のファイル名と --main の処理が入っていない(pwm.mjs には入っている)", async () => {
    const mcp = await readFile(MCP_JS, "utf8");
    const pwm = await readFile(PWM_JS, "utf8");
    for (const needle of ["main.token.kdbx", "main.kdbx", "--main", "withMainDb", "Master password"]) {
      expect(mcp.includes(needle), `mcp has ${needle}`).toBe(false);
      expect(pwm.includes(needle), `pwm has ${needle}`).toBe(true); // 検査が空振りでないことの確認
    }
  });
});

describe("14. pwm-mcp が通信しない", () => {
  it("前処理が本当に通信を止める(仕掛けの確認)", () => {
    const r = spawnSync(process.execPath, ["--import", BLOCK, "-e", "fetch('http://127.0.0.1:9').then(()=>process.exit(0),()=>process.exit(0))"], { encoding: "utf8" });
    expect(r.status).not.toBe(0); // fetch が同期的に投げるので、catch に入らず未捕捉の例外で落ちる
    const r2 = spawnSync(process.execPath, ["--import", BLOCK, "-e", "require('node:net').connect(9)"], { encoding: "utf8" });
    expect(r2.status).not.toBe(0);
    const r3 = spawnSync(process.execPath, ["--import", BLOCK, "-e", "require('node:net').createServer().listen(0)"], { encoding: "utf8" });
    expect(r3.status).not.toBe(0);
  });

  it("fetch と node:net・node:http(s) の接続を失敗させて起動しても、3つのツールが動く", async () => {
    const h = await realHome();
    const m = await connect(h.dir, { execArgv: ["--import", BLOCK] });
    try {
      expect((await m.client.listTools()).tools).toHaveLength(3);
      expect(JSON.parse(textOf(await call(m.client, "list_titles")))).toHaveLength(4);
      expect(JSON.parse(textOf(await call(m.client, "read_credential", { title: "web" }))).username).toBe("alice");
      const ran = JSON.parse(textOf(await call(m.client, "run", { command: [process.execPath, CHILD, "check", "K", SECRET], env: { K: "svc" } })));
      expect(ran.stdout).toBe("match");
    } finally {
      await m.close();
    }
  });
});

/** MCP の通信の生の標準出力・標準エラーを集める(JSON-RPC を1行ずつ送る)。 */
class RawMcp {
  stdout = "";
  stderr = "";
  private id = 0;
  private waiters = new Map<number, (v: unknown) => void>();
  private child;
  constructor(home: string) {
    this.child = spawn(process.execPath, [MCP_JS], {
      env: { ...process.env, PWM_HOME: home, PWM_LANG: "en" },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let buf = "";
    this.child.stdout.on("data", (d: Buffer) => {
      this.stdout += d.toString("utf8");
      buf += d.toString("utf8");
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as { id?: number };
        if (msg.id !== undefined) this.waiters.get(msg.id)?.(msg);
      }
    });
    this.child.stderr.on("data", (d: Buffer) => (this.stderr += d.toString("utf8")));
  }
  request(method: string, params: unknown): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve) => {
      this.waiters.set(id, resolve);
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method: string): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }
  async init(): Promise<void> {
    await this.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "raw", version: "0" } });
    this.notify("notifications/initialized");
  }
  tool(name: string, args: unknown): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }
  async close(): Promise<void> {
    this.child.stdin.end();
    await new Promise((r) => this.child.once("close", r));
  }
}

describe("19. カナリア(MCP と CLI の出力)", () => {
  it("run の標準出力の全体(MCP の通信の JSON)と標準エラーに目印が出ない。list_titles とエラーの応答にも出ない", async () => {
    const h = await realHome();
    const raw = new RawMcp(h.dir);
    await raw.init();
    await raw.request("tools/list", {});
    await raw.tool("list_titles", {});
    // run: 子が値を標準出力と標準エラーに出す。設計書 §13-2 の必須の項目
    const echoed = (await raw.tool("run", { command: [process.execPath, CHILD, "echo", "K"], env: { K: "svc" } })) as { result: Text };
    expect(JSON.parse(textOf(echoed.result)).stdout).toBe(`out:${CONCEALED}:end\n`);
    const split = (await raw.tool("run", { command: [process.execPath, CHILD, "split", "K"], env: { K: "svc/password" } })) as { result: Text };
    expect(JSON.parse(textOf(split.result)).stdout).toBe(`head:${CONCEALED}:tail\n`);
    // エラーの応答
    await raw.tool("read_credential", { title: "nope" });
    await raw.tool("read_credential", { title: "dup" });
    await raw.tool("run", { command: [process.execPath, CHILD, "exit", "0"], env: { K: "svc/zzz" } });
    await raw.tool("run", { command: [], env: {} });
    await raw.tool("run", { command: ["no-such-program-for-pwm-test"], env: { K: "svc" } });
    await raw.tool("run", { command: [process.execPath, CHILD, "exit", "0"], env: { K: "svc" }, timeout_seconds: 9999 });
    await raw.close();
    expect(raw.stdout).toContain(CONCEALED);
    expect(hasMarker(raw.stdout)).toBe(false);
    expect(hasMarker(raw.stderr)).toBe(false);
    // 標準出力は MCP の通信(1行1つの JSON)だけ
    for (const line of raw.stdout.split("\n").filter(Boolean)) expect(() => JSON.parse(line)).not.toThrow();
  });

  it("pwm の built の入口(dist/pwm.mjs)を実際に動かしても、エラーの標準出力と標準エラーに目印が出ない", async () => {
    const h = await realHome();
    const runBuilt = (args: string[]) =>
      spawnSync(process.execPath, [PWM_JS, ...args], { env: { ...process.env, PWM_HOME: h.dir, PWM_LANG: "en" }, encoding: "utf8", input: "" });
    const ok = runBuilt(["read", "web/username"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("alice\n");
    const secret = runBuilt(["read", "svc"]);
    expect(secret.stdout).toBe(`${SECRET}\n`); // read の値は出す(これは例外)
    for (const args of [["read", "nope"], ["read", "dup"], ["read", "web/zzz"], ["auto", "list"], ["sync"], ["auto", "add", "--title", "x"], ["read", "--main", "web"], ["run", "--env", "K=svc", "--", process.execPath, CHILD, "echo", "K"]]) {
      const r = runBuilt(args);
      const label = args[0] + " " + (args[1] ?? "");
      if (args[0] === "auto" && args[1] === "list") {
        expect(r.status).toBe(0);
        expect(hasMarker(r.stdout), label).toBe(false);
      } else if (args[0] === "run") {
        expect(r.status).toBe(0);
        expect(r.stdout).toBe(`out:${CONCEALED}:end\n`);
      } else {
        expect(r.status, label).not.toBe(0);
        expect(r.stdout, label).toBe("");
      }
      expect(hasMarker(r.stdout + r.stderr), label).toBe(false);
    }
  });

  it("テストのあとの PWM_HOME の全ファイル(DPAPI のファイルと .kdbx を含む)に平文の目印が無い", async () => {
    const h = await realHome();
    // 全ファイルの検査は registerHomeScan が後始末の前に行う。ここでは、いま作った保管庫の暗号文を直接確かめる
    for (const f of [FILES.automationKdbx, FILES.automationKey]) {
      const bytes = await readFile(path.join(h.dir, f));
      expect(bytes.includes(Buffer.from(CANARY_AUTOM))).toBe(false);
    }
  });
});
