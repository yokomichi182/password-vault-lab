// pwm audit。ローカルの automation.kdbx を読む(同期しない。read と同じ)。
import { auditDeps, auditExitCode, auditVault, formatAudit } from "../audit.ts";
import { withAutomationDb } from "../automation.ts";
import type { Ctx } from "../ctx.ts";
import { parse } from "./args.ts";

export async function cmdAudit(ctx: Ctx, args: string[]): Promise<number> {
  parse(args, { options: {} });
  const deps = auditDeps(ctx); // PWM_BREACH_URL の誤りは、保管庫を開く前に止める
  const result = await withAutomationDb(ctx, (db) => auditVault(db, deps));
  ctx.out(formatAudit(result, ctx.lang));
  return auditExitCode(result);
}
