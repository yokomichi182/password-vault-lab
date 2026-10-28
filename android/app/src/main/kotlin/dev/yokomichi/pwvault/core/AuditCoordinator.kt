package dev.yokomichi.pwvault.core

/** 設計書 §14: 漏洩チェックの結果。項目名と件数だけで、パスワードは持たない。excluded は種類が対象外の件数。 */
data class AuditReport(
    val at: Long,
    val breached: List<AuditItem>,
    val cleanCount: Int,
    val skippedCount: Int,
    val excludedCount: Int = 0,
)

/** 端末内に置く結果(§14-3)。持つのは uuid・日時・出現回数・前回のチェック時刻だけ。 */
interface AuditRecorder {
    /** 手動か自動で、最後に実際に調べた時刻。0 は一度もない。 */
    var lastRunAt: Long
    fun record(uuid: String, result: BreachResult, at: Long)
    fun touch(uuid: String, at: Long)
    fun forget(uuid: String)
}

/** 自動チェックで漏洩を検出したときの通知。出すのは項目名と出現回数まで。 */
interface BreachNotifier {
    fun canNotify(): Boolean
    fun notifyBreached(items: List<Pair<String, Int>>)
}

/**
 * 漏洩チェックの3つの経路(保存後・手動・ロック解除時)をまとめる。どの経路も [Entry.isLogin] を通し、
 * 種類がパスワードでない項目のハッシュは計算も送信もしない(§14-3)。Android の Context には依存しない。
 */
class AuditCoordinator(
    private val checker: () -> BreachChecker,
    private val recorder: AuditRecorder,
    private val notifier: BreachNotifier? = null,
    private val now: () -> Long = System::currentTimeMillis,
) {
    /**
     * 保存の直後に呼ぶ。送るべきなら SHA-1 を返す(バックグラウンドへはハッシュだけを渡す)。
     * 種類がパスワードでなければ null で、前回の結果も捨てる。パスワードが新しくなったときと、
     * API キーからパスワードに戻したときは、保存後に1回調べる。
     */
    fun onSaved(old: Entry?, new: Entry): String? {
        if (!new.isLogin) {
            recorder.forget(new.uuid)
            return null
        }
        val changed = old == null || !old.isLogin || old.password != new.password
        if (changed) return if (new.password.isNotEmpty()) BreachChecker.sha1Hex(new.password) else null
        recorder.touch(new.uuid, now())
        return null
    }

    /** [onSaved] が返したハッシュを1件調べて記録する(通信するのでメインスレッドで呼ばない)。 */
    fun checkOne(uuid: String, hash: String): BreachResult {
        val result = runCatching { checker().checkHash(hash) }.getOrDefault(BreachResult.Skipped)
        recorder.record(uuid, result, now())
        return result
    }

    /** 手動のチェック。対象外の件数は、オフラインのスキップとは別に数える。 */
    fun auditAll(entries: List<Entry>): AuditReport {
        val targets = entries.filter { it.isLogin }
        val items = checker().audit(targets)
        val at = now()
        items.forEach { recorder.record(it.uuid, it.result, at) }
        // 全件がスキップ(オフライン)のときは、前回のチェックの時刻を進めない
        if (items.any { it.result != BreachResult.Skipped }) recorder.lastRunAt = at
        return AuditReport(
            at = at,
            breached = items.filter { it.result is BreachResult.Breached },
            cleanCount = items.count { it.result == BreachResult.Clean },
            skippedCount = items.count { it.result == BreachResult.Skipped },
            excludedCount = entries.size - targets.size,
        )
    }

    /** ロック解除時に走らせるか。設定が有効で、Wi-Fi で、前回から 7 日以上(一度もなければ)のとき。 */
    fun autoDue(enabled: Boolean, onWifi: Boolean): Boolean {
        if (!enabled || !onWifi) return false
        val last = recorder.lastRunAt
        return last == 0L || now() - last >= INTERVAL_MS
    }

    /**
     * ロック解除時の自動チェック。走らせない条件のときは null。
     * 漏洩があり、通知が許可されているときだけシステムの通知を出す。結果は常に返すので、アプリ内にも出せる。
     */
    fun runAuto(entries: List<Entry>, enabled: Boolean, onWifi: Boolean): AuditReport? {
        if (!autoDue(enabled, onWifi)) return null
        val report = auditAll(entries)
        val n = notifier
        if (report.breached.isNotEmpty() && n != null && n.canNotify()) {
            n.notifyBreached(report.breached.map { it.title to (it.result as BreachResult.Breached).count })
        }
        return report
    }

    companion object {
        const val INTERVAL_MS = 7L * 24 * 60 * 60 * 1000
    }
}
