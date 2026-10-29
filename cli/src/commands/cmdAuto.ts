// 自動処理用の保管庫の作成・追加・変更・削除・一覧(人が端末で行う)と、pwm sync。
import path from "node:path";
import { ItemTypes, ENVIRONMENT_FIELD, ITEM_TYPE_FIELD } from "../../../extension/src/shared/constants.ts";
import { fetchVault } from "../../../extension/src/shared/sync.ts";
import { errorLabel } from "../../../extension/src/shared/vault.ts";
import { loadAutomationKey, loadAutomationToken, openFailure, withAutomationDb } from "../automation.ts";
import { CliError, ENTROPY_AUTOMATION_KEY, ENTROPY_AUTOMATION_TOKEN, type Ctx } from "../ctx.ts";
import {
  createAutomationVault,
  createKeyFile,
  fieldText,
  findOne,
  kdbxweb,
  liveEntries,
  openWithKeyFile,
  parseExpiry,
  saveDb,
  toCredential,
  type Kdbx,
} from "../kdbx.ts";
import {
  DEFAULT_AUTOMATION_VAULT,
  FILES,
  atomicWrite,
  checkVaultName,
  normalizeSyncUrl,
  readConfig,
  readIfExists,
  writeConfig,
} from "../store.ts";
import { msg, type MsgKey } from "../i18n.ts";
import { putVault } from "../syncClient.ts";
import { parse } from "./args.ts";

const MAX_ATTEMPTS = 3;

function requireTty(ctx: Ctx): void {
  if (!ctx.stdinIsTTY) throw new CliError("needTty");
}

async function askHidden(ctx: Ctx, label: MsgKey): Promise<string> {
  const v = await ctx.prompt.hidden(msg(ctx.lang, label));
  if (v === null) throw new CliError("cancelled", {}, 130);
  return v;
}

async function askValueTwice(ctx: Ctx): Promise<string> {
  const a = await askHidden(ctx, "promptValue");
  if (a === "") throw new CliError("emptyInput");
  const b = await askHidden(ctx, "promptValueAgain");
  if (a !== b) throw new CliError("mismatch");
  return a;
}

// ---- init ----

export async function cmdAutoInit(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { options: { "sync-url": { type: "string" }, vault: { type: "string" } } });
  requireTty(ctx);
  const cfg = await readConfig(ctx.home);
  const rawUrl = p.values["sync-url"] ?? cfg.syncUrl;
  if (!rawUrl) throw new CliError("noConfig");
  const syncUrl = normalizeSyncUrl(rawUrl);
  const vault = checkVaultName(p.values.vault ?? cfg.automationVault ?? DEFAULT_AUTOMATION_VAULT);

  const token = await askHidden(ctx, "promptToken");
  if (token === "") throw new CliError("emptyInput");

  // サーバーにすでに版があるときは作らない(そのキーファイルが手元にないので開けない)
  const got = await fetchVault(syncUrl, vault, token, ctx.fetch);
  if (got.kind === "ok") throw new CliError("serverHasVersion");
  if (got.kind === "auth") throw new CliError("syncAuth");
  if (got.kind === "unreachable") throw new CliError("offlineNoWrite");

  const keyFile = await createKeyFile();
  let protectedKey: Uint8Array;
  let protectedToken: Uint8Array;
  let bytes: Uint8Array;
  try {
    bytes = await createAutomationVault(keyFile);
    protectedKey = await ctx.protector.protect(keyFile, ENTROPY_AUTOMATION_KEY);
    protectedToken = await ctx.protector.protect(new Uint8Array(Buffer.from(token, "utf8")), ENTROPY_AUTOMATION_TOKEN);
  } finally {
    keyFile.fill(0);
  }

  const put = await putVault(syncUrl, vault, token, bytes, 0, ctx.fetch);
  if (put.kind === "conflict") throw new CliError("serverHasVersion");
  if (put.kind === "auth") throw new CliError("syncAuth");
  if (put.kind === "unreachable") throw new CliError("offlineNoWrite");
  if (put.kind === "rejected") throw new CliError("syncRejected", { status: put.status });

  // 成功したときだけ置く
  await atomicWrite(path.join(ctx.home, FILES.automationKey), protectedKey);
  await atomicWrite(path.join(ctx.home, FILES.automationToken), protectedToken);
  await atomicWrite(path.join(ctx.home, FILES.automationKdbx), bytes);
  await writeConfig(ctx.home, { syncUrl, automationVault: vault });
  ctx.out(msg(ctx.lang, "created") + "\n");
  return 0;
}

// ---- 書き込み(最新の版に変更を当てて PUT。409 なら当て直す) ----

async function mutate(ctx: Ctx, apply: (db: Kdbx) => void | Promise<void>): Promise<number> {
  const cfg = await readConfig(ctx.home);
  if (!cfg.syncUrl) throw new CliError("noAutomation");
  const vault = cfg.automationVault ?? DEFAULT_AUTOMATION_VAULT;
  const key = await loadAutomationKey(ctx);
  try {
    const token = await loadAutomationToken(ctx);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const got = await fetchVault(cfg.syncUrl, vault, token, ctx.fetch);
      if (got.kind === "auth") throw new CliError("syncAuth");
      if (got.kind === "unreachable") throw new CliError("offlineNoWrite");
      if (got.kind === "empty") throw new CliError("syncEmpty");
      let db: Kdbx;
      try {
        db = await openWithKeyFile(got.bytes, key);
      } catch (e) {
        const f = openFailure(e);
        throw new CliError("cannotOpenServer", { label: String(f.params.label ?? "") });
      }
      await apply(db);
      const bytes = await saveDb(db);
      const put = await putVault(cfg.syncUrl, vault, token, bytes, got.version, ctx.fetch);
      if (put.kind === "ok") {
        await atomicWrite(path.join(ctx.home, FILES.automationKdbx), bytes);
        ctx.out(msg(ctx.lang, "saved") + "\n");
        return 0;
      }
      if (put.kind === "conflict") continue;
      if (put.kind === "auth") throw new CliError("syncAuth");
      if (put.kind === "unreachable") throw new CliError("offlineNoWrite");
      throw new CliError("syncRejected", { status: put.kind === "rejected" ? put.status : 0 });
    }
    throw new CliError("conflictGiveUp", { count: MAX_ATTEMPTS });
  } finally {
    key.fill(0);
  }
}

function isUnique(db: Kdbx, title: string): boolean {
  return !liveEntries(db).some((e) => fieldText(e.fields.get("Title")) === title);
}

// ---- add ----

export async function cmdAutoAdd(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    options: {
      title: { type: "string" },
      username: { type: "string" },
      url: { type: "string" },
      type: { type: "string" },
      env: { type: "string" },
      expires: { type: "string" },
      notes: { type: "boolean" },
    },
  });
  requireTty(ctx);
  const v = p.values;
  const title = v.title ?? "";
  if (title === "") throw new CliError("badTitle");
  const type = v.type ?? ItemTypes.PASSWORD;
  if (type !== ItemTypes.PASSWORD && type !== ItemTypes.APIKEY) throw new CliError("badItemType");
  const expires = v.expires ? parseExpiry(v.expires) : undefined;

  const value = await askValueTwice(ctx);
  const notes = v.notes ? await askHidden(ctx, "promptNotes") : "";

  return mutate(ctx, (db) => {
    if (!isUnique(db, title)) throw new CliError("duplicateTitle");
    const e = db.createEntry(db.getDefaultGroup());
    e.fields.set("Title", title);
    e.fields.set("UserName", v.username ?? "");
    e.fields.set("Password", kdbxweb.ProtectedValue.fromString(value));
    e.fields.set("URL", v.url ?? "");
    if (notes !== "") e.fields.set("Notes", notes);
    if (type !== ItemTypes.PASSWORD) e.fields.set(ITEM_TYPE_FIELD, type); // password は属性を書かない
    if (v.env) e.fields.set(ENVIRONMENT_FIELD, v.env);
    if (expires) {
      e.times.expires = true;
      e.times.expiryTime = expires;
    }
  });
}

// ---- update ----

export async function cmdAutoUpdate(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, {
    options: {
      title: { type: "string" },
      username: { type: "string" },
      url: { type: "string" },
      env: { type: "string" },
      expires: { type: "string" },
      value: { type: "boolean" },
    },
  });
  requireTty(ctx);
  const v = p.values;
  const title = v.title ?? "";
  if (title === "") throw new CliError("badTitle");
  if (v.username === undefined && v.url === undefined && v.env === undefined && v.expires === undefined && !v.value) {
    throw new CliError("nothingToChange");
  }
  const expires = v.expires === undefined ? undefined : v.expires === "" ? null : parseExpiry(v.expires);
  const value = v.value ? await askValueTwice(ctx) : undefined;

  return mutate(ctx, (db) => {
    const e = findOne(db, title);
    e.pushHistory();
    if (v.username !== undefined) e.fields.set("UserName", v.username);
    if (v.url !== undefined) e.fields.set("URL", v.url);
    if (v.env !== undefined) {
      if (v.env === "") e.fields.delete(ENVIRONMENT_FIELD);
      else e.fields.set(ENVIRONMENT_FIELD, v.env);
    }
    if (expires !== undefined) {
      if (expires === null) e.times.expires = false;
      else {
        e.times.expires = true;
        e.times.expiryTime = expires;
      }
    }
    if (value !== undefined) e.fields.set("Password", kdbxweb.ProtectedValue.fromString(value));
    e.times.update();
  });
}

// ---- remove ----

export async function cmdAutoRemove(ctx: Ctx, args: string[]): Promise<number> {
  const p = parse(args, { options: { title: { type: "string" } } });
  requireTty(ctx);
  const title = p.values.title ?? "";
  if (title === "") throw new CliError("badTitle");
  const answer = await ctx.prompt.line(msg(ctx.lang, "confirmRemove"));
  if (answer === null || answer.trim().toLowerCase() !== "y") throw new CliError("cancelled", {}, 130);

  return mutate(ctx, (db) => {
    const e = findOne(db, title);
    db.move(e, null); // ごみ箱に入れず、DeletedObjects に記録する(db.remove はごみ箱が有効だと移すだけになる)
  });
}

// ---- list(ローカルのファイルだけ。値を出さない) ----

export async function cmdAutoList(ctx: Ctx, args: string[]): Promise<number> {
  parse(args, { options: {} });
  const rows = await withAutomationDb(ctx, (db) =>
    liveEntries(db).map((e) => {
      const c = toCredential(e);
      return `${c.title}\t${c.type}\t${c.environment}`;
    }),
  );
  ctx.out(rows.length > 0 ? rows.join("\n") + "\n" : "");
  return 0;
}

// ---- sync ----

export async function cmdSync(ctx: Ctx, args: string[]): Promise<number> {
  parse(args, { options: {} });
  const cfg = await readConfig(ctx.home);
  if (!cfg.syncUrl) throw new CliError("noAutomation");
  const vault = cfg.automationVault ?? DEFAULT_AUTOMATION_VAULT;
  const key = await loadAutomationKey(ctx);
  try {
    const token = await loadAutomationToken(ctx);
    const got = await fetchVault(cfg.syncUrl, vault, token, ctx.fetch);
    if (got.kind === "unreachable") throw new CliError("syncSkipped", {}, 2);
    if (got.kind === "auth") throw new CliError("syncAuth");
    if (got.kind === "empty") throw new CliError("syncEmpty");
    // キーファイルで開けたときだけ置き換える(設計書 §4 の6)
    try {
      await openWithKeyFile(got.bytes, key);
    } catch (e) {
      const label = errorLabelFor(e);
      throw new CliError("cannotOpenServer", { label });
    }
    const target = path.join(ctx.home, FILES.automationKdbx);
    const before = await readIfExists(target);
    if (before) await atomicWrite(path.join(ctx.home, FILES.automationBak), before);
    await atomicWrite(target, got.bytes);
    ctx.out(msg(ctx.lang, "syncDone", { version: got.version }) + "\n");
    return 0;
  } finally {
    key.fill(0);
  }
}

function errorLabelFor(e: unknown): string {
  const f = openFailure(e);
  return String(f.params.label ?? errorLabel(e));
}
