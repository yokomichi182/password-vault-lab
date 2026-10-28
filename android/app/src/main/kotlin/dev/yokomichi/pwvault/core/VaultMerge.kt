package dev.yokomichi.pwvault.core

/** 設計書 §4-3: 項目の UUID と最終更新日時で、項目単位にマージする。 */
object VaultMerge {
    fun merge(local: VaultData, remote: VaultData): VaultData {
        val deleted = HashMap<String, Long>()
        for (source in listOf(local.deleted, remote.deleted)) {
            for ((id, at) in source) deleted[id] = maxOf(at, deleted[id] ?: at)
        }

        val newest = LinkedHashMap<String, Entry>()
        for (e in local.entries + remote.entries) {
            val cur = newest[e.uuid]
            if (cur == null || e.modifiedAt > cur.modifiedAt) newest[e.uuid] = e
        }
        // 削除より後に更新された項目は残す。削除のほうが新しい（同時刻を含む）なら消す
        val kept = newest.values.filter { e ->
            val del = deleted[e.uuid]
            del == null || e.modifiedAt > del
        }
        val stillDeleted = deleted.filter { (id, at) ->
            val e = newest[id]
            e == null || e.modifiedAt <= at
        }
        return VaultData(kept, stillDeleted)
    }
}
