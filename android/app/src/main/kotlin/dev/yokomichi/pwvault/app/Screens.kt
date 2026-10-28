package dev.yokomichi.pwvault.app

import android.content.Context
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.yokomichi.pwvault.core.Entry
import dev.yokomichi.pwvault.core.HistoryItem
import dev.yokomichi.pwvault.core.PasswordGenerator
import kotlinx.coroutines.launch

private fun readText(ctx: Context, uri: Uri): String =
    ctx.contentResolver.openInputStream(uri)!!.use { String(it.readBytes(), Charsets.UTF_8) }

private fun readBytes(ctx: Context, uri: Uri): ByteArray =
    ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }

@Composable
fun App(m: AppModel) {
    Scaffold { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(horizontal = 16.dp)) {
            m.message?.let {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    TextButton({ m.message = null }) { Text("閉じる") }
                }
            }
            if (m.busy) Text("処理中…", color = MaterialTheme.colorScheme.primary)
            when (val s = m.screen) {
                Screen.Setup -> SetupScreen(m)
                Screen.Unlock -> UnlockScreen(m)
                Screen.List -> ListScreen(m)
                is Screen.Detail -> DetailScreen(m, s.uuid)
                is Screen.Edit -> EditScreen(m, s.uuid)
                Screen.Settings -> SettingsScreen(m)
            }
        }
    }
}

@Composable
private fun PasswordField(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier) {
    var show by remember { mutableStateOf(false) }
    OutlinedTextField(
        value, onChange, modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true,
        visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        trailingIcon = { TextButton({ show = !show }) { Text(if (show) "隠す" else "表示") } },
    )
}

/** 設計書 §5-2 の 1: 初期設定。新規作成、または .kdbx の取り込み。CSV は作成時に一緒に取り込める。 */
@Composable
private fun SetupScreen(m: AppModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var master by remember { mutableStateOf("") }
    var confirm by remember { mutableStateOf("") }
    var csv by remember { mutableStateOf<String?>(null) }
    var kdbx by remember { mutableStateOf<ByteArray?>(null) }
    val pickCsv = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        if (u != null) csv = runCatching { readText(ctx, u) }.getOrNull()
    }
    val pickKdbx = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        if (u != null) kdbx = runCatching { readBytes(ctx, u) }.getOrNull()
    }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("初期設定", style = MaterialTheme.typography.headlineSmall)
        Text("マスターパスワードは復元できません。忘れると保管庫を開けなくなります。")
        PasswordField(master, { master = it }, "マスターパスワード")
        if (kdbx == null) PasswordField(confirm, { confirm = it }, "マスターパスワード(確認)")
        Text(
            if (kdbx != null) "取り込む .kdbx を選択済み" else if (csv != null) "取り込む CSV を選択済み" else "取り込むデータ: なし",
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ pickKdbx.launch(arrayOf("*/*")) }) { Text(".kdbx を選ぶ") }
            OutlinedButton({ pickCsv.launch(arrayOf("text/*", "*/*")) }) { Text("CSV を選ぶ") }
        }
        val ok = master.length >= 8 && (kdbx != null || master == confirm) && !m.busy
        Button(
            onClick = {
                scope.launch {
                    val k = kdbx
                    if (k != null) m.importKdbx(k, master) else m.create(master, csv)
                }
            },
            enabled = ok,
        ) { Text(if (kdbx != null) "取り込む" else "作成する") }
        if (master.isNotEmpty() && master.length < 8) Text("8 文字以上にしてください")
        if (kdbx == null && confirm.isNotEmpty() && master != confirm) Text("確認用が一致しません")
    }
}

@Composable
private fun UnlockScreen(m: AppModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var master by remember { mutableStateOf("") }
    val bio = m.biometric.enabled
    // 設計書 §5-3: 生体認証で取り出したマスターパスワードで開く
    fun unlockWithBiometric() {
        val activity = ctx.findActivity() ?: return
        val cipher = m.biometric.decryptCipher()
        if (cipher == null) {
            m.message = "生体認証の登録が無効になりました。マスターパスワードで開いて、設定で登録し直してください"
            return
        }
        authenticate(
            activity, cipher, "保管庫を開く",
            onSuccess = { c ->
                val pw = m.biometric.open(c)
                if (pw == null) m.message = "生体認証で開けませんでした" else scope.launch { m.unlock(pw) }
            },
            onFailure = { if (it.isNotEmpty()) m.message = it },
        )
    }
    LaunchedEffect(Unit) { if (bio) unlockWithBiometric() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("ロック解除", style = MaterialTheme.typography.headlineSmall)
        PasswordField(master, { master = it }, "マスターパスワード")
        Button(
            onClick = {
                scope.launch {
                    m.unlock(master)
                    master = ""
                }
            },
            enabled = master.isNotEmpty() && !m.busy,
        ) { Text("開く") }
        if (bio) OutlinedButton({ unlockWithBiometric() }, enabled = !m.busy) { Text("生体認証で開く") }
    }
}

/** 設計書 §5-2 の 3: 一覧と検索。 */
@Composable
private fun ListScreen(m: AppModel) {
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    val shown = remember(m.entries, q) {
        val k = q.trim().lowercase()
        if (k.isEmpty()) m.entries
        else m.entries.filter { listOf(it.title, it.username, it.url).any { s -> k in s.lowercase() } }
    }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("保管庫 (${m.entries.size})", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            TextButton({ m.screen = Screen.Settings }) { Text("設定") }
            TextButton({ m.lock() }) { Text("ロック") }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(q, { q = it }, Modifier.weight(1f), label = { Text("検索") }, singleLine = true)
            Button({ m.screen = Screen.Edit(null) }) { Text("追加") }
        }
        Text(
            when {
                m.pendingSync -> "未同期の変更があります"
                else -> m.lastSync ?: ""
            },
            style = MaterialTheme.typography.bodySmall,
        )
        if (shown.isEmpty()) Text("該当する項目がありません", Modifier.padding(top = 24.dp))
        LazyColumn(Modifier.fillMaxSize()) {
            items(shown, key = { it.uuid }) { e ->
                Column(Modifier.fillMaxWidth().clickable { m.screen = Screen.Detail(e.uuid) }.padding(vertical = 10.dp)) {
                    Text(e.title.ifEmpty { "(無題)" }, style = MaterialTheme.typography.titleMedium)
                    Text(listOf(e.username, e.url).filter { it.isNotEmpty() }.joinToString("  "), style = MaterialTheme.typography.bodySmall)
                }
                HorizontalDivider()
            }
        }
    }
    LaunchedEffectOnce { if (m.settings.syncConfigured && m.lastSync == null) scope.launch { m.sync() } }
}

@Composable
private fun LaunchedEffectOnce(block: () -> Unit) {
    androidx.compose.runtime.LaunchedEffect(Unit) { block() }
}

/** 設計書 §5-2 の 4: 項目の詳細。 */
@Composable
private fun DetailScreen(m: AppModel, uuid: String) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    BackHandler { m.screen = Screen.List }
    val e = m.entries.firstOrNull { it.uuid == uuid }
    if (e == null) {
        m.screen = Screen.List
        return
    }
    var reveal by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton({ m.screen = Screen.List }) { Text("戻る") }
            Text(e.title.ifEmpty { "(無題)" }, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            TextButton({ m.screen = Screen.Edit(e.uuid) }) { Text("編集") }
        }
        Field("ユーザー名", e.username) { Clip.copySensitive(ctx, "ユーザー名", e.username) }
        Field("パスワード", if (reveal) e.password else "••••••••••") { Clip.copySensitive(ctx, "パスワード", e.password) }
        TextButton({ reveal = !reveal }) { Text(if (reveal) "パスワードを隠す" else "パスワードを表示") }
        Field("URL", e.url) { Clip.copySensitive(ctx, "URL", e.url) }
        if (e.androidPackage.isNotEmpty()) Field("Android アプリ", e.androidPackage) { }
        if (e.notes.isNotEmpty()) Field("メモ", e.notes) { }
        Text("コピーした内容は 30 秒後に消えます", style = MaterialTheme.typography.bodySmall)
        OutlinedButton({ confirmDelete = true }) { Text("削除") }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text("削除しますか") },
            text = { Text("「${e.title}」を削除します。他の端末にも同期されます。") },
            confirmButton = { TextButton({ confirmDelete = false; scope.launch { m.delete(e.uuid) } }) { Text("削除する") } },
            dismissButton = { TextButton({ confirmDelete = false }) { Text("やめる") } },
        )
    }
}

@Composable
private fun Field(label: String, value: String, onCopy: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelMedium)
            Text(value.ifEmpty { "-" })
        }
        if (value.isNotEmpty()) TextButton(onCopy) { Text("コピー") }
    }
}

/** 設計書 §5-2 の 4・5: 編集とパスワード生成。 */
@Composable
private fun EditScreen(m: AppModel, uuid: String?) {
    val scope = rememberCoroutineScope()
    val base = remember(uuid) { uuid?.let { id -> m.entries.firstOrNull { it.uuid == id } } ?: m.newEntry() }
    BackHandler { m.screen = if (uuid != null) Screen.Detail(uuid) else Screen.List }
    var title by remember { mutableStateOf(base.title) }
    var user by remember { mutableStateOf(base.username) }
    var pw by remember { mutableStateOf(base.password) }
    var url by remember { mutableStateOf(base.url) }
    var pkg by remember { mutableStateOf(base.androidPackage) }
    var notes by remember { mutableStateOf(base.notes) }
    var gen by remember { mutableStateOf(false) }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (uuid == null) "項目の追加" else "項目の編集", style = MaterialTheme.typography.titleLarge)
        OutlinedTextField(title, { title = it }, Modifier.fillMaxWidth(), label = { Text("タイトル") }, singleLine = true)
        OutlinedTextField(user, { user = it }, Modifier.fillMaxWidth(), label = { Text("ユーザー名") }, singleLine = true)
        PasswordField(pw, { pw = it }, "パスワード")
        OutlinedButton({ gen = true }) { Text("パスワードを生成") }
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("URL") }, singleLine = true)
        OutlinedTextField(pkg, { pkg = it }, Modifier.fillMaxWidth(), label = { Text("Android のパッケージ名") }, singleLine = true)
        OutlinedTextField(notes, { notes = it }, Modifier.fillMaxWidth(), label = { Text("メモ") }, minLines = 3)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    scope.launch {
                        m.save(base.copy(title = title.trim(), username = user, password = pw, url = url.trim(), androidPackage = pkg.trim(), notes = notes))
                    }
                },
                enabled = title.isNotBlank() && !m.busy,
            ) { Text("保存") }
            OutlinedButton({ m.screen = if (uuid != null) Screen.Detail(uuid) else Screen.List }) { Text("やめる") }
        }
    }
    if (gen) GeneratorDialog(onUse = { pw = it; gen = false }, onDismiss = { gen = false })
}

@Composable
private fun GeneratorDialog(onUse: (String) -> Unit, onDismiss: () -> Unit) {
    val generator = remember { PasswordGenerator() }
    var length by remember { mutableIntStateOf(20) }
    var sets by remember { mutableStateOf(PasswordGenerator.CharSet.entries.toSet()) }
    var value by remember { mutableStateOf(generator.generate(20, PasswordGenerator.CharSet.entries.toSet())) }
    fun regen() {
        if (sets.isNotEmpty()) value = generator.generate(length.coerceAtLeast(sets.size), sets)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("パスワードを生成") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(value, style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    length.toString(), { v -> v.toIntOrNull()?.let { length = it.coerceIn(4, 128); regen() } },
                    label = { Text("長さ(4〜128)") }, singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                )
                PasswordGenerator.CharSet.entries.forEach { cs ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(cs in sets, { on ->
                            val next = if (on) sets + cs else sets - cs
                            if (next.isNotEmpty()) { sets = next; regen() }
                        })
                        Text(
                            when (cs) {
                                PasswordGenerator.CharSet.LOWER -> "小文字"
                                PasswordGenerator.CharSet.UPPER -> "大文字"
                                PasswordGenerator.CharSet.DIGITS -> "数字"
                                PasswordGenerator.CharSet.SYMBOLS -> "記号"
                            },
                        )
                    }
                }
                TextButton({ regen() }) { Text("作り直す") }
            }
        },
        confirmButton = { TextButton({ onUse(value) }) { Text("使う") } },
        dismissButton = { TextButton(onDismiss) { Text("やめる") } },
    )
}

/** 設計書 §5-2 の 6: 設定。 */
@Composable
private fun SettingsScreen(m: AppModel) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    BackHandler { m.screen = Screen.List }
    val s = m.settings
    var url by remember { mutableStateOf(s.syncUrl) }
    var token by remember { mutableStateOf(s.syncToken) }
    var device by remember { mutableStateOf(s.deviceName) }
    var minutes by remember { mutableStateOf(s.autoLockMinutes.toString()) }
    var info by remember { mutableStateOf<String?>(null) }
    var bioOn by remember { mutableStateOf(m.biometric.enabled) }
    var history by remember { mutableStateOf<List<HistoryItem>?>(null) }
    var restoreTarget by remember { mutableStateOf<HistoryItem?>(null) }
    fun setBiometric(on: Boolean) {
        if (!on) {
            m.biometric.disable()
            bioOn = false
            return
        }
        val activity = ctx.findActivity() ?: return
        val master = m.masterForBiometric() ?: return
        authenticate(
            activity, m.biometric.encryptCipher(), "生体認証を登録",
            onSuccess = { c ->
                m.biometric.store(c, master)
                bioOn = true
            },
            onFailure = { if (it.isNotEmpty()) info = it },
        )
    }
    val exportLauncher = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { u ->
        if (u != null) scope.launch {
            val bytes = m.export() ?: return@launch
            info = runCatching { ctx.contentResolver.openOutputStream(u)!!.use { it.write(bytes) } }
                .fold({ ".kdbx を書き出しました" }, { "書き出せませんでした" })
        }
    }
    val csvLauncher = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { u ->
        if (u != null) scope.launch { info = m.importCsv(runCatching { readText(ctx, u) }.getOrDefault("")) }
    }
    fun apply() {
        s.syncUrl = url
        s.syncToken = token
        s.deviceName = device
        minutes.toIntOrNull()?.coerceIn(1, 120)?.let { s.autoLockMinutes = it }
    }
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton({ apply(); m.screen = Screen.List }) { Text("戻る") }
            Text("設定", style = MaterialTheme.typography.titleLarge)
        }
        Text("同期", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Worker の URL") }, singleLine = true)
        PasswordField(token, { token = it }, "同期トークン")
        OutlinedTextField(device, { device = it }, Modifier.fillMaxWidth(), label = { Text("この端末の名前") }, singleLine = true)
        Button({ apply(); scope.launch { m.sync() } }, enabled = !m.busy) { Text("今すぐ同期") }
        Text(if (m.pendingSync) "未同期の変更があります" else (m.lastSync ?: "未同期"))
        HorizontalDivider()
        Text("自動ロック", style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            minutes, { minutes = it }, Modifier.fillMaxWidth(), label = { Text("バックグラウンドで何分たったらロックするか") },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        Text("画面を消したときは、すぐにロックします。", style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Text("ロック解除", style = MaterialTheme.typography.titleMedium)
        if (m.biometric.available()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Switch(bioOn, { setBiometric(it) })
                Text("生体認証で開く")
            }
            Text("指紋などを登録し直すと無効になります。そのときはマスターパスワードで開いて登録し直してください。", style = MaterialTheme.typography.bodySmall)
        } else {
            Text("この端末では生体認証を使えません(指紋などの登録がありません)。", style = MaterialTheme.typography.bodySmall)
        }
        HorizontalDivider()
        Text("データ", style = MaterialTheme.typography.titleMedium)
        OutlinedButton(
            { apply(); scope.launch { history = m.history() } },
            enabled = !m.busy && m.settings.syncConfigured,
        ) { Text("履歴から復元") }
        OutlinedButton({ exportLauncher.launch("pwvault.kdbx") }) { Text(".kdbx を書き出す(暗号化済み)") }
        OutlinedButton({ csvLauncher.launch(arrayOf("text/*", "*/*")) }) { Text("CSV を取り込む(Chrome / Bitwarden)") }
        info?.let { Text(it) }
    }

    history?.let { list ->
        AlertDialog(
            onDismissRequest = { history = null },
            title = { Text("復元する版を選ぶ") },
            text = {
                if (list.isEmpty()) Text("履歴がありません")
                else LazyColumn {
                    items(list) { h ->
                        Column(Modifier.fillMaxWidth().clickable { restoreTarget = h; history = null }.padding(vertical = 8.dp)) {
                            Text("版 ${h.version}  ${h.createdAt}")
                            Text("${h.device}  ${h.size / 1024} KB", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            },
            confirmButton = { TextButton({ history = null }) { Text("閉じる") } },
        )
    }
    restoreTarget?.let { h ->
        AlertDialog(
            onDismissRequest = { restoreTarget = null },
            title = { Text("版 ${h.version} に戻しますか") },
            text = { Text("いまの内容は端末内に退避します。戻した内容は、同期で他の端末にも反映されます。") },
            confirmButton = {
                TextButton({
                    restoreTarget = null
                    scope.launch { info = m.restore(h) }
                }) { Text("戻す") }
            },
            dismissButton = { TextButton({ restoreTarget = null }) { Text("やめる") } },
        )
    }
}
