// pwm fill --title T [--url U]: Chrome 拡張に、開いているタブへの入力を頼む(設計書 §11-3)。
// Native Messaging のホスト pwm-bridge を通す。標準出力に出すのは、結果の語(filled、denied、not_found、locked、unavailable)だけ。
import { sanitizeClientName } from "../approve/protocol.ts";
import { FILL_WAIT_MS, URL_MAX, requestFill } from "../bridge/files.ts";
import { CliError, type Ctx } from "../ctx.ts";
import { parse } from "./args.ts";

export async function cmdFill(ctx: Ctx, args: string[], timeoutMs: number = FILL_WAIT_MS): Promise<number> {
  const p = parse(args, { options: { title: { type: "string" }, url: { type: "string" } } });
  const title = p.values.title ?? "";
  if (title === "") throw new CliError("badTitle");
  const url = p.values.url;
  if (url !== undefined && url.length > URL_MAX) throw new CliError("badUrlArg");
  const result = await requestFill({
    home: ctx.home,
    title,
    ...(url !== undefined ? { url } : {}),
    client: sanitizeClientName("pwm fill (CLI)"),
    timeoutMs,
  });
  ctx.out(result + "\n");
  return result === "filled" ? 0 : 1;
}
