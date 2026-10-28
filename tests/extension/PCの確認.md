# PC の確認手順(フェーズ3・Chrome 拡張)

PC の Chrome での確認は、精査(Opus)を通ってから、利用者が自分の PC で行う。
実在のパスワードと実在のサイトは使わない。以下は架空の項目と、自分の PC の中だけで動くテストページで確かめる。

## 準備

1. 確認専用の Chrome プロファイルを作る(普段のプロファイルは使わない)。Chrome 右上のプロファイルのアイコン → 追加 で作れる。
2. 拡張を作る。`extension/` で `npm install` のあと、`npm run build:test` を実行する。これで `extension/dist/` ができる。
   - 通常の `npm run build` で作った拡張でも、クリックなしの入力は確かめられる。ただし漏洩チェックの送り先が本物の Pwned Passwords になるので、「確認」の 6 と 7 はできない(確認用の項目は「見つからない」と返る)。
   - `build:test` の拡張は、漏洩チェックの送り先がローカルのモックになり、`http://localhost` への通信を権限の確認なしで許す(テスト専用の形)。通常のビルドで試すときは、設定画面の保存で権限の確認が出るので許可する。確認が終わったら拡張を削除する。
3. Android 側で、確認用の架空の保管庫を作る。環境変数 `PWV_EXT_VAULT_DIR`(作業フォルダの外のフォルダ)と `PWV_EXT_PORT_A`(既定は `18701`)を指定して、`android/` で次を実行する。JAVA_HOME は Android Studio 同梱の JBR にする。
   `gradlew testDebugUnitTest --tests '*ExtensionVaultTest*'`
   `PWV_EXT_VAULT_DIR` に `extension-vault.kdbx` ができる。マスターパスワードは `ExtensionVaultTest` の `MASTER`(本体用の目印(AGENTS.md)を含む架空の値)。
4. 確認環境を動かす。`extension/` で `npm run serve:check` を実行する(`PWV_EXT_VAULT_DIR` は準備3と同じにする)。ローカルの同期先(`wrangler dev`。`.dev.vars` は読まない)、テストページ、漏洩チェックのモックが立ち上がる。止めるときは Ctrl+C。
5. 確認専用プロファイルの Chrome で `chrome://extensions` を開き、右上の「デベロッパー モード」をオンにして、「パッケージ化されていない拡張機能を読み込む」で `extension/dist` を選ぶ。
6. 拡張の「詳細」→「拡張機能のオプション」で設定画面を開き、次を入れて「確かめて保存」を押す。「保存しました」と出ればよい。
   - 同期先の URL: `http://localhost:18788`
   - 保管庫の名前: `android`
   - 同期トークン: 本体用の目印(AGENTS.md)+ `-e2e-token-android`
   - マスターパスワード: 準備3の `MASTER`
7. ツールバーの拡張のアイコンを押し、マスターパスワードを入れて「解除」を押す。項目が3件出る(Extension Test Login、Extension Hidden Api Key、Extension Other Site)。

## 確かめること

| # | 操作 | 期待 |
|---|---|---|
| 1 | `http://app.localhost:18701/login.html` を開く | クリックなしで、ユーザー名 `ext-user` とパスワードの欄が入る(パスワードは伏せ字のまま。API キーの値は入らない) |
| 2 | `http://app.localhost:18702/login.html`(ポート違い)と `http://app2.localhost:18701/login.html`(別のホスト)を開く | どちらも入らない |
| 3 | アイコンを押してロックし、`http://app.localhost:18701/login.html` を開き直す | 入らない。解除すると、開き直したページで入る |
| 4 | 1 のページで、アイコンを押す | 「このページの項目」に Extension Test Login だけが出て、「入力」がある。Extension Hidden Api Key には「入力」がなく、コピーのボタンだけがある |
| 5 | 拡張の設定画面で「ページの読み込み時に自動で入力する」をオフにして保存し、1 のページを開き直す | 入らない。アイコンから「入力」を押すと入る |
| 6 | Extension Test Login の「この項目の漏洩チェック」を押す(`build:test` の拡張) | 「漏洩済み(3 回)」と警告が出る。API キーの項目にはこのボタンがない |
| 7 | `npm run serve:check` を止めてから、もう一度 6 を押す | 「確かめられませんでした」と出る(漏洩なしとは出ない) |
| 8 | 「パスワードをコピー」を押し、メモ帳などに貼り付ける。30 秒待って、もう一度貼り付ける | 1 回目は貼り付けられ、30 秒後は空白に変わる |

## 後片付け

- 拡張を削除する。確認専用のプロファイルは、使わなければ削除する。
- `npm run serve:check` を止める(一時フォルダの同期先のデータも消える)。
- `PWV_EXT_VAULT_DIR` の `extension-vault.kdbx` を消す。

## 注意

- 確認に実在のパスワード、実在のサイト、普段のプロファイルは使わない。
- 設定画面に入れるトークンとマスターパスワードは、確認用の架空の値だけにする。
- Chrome はポート 18701、18702、18788、18999 を使う。ほかのソフトが使っているときは、環境変数 `PWV_E2E_PORT_A` などで変えられる(Android 側の `PWV_EXT_PORT_A` も同じ値にする)。
