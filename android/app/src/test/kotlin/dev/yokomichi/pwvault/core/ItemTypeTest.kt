package dev.yokomichi.pwvault.core

import app.keemobile.kotpass.database.KeePassDatabase
import app.keemobile.kotpass.database.encode
import app.keemobile.kotpass.models.EntryValue
import app.keemobile.kotpass.models.Group
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID

private const val CANARY = "CANARY-7f3e9a1c"
private const val MASTER = "master-$CANARY-dummy"
private const val T0 = 1_700_000_000_000L
private const val EXPIRY = 1_900_000_000_000L

private fun uid(n: Int) = UUID(0L, n.toLong()).toString()

private fun login(n: Int, at: Long = T0) =
    Entry(uid(n), "title$n", "user$n", "$CANARY-pw$n", "https://site$n.example", "", "memo$n", at)

private fun key(n: Int, at: Long = T0) =
    Entry(uid(n), "svc$n", "kid$n", "$CANARY-key$n", "https://console$n.example", "", "memo$n", at, ItemTypes.APIKEY, "本番", EXPIRY)

private fun db(bytes: ByteArray): KeePassDatabase.Ver4x {
    val v = KdbxVault.open(bytes, MASTER)
    val f = KdbxVault::class.java.getDeclaredField("db").apply { isAccessible = true }
    return f.get(v) as KeePassDatabase.Ver4x
}

private fun allEntries(d: KeePassDatabase.Ver4x): List<app.keemobile.kotpass.models.Entry> {
    val out = ArrayList<app.keemobile.kotpass.models.Entry>()
    fun walk(g: Group) { out += g.entries; g.groups.forEach(::walk) }
    walk(d.content.group)
    return out
}

private fun roundTrip(data: VaultData): VaultData = KdbxVault.open(KdbxVault.create(MASTER).withData(data).encode(), MASTER).data()

/** 設計書 §2-1: 項目の種類(ItemType)、環境、期限。 */
class ItemTypeTest {
    // テスト1
    @Test
    fun apikey_の種類_環境_期限_値が戻り_値は保護される() {
        val k = key(1)
        val bytes = KdbxVault.create(MASTER).withData(VaultData(listOf(k))).encode()
        val back = KdbxVault.open(bytes, MASTER).data().entries.single()
        assertEquals(k, back)
        assertEquals(ItemTypes.APIKEY, back.itemType)
        assertEquals("本番", back.environment)
        assertEquals(EXPIRY, back.expiresAt)
        assertEquals("$CANARY-key1", back.password)
        val kp = allEntries(db(bytes)).single()
        assertTrue(kp.fields.password is EntryValue.Encrypted, "キーは保護属性(Protected)のまま")
        assertTrue(kp.fields[KdbxVault.ITEM_TYPE_FIELD] is EntryValue.Plain)
        assertTrue(kp.fields[KdbxVault.ENVIRONMENT_FIELD] is EntryValue.Plain)
        assertTrue(kp.times!!.expires)
        assertEquals(Instant.ofEpochMilli(EXPIRY), kp.times!!.expiryTime)
        // 別のカスタム属性に値を置かない
        assertEquals(
            setOf("Title", "UserName", "Password", "URL", "Notes", "ItemType", "Environment"),
            kp.fields.keys.toSet(),
        )
    }

    // テスト3
    @Test
    fun ItemType_の無い項目は_password_として読める() {
        val back = roundTrip(VaultData(listOf(login(1))))
        assertEquals("", back.entries.single().itemType)
        assertTrue(back.entries.single().isLogin)
    }

    // テスト4
    @Test
    fun password_の項目を保存しても_ItemType_は書かれず_開いて保存しても差分が出ない() {
        val bytes = KdbxVault.create(MASTER).withData(VaultData(listOf(login(1), login(2)))).encode()
        assertTrue(allEntries(db(bytes)).none { KdbxVault.ITEM_TYPE_FIELD in it.fields || KdbxVault.ENVIRONMENT_FIELD in it.fields })
        val v = KdbxVault.open(bytes, MASTER)
        val again = v.withData(v.data()).encode()
        // 暗号化した値の比較は避け、属性の名前・時刻・読み出した内容が同じことを見る
        fun shape(b: ByteArray) = allEntries(db(b)).map { Triple(it.fields.keys.toSet(), it.times, it.uuid) }
        assertEquals(shape(bytes), shape(again), "変更していない項目は属性も時刻も変わらない")
        assertEquals(KdbxVault.open(bytes, MASTER).data(), KdbxVault.open(again, MASTER).data())
        assertTrue(allEntries(db(again)).none { KdbxVault.ITEM_TYPE_FIELD in it.fields })
    }

    // テスト5
    @Test
    fun 種類を往復で変えても正しく残り_password_に戻すと属性が消える() {
        val v0 = KdbxVault.create(MASTER).withData(VaultData(listOf(login(1))))
        // password -> apikey
        val toKey = v0.data().entries.single().copy(itemType = ItemTypes.APIKEY, environment = "テスト", expiresAt = EXPIRY, modifiedAt = T0 + 1000)
        val v1 = KdbxVault.open(v0.withData(VaultData(listOf(toKey))).encode(), MASTER)
        assertEquals(toKey, v1.data().entries.single())
        // apikey -> password(環境と期限は空にして戻す)
        val back = toKey.copy(itemType = "", environment = "", expiresAt = null, modifiedAt = T0 + 2000)
        val bytes2 = v1.withData(VaultData(listOf(back))).encode()
        val kp = allEntries(db(bytes2)).single()
        assertFalse(KdbxVault.ITEM_TYPE_FIELD in kp.fields, "password に戻したら ItemType を消す")
        assertFalse(KdbxVault.ENVIRONMENT_FIELD in kp.fields)
        assertFalse(kp.times!!.expires)
        assertEquals(back, KdbxVault.open(bytes2, MASTER).data().entries.single())
    }

    // テスト6
    @Test
    fun マージ_手元で種類を変えサーバーが古いままなら手元が残り_サーバーで新しく変えたらサーバーが残る() {
        val base = login(1, at = T0)
        val serverOld = VaultData(listOf(base))
        val localChanged = VaultData(listOf(base.copy(itemType = ItemTypes.APIKEY, environment = "本番", modifiedAt = T0 + 5000)))
        assertEquals(ItemTypes.APIKEY, VaultMerge.merge(localChanged, serverOld).entries.single().itemType)
        assertEquals("本番", VaultMerge.merge(localChanged, serverOld).entries.single().environment)

        val serverNew = VaultData(listOf(base.copy(itemType = ItemTypes.APIKEY, environment = "テスト", modifiedAt = T0 + 9000)))
        val localOld = VaultData(listOf(base.copy(itemType = ItemTypes.APIKEY, environment = "本番", modifiedAt = T0 + 5000)))
        assertEquals("テスト", VaultMerge.merge(localOld, serverNew).entries.single().environment)
        val toPassword = VaultData(listOf(base.copy(itemType = "", modifiedAt = T0 + 9000)))
        assertEquals("", VaultMerge.merge(localOld, toPassword).entries.single().itemType)

        // KDBX を土台にした実際のマージ(adopt と同じ手順)でも、モデルの種類・環境・期限が残る
        val remoteVault = KdbxVault.create(MASTER).withData(serverOld)
        val merged = remoteVault.withData(VaultMerge.merge(localChanged, remoteVault.data()))
        val out = KdbxVault.open(merged.encode(), MASTER).data().entries.single()
        assertEquals(ItemTypes.APIKEY, out.itemType)
        assertEquals("本番", out.environment)
    }

    // テスト7
    @Test
    fun 知らない種類は文字列のまま書き戻され_isLogin_は_false() {
        val note = login(1).copy(itemType = "note")
        val back = roundTrip(VaultData(listOf(note))).entries.single()
        assertEquals("note", back.itemType)
        assertFalse(back.isLogin)
        // 開いて別の項目だけ変えて書き戻しても、知らない種類は変わらない
        val v = KdbxVault.open(KdbxVault.create(MASTER).withData(VaultData(listOf(note, login(2)))).encode(), MASTER)
        val edited = v.data().entries.map { if (it.uuid == uid(2)) it.copy(notes = "x", modifiedAt = T0 + 1000) else it }
        val again = KdbxVault.open(v.withData(VaultData(edited)).encode(), MASTER).data()
        assertEquals("note", again.entries.single { it.uuid == uid(1) }.itemType)
    }

    // テスト8
    @Test
    fun KeePassXC_が付けた未知の属性と期限は_種類だけ変えても消えない() {
        // KeePassXC が付けたことにする: 未知の属性、期限(有効)。もう1件は期限の印は無いが時刻だけが残っている
        val seed = KdbxVault.create(MASTER).withData(VaultData(listOf(login(1), login(2)))).encode()
        val d = db(seed)
        val xcExpiry = Instant.ofEpochMilli(EXPIRY + 123_000)
        val stale = Instant.ofEpochMilli(1_600_000_000_000)
        fun patch(g: Group): Group = g.copy(
            entries = g.entries.map { kp ->
                when (kp.uuid.toString()) {
                    uid(1) -> kp.copy(
                        fields = kp.fields + ("KPXC_Custom" to EntryValue.Plain("keep-me")),
                        times = kp.times!!.copy(expires = true, expiryTime = xcExpiry),
                    )
                    else -> kp.copy(times = kp.times!!.copy(expires = false, expiryTime = stale))
                }
            },
            groups = g.groups.map(::patch),
        )
        val out = ByteArrayOutputStream()
        d.copy(content = d.content.copy(group = patch(d.content.group))).encode(out)
        val v = KdbxVault.open(out.toByteArray(), MASTER)
        val data = v.data()
        assertEquals(xcExpiry.toEpochMilli(), data.entries.single { it.uuid == uid(1) }.expiresAt)
        assertNull(data.entries.single { it.uuid == uid(2) }.expiresAt)

        // 種類だけ変える(期限は触らない)
        val changed = data.entries.map { it.copy(itemType = ItemTypes.APIKEY, modifiedAt = T0 + 5000) }
        val after = allEntries(db(v.withData(VaultData(changed)).encode()))
        val e1 = after.single { it.uuid.toString() == uid(1) }
        assertEquals("keep-me", e1.fields["KPXC_Custom"]?.content)
        assertEquals("apikey", e1.fields[KdbxVault.ITEM_TYPE_FIELD]?.content)
        assertTrue(e1.times!!.expires)
        assertEquals(xcExpiry, e1.times!!.expiryTime, "期限の時刻は変わらない")
        val e2 = after.single { it.uuid.toString() == uid(2) }
        assertFalse(e2.times!!.expires)
        assertEquals(stale, e2.times!!.expiryTime, "期限の印が無い項目の時刻も消さない")

        // 期限を消すと印だけが外れる
        val cleared = changed.map { it.copy(expiresAt = null, modifiedAt = T0 + 9000) }
        val e1c = allEntries(db(v.withData(VaultData(cleared)).encode())).single { it.uuid.toString() == uid(1) }
        assertFalse(e1c.times!!.expires)
        assertEquals("keep-me", e1c.fields["KPXC_Custom"]?.content)
    }

    // テスト9
    @Test
    fun CSV_の取り込みで作った項目はすべて_password() {
        val csv = "name,url,username,password\na,https://a.example,u1,$CANARY-1\nb,https://b.example,u2,$CANARY-2\n"
        val r = CsvImport.import(csv, emptyList(), now = T0)
        assertEquals(2, r.entries.size)
        assertTrue(r.entries.all { it.itemType.isEmpty() && it.isLogin && it.environment.isEmpty() && it.expiresAt == null })
        assertTrue(roundTrip(VaultData(r.entries)).entries.all { it.isLogin && it.itemType.isEmpty() })
    }

    // テスト10
    @Test
    fun isLogin_は_apikey_と知らない値で_false() {
        assertTrue(login(1).isLogin)
        assertTrue(login(1).copy(itemType = ItemTypes.PASSWORD).isLogin)
        assertFalse(key(1).isLogin)
        assertFalse(login(1).copy(itemType = "note").isLogin)
        assertFalse(login(1).copy(itemType = "APIKEY").isLogin)
        assertFalse(login(1).copy(itemType = " ").isLogin)
    }

    // テスト11(一部): 値が文字列表現と例外に出ない
    @Test
    fun apikey_の値が_toString_と例外のメッセージに出ない() {
        assertFalse(CANARY in key(1).toString())
        val bytes = KdbxVault.create(MASTER).withData(VaultData(listOf(key(1)))).encode()
        val ex = org.junit.jupiter.api.Assertions.assertThrows(Exception::class.java) { KdbxVault.open(bytes, "wrong-$CANARY") }
        assertFalse(CANARY in ex.toString() || CANARY in (ex.message ?: ""))
        assertFalse(CANARY in String(bytes, Charsets.ISO_8859_1))
    }

    // テスト12
    @Test
    fun 一覧の検索は_値_Password_では当たらず_タイトル_ユーザー名_URL_環境で当たる() {
        val list = listOf(login(1), key(2))
        assertTrue(EntryView.filter(list, CANARY, KindFilter.ALL).isEmpty())
        assertTrue(EntryView.filter(list, "key2", KindFilter.ALL).isEmpty())
        assertEquals(listOf(uid(2)), EntryView.filter(list, "svc2", KindFilter.ALL).map { it.uuid })
        assertEquals(listOf(uid(2)), EntryView.filter(list, "kid2", KindFilter.ALL).map { it.uuid })
        assertEquals(listOf(uid(2)), EntryView.filter(list, "console2", KindFilter.ALL).map { it.uuid })
        assertEquals(listOf(uid(2)), EntryView.filter(list, "本番", KindFilter.ALL).map { it.uuid })
        assertEquals(listOf(uid(1)), EntryView.filter(list, "site1", KindFilter.ALL).map { it.uuid })
    }

    @Test
    fun 絞り込みの_その他_は_すべて_にだけ出る() {
        val other = login(3).copy(itemType = "note")
        val list = listOf(login(1), key(2), other)
        assertEquals(3, EntryView.filter(list, "", KindFilter.ALL).size)
        assertEquals(listOf(uid(1)), EntryView.filter(list, "", KindFilter.PASSWORD).map { it.uuid })
        assertEquals(listOf(uid(2)), EntryView.filter(list, "", KindFilter.API_KEY).map { it.uuid })
    }

    @Test
    fun 期限の表示は_期限切れと30日以内() {
        val now = T0
        val day = 86_400_000L
        fun st(at: Long?) = EntryView.expiry(login(1).copy(expiresAt = at), now)
        assertEquals(ExpiryState.NONE, st(null))
        assertEquals(ExpiryState.EXPIRED, st(now - 1))
        assertEquals(ExpiryState.SOON, st(now + 29 * day))
        assertEquals(ExpiryState.SOON, st(now + 30 * day))
        assertEquals(ExpiryState.OK, st(now + 31 * day))
    }
}

class EnvironmentChoiceTest {
    @Test
    fun choicesAreFixedRegardlessOfLocale() {
        val saved = java.util.Locale.getDefault()
        try {
            java.util.Locale.setDefault(java.util.Locale.ENGLISH)
            assertEquals(listOf("本番", "テスト"), ItemTypes.ENVIRONMENT_CHOICES)
            assertEquals("本番", ItemTypes.ENV_PRODUCTION)
            // 英語表示でも「本番」で保存され、KDBX を往復しても変わらない
            val e = Entry(uid(1), "svc", "kid", "$CANARY-k", "", "", "", T0, ItemTypes.APIKEY, ItemTypes.ENV_PRODUCTION, null)
            val back = roundTrip(VaultData(listOf(e))).entries.single()
            assertEquals("本番", back.environment)
        } finally { java.util.Locale.setDefault(saved) }
    }

    @Test
    fun freeTextEnvironmentIsKept() {
        val e = Entry(uid(2), "svc", "kid", "$CANARY-k", "", "", "", T0, ItemTypes.APIKEY, "staging-eu", null)
        val back = roundTrip(VaultData(listOf(e))).entries.single()
        assertEquals("staging-eu", back.environment)
    }
}
