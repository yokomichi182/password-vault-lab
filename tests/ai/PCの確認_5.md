# PC の確認手順(フェーズ5・AI 連携: request_credential と request_fill)

PC での確認は、精査(Opus)を通ってから、利用者が自分の PC で行います。
実在のパスワード、実在のサービスのキー、普段の `%LOCALAPPDATA%\pwm\` は使いません。Native Messaging のホストと `pwm-mcp` の登録は、この手順で利用者が行います(実装担当は登録しません)。
**実在の Pwned Passwords API には送りません。** `PWM_BREACH_URL` を、フェーズ3.6 と同じモック(`npm run serve:breach`)に向けます。

## 準備

1. ビルドします。

   ```powershell
   cd <リポジトリ>\cli ; npm install ; npm run build
   cd <リポジトリ>\extension ; npm install ; npm run build
   $cli = "<リポジトリ>\cli\dist"
   ```

2. 確認用の置き場と、漏洩チェックの先を決めます(`pwm` を実行する PowerShell に毎回入れます)。

   ```powershell
   $env:PWM_HOME = "$env:TEMP\pwm-check-5"
   $env:PWM_BREACH_URL = "http://127.0.0.1:18080"
   ```

3. 同期先とモックを動かします(それぞれ別の PowerShell で `cli/` に移って実行。止めるときは Ctrl+C)。
   - `npm run serve:check`(同期先。`http://127.0.0.1:18789`。架空のトークンと本体のマスターパスワードが `%TEMP%\pwm-serve-check\tokens.txt` に書かれます)
   - `npm run serve:breach`(漏洩チェックのモック。`http://127.0.0.1:18080`)
4. 自動処理用の保管庫と、本体の保管庫を設定します(貼り方は 3.6 の手順書の「貼り方」と同じ。トークンの欄で止まってから、別の PowerShell でクリップボードに入れ、Ctrl+V を1回だけ押します)。

   ```powershell
   node $cli\pwm.mjs auto init --sync-url http://127.0.0.1:18789      # automation-token
   node $cli\pwm.mjs main setup --sync-url http://127.0.0.1:18789     # main-token、master-password
   ```

   `serve:check` が用意する本体の保管庫の項目 `Main Only Site` を、`request_credential` の確認に使います。自動処理用の保管庫には `node $cli\pwm.mjs auto add --title Auto-Demo` で1件足しておきます。
5. Chrome に拡張を読み込みます(`chrome://extensions`、デベロッパーモード、「パッケージ化されていない拡張機能を読み込む」で `extension\dist`)。拡張の ID は `ldjpfcedfcjleggiionhldenohpaafhp` に固定されています(manifest の key)。拡張の「サイトへのアクセス」は「すべてのサイト」にします(フェーズ3 の確認と同じ)。設定画面で同期先(`http://localhost:18789`)、保管庫の名前(`main`)、本体のトークン、マスターパスワードを入れて保存し、ポップアップで解除します。
6. 入力の試験に使うページを用意します。`tests\extension\pages\login.html` を、`*.localhost` で配ります(例: `cd tests\extension\pages ; python -m http.server 18701`、ブラウザで `http://app.localhost:18701/login.html`)。本体の保管庫に、この URL の項目を拡張から見えるように入れておきます(`serve:check` の本体の保管庫に無いときは、Android アプリか KeePassXC で、URL が `http://app.localhost:18701` の項目 `App Login` と、同じ URL の API キーの項目 `App Api Key` を作って同期します)。

## Native Messaging のホストの登録

```powershell
cd <リポジトリ>\cli
npm run bridge:manifest -- "$env:LOCALAPPDATA\pwm-bridge" --home $env:PWM_HOME
reg add "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pwm.bridge" /ve /t REG_SZ /d "$env:LOCALAPPDATA\pwm-bridge\com.pwm.bridge.json" /f
```

- `--home` は、ホストに `PWM_HOME` を渡すためです(確認用の置き場を使うとき)。普段使いでは付けません。
- パスに日本語が含まれると、Chrome がホストを起動できないことがあります。その場合は `cli\dist` を英数字だけのフォルダに写して、`--dist <写した先>` を付けて作り直します。
- 登録したあと、Chrome を完全に閉じて開き直します。ホストが起動すると、`$env:PWM_HOME\bridge\` フォルダができます。

外すとき:

```powershell
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pwm.bridge" /f
```

## pwm-mcp の登録(Claude Code)

```powershell
claude.cmd mcp add pwm --scope local -e PWM_HOME="$env:PWM_HOME" -e PWM_BREACH_URL="http://127.0.0.1:18080" -- node "$cli\pwm-mcp.mjs"
```

登録後、Claude Code を開き直し、`/mcp` で `pwm` がつながっていることを確かめます。外すときは `claude.cmd mcp remove pwm --scope local` です。

## 確かめること(request_credential)

| # | 操作 | 期待 |
|---|---|---|
| 1 | Claude に「`list_titles` を使って」と頼む | ツールが6つ(`list_titles`、`read_credential`、`run`、`audit`、`request_credential`、`request_fill`)ある。`list_titles` には `Auto-Demo` だけが出る |
| 2 | Claude に「`read_credential` で `Main Only Site` を読んで」と頼む | 該当なし。本体の保管庫の値は返らない |
| 3 | Claude に「`request_credential` で `Main Only Site` を取って」と頼む | PC の画面に承認ダイアログが出る。最前面で、項目名、要求元(自己申告)、時刻、マスターパスワードの欄がある |
| 4 | マスターパスワードを入れ、「解除して内容を確認」を押す | 種類と、ユーザー名の先頭2文字+…が出る。ボタンは「今回だけ返す」(Enter)、「自動処理用の保管庫に複製して返す」、「拒否」(Esc) |
| 5 | 「今回だけ返す」を押す | Claude に値が返る(`returnedOnce` が true、`copied` が false)。`pwm auto list` に `Main Only Site` は増えない |
| 6 | もう一度 3 を頼み、「拒否」を押す(または Esc、窓を閉じる) | Claude に `denied` が返り、値は返らない |
| 7 | もう一度 3 を頼み、マスターパスワードに誤った値を入れる | `denied`(誤りであることは Claude に伝わらない) |
| 8 | 3 を頼み、ダイアログを放っておく | 120 秒で閉じ、`denied` |
| 9 | 3 を頼み、「複製して返す」を押す | 値が返る(`copied` が true、`breach` に結果)。`pwm auto list` に `Main Only Site` が増える。Claude に「`read_credential` で読んで」と頼むと、承認なしで読める。もう一度 `request_credential` を頼むと、ダイアログは出ずに「read_credential を使って」と返る |
| 10 | 3 を頼み、ダイアログが出ている間にもう一度同じ依頼をさせる | 2つ目は、ダイアログを出さずに `busy` |
| 11 | 本体の保管庫に無い項目名で 3 を頼み、マスターパスワードを入れる | `not_found` |
| 12 | `serve:check` を止めてから 3 を頼む | マスターパスワードを入れたあと `unavailable`(値は返らない) |

## 確かめること(request_fill)

ブラウザで `http://app.localhost:18701/login.html` を前面に出し、拡張を解除しておきます。設定画面でオンロード自動入力を**オフ**にします(オンのままだと、request_fill の前に入ってしまいます)。

| # | 操作 | 期待 |
|---|---|---|
| 13 | Claude に「`request_fill` で `App Login` を入力して」と頼む(未承認) | Chrome に承認画面(小さな窓)が出る。サイトのオリジン、項目名、ユーザー名の先頭2文字+…、要求元(自己申告)が出る。既定のフォーカスは「拒否」 |
| 14 | 「承認して入力し、今後も入力する」を押す | ページの欄に入り、Claude には `filled` だけが返る(値は返らない)。設定画面の「AI の入力を承認したサイト」に、オリジンと時刻が1件出る |
| 15 | ページを開き直し、13 をもう一度頼む | 承認画面なしで入り、`filled` |
| 16 | 設定画面でその1件を削除する(確認が出る。キャンセルすると消えない) | 消える。13 をもう一度頼むと、承認画面が出る |
| 17 | 13 で「拒否」を押す(または窓を閉じる) | 入らず `denied`。承認リストに増えない |
| 18 | 13 で放っておく | 55 秒で窓が閉じ、`denied` |
| 19 | Claude に「`request_fill` で `App Api Key` を入力して」と頼む | `not_found`(承認済みでも入らない) |
| 20 | Claude に「url に `https://other.example.test` を付けて `request_fill` で `App Login` を」と頼む | `not_found`(実際のタブと違う URL は入力しない) |
| 21 | 拡張をロックして 13 を頼む | `locked` |
| 22 | Chrome を閉じて 13 を頼む(または Chrome を開いたまま、ホストの登録を外して再起動) | 60 秒後に `unavailable` |
| 23 | 承認画面が出ている間に、別のタブを前面にして「承認」を押す | 入らず `not_found`。承認リストに増えない |
| 24 | 端末から `node $cli\pwm.mjs fill --title "App Login"` を実行する | 結果の語だけが出る(`filled` で終了コード 0、それ以外は 1) |

## 後片付け

- `reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.pwm.bridge" /f` で登録を外し、`$env:LOCALAPPDATA\pwm-bridge` を削除します。
- `claude.cmd mcp remove pwm --scope local` で登録を外します。
- `$env:PWM_HOME` のフォルダ(`$env:TEMP\pwm-check-5`)を削除し、`PWM_HOME`、`PWM_BREACH_URL`、`PWM_LANG` を消します。
- `serve:check` と `serve:breach` を止め、ポート 18789 と 18080 が空いたことを確かめます。`%TEMP%\pwm-serve-check\tokens.txt` と `%TEMP%\pwm-serve-breach\values.txt` を削除し、クリップボードを `Set-Clipboard -Value " "` で上書きします。
- Chrome の拡張を削除します。

## 注意

- 画面を操作できる AI(コンピューターの操作)は、承認ダイアログや承認画面のボタンを自分で押せます。承認は、本人が画面の前にいることを前提にしています。
- 要求元の名前は AI の自己申告で、偽れます。
- 同じユーザーのプロセスは、`bridge` フォルダに依頼を書けます(入力されるのは、承認済みのオリジンの実際のタブだけで、値は返りません)。
- 承認リストはオンロード自動入力には効きません。
