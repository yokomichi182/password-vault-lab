import * as kdbxweb from "kdbxweb";
import { describe, expect, it } from "vitest";
import { setupArgon2, openVaultItems, createTokenVault, openTokenVault } from "../src/shared/vault.ts";
import { CANARY } from "./canary.ts";

const MASTER = `master-${CANARY}-dummy`;

async function makeVault(): Promise<Uint8Array> {
  setupArgon2();
  const db = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(MASTER)), "t");
  db.setVersion(4);
  db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
  db.header.kdfParameters!.set("M", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1024 * 1024));
  db.header.kdfParameters!.set("I", kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(1));
  db.header.kdfParameters!.set("P", kdbxweb.VarDictionary.ValueType.UInt32, 1);
  const root = db.getDefaultGroup();
  const mk = (title: string, pw: string, extra: Record<string, string> = {}) => {
    const e = db.createEntry(root);
    e.fields.set("Title", title);
    e.fields.set("UserName", `${title}-user`);
    e.fields.set("Password", kdbxweb.ProtectedValue.fromString(pw));
    e.fields.set("URL", `https://${title}.example.test`);
    for (const [k, v] of Object.entries(extra)) e.fields.set(k, v);
    return e;
  };
  mk("plain", `${CANARY}-1`);
  mk("explicit", `${CANARY}-2`, { ItemType: "password" });
  mk("key", `${CANARY}-3`, { ItemType: "apikey", Environment: "本番" });
  mk("note", `${CANARY}-4`, { ItemType: "note" });
  // ごみ箱の中の項目は写さない
  const bin = db.createGroup(root, "Recycle Bin");
  db.meta.recycleBinUuid = bin.uuid;
  const e = db.createEntry(bin);
  e.fields.set("Title", "trashed");
  e.fields.set("Password", kdbxweb.ProtectedValue.fromString(`${CANARY}-5`));
  return new Uint8Array(await db.save());
}

describe("kdbxweb で Android と同じ属性名の項目が読める", () => {
  it("4. 種類と環境が読め、password は空の種類にそろい、ごみ箱は除く", async () => {
    const items = await openVaultItems(await makeVault(), MASTER);
    const by = new Map(items.map((i) => [i.title, i]));
    expect(items).toHaveLength(4);
    expect(by.get("plain")!.itemType).toBe("");
    expect(by.get("explicit")!.itemType).toBe("");
    expect(by.get("key")!.itemType).toBe("apikey");
    expect(by.get("note")!.itemType).toBe("note");
    expect(by.get("plain")!.password).toBe(`${CANARY}-1`);
    expect(by.get("plain")!.username).toBe("plain-user");
    expect(by.get("plain")!.url).toBe("https://plain.example.test");
    expect(by.has("trashed")).toBe(false);
  });

  it("9. マスターパスワードが違うとき、例外のメッセージに目印が入らない", async () => {
    const bytes = await makeVault();
    await expect(openVaultItems(bytes, `${CANARY}-wrong`)).rejects.toSatisfy((e: Error) => !String(e.message).includes(CANARY));
  });
});

describe("トークン入れ", () => {
  it("マスターパスワードでトークンを取り出せ、違うパスワードでは開けない。バイト列にトークンの平文が無い", async () => {
    const token = `${CANARY}-token`;
    const bytes = await createTokenVault(MASTER, token);
    expect(await openTokenVault(bytes, MASTER)).toBe(token);
    expect(Buffer.from(bytes).includes(Buffer.from(token))).toBe(false);
    await expect(openTokenVault(bytes, "wrong-master")).rejects.toBeInstanceOf(Error);
  });
});
