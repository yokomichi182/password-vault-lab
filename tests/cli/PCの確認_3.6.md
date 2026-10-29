# PC の確認手順(フェーズ3.6・パスワード漏れチェック)

PC での確認は、精査(Opus)を通ってから、利用者が自分の PC で行います。
**実在の Pwned Passwords API(api.pwnedpasswords.com)には送りません。** 確認のあいだは、自分の PC の中で動くモックサーバー(`npm run serve:breach`)だけを使います。実在のパスワードと実在のサービスのキーも使いません。
Claude Code に `pwm-mcp` を登録する手順は、利用者が自分で行います(実装担当は登録しません)。タスクスケジューラへの登録も、この確認では行いません(書き方だけを載せます)。

## 準備

1. `cli/` で `npm install` のあと、`npm run build` を実行します。`cli/dist/` に `pwm.mjs`、`pwm-mcp.mjs`、`serve-check.mjs`、`serve-breach.mjs` ができます。以下では、このフォルダの絶対パスを `$cli` とします(PowerShell)。

   ```powershell
   $cli = "<リポジトリ>\cli\dist"
   ```

2. 確認用の置き場を作業フォルダの外に決めます。普段の `%LOCALAPPDATA%\pwm\` は使いません。**漏洩チェックの先を、モックサーバーに向けます。** この2つを必ず、`pwm` を実行する PowerShell に入れます(入れ忘れると、実在の API に送ります)。

   ```powershell
   $env:PWM_HOME = "$env:TEMP\pwm-check-36"
   $env:PWM_BREACH_URL = "http://127.0.0.1:18080"
   ```

   日本語の文言で確かめるときは `$env:PWM_LANG = "ja"` も入れます。`PWM_BREACH_URL` が受け付けるのは `http://127.0.0.1:<ポート>` と `http://localhost:<ポート>`(パスなし)だけです。それ以外はエラーで止まり、何も送りません。
3. 同期先を動かします。別の PowerShell で `cli/` に移り、`npm run serve:check` を実行します(フェーズ3.5の確認と同じです。止めるときは Ctrl+C)。`http://127.0.0.1:18789` で動き、架空のトークンは `%TEMP%\pwm-serve-check\tokens.txt` に書かれます。
4. 漏洩チェックのモックサーバーを動かします。さらに別の PowerShell で `cli/` に移り、`npm run serve:breach` を実行します(止めるときは Ctrl+C)。
   - `http://127.0.0.1:18080` で待ち受けます(別のポートにするときは `npm run serve:breach -- 18081` のように書き、`PWM_BREACH_URL` も合わせます)。
   - 受け取った要求は `GET /range/<先頭5文字>  Add-Padding: true` の1行で画面に出ます。パスワードやハッシュの全体は画面にも届きません。
   - 架空の値(漏洩済みとして扱う値1つ、漏洩なしの値1つ、API キーの値1つ)は `%TEMP%\pwm-serve-breach\values.txt` に書かれます。画面には出ません。止めて起動し直しても、同じ値を使います。
5. 貼り方(フェーズ3.5の確認で、トークンを貼った時点のクリップボードの中身が違って 401 になることが何度かありました)。`pwm` が「同期トークン:」や「値:」で**止まってから**、**止まっている画面とは別の PowerShell** で次を実行して値だけをクリップボードに入れ、元の画面に戻って Ctrl+V を**1回だけ**押して Enter を押します。入力欄は何も表示しないので、2回貼らないようにします。値を2回入れる欄(「値:」「値(もう一度):」)は、クリップボードに入れ直さずに、同じ値をもう一度貼ります。

   ```powershell
   # 同期トークン(自動処理用)
   (Select-String -Path "$env:TEMP\pwm-serve-check\tokens.txt" -Pattern '^automation-token:\s*(\S+)').Matches[0].Groups[1].Value | Set-Clipboard
   # 漏洩済みとして扱う値
   (Select-String -Path "$env:TEMP\pwm-serve-breach\values.txt" -Pattern '^pwned-value:\s*(\S+)').Matches[0].Groups[1].Value | Set-Clipboard
   # 漏洩なしの値
   (Select-String -Path "$env:TEMP\pwm-serve-breach\values.txt" -Pattern '^clean-value:\s*(\S+)').Matches[0].Groups[1].Value | Set-Clipboard
   # API キーの値
   (Select-String -Path "$env:TEMP\pwm-serve-breach\values.txt" -Pattern '^apikey-value:\s*(\S+)').Matches[0].Groups[1].Value | Set-Clipboard
   ```

   クリップボードに入った値は、確認が終わったら `Set-Clipboard -Value " "` で上書きして消します。

## 確かめること

終了コードは、実行した直後に `$LASTEXITCODE` で見ます。

| # | 操作 | 期待 |
|---|---|---|
| 1 | `node $cli\pwm.mjs auto init --sync-url http://127.0.0.1:18789` を実行し、トークンの欄に `automation-token` を貼る | 「Created the automation vault.」と出る(日本語では「自動処理用の保管庫を作りました」)。トークンの欄が空のまま Enter を押したときは、通信せずに「The input is empty.」(「入力が空です」)と出て止まる |
| 2 | `node $cli\pwm.mjs auto add --title Demo-Pwned --username demo-user` を実行し、値の欄に `pwned-value` を2回貼る | 「Saved.」のあと、標準エラーに「This value has appeared in known breaches (31337 times). Use a different value.」(「この値は漏洩済みです(31337 回)。別の値にしてください。」)と出る。`$LASTEXITCODE` が 0。モックの画面に `GET /range/…  Add-Padding: true` が1行出る(1回だけ) |
| 3 | `node $cli\pwm.mjs auto add --title Demo-Clean` を実行し、値の欄に `clean-value` を2回貼る | 「Saved.」だけが出る(漏洩の知らせは出ない)。モックの画面に要求が1行増える |
| 4 | `node $cli\pwm.mjs auto add --title Demo-Key --type apikey --env test` を実行し、値の欄に `apikey-value` を2回貼る | 「Saved.」だけが出る。**モックの画面に要求が増えない**(API キーは送らない) |
| 5 | `node $cli\pwm.mjs audit` | 次の形で出る。`$LASTEXITCODE` が 3。モックの画面に要求が2行増える(Demo-Pwned と Demo-Clean の分。API キーの分は無い)。ユーザー名、URL、パスワード、ハッシュは出ない |
| 6 | `node $cli\pwm.mjs audit --notify` | 5 と同じ出力で、`$LASTEXITCODE` が 3。Windows のトーストが1つ出て、「pwm: 1 password(s) found in known breaches」(日本語では「pwm: 1 件のパスワードが漏洩済みです」)と件数だけが書かれている。項目名(Demo-Pwned)は書かれていない。トーストが見えないときは、通知センターを開く(集中モードや通知の設定で、画面に出ないことがあります) |
| 7 | Claude Code に `pwm-mcp` を登録する(下の「登録」)。Claude に「`audit` を使って漏洩チェックをして」と頼む | `Demo-Pwned` と 31337 が返る。`clean` が 1、`skipped` が 0、`notApplicable` が 1。パスワードやハッシュは返らない。ツールの一覧は `list_titles`、`read_credential`、`run`、`audit` の4つ |
| 8 | モックサーバー(`npm run serve:breach`)を Ctrl+C で止める。`node $cli\pwm.mjs audit --notify` を実行する | 「Skipped: 2」が出て、「Skipped items could not be checked … not confirmed clean.」の1行が付く。`Clean: 0`(漏洩なしとは数えない)。`$LASTEXITCODE` が 2。**トーストは出ない** |
| 9 | (7 の登録のまま)Claude に、もう一度「`audit` を使って」と頼む | `skipped` が 2、`clean` が 0、`pwned` が空 |
| 10 | `$env:PWM_BREACH_URL = "https://example.com"` にしてから `node $cli\pwm.mjs audit` を実行する。終わったら `$env:PWM_BREACH_URL = "http://127.0.0.1:18080"` に戻す | 「PWM_BREACH_URL must be … Nothing was sent.」と出て、`$LASTEXITCODE` が 1。何も送らない(モックを起動し直していても、画面に要求が出ない) |
| 11 | (任意)`node $cli\pwm.mjs main setup --sync-url http://127.0.0.1:18789` を実行し、本体用のトークンとマスターパスワード(tokens.txt の `main-token`、`master-password`)を貼る。モックを起動し直してから、`node $cli\pwm.mjs audit --main` を実行し、マスターパスワードを貼る | 本体の保管庫の項目 `Main Only Site` だけが調べられ、`Checked: 1  Pwned: 0  Clean: 1 …`。`$LASTEXITCODE` が 0。自動処理用の項目(Demo-*)は出ない。標準入力を流し込んで実行する(例: `"x" \| node $cli\pwm.mjs audit --main`)と、何も聞かずにやめる |

5 の期待する出力(英語)は次のとおりです。

```
Pwned:
  Demo-Pwned	31337
Checked: 2  Pwned: 1  Clean: 1  Skipped: 0  Not applicable: 1
```

### 登録

Claude Code の `claude mcp add` で、環境変数と起動のコマンドを渡して登録します(フェーズ3.5の手順書と同じです)。**`PWM_BREACH_URL` も入れます。** 入れないと、MCP の `audit` が実在の API に送ります。

```powershell
claude.cmd mcp add pwm --scope local -e PWM_HOME="$env:TEMP\pwm-check-36" -e PWM_BREACH_URL="http://127.0.0.1:18080" -- node "$cli\pwm-mcp.mjs"
```

- `claude` ではなく `claude.cmd` と書きます(PowerShell が `claude.ps1` の `--` を取り除くため)。名前の `pwm` は `-e` より前に置きます。
- 登録したあと、Claude Code を開き直して `/mcp` で `pwm` がつながっていることを確かめます。
- 登録を外すときは `claude.cmd mcp remove pwm --scope local` です。

## 毎日の自動チェック(タスクスケジューラ。この確認では登録しない)

毎日動かすときの書き方です。**確認用の `PWM_BREACH_URL` や `PWM_HOME` を入れず**、普段の置き場(`%LOCALAPPDATA%\pwm\`)を読みます。このときは実在の API(`https://api.pwnedpasswords.com`)に、ハッシュの先頭5文字だけが送られます。

```powershell
$node = (Get-Command node).Source
$sync = New-ScheduledTaskAction -Execute $node -Argument "`"$cli\pwm.mjs`" sync"
$audit = New-ScheduledTaskAction -Execute $node -Argument "`"$cli\pwm.mjs`" audit --notify"
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00
Register-ScheduledTask -TaskName "pwm audit" -Action @($sync, $audit) -Trigger $trigger
```

- `$cli` は、本番では `dist` を置いた固定の場所にします(リポジトリを動かすと動かなくなります)。
- ユーザーがログオンしているときに動かします(DPAPI の鍵とトーストは、そのユーザーのものです)。
- 結果は、タスクの「最後の実行結果」の終了コードで分かります。`audit` の終了コードは、漏洩済みあり 3、スキップのみ 2、漏洩なし 0、それ以外の失敗 1 です。`--notify` のトーストは、漏洩済みがあるときだけ出ます。
- `pwm audit` が調べるのは、前回の `pwm sync` の時点の写しです。上の例は、先に `sync` を動かします(`sync` が通信できなくても、`audit` は手元の写しで動きます)。

## 後片付け

- 登録を外します: `claude.cmd mcp remove pwm --scope local`
- `PWM_HOME` に使ったフォルダ(`$env:TEMP\pwm-check-36`)を削除し、`$env:PWM_HOME`、`$env:PWM_BREACH_URL`、`$env:PWM_LANG` を消します。
- `npm run serve:check` と `npm run serve:breach` を止めます。Windows では子のプロセス(workerd)が残ることがあるので、ポート 18789 と 18080 が空いたことを確かめます。
- `%TEMP%\pwm-serve-check\tokens.txt` と `%TEMP%\pwm-serve-breach\values.txt` を削除します。クリップボードを `Set-Clipboard -Value " "` で上書きします。

## 注意

- 確認に実在のパスワード、実在のサービスのキー、普段の `%LOCALAPPDATA%\pwm\` は使いません。実在の API に送るのは、確認が終わったあとに、利用者が普段の置き場で `pwm audit` を実行したときだけです。
- 送るのはハッシュの先頭5文字と、要求を送った事実(IP アドレスと時刻)までです。パスワードとハッシュの全体は送りません(設計書 §14)。
- 監査の結果はどこにも保存しません。ファイルにも保管庫にも書きません。
- `skipped`(スキップ)は「調べられなかった」であり、「漏洩なし」ではありません。
- MCP の `audit` が調べるのは自動処理用の保管庫だけです。本体の保管庫を調べる口はありません。
