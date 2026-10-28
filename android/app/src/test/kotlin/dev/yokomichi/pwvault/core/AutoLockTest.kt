package dev.yokomichi.pwvault.core

import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** 実装指示 4-1 の 15: 自動ロックの判定(時刻は注入する)。 */
class AutoLockTest {
    private val limit = 5 * 60_000L
    private val t0 = 1_700_000_000_000L

    @Test
    fun バックグラウンドに回ってから設定の時間を過ぎていればロックする() {
        assertTrue(AutoLock.due(true, t0, t0 + limit, limit))
        assertTrue(AutoLock.due(true, t0, t0 + limit + 1, limit))
        assertTrue(AutoLock.due(true, t0, t0 + 60_000L, 60_000L))
    }

    @Test
    fun 時間の前ならロックしない() {
        assertFalse(AutoLock.due(true, t0, t0 + limit - 1, limit))
        assertFalse(AutoLock.due(true, t0, t0, limit))
    }

    @Test
    fun すでにロック中_またはバックグラウンドに回っていないときは何もしない() {
        assertFalse(AutoLock.due(false, t0, t0 + limit * 10, limit))
        assertFalse(AutoLock.due(true, 0L, t0 + limit * 10, limit))
    }
}
