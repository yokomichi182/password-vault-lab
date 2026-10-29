import { parseArgs, type ParseArgsConfig } from "node:util";
import { CliError } from "../ctx.ts";

/**
 * parseArgs を strict で呼ぶ。知らない引数は「知らない引数」とだけ出す
 * (`--value=...` のような引数に値が載っていても、エラーの文言に入れない)。
 */
export function parse<T extends ParseArgsConfig>(
  args: string[],
  config: T,
): ReturnType<typeof parseArgs<T>> {
  try {
    return parseArgs({ ...config, args, strict: true, allowPositionals: config.allowPositionals ?? false }) as unknown as ReturnType<typeof parseArgs<T>>;
  } catch {
    throw new CliError("unknownArg");
  }
}

/** `--` の前と後に分ける。`--` が無ければ後は空。 */
export function splitDashDash(args: string[]): { before: string[]; after: string[] | null } {
  const i = args.indexOf("--");
  if (i < 0) return { before: args, after: null };
  return { before: args.slice(0, i), after: args.slice(i + 1) };
}
