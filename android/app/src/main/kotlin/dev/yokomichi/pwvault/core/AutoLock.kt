package dev.yokomichi.pwvault.core

/** 設計書 §5-3: 自動ロックの判定。時刻は呼び出し側が渡す(端末なしで試せるようにする)。 */
object AutoLock {
    /**
     * 保管庫が開いていて、バックグラウンドに回った時刻が分かっていて([backgroundedAt] が 0 より大きい)、
     * そこから [limitMs] 以上たっていれば true。アプリの画面と自動入力の両方が同じ判定を通る。
     */
    fun due(unlocked: Boolean, backgroundedAt: Long, now: Long, limitMs: Long): Boolean =
        unlocked && backgroundedAt > 0 && now - backgroundedAt >= limitMs
}
