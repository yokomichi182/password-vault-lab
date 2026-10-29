import { readdir } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { runPwm } from "../src/pwm.ts";
import { CANARY_AUTOM, makeCtx, makeHome, registerHomeScan, tmpHome } from "./helpers.ts";

registerHomeScan();

const SECRET_ARG = `${CANARY_AUTOM}-typed-on-the-command-line`;

describe("15. 端末でないとき", () => {
  it("--main と書き込みのコマンドは何もせずにやめる。標準入力に値を流し込んでも読まない", async () => {
    const h = await makeHome([{ title: "svc", password: "pw" }], { token: "t", syncUrl: "http://127.0.0.1:9", vault: "automation" });
    const before = (await readdir(h.dir)).sort();
    const cases: string[][] = [
      ["read", "--main", "svc"],
      ["run", "--main", "--env", "K=svc", "--", "node", "-e", "0"],
      ["auto", "init", "--sync-url", "http://127.0.0.1:9"],
      ["auto", "add", "--title", "new"],
      ["auto", "update", "--title", "svc", "--value"],
      ["auto", "remove", "--title", "svc"],
      ["main", "setup", "--sync-url", "http://127.0.0.1:9"],
    ];
    for (const argv of cases) {
      // 流し込まれた値(答え)は、聞かれないので使われない。通信もしない(既定の fetch は常に失敗する)
      const t = makeCtx(h.dir, { tty: false, answers: ["y", "piped-secret", "piped-secret"] });
      const code = await runPwm(argv, t.ctx);
      expect(code, argv.join(" ")).not.toBe(0);
      expect(t.asked, argv.join(" ")).toEqual([]);
      expect(t.stdout()).toBe("");
      expect(t.stderr()).toContain("terminal");
    }
    expect((await readdir(h.dir)).sort()).toEqual(before);
  });

  it("pwm read(--main なし)は端末でなくても読める(自動処理用の保管庫だけ)", async () => {
    const h = await makeHome([{ title: "svc", password: "pw-value" }]);
    const t = makeCtx(h.dir, { tty: false });
    expect(await runPwm(["read", "svc"], t.ctx)).toBe(0);
    expect(t.stdout()).toBe("pw-value\n");
  });
});

describe("16. 値を引数で受け取らない", () => {
  it("--token、--value=...、--password などは「知らない引数」でやめる。引数の文字列を表示しない", async () => {
    const h = await makeHome([{ title: "svc", password: "pw" }], { token: "t", syncUrl: "http://127.0.0.1:9", vault: "automation" });
    const cases: string[][] = [
      ["auto", "add", "--title", "x", `--value=${SECRET_ARG}`],
      ["auto", "add", "--title", "x", "--value", SECRET_ARG],
      ["auto", "add", "--title", "x", `--password=${SECRET_ARG}`],
      ["auto", "add", "--title", "x", `--notes=${SECRET_ARG}`],
      ["auto", "update", "--title", "svc", `--value=${SECRET_ARG}`],
      ["auto", "update", "--title", "svc", "--password", SECRET_ARG],
      ["auto", "init", `--token=${SECRET_ARG}`],
      ["auto", "init", "--token", SECRET_ARG],
      ["main", "setup", `--password=${SECRET_ARG}`],
      ["main", "setup", `--master-password=${SECRET_ARG}`],
      ["read", `--token=${SECRET_ARG}`, "svc"],
      ["read", `--password=${SECRET_ARG}`, "svc"],
      ["run", `--token=${SECRET_ARG}`, "--env", "K=svc", "--", "node", "-e", "0"],
      ["sync", `--token=${SECRET_ARG}`],
    ];
    for (const argv of cases) {
      const t = makeCtx(h.dir, { answers: ["y", "x", "x"] });
      const code = await runPwm(argv, t.ctx);
      expect(code, argv.join(" ").replace(SECRET_ARG, "***")).not.toBe(0);
      expect(t.asked).toEqual([]); // 何も聞かない(何も書かない)
      expect(t.stdout() + t.stderr()).not.toContain(SECRET_ARG);
    }
  });

  it("ソースに値の引数の口が無い(add/update が受けるのは決めたオプションだけ)", async () => {
    const dir = await tmpHome();
    for (const flag of ["--value=x", "--token=x", "--password=x", "--notes=x"]) {
      const t = makeCtx(dir);
      expect(await runPwm(["auto", "add", "--title", "t", flag], t.ctx)).not.toBe(0);
      expect(t.stderr()).toContain("Unknown or unsupported argument");
    }
  });
});
