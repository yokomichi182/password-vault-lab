import * as kdbxweb from "kdbxweb";
import { setupArgon2 } from "../src/shared/vault.ts";
import { CANARY } from "./canary.ts";

export const MASTER = `master-${CANARY}-dummy`;

export interface FakeItem {
  title: string;
  password: string;
  url?: string;
  extra?: Record<string, string>;
}

/** 速く開けるよう Argon2id を小さくした、架空の KDBX4 を作る。 */
export async function makeKdbx(master: string, items: FakeItem[]): Promise<Uint8Array> {
  setupArgon2();
  const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(master)), "t");
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
  db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1));
  db.header.kdfParameters!.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 1);
  const root = db.getDefaultGroup();
  for (const it of items) {
    const e = db.createEntry(root);
    e.fields.set("Title", it.title);
    e.fields.set("UserName", `${it.title}-user`);
    e.fields.set("Password", kdbxweb.ProtectedValue.fromString(it.password));
    e.fields.set("URL", it.url ?? `https://${it.title}.example.test`);
    for (const [k, v] of Object.entries(it.extra ?? {})) e.fields.set(k, v);
  }
  return new Uint8Array(await db.save());
}
