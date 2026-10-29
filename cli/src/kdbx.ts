import * as kdbxwebNs from "kdbxweb";
import { ENVIRONMENT_FIELD, ITEM_TYPE_FIELD, ItemTypes } from "../../extension/src/shared/constants.ts";
import { toArrayBuffer } from "../../extension/src/shared/base64.ts";
import { setupArgon2 } from "../../extension/src/shared/vault.ts";
import { CliError } from "./ctx.ts";

// CommonJS の読み込みで名前空間の default に中身が入る場合に備える(拡張の vault.ts と同じ)
export const kdbxweb = ((kdbxwebNs as unknown as { default?: typeof kdbxwebNs }).default ?? kdbxwebNs) as typeof kdbxwebNs;
export type Kdbx = kdbxwebNs.Kdbx;
export type KdbxEntry = kdbxwebNs.KdbxEntry;

/** 拡張のトークン入れと同じ作り: KDBX4、Argon2id、64MiB、3回、並列2。 */
function applyKdf(db: Kdbx): void {
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(64 * 1024 * 1024));
  db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(3));
  db.header.kdfParameters!.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 2);
}

/** KeePass の XML 形式(版2)のキーファイルを新しく作る。 */
export async function createKeyFile(): Promise<Uint8Array> {
  return kdbxweb.Credentials.createRandomKeyFile(2);
}

/** キーファイルだけで開く保管庫(パスワードなし)の空の1つ目の版を作る。 */
export async function createAutomationVault(keyFile: Uint8Array): Promise<Uint8Array> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(null, keyFile);
  await creds.ready;
  const db = kdbxweb.Kdbx.create(creds, "pwm-automation");
  applyKdf(db);
  return new Uint8Array(await db.save());
}

export async function openWithKeyFile(bytes: Uint8Array, keyFile: Uint8Array): Promise<Kdbx> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(null, keyFile);
  await creds.ready;
  return kdbxweb.Kdbx.load(toArrayBuffer(bytes), creds);
}

export async function openWithPassword(bytes: Uint8Array, master: string): Promise<Kdbx> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(master));
  await creds.ready;
  return kdbxweb.Kdbx.load(toArrayBuffer(bytes), creds);
}

export async function saveDb(db: Kdbx): Promise<Uint8Array> {
  return new Uint8Array(await db.save());
}

export function fieldText(value: kdbxwebNs.KdbxEntryField | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return value.getText();
}

function collect(group: kdbxwebNs.KdbxGroup, binId: string | undefined, out: KdbxEntry[]): void {
  if (binId !== undefined && group.uuid.id === binId) return; // ごみ箱の中は対象にしない
  for (const e of group.entries) out.push(e);
  for (const g of group.groups) collect(g, binId, out);
}

export function liveEntries(db: Kdbx): KdbxEntry[] {
  const bin = db.meta.recycleBinUuid;
  const out: KdbxEntry[] = [];
  collect(db.getDefaultGroup(), bin && !bin.empty ? bin.id : undefined, out);
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 有効期限の日付(今の PC のタイムゾーン)。期限なしは空。 */
export function expiryText(entry: KdbxEntry): string {
  const t = entry.times;
  if (!t.expires || !t.expiryTime) return "";
  const d = t.expiryTime;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** YYYY-MM-DD を、その日の終わり(23:59:59、今の PC のタイムゾーン)の日時にする。Android と同じ。 */
export function parseExpiry(text: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!m) throw new CliError("badExpires");
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d, 23, 59, 59);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) throw new CliError("badExpires");
  return date;
}

export interface Credential {
  title: string;
  username: string;
  password: string;
  url: string;
  notes: string;
  type: string;
  environment: string;
  expires: string;
}

export function toCredential(e: KdbxEntry): Credential {
  const rawType = fieldText(e.fields.get(ITEM_TYPE_FIELD));
  return {
    title: fieldText(e.fields.get("Title")),
    username: fieldText(e.fields.get("UserName")),
    password: fieldText(e.fields.get("Password")),
    url: fieldText(e.fields.get("URL")),
    notes: fieldText(e.fields.get("Notes")),
    type: rawType === "" ? ItemTypes.PASSWORD : rawType,
    environment: fieldText(e.fields.get(ENVIRONMENT_FIELD)),
    expires: expiryText(e),
  };
}

/** タイトルが完全に一致する項目を1件だけ返す。0件・2件以上はエラー(件数だけ出す)。 */
export function findOne(db: Kdbx, title: string): KdbxEntry {
  const hits = liveEntries(db).filter((e) => fieldText(e.fields.get("Title")) === title);
  if (hits.length === 0) throw new CliError("notFound");
  if (hits.length > 1) throw new CliError("ambiguous", { count: hits.length });
  return hits[0]!;
}

/** 欄の名前(小文字)→ 値を返す関数。 */
export const FIELD_READERS: Record<string, (c: Credential) => string> = {
  password: (c) => c.password,
  username: (c) => c.username,
  url: (c) => c.url,
  notes: (c) => c.notes,
  type: (c) => c.type,
  environment: (c) => c.environment,
  expires: (c) => c.expires,
};

/** 参照 `タイトル/欄` を分ける。最後の `/` で分け、`/` が無いときは password。欄の名前は小文字にそろえる。 */
export function parseRef(ref: string): { title: string; field: string } {
  const i = ref.lastIndexOf("/");
  const title = i < 0 ? ref : ref.slice(0, i);
  const field = i < 0 ? "password" : ref.slice(i + 1).toLowerCase();
  if (title === "" || field === "") throw new CliError("badRef");
  if (!Object.hasOwn(FIELD_READERS, field)) throw new CliError("unknownField");
  return { title, field };
}

/** 参照から値を取り出す。 */
export function resolveRef(db: Kdbx, ref: string): string {
  const { title, field } = parseRef(ref);
  return FIELD_READERS[field]!(toCredential(findOne(db, title)));
}
