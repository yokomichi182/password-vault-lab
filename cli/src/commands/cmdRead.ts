// pwm read と pwm run。--main が無ければローカルの automation.kdbx だけを読み、通信しない。
import { withAutomationDb } from "../automation.ts";
import { CliError, type Ctx } from "../ctx.ts";
import { parseRef, resolveRef, type Kdbx } from "../kdbx.ts";
import { withMainDb } from "../main/mainVault.ts";
import { parseEnvSpec, runChild } from "../run.ts";
import { parse, splitDashDash } from "./args.ts";

export function withSource<T>(ctx: Ctx, main: boolean, fn: (db: Kdbx) => Promise<T> | T): Promise<T> {
  return main ? withMainDb(ctx, fn) : withAutomationDb(ctx, fn);
}

export async function cmdRead(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    options: { main: { type: "boolean" }, "no-newline": { type: "boolean" } },
    allowPositionals: true,
  });
  if (p.positionals.length !== 1) throw new CliError("badRef");
  const ref = p.positionals[0]!;
  parseRef(ref); // 形と欄の名前を先に確かめる(パスワードを聞く前に)
  const main = p.values.main === true;
  if (main && !ctx.stdinIsTTY) throw new CliError("needTty");
  const value = await withSource(ctx, main, (db) => resolveRef(db, ref));
  ctx.out(p.values["no-newline"] ? value : value + "\n");
  return 0;
}

export async function cmdRun(ctx: Ctx, args: string[]): Promise<number> {
  const { before, after } = splitDashDash(args);
  const p = parse(before, {
    options: { main: { type: "boolean" }, env: { type: "string", multiple: true }, timeout: { type: "string" } },
  });
  const specs = (p.values.env ?? []).map((s) => parseEnvSpec(s, ctx.environ));
  if (specs.length === 0) throw new CliError("noEnv");
  if (new Set(specs.map((s) => s.name.toLowerCase())).size !== specs.length) throw new CliError("badEnvSpec");
  for (const s of specs) parseRef(s.ref);
  if (!after || after.length === 0) throw new CliError("noCommand");
  let timeoutSec = 600;
  if (p.values.timeout !== undefined) {
    timeoutSec = Number(p.values.timeout);
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) throw new CliError("badTimeout");
  }
  const main = p.values.main === true;
  if (main && !ctx.stdinIsTTY) throw new CliError("needTty");

  const resolved = await withSource(ctx, main, (db) => specs.map((s) => ({ name: s.name, value: resolveRef(db, s.ref) })));
  const extraEnv: Record<string, string> = {};
  for (const r of resolved) extraEnv[r.name] = r.value;
  return runChild({
    command: after,
    extraEnv,
    baseEnv: ctx.environ,
    values: resolved.map((r) => r.value),
    timeoutMs: timeoutSec * 1000,
    stdin: "inherit",
    onStdout: (b) => ctx.out(b),
    onStderr: (b) => ctx.err(b),
  });
}
