import { msg, type Lang, type MsgKey } from "./i18n.ts";

/** 表示してよい文言だけを持つ失敗。メッセージには鍵(i18n のキー)だけを入れ、値は入れない。 */
export class CliError extends Error {
  readonly key: MsgKey;
  readonly params: Record<string, string | number>;
  readonly exitCode: number;
  constructor(key: MsgKey, params: Record<string, string | number> = {}, exitCode = 1) {
    super(key);
    this.name = "CliError";
    this.key = key;
    this.params = params;
    this.exitCode = exitCode;
  }
  text(lang: Lang): string {
    return msg(lang, this.key, this.params);
  }
}

/** DPAPI の包み。単体テストでは偽物に差し替える。 */
export interface Protector {
  protect(data: Uint8Array, entropy: string): Promise<Uint8Array>;
  unprotect(data: Uint8Array, entropy: string): Promise<Uint8Array>;
}

/** 端末からの入力。null は Ctrl+C(何も書かずにやめる)。テストでは差し替える。 */
export interface Prompter {
  hidden(label: string): Promise<string | null>;
  line(label: string): Promise<string | null>;
}

/** コマンドが使う外とのつながり。入口で本物を作り、テストでは差し替える。 */
export interface Ctx {
  home: string;
  lang: Lang;
  protector: Protector;
  fetch: typeof fetch;
  stdinIsTTY: boolean;
  prompt: Prompter;
  out(chunk: string | Uint8Array): void;
  err(chunk: string | Uint8Array): void;
  environ: Record<string, string | undefined>;
  now(): Date;
}

export const ENTROPY_AUTOMATION_KEY = "pwm/automation-key";
export const ENTROPY_AUTOMATION_TOKEN = "pwm/automation-token";
