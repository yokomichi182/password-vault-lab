// 本体の保管庫(対話用)。読み取りだけ。このフォルダのモジュールは pwm-mcp から import しない(設計書 §11-2、AGENTS.md の決まり7)。
import { stat } from "node:fs/promises";
import path from "node:path";
import { fetchVault } from "../../../extension/src/shared/sync.ts";
import { createTokenVault, openTokenVault } from "../../../extension/src/shared/vault.ts";
import { openFailure } from "../automation.ts";
import { parse } from "../commands/args.ts";
import { CliError, type Ctx } from "../ctx.ts";
import { msg, type MsgKey } from "../i18n.ts";
import { openWithPassword, type Kdbx } from "../kdbx.ts";
import { DEFAULT_MAIN_VAULT, atomicWrite, checkVaultName, normalizeSyncUrl, readConfig, readIfExists, writeConfig } from "../store.ts";

const MAIN_FILES = {
  tokenKdbx: "main.token.kdbx",
  kdbx: "main.kdbx",
} as const;

async function ask(ctx: Ctx, key: MsgKey): Promise<string> {
  const v = await ctx.prompt.hidden(msg(ctx.lang, key));
  if (v === null) throw new CliError("cancelled", {}, 130);
  return v;
}

function labelOf(e: unknown): string {
  return String(openFailure(e).params.label ?? "");
}

/** pwm main setup [--sync-url URL] [--vault NAME] */
export async function cmdMainSetup(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { options: { "sync-url": { type: "string" }, vault: { type: "string" } } });
  if (!ctx.stdinIsTTY) throw new CliError("needTty");
  const cfg = await readConfig(ctx.home);
  const rawUrl = p.values["sync-url"] ?? cfg.syncUrl;
  if (!rawUrl) throw new CliError("noConfig");
  const syncUrl = normalizeSyncUrl(rawUrl);
  const vault = checkVaultName(p.values.vault ?? cfg.mainVault ?? DEFAULT_MAIN_VAULT);

  const token = await ask(ctx, "promptToken");
  if (token === "") throw new CliError("emptyInput");
  const master = await ask(ctx, "promptMaster");
  if (master === "") throw new CliError("emptyInput");

  const got = await fetchVault(syncUrl, vault, token, ctx.fetch);
  if (got.kind === "auth") throw new CliError("syncAuth");
  if (got.kind === "unreachable") throw new CliError("offlineNoWrite");
  if (got.kind === "empty") throw new CliError("syncEmpty");
  try {
    await openWithPassword(got.bytes, master);
  } catch (e) {
    throw new CliError("cannotOpenServer", { label: labelOf(e) });
  }
  const tokenVault = await createTokenVault(master, token); // 拡張と同じトークン入れ
  // 開けたときだけ置く
  await atomicWrite(path.join(ctx.home, MAIN_FILES.tokenKdbx), tokenVault);
  await atomicWrite(path.join(ctx.home, MAIN_FILES.kdbx), got.bytes);
  await writeConfig(ctx.home, { syncUrl, mainVault: vault });
  ctx.out(msg(ctx.lang, "saved") + "\n");
  return 0;
}

/**
 * 本体の保管庫を読み取りだけで開く(--main)。マスターパスワードは端末の伏せ字の入力だけで受け取る。
 * 通信できないときは前回の暗号文で開き、前回の同期の日時を標準エラーに出す。サーバーの版が開けないときは上書きしない。
 */
export async function withMainDb<T>(ctx: Ctx, fn: (db: Kdbx) => Promise<T> | T): Promise<T> {
  if (!ctx.stdinIsTTY) throw new CliError("needTty");
  const tokenBytes = await readIfExists(path.join(ctx.home, MAIN_FILES.tokenKdbx));
  const cfg = await readConfig(ctx.home);
  if (!tokenBytes || !cfg.syncUrl) throw new CliError("noMain");
  const vault = cfg.mainVault ?? DEFAULT_MAIN_VAULT;

  const master = await ask(ctx, "promptMaster");
  let token: string;
  try {
    token = await openTokenVault(tokenBytes, master);
  } catch (e) {
    throw new CliError("cannotOpen", { label: labelOf(e) });
  }
  const got = await fetchVault(cfg.syncUrl, vault, token, ctx.fetch);
  if (got.kind === "auth") throw new CliError("syncAuth");
  if (got.kind === "empty") throw new CliError("syncEmpty");
  let db: Kdbx;
  if (got.kind === "ok") {
    try {
      db = await openWithPassword(got.bytes, master);
    } catch (e) {
      throw new CliError("cannotOpenServer", { label: labelOf(e) }); // main.kdbx は上書きしない
    }
    await atomicWrite(path.join(ctx.home, MAIN_FILES.kdbx), got.bytes);
  } else {
    const file = path.join(ctx.home, MAIN_FILES.kdbx);
    const cached = await readIfExists(file);
    if (!cached) throw new CliError("noLastSync");
    const at = (await stat(file)).mtime.toISOString();
    ctx.err(msg(ctx.lang, "lastSync", { at }) + "\n");
    try {
      db = await openWithPassword(cached, master);
    } catch (e) {
      throw new CliError("cannotOpen", { label: labelOf(e) });
    }
  }
  return fn(db);
}
