import { setupArgon2 } from "../../extension/src/shared/vault.ts";
import { kdbxweb } from "../src/kdbx.ts";

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

