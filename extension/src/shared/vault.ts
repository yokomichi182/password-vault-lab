import { argon2id, argon2d } from "hash-wasm";
import * as kdbxweb from "kdbxweb";
import { ENVIRONMENT_FIELD, ITEM_TYPE_FIELD, ItemTypes } from "./constants.ts";
import { toArrayBuffer } from "./base64.ts";

// 暗号処理は kdbxweb + hash-wasm(Argon2 の WASM)に任せる。tests/xcheck/check.mjs と同じ使い方。
let argon2Ready = false;
export function setupArgon2(): void {
  if (argon2Ready) return;
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type) => {
      const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d;
      const out = await fn({
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        memorySize: Number(memory), // KiB
        iterations: Number(iterations),
        parallelism: Number(parallelism),
        hashLength: Number(length),
        outputType: "binary",
      });
      return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
    },
  );
  argon2Ready = true;
}

/** セッションに置く、写した1項目。 */
export interface VaultItem {
  id: string;
  title: string;
  username: string;
  password: string;
  url: string;
  /** 空はパスワード(`password` も空にそろえる)。知らない値は文字列のまま。 */
  itemType: string;
}

function fieldText(value: kdbxweb.KdbxEntryField | undefined): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return value.getText();
}

function toItem(entry: kdbxweb.KdbxEntry): VaultItem {
  const rawType = fieldText(entry.fields.get(ITEM_TYPE_FIELD));
  return {
    id: entry.uuid.id,
    title: fieldText(entry.fields.get("Title")),
    username: fieldText(entry.fields.get("UserName")),
    password: fieldText(entry.fields.get("Password")),
    url: fieldText(entry.fields.get("URL")),
    itemType: rawType === ItemTypes.PASSWORD ? "" : rawType,
  };
}

/** 環境(API キー用)は読まないが、属性名を持っておくために公開する。 */
export function readEnvironment(entry: kdbxweb.KdbxEntry): string {
  return fieldText(entry.fields.get(ENVIRONMENT_FIELD));
}

function collect(group: kdbxweb.KdbxGroup, binId: string | undefined, out: kdbxweb.KdbxEntry[]): void {
  if (binId !== undefined && group.uuid.id === binId) return; // ごみ箱の中は一覧に出さない(Android と同じ)
  for (const e of group.entries) out.push(e);
  for (const g of group.groups) collect(g, binId, out);
}

/** 保管庫を開いて項目を写す。マスターパスワードが違う、または壊れているときは例外(値は含まない)。 */
export async function openVaultItems(bytes: Uint8Array, masterPassword: string): Promise<VaultItem[]> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const db = await kdbxweb.Kdbx.load(toArrayBuffer(bytes), creds);
  const binUuid = db.meta.recycleBinUuid;
  const entries: kdbxweb.KdbxEntry[] = [];
  collect(db.getDefaultGroup(), binUuid && !binUuid.empty ? binUuid.id : undefined, entries);
  return entries.map(toItem);
}

// ---- 同期トークン入れ(マスターパスワードで鍵をかけた小さな KDBX。項目1つの Password にトークン) ----

const TOKEN_ENTRY_TITLE = "sync-token";

export async function createTokenVault(masterPassword: string, token: string): Promise<Uint8Array> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const db = kdbxweb.Kdbx.create(creds, "pwvault-token");
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(64 * 1024 * 1024));
  db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(3));
  db.header.kdfParameters!.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 2);
  const entry = db.createEntry(db.getDefaultGroup());
  entry.fields.set("Title", TOKEN_ENTRY_TITLE);
  entry.fields.set("Password", kdbxweb.ProtectedValue.fromString(token));
  return new Uint8Array(await db.save());
}

/** トークンを取り出す。マスターパスワードが違うときは例外(値は含まない)。 */
export async function openTokenVault(bytes: Uint8Array, masterPassword: string): Promise<string> {
  setupArgon2();
  const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(masterPassword));
  const db = await kdbxweb.Kdbx.load(toArrayBuffer(bytes), creds);
  for (const e of db.getDefaultGroup().entries) {
    if (fieldText(e.fields.get("Title")) === TOKEN_ENTRY_TITLE) return fieldText(e.fields.get("Password"));
  }
  throw new Error("token entry missing");
}
