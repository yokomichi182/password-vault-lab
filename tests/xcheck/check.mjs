// 設計書 §13 / §9: Android(kotpass) と PC(kdbxweb) で .kdbx を相互に開けることの確認。
// 使い方: `bash run.sh`（Android が android-made.kdbx を作る → このスクリプトが検証して node-made.kdbx を作る → Android が検証）
// データはすべて架空。パスワードは値を出力せず、一致したかどうかだけを出す。
import { argon2id, argon2d } from 'hash-wasm'
import kdbxweb from 'kdbxweb'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'

const dir = process.env.PWV_XCHECK_DIR ?? path.join(os.homedir(), 'pwvault-build', 'app', 'xcheck')
const MASTER = 'master-CANARY-7f3e9a1c-dummy'
const CANARY = 'CANARY-7f3e9a1c'

kdbxweb.CryptoEngine.setArgon2Impl(async (password, salt, memory, iterations, length, parallelism, type, version) => {
  const fn = type === kdbxweb.CryptoEngine.Argon2TypeArgon2id ? argon2id : argon2d
  const out = await fn({
    password: new Uint8Array(password),
    salt: new Uint8Array(salt),
    memorySize: memory, // KiB
    iterations,
    parallelism,
    hashLength: length,
    outputType: 'binary',
  })
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
})

const toBuf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
const text = (v) => (v == null ? '' : typeof v === 'string' ? v : v.getText())
const uid = (n) => `00000000-0000-0000-0000-${n.toString(16).padStart(12, '0')}`
let passed = 0
const ok = (name) => { passed++; console.log(`ok - ${name}`) }

// 1. Android が作った .kdbx を kdbxweb で開く
const androidFile = path.join(dir, 'android-made.kdbx')
const bytes = fs.readFileSync(androidFile)
const creds = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(MASTER))
const db = await kdbxweb.Kdbx.load(toBuf(new Uint8Array(bytes)), creds)
assert.equal(db.header.versionMajor, 4)
assert.equal(db.header.kdfParameters.get('M').valueOf() !== undefined, true)
ok('kdbxweb が Android 製の KDBX4 を開ける(マスターパスワードで復号)')

const hexOf = (u) => Buffer.from(u.id, 'base64').toString('hex')
const byN = new Map()
for (const entry of db.getDefaultGroup().allEntries()) byN.set(parseInt(hexOf(entry.uuid).slice(-4), 16), entry)
const e1 = byN.get(1)
assert.ok(e1, '項目1が見つからない')
assert.equal(text(e1.fields.get('Title')), 'title1')
assert.equal(text(e1.fields.get('UserName')), 'user1')
assert.equal(text(e1.fields.get('Password')), `${CANARY}-pw1`)
assert.equal(text(e1.fields.get('URL')), 'https://site1.example')
assert.equal(text(e1.fields.get('Notes')), 'memo1')
ok('標準5項目の値が一致する(パスワードは一致可否のみ確認)')

const e2 = byN.get(2)
assert.equal(text(e2.fields.get('AndroidApp')), 'com.example.app')
ok('AndroidApp 属性が読める')

const jp = byN.get(3)
assert.equal(text(jp.fields.get('Title')), '銀行 "A" <b>')
assert.equal(text(jp.fields.get('Notes')), 'メモ\n二行目')
assert.equal(text(jp.fields.get('URL')), 'https://例.jp/?a=1&b=2')
ok('日本語・記号・改行が壊れない')

// 種類(設計書 §2-1): password は属性を書かず、apikey は ItemType と Environment と期限が読める
assert.equal(e1.fields.has('ItemType'), false)
assert.equal(e1.fields.has('Environment'), false)
assert.equal(e1.times.expires, false)
const e4 = byN.get(4)
assert.ok(e4, 'apikey の項目が見つからない')
assert.equal(text(e4.fields.get('Title')), 'apikey-svc')
assert.equal(text(e4.fields.get('ItemType')), 'apikey')
assert.equal(text(e4.fields.get('Environment')), '本番')
assert.equal(e4.times.expires, true)
assert.equal(e4.times.expiryTime.getTime(), 1_900_000_000_000)
assert.equal(text(e4.fields.get('Password')), `${CANARY}-key4`)
assert.ok(e4.fields.get('Password') instanceof kdbxweb.ProtectedValue, 'キーは保護属性(Protected)')
assert.ok(!(e4.fields.get('ItemType') instanceof kdbxweb.ProtectedValue))
assert.ok(!(e4.fields.get('Environment') instanceof kdbxweb.ProtectedValue))
ok('apikey の種類・環境・期限が読め、キーは Protected、password の項目には種類の属性が無い')

assert.equal(db.deletedObjects.some((d) => parseInt(hexOf(d.uuid).slice(-4), 16) === 9), true)
ok('削除記録(DeletedObjects)が読める')

// 2. kdbxweb で作った .kdbx を Android に渡す(Argon2id 64MiB/3回/並列2)
const nodeDb = kdbxweb.Kdbx.create(new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(MASTER)), 'xcheck')
nodeDb.setVersion(4)
nodeDb.setKdf(kdbxweb.Consts.KdfId.Argon2id)
nodeDb.header.kdfParameters.set('M', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(64 * 1024 * 1024))
nodeDb.header.kdfParameters.set('I', kdbxweb.VarDictionary.ValueType.UInt64, kdbxweb.Int64.from(3))
nodeDb.header.kdfParameters.set('P', kdbxweb.VarDictionary.ValueType.UInt32, 2)
const root = nodeDb.getDefaultGroup()
const sub = nodeDb.createGroup(root, '仕事')
const mk = (group, n, title, pw) => {
  const e = nodeDb.createEntry(group)
  e.uuid = new kdbxweb.KdbxUuid(Buffer.from(uid(n).replaceAll('-', ''), 'hex').toString('base64'))
  e.fields.set('Title', title)
  e.fields.set('UserName', `nuser${n}`)
  e.fields.set('Password', kdbxweb.ProtectedValue.fromString(pw))
  e.fields.set('URL', `https://node${n}.example`)
  e.fields.set('Notes', `nmemo${n}`)
  return e
}
mk(root, 0x11, 'node-root', `${CANARY}-n1`)
mk(sub, 0x12, 'node-sub', `${CANARY}-n2`)
const apikey = mk(root, 0x13, 'node-key', `${CANARY}-n3`)
apikey.fields.set('ItemType', 'apikey')
apikey.fields.set('Environment', 'テスト')
apikey.times.expires = true
apikey.times.expiryTime = new Date(1_900_000_000_000)
const out = await nodeDb.save()
fs.writeFileSync(path.join(dir, 'node-made.kdbx'), Buffer.from(out))
ok('kdbxweb で KDBX4 を作成して保存した(Android 側で検証)')

console.log(`passed ${passed}`)
