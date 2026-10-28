package dev.yokomichi.pwvault.core

import app.keemobile.kotpass.constants.BasicField
import app.keemobile.kotpass.cryptography.EncryptedValue
import app.keemobile.kotpass.database.Credentials
import app.keemobile.kotpass.database.KeePassDatabase
import app.keemobile.kotpass.database.decode
import app.keemobile.kotpass.database.encode
import app.keemobile.kotpass.database.header.KdfParameters
import app.keemobile.kotpass.models.DeletedObject
import app.keemobile.kotpass.models.Entry as KpEntry
import app.keemobile.kotpass.models.EntryFields
import app.keemobile.kotpass.models.EntryValue
import app.keemobile.kotpass.models.FormatVersion
import app.keemobile.kotpass.models.Group
import app.keemobile.kotpass.models.Meta
import app.keemobile.kotpass.models.TimeData
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.util.UUID

/**
 * 設計書 §2: 保管庫は KDBX4。暗号処理は kotpass に任せ、ここでは [VaultData] との変換だけを行う。
 *
 * 読み込んだ KDBX の構造（グループ、ごみ箱、未知の属性）はそのまま持ち回り、
 * 書き出すときは項目の差分だけを反映する。ごみ箱の中の項目は一覧に出さず、書き出しでも触らない。
 */
class KdbxVault private constructor(private val db: KeePassDatabase) {

    /** 一覧に出す項目と、削除の記録。modifiedAt は KDBX の精度に合わせて秒単位。 */
    fun data(): VaultData {
        val bin = db.content.meta.recycleBinUuid
        val entries = ArrayList<Entry>()
        fun walk(g: Group) {
            if (g.uuid == bin) return
            g.entries.mapTo(entries, ::toEntry)
            g.groups.forEach(::walk)
        }
        walk(db.content.group)
        val deleted = db.content.deletedObjects.associate { it.id.toString() to it.deletionTime.toEpochMilli() }
        return VaultData(entries, deleted)
    }

    /** [data] の内容に合わせた新しい保管庫を返す。この保管庫自体は変えない。 */
    fun withData(data: VaultData): KdbxVault {
        val bin = db.content.meta.recycleBinUuid
        val byId = data.entries.associateBy { it.uuid }
        // ごみ箱の中の項目は一覧に無いので、「新規の項目」として二重に作らない
        val binIds = HashSet<String>()
        fun collectBin(g: Group, inside: Boolean) {
            val now = inside || g.uuid == bin
            if (now) g.entries.forEach { binIds += it.uuid.toString() }
            g.groups.forEach { collectBin(it, now) }
        }
        collectBin(db.content.group, false)

        val placed = HashSet<String>()
        fun rebuild(g: Group, isRoot: Boolean): Group {
            if (g.uuid == bin) return g
            val kept = g.entries.mapNotNull { kp ->
                val e = byId[kp.uuid.toString()] ?: return@mapNotNull null
                placed += e.uuid
                applyTo(kp, e)
            }
            val groups = g.groups.map { rebuild(it, false) }
            return g.copy(entries = kept, groups = groups)
        }
        val rebuilt = rebuild(db.content.group, true)
        val added = data.entries.filter { it.uuid !in placed && it.uuid !in binIds }.map(::fromEntry)
        val root = rebuilt.copy(entries = rebuilt.entries + added)
        val deletedObjects = data.deleted.map { (id, at) ->
            DeletedObject(UUID.fromString(id), Instant.ofEpochMilli(at))
        }
        val content = db.content.copy(group = root, deletedObjects = deletedObjects)
        return KdbxVault(
            when (db) {
                is KeePassDatabase.Ver4x -> db.copy(content = content)
                is KeePassDatabase.Ver3x -> db.copy(content = content)
            },
        )
    }

    /** KDBX4 のファイルとして書き出す。マスターパスワードは作成・読み込み時のものを使う。 */
    fun encode(): ByteArray {
        val out = ByteArrayOutputStream()
        db.encode(out)
        return out.toByteArray()
    }

    companion object {
        /** 設計書 §2: Argon2id（メモリ 64MiB、反復 3 回、並列 2）。 */
        fun create(masterPassword: String, name: String = "pwvault"): KdbxVault {
            val base = KeePassDatabase.Ver4x.create(
                rootName = name,
                meta = Meta(name = name, generator = "pwvault"),
                credentials = Credentials.from(EncryptedValue.fromString(masterPassword)),
            )
            val kdf = base.header.kdfParameters as KdfParameters.Argon2
            return KdbxVault(
                base.copy(
                    header = base.header.copy(
                        version = FormatVersion(4, 0),
                        kdfParameters = kdf.copy(
                            variant = KdfParameters.Argon2.Variant.Argon2id,
                            memory = 64UL * 1024UL * 1024UL,
                            iterations = 3U,
                            parallelism = 2U,
                        ),
                    ),
                ),
            )
        }

        /** パスワードが違う、または壊れたファイルのときは kotpass の例外がそのまま上がる（値は含まない）。 */
        fun open(bytes: ByteArray, masterPassword: String): KdbxVault =
            KdbxVault(
                KeePassDatabase.decode(
                    ByteArrayInputStream(bytes),
                    Credentials.from(EncryptedValue.fromString(masterPassword)),
                ),
            )

        const val ANDROID_APP_FIELD = "AndroidApp"
        // 設計書 §2-1: 値(password / apikey)は ItemTypes。Environment は値ではないので保護しない
        const val ITEM_TYPE_FIELD = "ItemType"
        const val ENVIRONMENT_FIELD = "Environment"

        private fun toEntry(kp: KpEntry): Entry = Entry(
            uuid = kp.uuid.toString(),
            title = kp.fields.title?.content.orEmpty(),
            username = kp.fields.userName?.content.orEmpty(),
            password = kp.fields.password?.content.orEmpty(),
            url = kp.fields.url?.content.orEmpty(),
            androidPackage = kp.fields[ANDROID_APP_FIELD]?.content.orEmpty(),
            notes = kp.fields.notes?.content.orEmpty(),
            modifiedAt = (kp.times?.lastModificationTime ?: Instant.EPOCH).toEpochMilli(),
            // password は「属性なし」と同じ扱いにする(開いて保存しただけで差分を出さない)
            itemType = kp.fields[ITEM_TYPE_FIELD]?.content.orEmpty().let { if (it == ItemTypes.PASSWORD) "" else it },
            environment = kp.fields[ENVIRONMENT_FIELD]?.content.orEmpty(),
            expiresAt = expiresOf(kp),
        )

        private fun expiresOf(kp: KpEntry): Long? =
            kp.times?.takeIf { it.expires }?.expiryTime?.toEpochMilli()

        /** 種類と環境の属性。空のときは属性を書かない(applyTo では消す)。 */
        private fun withExtraFields(fields: EntryFields, e: Entry): EntryFields {
            var f = fields
            f = if (e.itemType.isEmpty()) f - ITEM_TYPE_FIELD else f + (ITEM_TYPE_FIELD to EntryValue.Plain(e.itemType))
            f = if (e.environment.isEmpty()) f - ENVIRONMENT_FIELD else f + (ENVIRONMENT_FIELD to EntryValue.Plain(e.environment))
            return f
        }

        private fun fieldsFor(e: Entry): List<Pair<String, EntryValue>> = buildList {
            add(BasicField.Title() to EntryValue.Plain(e.title))
            add(BasicField.UserName() to EntryValue.Plain(e.username))
            add(BasicField.Password() to EntryValue.Encrypted(EncryptedValue.fromString(e.password)))
            add(BasicField.Url() to EntryValue.Plain(e.url))
            add(BasicField.Notes() to EntryValue.Plain(e.notes))
        }

        private fun fromEntry(e: Entry): KpEntry {
            val at = Instant.ofEpochMilli(e.modifiedAt)
            var fields = KpEntry(UUID.fromString(e.uuid)).fields + fieldsFor(e)
            if (e.androidPackage.isNotEmpty()) fields += ANDROID_APP_FIELD to EntryValue.Plain(e.androidPackage)
            fields = withExtraFields(fields, e)
            val times = TimeData.create(at)
            return KpEntry(
                uuid = UUID.fromString(e.uuid),
                fields = fields,
                times = e.expiresAt?.let { times.copy(expires = true, expiryTime = Instant.ofEpochMilli(it)) } ?: times,
            )
        }

        /** 既存の項目に変更が無ければそのまま返す（履歴や未知の属性を壊さない）。 */
        private fun applyTo(kp: KpEntry, e: Entry): KpEntry {
            if (toEntry(kp) == e) return kp
            var fields = kp.fields + fieldsFor(e)
            fields = if (e.androidPackage.isEmpty()) fields - ANDROID_APP_FIELD
            else fields + (ANDROID_APP_FIELD to EntryValue.Plain(e.androidPackage))
            fields = withExtraFields(fields, e)
            var times = (kp.times ?: TimeData.create()).copy(lastModificationTime = Instant.ofEpochMilli(e.modifiedAt))
            // 期限を変えていないときは、KeePassXC が付けた期限の時刻や印をそのまま残す
            if (e.expiresAt != expiresOf(kp)) {
                times = if (e.expiresAt == null) times.copy(expires = false)
                else times.copy(expires = true, expiryTime = Instant.ofEpochMilli(e.expiresAt))
            }
            return kp.copy(fields = fields, times = times)
        }
    }
}
