import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { errorLabel } from "../../extension/src/shared/vault.ts";
import { cmdAutoAdd, cmdAutoInit, cmdAutoList, cmdAutoRemove, cmdAutoUpdate, cmdSync } from "./commands/cmdAuto.ts";
import { cmdRead, cmdRun } from "./commands/cmdRead.ts";
import { CliError, type Ctx } from "./ctx.ts";
import { windowsDpapi } from "./dpapi.ts";
import { detectLang, msg } from "./i18n.ts";
import { cmdMainSetup } from "./main/mainVault.ts";
import { ttyPrompter } from "./prompt.ts";
import { pwmHome } from "./store.ts";

const USAGE = `pwm - CLI for the automation vault (and read-only access to the main vault)

  pwm auto init [--sync-url URL] [--vault NAME]
  pwm auto add --title T [--username U] [--url URL] [--type password|apikey] [--env E] [--expires YYYY-MM-DD] [--notes]
  pwm auto update --title T [--username U] [--url URL] [--env E] [--expires YYYY-MM-DD] [--value]
  pwm auto remove --title T
  pwm auto list
  pwm sync
  pwm main setup [--sync-url URL] [--vault NAME]
  pwm read [--main] [--no-newline] TITLE[/FIELD]
  pwm run [--main] --env NAME=TITLE[/FIELD] [--env ...] [--timeout SECONDS] -- COMMAND [ARGS...]
`;

/** コマンドを実行して終了コードを返す。失敗は値を含まない文言にして標準エラーに出す。 */
export async function runPwm(argv: string[], ctx: Ctx): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case "auto": {
        const [sub, ...args] = rest;
        if (sub === "init") return await cmdAutoInit(ctx, args);
        if (sub === "add") return await cmdAutoAdd(ctx, args);
        if (sub === "update") return await cmdAutoUpdate(ctx, args);
        if (sub === "remove") return await cmdAutoRemove(ctx, args);
        if (sub === "list") return await cmdAutoList(ctx, args);
        break;
      }
      case "sync":
        return await cmdSync(ctx, rest);
      case "main":
        if (rest[0] === "setup") return await cmdMainSetup(ctx, rest.slice(1));
        break;
      case "read":
        return await cmdRead(ctx, rest);
      case "run":
        return await cmdRun(ctx, rest);
      default:
        break;
    }
    ctx.err(USAGE);
    return 2;
  } catch (e) {
    if (e instanceof CliError) {
      ctx.err(`pwm: ${e.text(ctx.lang)}\n`);
      return e.exitCode;
    }
    ctx.err(`pwm: ${msg(ctx.lang, "unexpected", { label: errorLabel(e) })}\n`);
    return 1;
  }
}

export function realCtx(): Ctx {
  const environ = process.env as Record<string, string | undefined>;
  return {
    home: pwmHome(environ),
    lang: detectLang(environ),
    protector: windowsDpapi,
    fetch,
    stdinIsTTY: process.stdin.isTTY === true,
    prompt: ttyPrompter,
    out: (c) => void process.stdout.write(c),
    err: (c) => void process.stderr.write(c),
    environ,
    now: () => new Date(),
  };
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
  runPwm(process.argv.slice(2), realCtx()).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
