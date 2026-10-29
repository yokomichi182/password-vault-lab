// 自動処理用の保管庫を、ローカルのファイルだけから開く(通信しない)。pwm-mcp もここだけを使う。
import path from "node:path";
import { errorLabel, isInvalidKeyError } from "../../extension/src/shared/vault.ts";
import { CliError, ENTROPY_AUTOMATION_KEY, ENTROPY_AUTOMATION_TOKEN, type Ctx } from "./ctx.ts";
import { openWithKeyFile, type Kdbx } from "./kdbx.ts";
import { FILES, readIfExists } from "./store.ts";

export async function loadAutomationKey(ctx: Ctx): Promise<Uint8Array> {
  const protectedKey = await readIfExists(path.join(ctx.home, FILES.automationKey));
  if (!protectedKey) throw new CliError("noAutomation");
  return ctx.protector.unprotect(protectedKey, ENTROPY_AUTOMATION_KEY);
}

export async function loadAutomationToken(ctx: Ctx): Promise<string> {
  const protectedToken = await readIfExists(path.join(ctx.home, FILES.automationToken));
  if (!protectedToken) throw new CliError("noAutomation");
  const bytes = await ctx.protector.unprotect(protectedToken, ENTROPY_AUTOMATION_TOKEN);
  const text = Buffer.from(bytes).toString("utf8");
  bytes.fill(0);
  return text;
}

/** 鍵を開く問題と、壊れているなどの問題を分けて、値を含まない失敗にする。 */
export function openFailure(e: unknown): CliError {
  if (e instanceof CliError) return e;
  return new CliError("cannotOpen", { label: isInvalidKeyError(e) ? "key" : errorLabel(e) });
}

/**
 * ローカルの automation.kdbx を、DPAPI で開いたキーファイルで開き、1回の処理の間だけ使う。
 * 終わったら参照を捨てる(キーファイルのバイト列は0で埋める)。
 */
export async function withAutomationDb<T>(ctx: Ctx, fn: (db: Kdbx) => Promise<T> | T): Promise<T> {
  const bytes = await readIfExists(path.join(ctx.home, FILES.automationKdbx));
  if (!bytes) throw new CliError("noAutomation");
  const key = await loadAutomationKey(ctx);
  try {
    let db: Kdbx;
    try {
      db = await openWithKeyFile(bytes, key);
    } catch (e) {
      throw openFailure(e);
    }
    return await fn(db);
  } finally {
    key.fill(0);
  }
}
