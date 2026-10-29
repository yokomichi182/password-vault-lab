import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { setupArgon2 } from "../../extension/src/shared/vault.ts";
import { CliError, ENTROPY_AUTOMATION_KEY, ENTROPY_AUTOMATION_TOKEN, type Ctx, type Prompter, type Protector } from "../src/ctx.ts";
import { createKeyFile, kdbxweb } from "../src/kdbx.ts";
import { FILES } from "../src/store.ts";

// 目印はソースに書かず、実行時に組み立てる(作業フォルダの探査に掛けないため)
export const CANARY_MAIN = ["CANARY", "7f3e9a1c"].join("-");
export const CANARY_AUTOM = ["CANARY", "AUTOM", "ab12cd34"].join("-");
export const MASTER = `master-${CANARY_MAIN}-dummy`;

/** 偽の DPAPI(単体テスト用)。entropy が違えば開けない。守った中身に元のバイト列を残さない。 */
export class FakeProtector implements Protector {
  async protect(data: Uint8Array, entropy: string): Promise<Uint8Array> {
    const pad = Buffer.from(entropy, "utf8");
    const out = new Uint8Array(data.length + 4);
    out.set([0x46, 0x41, 0x4b, 0x45]);
    data.forEach((b, i) => (out[i + 4] = b ^ 0xa5 ^ pad[i % pad.length]!));
    return out;
  }
  async unprotect(data: Uint8Array, entropy: string): Promise<Uint8Array> {
    if (data.length < 4 || data[0] !== 0x46 || data[1] !== 0x41) throw new CliError("dpapiOpen", { code: 2 });
    const pad = Buffer.from(entropy, "utf8");
    const out = new Uint8Array(data.length - 4);
    for (let i = 0; i < out.length; i++) out[i] = data[i + 4]! ^ 0xa5 ^ pad[i % pad.length]!;
    // entropy が違うと中身が壊れる。偽物なので、開けたかは呼び出し側(KDBX)が確かめる
    return out;
  }
}

export interface TestItem {
  title: string;
  username?: string;
  password: string;
  url?: string;
  notes?: string;
  type?: string;
  environment?: string;
  expires?: Date;
}

/** Argon2id を小さくした KDBX4 を作る。keyFile か master のどちらか(または両方)で開く。 */
export async function makeKdbx(
  cred: { keyFile?: Uint8Array; master?: string },
  items: TestItem[],
  opts: { recycleBin?: TestItem[] } = {},
): Promise<Uint8Array> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(
    cred.master !== undefined ? kdbxweb.ProtectedValue.fromString(cred.master) : null,
    cred.keyFile ?? null,
  );
  await creds.ready;
  const db = kdbxweb.Kdbx.create(creds, "t");
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
  db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1));
  db.header.kdfParameters!.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 1);
  const add = (group: Parameters<typeof db.createEntry>[0], it: TestItem) => {
    const e = db.createEntry(group);
    e.fields.set("Title", it.title);
    e.fields.set("UserName", it.username ?? `${it.title}-user`);
    e.fields.set("Password", kdbxweb.ProtectedValue.fromString(it.password));
    e.fields.set("URL", it.url ?? "https://example.test/");
    if (it.notes !== undefined) e.fields.set("Notes", it.notes);
    if (it.type) e.fields.set("ItemType", it.type);
    if (it.environment) e.fields.set("Environment", it.environment);
    if (it.expires) {
      e.times.expires = true;
      e.times.expiryTime = it.expires;
    }
  };
  for (const it of items) add(db.getDefaultGroup(), it);
  if (opts.recycleBin) {
    const bin = db.createGroup(db.getDefaultGroup(), "Recycle Bin");
    db.meta.recycleBinUuid = bin.uuid;
    for (const it of opts.recycleBin) add(bin, it);
  }
  return new Uint8Array(await db.save());
}

const homes: string[] = [];

export async function tmpHome(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pwm-test-"));
  homes.push(dir);
  return dir;
}

export interface Home {
  dir: string;
  keyFile: Uint8Array;
  protector: Protector;
}

/** 自動処理用の保管庫を置いた PWM_HOME を作る。 */
export async function makeHome(
  items: TestItem[],
  opts: { protector?: Protector; token?: string; syncUrl?: string; vault?: string; recycleBin?: TestItem[] } = {},
): Promise<Home> {
  const dir = await tmpHome();
  const protector = opts.protector ?? new FakeProtector();
  const keyFile = await createKeyFile();
  await writeFile(path.join(dir, FILES.automationKdbx), await makeKdbx({ keyFile }, items, { recycleBin: opts.recycleBin }));
  await writeFile(path.join(dir, FILES.automationKey), await protector.protect(keyFile, ENTROPY_AUTOMATION_KEY));
  if (opts.token !== undefined) {
    await writeFile(
      path.join(dir, FILES.automationToken),
      await protector.protect(new Uint8Array(Buffer.from(opts.token, "utf8")), ENTROPY_AUTOMATION_TOKEN),
    );
  }
  if (opts.syncUrl) {
    await writeFile(path.join(dir, FILES.config), JSON.stringify({ syncUrl: opts.syncUrl, automationVault: opts.vault ?? "automation" }));
  }
  return { dir, keyFile, protector };
}

export interface TestRun {
  ctx: Ctx;
  stdout: () => string;
  stderr: () => string;
  /** 聞かれた案内の文言(値は入らない) */
  asked: string[];
}

/** 入力を差し替えたコンテキスト。answers は聞かれた順の答え(null は Ctrl+C)。 */
export function makeCtx(
  home: string,
  opts: {
    protector?: Protector;
    tty?: boolean;
    answers?: (string | null)[];
    fetchImpl?: typeof fetch;
    lang?: "en" | "ja";
    environ?: Record<string, string | undefined>;
  } = {},
): TestRun {
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const answers = [...(opts.answers ?? [])];
  const asked: string[] = [];
  const ask = async (label: string) => {
    asked.push(label);
    return answers.length > 0 ? answers.shift()! : null;
  };
  const prompt: Prompter = { hidden: ask, line: ask };
  const toBuf = (c: string | Uint8Array) => Buffer.from(c as Uint8Array);
  const ctx: Ctx = {
    home,
    lang: opts.lang ?? "en",
    protector: opts.protector ?? new FakeProtector(),
    fetch: opts.fetchImpl ?? (() => Promise.reject(new Error("no network in this test"))),
    stdinIsTTY: opts.tty ?? true,
    prompt,
    out: (c) => void outChunks.push(typeof c === "string" ? Buffer.from(c) : toBuf(c)),
    err: (c) => void errChunks.push(typeof c === "string" ? Buffer.from(c) : toBuf(c)),
    environ: opts.environ ?? { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
    now: () => new Date(),
  };
  return { ctx, stdout: () => Buffer.concat(outChunks).toString("utf8"), stderr: () => Buffer.concat(errChunks).toString("utf8"), asked };
}

// ---- 目印の探査 ----

export const MARKERS = [Buffer.from(CANARY_MAIN), Buffer.from(["CANARY", "AUTOM", ""].join("-"))];

export async function filesContaining(dir: string, needles: Buffer[] = MARKERS): Promise<string[]> {
  const found: string[] = [];
  async function walk(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) {
        const data = await readFile(p);
        if (needles.some((n) => data.includes(n))) found.push(path.relative(dir, p));
      }
    }
  }
  await walk(dir);
  return found;
}

export function hasMarker(text: string): boolean {
  return MARKERS.some((m) => text.includes(m.toString()));
}

/** このテストファイルで作った PWM_HOME の全ファイルに目印が無いこと(19 の最後)を、後始末の前に確かめる。 */
export function registerHomeScan(): void {
  afterAll(async () => {
    const bad: string[] = [];
    for (const h of homes) for (const f of await filesContaining(h)) bad.push(`${path.basename(h)}/${f}`);
    const failed = bad.length > 0;
    for (const h of homes) await rm(h, { recursive: true, force: true }).catch(() => undefined);
    if (failed) throw new Error(`canary found in PWM_HOME files: ${bad.join(", ")}`);
  });
}

