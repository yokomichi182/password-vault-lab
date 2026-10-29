import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_VAULT_NAME, VAULT_NAME_RE } from "../../extension/src/shared/constants.ts";
import { CliError } from "./ctx.ts";

// 置くファイルの名前(本体の保管庫のファイル名は main/ の中だけに書く)
export const FILES = {
  config: "config.json",
  automationKdbx: "automation.kdbx",
  automationBak: "automation.kdbx.bak",
  automationKey: "automation.key.dpapi",
  automationToken: "automation.token.dpapi",
} as const;

export const DEFAULT_AUTOMATION_VAULT = "automation";
export const DEFAULT_MAIN_VAULT = DEFAULT_VAULT_NAME;

export function pwmHome(environ: Record<string, string | undefined>): string {
  const fromEnv = environ.PWM_HOME;
  if (fromEnv) return path.resolve(fromEnv);
  const local = environ.LOCALAPPDATA;
  if (!local) throw new Error("LOCALAPPDATA is not set");
  return path.join(local, "pwm");
}

/** 一時ファイルに書いてから名前を変える(途中で落ちても壊れたファイルを残さない)。 */
export async function atomicWrite(file: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export async function readIfExists(file: string): Promise<Uint8Array | null> {
  try {
    return new Uint8Array(await readFile(file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

export interface Config {
  syncUrl?: string;
  automationVault?: string;
  mainVault?: string;
}

export async function readConfig(home: string): Promise<Config> {
  const raw = await readIfExists(path.join(home, FILES.config));
  if (!raw) return {};
  try {
    const j = JSON.parse(Buffer.from(raw).toString("utf8")) as Record<string, unknown>;
    const out: Config = {};
    if (typeof j.syncUrl === "string") out.syncUrl = j.syncUrl;
    if (typeof j.automationVault === "string" && VAULT_NAME_RE.test(j.automationVault)) out.automationVault = j.automationVault;
    if (typeof j.mainVault === "string" && VAULT_NAME_RE.test(j.mainVault)) out.mainVault = j.mainVault;
    return out;
  } catch {
    return {};
  }
}

export async function writeConfig(home: string, patch: Config): Promise<void> {
  const cur = await readConfig(home);
  await atomicWrite(path.join(home, FILES.config), JSON.stringify({ ...cur, ...patch }, null, 2) + "\n");
}

/** 同期先の URL を検証してオリジンにそろえる。https、または localhost 系の http だけ。 */
export function normalizeSyncUrl(text: string): string {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CliError("badSyncUrl");
  }
  const h = url.hostname;
  const local = h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h.endsWith(".localhost");
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return url.origin;
  throw new CliError("badSyncUrl");
}

export function checkVaultName(name: string): string {
  if (!VAULT_NAME_RE.test(name)) throw new CliError("badVaultName");
  return name;
}
