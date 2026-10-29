import { describe, expect, it } from "vitest";
import { detectLang } from "../src/i18n.ts";
import { runPwm } from "../src/pwm.ts";
import { makeCtx, registerHomeScan, tmpHome } from "./helpers.ts";

registerHomeScan();

describe("10. 文言", () => {
  it("PWM_LANG で ja と en が切り替わる", () => {
    expect(detectLang({ PWM_LANG: "ja" })).toBe("ja");
    expect(detectLang({ PWM_LANG: "en" })).toBe("en");
  });

  it("エラーの文言が言語ごとに切り替わる", async () => {
    const home = await tmpHome();
    const en = makeCtx(home, { lang: "en" });
    const ja = makeCtx(home, { lang: "ja" });
    expect(await runPwm(["read", "x/password"], en.ctx)).not.toBe(0);
    expect(await runPwm(["read", "x/password"], ja.ctx)).not.toBe(0);
    expect(en.stderr()).toContain("automation vault is not set up");
    expect(ja.stderr()).toContain("自動処理用の保管庫がありません");
    expect(en.stderr()).not.toBe(ja.stderr());
  });
});
