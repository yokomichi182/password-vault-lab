# PC の確認手順(フェーズ3.5・CLI と MCP サーバー)

PC での確認は、精査(Opus)を通ってから、利用者が自分の PC で行います。
実在のパスワードと実在のサービスのキーは使いません。以下は架空の項目と、自分の PC の中だけで動く同期先で確かめます。
Claude Code に `pwm-mcp` を登録する手順は、利用者が自分で行います(実装担当は登録しません)。

## 準備

1. `cli/` で `npm install` のあと、`npm run build` を実行します。`cli/dist/pwm.mjs` と `cli/dist/pwm-mcp.mjs` ができます。以下では、このフォルダの絶対パスを `$cli` とします(PowerShell)。

   ```powershell
   $cli = "<リポジトリ>\cli\dist"
   ```

2. 確認用の置き場を作業フォルダの外に決めます。普段の `%LOCALAPPDATA%\pwm\` は使いません。

   ```powershell
   $env:PWM_HOME = "$env:TEMP\pwm-check"
   ```

   以降のコマンドは、この環境変数を入れた同じ PowerShell で実行します。日本語の文言で確かめるときは `$env:PWM_LANG = "ja"` も入れます。
3. 同期先を動かします。別の PowerShell で `cli/` に移り、`npm run serve:check` を実行します。止めるときは Ctrl+C です。
   - ローカルの `wrangler dev`(`.dev.vars` は読まない)が `http://127.0.0.1:18789` で動きます。保管庫は自動処理用の `automation` と本体用の `main` です。
   - 本体用の保管庫には、架空の項目 `Main Only Site` が1つ入っています。
   - 架空のトークン2つとマスターパスワードは、`%TEMP%\pwm-serve-check\tokens.txt` に書かれます。画面には出ません。値は手で組み立てずに、このファイルから貼ります。
   - 貼り方: `pwm` が「同期トークン:」などで止まってから、**別の PowerShell** で次を実行して値だけをクリップボードに入れ、元の画面に戻って Ctrl+V を1回押して Enter を押します(`main-token`、`master-password` も同じ)。入力欄は何も表示しないので、2回貼らないようにします。行を手で選んでコピーすると、名前や空白が混ざって 401 になります。

     ```powershell
     (Select-String -Path "$env:TEMP\pwm-serve-check\tokens.txt" -Pattern '^automation-token:\s*(\S+)').Matches[0].Groups[1].Value | Set-Clipboard
     ```

## 確かめること

| # | 操作 | 期待 |
|---|---|---|
| 1 | `node $cli\pwm.mjs auto init --sync-url http://127.0.0.1:18789` を実行し、トークンの入力欄に tokens.txt の `automation-token` を貼る | 「Created the automation vault.」(日本語では「自動処理用の保管庫を作りました」)と出る。入力した文字は画面に出ない。`$env:PWM_HOME` に `automation.kdbx`、`automation.key.dpapi`、`automation.token.dpapi`、`config.json` ができ、キーファイルの平文のファイルは無い |
| 2 | `node $cli\pwm.mjs auto add --title Demo-Key --type apikey --env test` を実行し、値の欄に架空の API キー(例: `demo-` に続けて適当な英数字)を2回入れる | 「Saved.」と出る。値は画面に出ない |
| 3 | `node $cli\pwm.mjs auto add --title Demo-Login --username demo-user` を実行し、値の欄に架空のパスワードを2回入れる | 「Saved.」と出る |
| 4 | `node $cli\pwm.mjs auto list` | `Demo-Key`、`Demo-Login` が、種類と環境といっしょに出る。値は出ない |
| 5 | `node $cli\pwm.mjs sync` | 「Synced」と出て、終了コードが 0。同期先を止めてからもう一度実行すると「Skipped」と出て、終了コードが 0 以外になり、`automation.kdbx` は変わらない |
| 6 | `node $cli\pwm.mjs read Demo-Login/username` と `node $cli\pwm.mjs read Demo-Key` | ユーザー名と、2 で入れた値がそのまま出る(`read` は値を出す。人が使う画面でだけ使う) |
| 7 | `node $cli\pwm.mjs run --env DEMO_KEY=Demo-Key -- node -e 'console.log(process.env.DEMO_KEY)'` | `<concealed by pwm>` と出る。値は出ない |
| 8 | `node $cli\pwm.mjs run --env DEMO_KEY=Demo-Key -- node -e 'console.log(process.env.DEMO_KEY.length)'` | 2 で入れた値の文字数が出る(子には値が渡っている) |
| 9 | Claude Code に `pwm-mcp` を登録する(下の「登録」)。Claude に「`list_titles` を使って」と頼む | `Demo-Key` と `Demo-Login` が出る。`Main Only Site` は出ない |
| 10 | Claude に「`read_credential` で `Demo-Login` を読んで」と頼む | ユーザー名とパスワードが返る(会話の記録に残る。実在の値で試さない) |
| 11 | Claude に「`run` で `node -e 'console.log(process.env.DEMO_KEY)'` を、`DEMO_KEY` に `Demo-Key` を入れて実行して」と頼む | 出力が `<concealed by pwm>` になる |
| 12 | Claude に「`read_credential` で `Main Only Site` を読んで」と頼む | 「該当なし」(英語では「No matching item.」)になる。本体の保管庫を探しに行かない |
| 13 | (任意)`node $cli\pwm.mjs main setup --sync-url http://127.0.0.1:18789` を実行し、本体用のトークンとマスターパスワードを貼る。そのあと `node $cli\pwm.mjs read --main "Main Only Site/username"` | `main-user` が出る。12 をもう一度頼んでも「該当なし」のまま |
| 14 | `node $cli\pwm.mjs read --main "Main Only Site"` を、標準入力を流し込んで実行する(例: `"x" \| node $cli\pwm.mjs read --main "Main Only Site"`) | 端末でないので、何も聞かずにやめる |

### 登録

Claude Code の `claude mcp add` で、環境変数と起動のコマンドを渡して登録します。`$env:PWM_HOME` と同じ値を `PWM_HOME` に入れます。

```powershell
claude.cmd mcp add pwm --scope local -e PWM_HOME="$env:TEMP\pwm-check" -- node "$cli\pwm-mcp.mjs"
```

- `claude` ではなく `claude.cmd` と書きます。npm で入れた `claude` は PowerShell では `claude.ps1` が呼ばれ、PowerShell が `--` を取り除くので「missing required argument 'commandOrUrl'」になります(`node` のような実行ファイルには `--` はそのまま渡ります)。
- 名前の `pwm` は `-e` より前に置きます。`-e` は値を複数受け取るので、後ろに置くと名前まで環境変数として読まれ、「missing required argument 'name'」になります。

- 登録したあと、Claude Code を開き直して `/mcp` で `pwm` がつながっていることを確かめます。
- 登録を外すときは次のとおりです。

```powershell
claude mcp remove pwm --scope local
```

## 後片付け

- 登録を外します: `claude mcp remove pwm --scope local`
- `PWM_HOME` に使ったフォルダ(`$env:TEMP\pwm-check`)を削除し、`$env:PWM_HOME` と `$env:PWM_LANG` を消します。
- `npm run serve:check` を止めます(一時フォルダの同期先のデータも消えます)。Windows では子のプロセス(workerd)が残ることがあるので、ポート 18789 が空いたことを確かめます。
- `%TEMP%\pwm-serve-check\tokens.txt` を削除します。

## 注意

- 確認に実在のパスワード、実在のサービスのキー、普段の `%LOCALAPPDATA%\pwm\` は使いません。
- `pwm read` は値をそのまま出します。画面共有や記録が残る場所では実行しません。
- 自動処理用の保管庫は、この PC の今のユーザーだけが開けます(キーファイルを DPAPI で守っています)。PC を失うと開けなくなります。入れる値は作り直せるものにします。
- `pwm run` の伏せ字は、子が値をそのまま出したときだけ効きます。値を変形して出したもの(base64、逆順、一部だけなど)は置き換えられません。子がファイルや外部に値を送ることも止められません。
- MCP の `run` は任意のコマンドを実行できます。AI がもともと端末を使える環境で使う前提です。
