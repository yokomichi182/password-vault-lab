// pwm audit [--main] [--notify]。既定はローカルの automation.kdbx(同期しない)。--main は read --main と同じく端末のときだけ。
import { auditDeps, auditExitCode, auditVault, formatAudit } from "../audit.ts";
import { CliError, type Ctx } from "../ctx.ts";
import { msg } from "../i18n.ts";
import { parse } from "./args.ts";
import { withSource } from "./cmdRead.ts";

export async function cmdAudit(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { options: { main: { type: "boolean" }, notify: { type: "boolean" } } });
  const main = p.values.main === true;
  const deps = auditDeps(ctx); // PWM_BREACH_URL の誤りは、保管庫を開く前(パスワードを聞く前)に止める
  if (main && !ctx.stdinIsTTY) throw new CliError("needTty");

  const result = await withSource(ctx, main, (db) => auditVault(db, deps));
  ctx.out(formatAudit(result, ctx.lang));

  // 通知は漏洩済みのときだけ。件数だけを書く。失敗しても出力と終了コードは変えない
  if (p.values.notify && result.pwned.length > 0) {
    try {
      await ctx.notify(msg(ctx.lang, "auditNotifyText", { count: result.pwned.length }));
    } catch {
      ctx.err(msg(ctx.lang, "auditNotifyFailed") + "\n");
    }
  }
  return auditExitCode(result);
}
