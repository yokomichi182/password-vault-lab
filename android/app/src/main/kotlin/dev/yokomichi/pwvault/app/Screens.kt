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
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.Switch
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
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
import androidx.compose.ui.res.stringResource
import dev.yokomichi.pwvault.R
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import dev.yokomichi.pwvault.core.BreachResult
import dev.yokomichi.pwvault.core.Entry
import dev.yokomichi.pwvault.core.EntryView
import dev.yokomichi.pwvault.core.ExpiryState
import dev.yokomichi.pwvault.core.ItemTypes
import dev.yokomichi.pwvault.core.KindFilter
import dev.yokomichi.pwvault.core.HistoryItem
import dev.yokomichi.pwvault.core.PasswordGenerator
import kotlinx.coroutines.launch

private fun readText(ctx: Context, uri: Uri): String =
    ctx.contentResolver.openInputStream(uri)!!.use { String(it.readBytes(), Charsets.UTF_8) }

private fun readBytes(ctx: Context, uri: Uri): ByteArray =
    ctx.contentResolver.openInputStream(uri)!!.use { it.readBytes() }

/** 期限の日付(端末のタイムゾーン)。入力した日の終わりまで有効とする。 */
private fun expiryText(at: Long?): String =
    at?.let { java.time.Instant.ofEpochMilli(it).atZone(java.time.ZoneId.systemDefault()).toLocalDate().toString() }.orEmpty()

/** 空は期限なし(null)。形が違うときは Result.failure。 */
private fun parseExpiry(text: String): Result<Long?> {
    val t = text.trim()
    if (t.isEmpty()) return Result.success(null)
    return runCatching {
        java.time.LocalDate.parse(t).atTime(23, 59, 59).atZone(java.time.ZoneId.systemDefault()).toInstant().toEpochMilli()
    }
}

@Composable
private fun typeBadge(e: Entry): String = when {
    e.itemType == ItemTypes.APIKEY -> stringResource(R.string.badge_apikey)
    !e.isLogin -> stringResource(R.string.badge_other)
    else -> ""
}

@Composable
private fun expiryBadge(e: Entry): String = when (EntryView.expiry(e, System.currentTimeMillis())) {
    ExpiryState.EXPIRED -> stringResource(R.string.expiry_expired)
    ExpiryState.SOON -> stringResource(R.string.expiry_soon)
    else -> ""
}

@Composable
fun App(m: AppModel) {
    Scaffold { pad ->
        Column(Modifier.fillMaxSize().padding(pad).padding(horizontal = 16.dp)) {
            m.message?.let {
                Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, Modifier.weight(1f), color = MaterialTheme.colorScheme.error)
                    TextButton({ m.message = null }) { Text(stringResource(R.string.close)) }
                }
            }
            if (m.busy) Text(stringResource(R.string.processing), color = MaterialTheme.colorScheme.primary)
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
internal fun PasswordField(value: String, onChange: (String) -> Unit, label: String, modifier: Modifier = Modifier) {
    var show by remember { mutableStateOf(false) }
    OutlinedTextField(
        value, onChange, modifier.fillMaxWidth(), label = { Text(label) }, singleLine = true,
        visualTransformation = if (show) VisualTransformation.None else PasswordVisualTransformation(),
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
        trailingIcon = { TextButton({ show = !show }) { Text(if (show) stringResource(R.string.hide) else stringResource(R.string.show)) } },
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
        Text(stringResource(R.string.setup_title), style = MaterialTheme.typography.headlineSmall)
        Text(stringResource(R.string.setup_warning))
        PasswordField(master, { master = it }, stringResource(R.string.master_password))
        if (kdbx == null) PasswordField(confirm, { confirm = it }, stringResource(R.string.master_password_confirm))
        Text(
            if (kdbx != null) stringResource(R.string.setup_kdbx_selected) else if (csv != null) stringResource(R.string.setup_csv_selected) else stringResource(R.string.setup_nothing),
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ pickKdbx.launch(arrayOf("*/*")) }) { Text(stringResource(R.string.pick_kdbx)) }
            OutlinedButton({ pickCsv.launch(arrayOf("text/*", "*/*")) }) { Text(stringResource(R.string.pick_csv)) }
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
        ) { Text(if (kdbx != null) stringResource(R.string.import_action) else stringResource(R.string.create_action)) }
        if (master.isNotEmpty() && master.length < 8) Text(stringResource(R.string.min_length))
        if (kdbx == null && confirm.isNotEmpty() && master != confirm) Text(stringResource(R.string.confirm_mismatch))
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
            m.message = ctx.getString(R.string.bio_invalidated)
            return
        }
        authenticate(
            activity, cipher, ctx.getString(R.string.open_vault),
            onSuccess = { c ->
                val pw = m.biometric.open(c)
                if (pw == null) m.message = ctx.getString(R.string.bio_open_failed) else scope.launch { m.unlock(pw) }
            },
            onFailure = { if (it.isNotEmpty()) m.message = it },
        )
    }
    LaunchedEffect(Unit) { if (bio) unlockWithBiometric() }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text(stringResource(R.string.unlock_title), style = MaterialTheme.typography.headlineSmall)
        PasswordField(master, { master = it }, stringResource(R.string.master_password))
        Button(
            onClick = {
                scope.launch {
                    m.unlock(master)
                    master = ""
                }
            },
            enabled = master.isNotEmpty() && !m.busy,
        ) { Text(stringResource(R.string.open_action)) }
        if (bio) OutlinedButton({ unlockWithBiometric() }, enabled = !m.busy) { Text(stringResource(R.string.open_with_bio)) }
    }
}

/** 設計書 §5-2 の 3: 一覧と検索。 */
@Composable
private fun ListScreen(m: AppModel) {
    val scope = rememberCoroutineScope()
    var q by remember { mutableStateOf("") }
    var kind by remember { mutableStateOf(KindFilter.ALL) }
    val shown = remember(m.entries, q, kind) { EntryView.filter(m.entries, q, kind) }
    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(stringResource(R.string.vault_count, m.entries.size), Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            TextButton({ m.screen = Screen.Settings }) { Text(stringResource(R.string.settings)) }
            TextButton({ m.lock() }) { Text(stringResource(R.string.lock)) }
        }
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(q, { q = it }, Modifier.weight(1f), label = { Text(stringResource(R.string.search)) }, singleLine = true)
            Button({ m.screen = Screen.Edit(null) }) { Text(stringResource(R.string.add)) }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            listOf(
                KindFilter.ALL to R.string.filter_all,
                KindFilter.PASSWORD to R.string.filter_password,
                KindFilter.API_KEY to R.string.filter_apikey,
            ).forEach { (k, label) ->
                FilterChip(kind == k, { kind = k }, label = { Text(stringResource(label)) })
            }
        }
        m.autoAuditReport?.let { r ->
            Column(Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        stringResource(R.string.auto_audit_banner, r.breached.size),
                        Modifier.weight(1f), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.titleSmall,
                    )
                    TextButton({ m.autoAuditReport = null }) { Text(stringResource(R.string.close)) }
                }
                r.breached.forEach { b ->
                    Text(
                        stringResource(R.string.audit_seen, b.title.ifEmpty { stringResource(R.string.untitled) }, (b.result as BreachResult.Breached).count),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
        Text(
            when {
                m.pendingSync -> stringResource(R.string.pending_sync)
                else -> m.lastSync ?: ""
            },
            style = MaterialTheme.typography.bodySmall,
        )
        if (shown.isEmpty()) Text(stringResource(R.string.no_items), Modifier.padding(top = 24.dp))
        LazyColumn(Modifier.fillMaxSize()) {
            items(shown, key = { it.uuid }) { e ->
                Column(Modifier.fillMaxWidth().clickable { m.screen = Screen.Detail(e.uuid) }.padding(vertical = 10.dp)) {
                    Text(e.title.ifEmpty { stringResource(R.string.untitled) }, style = MaterialTheme.typography.titleMedium)
                    val marks = listOf(typeBadge(e), e.environment, expiryBadge(e)).filter { it.isNotEmpty() }.joinToString(" / ")
                    if (marks.isNotEmpty()) {
                        Text(
                            marks, style = MaterialTheme.typography.labelMedium,
                            color = if (EntryView.expiry(e, System.currentTimeMillis()) == ExpiryState.EXPIRED) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary,
                        )
                    }
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
            TextButton({ m.screen = Screen.List }) { Text(stringResource(R.string.back)) }
            Text(e.title.ifEmpty { stringResource(R.string.untitled) }, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
            TextButton({ m.screen = Screen.Edit(e.uuid) }) { Text(stringResource(R.string.edit)) }
        }
        val isKey = e.itemType == ItemTypes.APIKEY
        val userLabel = stringResource(if (isKey) R.string.apikey_account else R.string.username)
        val secretLabel = stringResource(if (isKey) R.string.apikey_key else R.string.password)
        val typeName = stringResource(
            when {
                isKey -> R.string.type_apikey
                e.isLogin -> R.string.type_password
                else -> R.string.type_other
            },
        )
        Field(stringResource(R.string.type_label), typeName) { }
        if (e.environment.isNotEmpty()) Field(stringResource(R.string.environment), e.environment) { }
        e.expiresAt?.let { at ->
            val badge = expiryBadge(e)
            Field(stringResource(R.string.expires_label), expiryText(at) + if (badge.isNotEmpty()) "  ($badge)" else "") { }
        }
        Field(userLabel, e.username) { Clip.copySensitive(ctx, userLabel, e.username) }
        Field(secretLabel, if (reveal) e.password else "••••••••••") { Clip.copySensitive(ctx, secretLabel, e.password) }
        TextButton({ reveal = !reveal }) { Text(if (reveal) stringResource(R.string.hide_password) else stringResource(R.string.show_password)) }
        Field(if (isKey) stringResource(R.string.apikey_url) else "URL", e.url) { Clip.copySensitive(ctx, "URL", e.url) }
        if (e.androidPackage.isNotEmpty()) Field(stringResource(R.string.android_app), e.androidPackage) { }
        if (e.notes.isNotEmpty()) Field(stringResource(R.string.notes), e.notes) { }
        Text(stringResource(R.string.copy_note), style = MaterialTheme.typography.bodySmall)
        AuditLine(m, e)
        OutlinedButton({ confirmDelete = true }) { Text(stringResource(R.string.delete)) }
    }
    if (confirmDelete) {
        AlertDialog(
            onDismissRequest = { confirmDelete = false },
            title = { Text(stringResource(R.string.delete_title)) },
            text = { Text(stringResource(R.string.delete_body, e.title)) },
            confirmButton = { TextButton({ confirmDelete = false; scope.launch { m.delete(e.uuid) } }) { Text(stringResource(R.string.delete_confirm)) } },
            dismissButton = { TextButton({ confirmDelete = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** 設計書 §14-2: 項目の詳細に「最終チェックの日時と結果」を出す。 */
@Composable
private fun AuditLine(m: AppModel, e: Entry) {
    m.auditStamp // 結果が変わったら描き直す
    val last = m.auditLog.last(e.uuid)
    val text = when {
        // 設計書 §14-3: API キーと知らない種類は送らない。「未チェック」ではなく「対象外」と出す
        !e.isLogin -> stringResource(R.string.audit_not_target)
        last == null -> stringResource(R.string.audit_unchecked)
        else -> {
            val at = java.text.SimpleDateFormat("yyyy-MM-dd HH:mm", java.util.Locale.JAPAN).format(java.util.Date(last.checkedAt))
            val result = if (last.count > 0) stringResource(R.string.audit_breached, last.count) else stringResource(R.string.audit_clean)
            // パスワードを変えたあとの結果は、いまのパスワードのものではない
            val stale = if (e.modifiedAt > last.validAt) stringResource(R.string.audit_stale) else ""
            stringResource(R.string.audit_line, at, result, stale)
        }
    }
    Text(text, style = MaterialTheme.typography.bodySmall)
}

@Composable
private fun Field(label: String, value: String, onCopy: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.labelMedium)
            Text(value.ifEmpty { "-" })
        }
        if (value.isNotEmpty()) TextButton(onCopy) { Text(stringResource(R.string.copy)) }
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
    // 種類。空はパスワード。知らない種類(その他)は、選び直さないかぎり文字列のまま保つ
    var type by remember { mutableStateOf(base.itemType) }
    var env by remember { mutableStateOf(base.environment) }
    val initialExpiry = remember { expiryText(base.expiresAt) }
    var expiry by remember { mutableStateOf(initialExpiry) }
    val isKey = type == ItemTypes.APIKEY
    val parsedExpiry = parseExpiry(expiry)
    val expiryOk = !isKey || parsedExpiry.isSuccess
    Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(if (uuid == null) stringResource(R.string.add_item) else stringResource(R.string.edit_item), style = MaterialTheme.typography.titleLarge)
        Text(stringResource(R.string.type_label), style = MaterialTheme.typography.labelMedium)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(type.isEmpty() || type == ItemTypes.PASSWORD, { type = "" }, label = { Text(stringResource(R.string.type_password)) })
            FilterChip(isKey, { type = ItemTypes.APIKEY }, label = { Text(stringResource(R.string.type_apikey)) })
            if (type.isNotEmpty() && type != ItemTypes.PASSWORD && !isKey) {
                FilterChip(true, { }, label = { Text(stringResource(R.string.type_other)) })
            }
        }
        OutlinedTextField(
            title, { title = it }, Modifier.fillMaxWidth(),
            label = { Text(stringResource(if (isKey) R.string.apikey_service else R.string.title)) }, singleLine = true,
        )
        OutlinedTextField(
            user, { user = it }, Modifier.fillMaxWidth(),
            label = { Text(stringResource(if (isKey) R.string.apikey_account else R.string.username)) }, singleLine = true,
        )
        PasswordField(pw, { pw = it }, stringResource(if (isKey) R.string.apikey_key else R.string.password))
        // API キーには生成ボタンを出さない
        if (!isKey) OutlinedButton({ gen = true }) { Text(stringResource(R.string.generate_password)) }
        if (isKey) {
            OutlinedTextField(env, { env = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.environment)) }, singleLine = true)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                // ラベルは表示言語、保存する値は固定の文字列(ItemTypes)
                listOf(
                    ItemTypes.ENV_PRODUCTION to R.string.env_production,
                    ItemTypes.ENV_TEST to R.string.env_test,
                ).forEach { (v, id) ->
                    FilterChip(env == v, { env = v }, label = { Text(stringResource(id)) })
                }
            }
            OutlinedTextField(
                expiry, { expiry = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.expires_input)) }, singleLine = true,
                isError = !expiryOk, supportingText = if (expiryOk) null else ({ Text(stringResource(R.string.expires_invalid)) }),
            )
        }
        OutlinedTextField(
            url, { url = it }, Modifier.fillMaxWidth(),
            label = { Text(if (isKey) stringResource(R.string.apikey_url) else "URL") }, singleLine = true,
        )
        OutlinedTextField(pkg, { pkg = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.android_package)) }, singleLine = true)
        OutlinedTextField(notes, { notes = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.notes)) }, minLines = 3)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = {
                    // 期限は、入力を変えたときだけ書き換える(KeePassXC が付けた時刻をそのまま残す)
                    val expiresAt = if (isKey && expiry != initialExpiry) parsedExpiry.getOrNull() else base.expiresAt
                    scope.launch {
                        m.save(
                            base.copy(
                                title = title.trim(), username = user, password = pw, url = url.trim(), androidPackage = pkg.trim(), notes = notes,
                                itemType = type, environment = env.trim(), expiresAt = expiresAt,
                            ),
                        )
                    }
                },
                enabled = title.isNotBlank() && expiryOk && !m.busy,
            ) { Text(stringResource(R.string.save)) }
            OutlinedButton({ m.screen = if (uuid != null) Screen.Detail(uuid) else Screen.List }) { Text(stringResource(R.string.cancel)) }
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
        title = { Text(stringResource(R.string.generate_password)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(value, style = MaterialTheme.typography.titleMedium)
                OutlinedTextField(
                    length.toString(), { v -> v.toIntOrNull()?.let { length = it.coerceIn(4, 128); regen() } },
                    label = { Text(stringResource(R.string.gen_length)) }, singleLine = true,
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
                                PasswordGenerator.CharSet.LOWER -> stringResource(R.string.cs_lower)
                                PasswordGenerator.CharSet.UPPER -> stringResource(R.string.cs_upper)
                                PasswordGenerator.CharSet.DIGITS -> stringResource(R.string.cs_digits)
                                PasswordGenerator.CharSet.SYMBOLS -> stringResource(R.string.cs_symbols)
                            },
                        )
                    }
                }
                TextButton({ regen() }) { Text(stringResource(R.string.regenerate)) }
            }
        },
        confirmButton = { TextButton({ onUse(value) }) { Text(stringResource(R.string.use)) } },
        dismissButton = { TextButton(onDismiss) { Text(stringResource(R.string.cancel)) } },
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
    var autoAuditOn by remember { mutableStateOf(s.autoAudit) }
    // 通知の許可を求める。許可されなくても、自動チェックの設定はオンのままにする(結果は一覧の上に出る)
    val notifPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { }
    // 設計書 §5-4: 自動入力サービスの状態。システムの設定から戻ったときに読み直す
    var autofillOn by remember { mutableStateOf(autofillEnabled(ctx)) }
    DisposableEffect(Unit) {
        val owner = ctx.findActivity()
        val obs = androidx.lifecycle.LifecycleEventObserver { _, ev ->
            if (ev == androidx.lifecycle.Lifecycle.Event.ON_RESUME) autofillOn = autofillEnabled(ctx)
        }
        owner?.lifecycle?.addObserver(obs)
        onDispose { owner?.lifecycle?.removeObserver(obs) }
    }
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
            activity, m.biometric.encryptCipher(), ctx.getString(R.string.enroll_bio),
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
                .fold({ ctx.getString(R.string.kdbx_exported) }, { ctx.getString(R.string.export_failed) })
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
            TextButton({ apply(); m.screen = Screen.List }) { Text(stringResource(R.string.back)) }
            Text(stringResource(R.string.settings), style = MaterialTheme.typography.titleLarge)
        }
        Text(stringResource(R.string.sync), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(url, { url = it }, Modifier.fillMaxWidth(), label = { Text("Worker URL") }, singleLine = true)
        PasswordField(token, { token = it }, stringResource(R.string.sync_token))
        OutlinedTextField(device, { device = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.device_name)) }, singleLine = true)
        Button({ apply(); scope.launch { m.sync() } }, enabled = !m.busy) { Text(stringResource(R.string.sync_now)) }
        Text(if (m.pendingSync) stringResource(R.string.pending_sync) else (m.lastSync ?: stringResource(R.string.not_synced)))
        HorizontalDivider()
        Text(stringResource(R.string.auto_lock), style = MaterialTheme.typography.titleMedium)
        OutlinedTextField(
            minutes, { minutes = it }, Modifier.fillMaxWidth(), label = { Text(stringResource(R.string.auto_lock_minutes)) },
            singleLine = true, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
        )
        Text(stringResource(R.string.auto_lock_note), style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Text(stringResource(R.string.unlock_title), style = MaterialTheme.typography.titleMedium)
        if (m.biometric.available()) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                Switch(bioOn, { setBiometric(it) })
                Text(stringResource(R.string.open_with_bio))
            }
            Text(stringResource(R.string.bio_reenroll), style = MaterialTheme.typography.bodySmall)
        } else {
            Text(stringResource(R.string.bio_unavailable), style = MaterialTheme.typography.bodySmall)
        }
        HorizontalDivider()
        Text(stringResource(R.string.audit_title), style = MaterialTheme.typography.titleMedium)
        Button({ scope.launch { m.audit() } }, enabled = !m.auditing && m.entries.isNotEmpty()) {
            Text(if (m.auditing) stringResource(R.string.checking) else stringResource(R.string.audit_title))
        }
        Text(
            stringResource(R.string.audit_privacy),
            style = MaterialTheme.typography.bodySmall,
        )
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Switch(autoAuditOn, { on ->
                autoAuditOn = on
                s.autoAudit = on
                if (on && android.os.Build.VERSION.SDK_INT >= 33 &&
                    ctx.checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED
                ) notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
            })
            Text(stringResource(R.string.auto_audit))
        }
        Text(stringResource(R.string.auto_audit_note), style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Text(stringResource(R.string.autofill_title), style = MaterialTheme.typography.titleMedium)
        Text(stringResource(if (autofillOn) R.string.autofill_enabled else R.string.autofill_disabled))
        if (!autofillOn) {
            OutlinedButton({
                runCatching {
                    ctx.startActivity(
                        android.content.Intent(
                            android.provider.Settings.ACTION_REQUEST_SET_AUTOFILL_SERVICE,
                            Uri.parse("package:" + ctx.packageName),
                        ),
                    )
                }.onFailure { info = ctx.getString(R.string.autofill_settings_unavailable) }
            }) { Text(stringResource(R.string.autofill_open_settings)) }
        }
        Text(stringResource(R.string.autofill_chrome_note), style = MaterialTheme.typography.bodySmall)
        HorizontalDivider()
        Text(stringResource(R.string.data), style = MaterialTheme.typography.titleMedium)
        OutlinedButton(
            { apply(); scope.launch { history = m.history() } },
            enabled = !m.busy && m.settings.syncConfigured,
        ) { Text(stringResource(R.string.restore_history)) }
        OutlinedButton({ exportLauncher.launch("pwvault.kdbx") }) { Text(stringResource(R.string.export_kdbx)) }
        OutlinedButton({ csvLauncher.launch(arrayOf("text/*", "*/*")) }) { Text(stringResource(R.string.import_csv)) }
        info?.let { Text(it) }
    }

    m.auditReport?.let { r ->
        AlertDialog(
            onDismissRequest = { m.auditReport = null },
            title = { Text(if (r.breached.isEmpty()) stringResource(R.string.audit_none) else stringResource(R.string.audit_n_breached, r.breached.size)) },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    LazyColumn(Modifier.weight(1f, fill = false)) {
                        items(r.breached) { b ->
                            val n = (b.result as BreachResult.Breached).count
                            Text(stringResource(R.string.audit_seen, b.title.ifEmpty { stringResource(R.string.untitled) }, n), Modifier.padding(vertical = 4.dp))
                        }
                    }
                    Text(stringResource(R.string.audit_clean_n, r.cleanCount), style = MaterialTheme.typography.bodySmall)
                    if (r.excludedCount > 0) {
                        Text(stringResource(R.string.audit_excluded_n, r.excludedCount), style = MaterialTheme.typography.bodySmall)
                    }
                    if (r.skippedCount > 0) {
                        Text(
                            stringResource(R.string.audit_skipped_n, r.skippedCount),
                            style = MaterialTheme.typography.bodySmall,
                        )
                    }
                }
            },
            confirmButton = { TextButton({ m.auditReport = null }) { Text(stringResource(R.string.close)) } },
        )
    }
    history?.let { list ->
        AlertDialog(
            onDismissRequest = { history = null },
            title = { Text(stringResource(R.string.restore_pick)) },
            text = {
                if (list.isEmpty()) Text(stringResource(R.string.no_history))
                else LazyColumn {
                    items(list) { h ->
                        Column(Modifier.fillMaxWidth().clickable { restoreTarget = h; history = null }.padding(vertical = 8.dp)) {
                            Text(stringResource(R.string.version_line, h.version, h.createdAt))
                            Text("${h.device}  ${h.size / 1024} KB", style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            },
            confirmButton = { TextButton({ history = null }) { Text(stringResource(R.string.close)) } },
        )
    }
    restoreTarget?.let { h ->
        AlertDialog(
            onDismissRequest = { restoreTarget = null },
            title = { Text(stringResource(R.string.restore_confirm_title, h.version)) },
            text = { Text(stringResource(R.string.restore_confirm_body)) },
            confirmButton = {
                TextButton({
                    restoreTarget = null
                    scope.launch { info = m.restore(h) }
                }) { Text(stringResource(R.string.restore)) }
            },
            dismissButton = { TextButton({ restoreTarget = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

/** 設計書 §5-4: Tobari が自動入力サービスとして選ばれているか。 */
private fun autofillEnabled(ctx: Context): Boolean =
    ctx.getSystemService(android.view.autofill.AutofillManager::class.java)?.hasEnabledAutofillServices() == true
