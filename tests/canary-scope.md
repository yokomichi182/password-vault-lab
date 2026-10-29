# カナリア探査範囲

このファイルで、全フェーズに共通するカナリアの探査先を固定します。フェーズを追加するときは探査方法を追記し、既存の探査先は削除しません。

| 探査先 | 探査方法 | フェーズ0での扱い |
|---|---|---|
| コンソールのログ | Vitestで `console` の各メソッドを監視し、ローカル実行の標準出力と標準エラーも検索する | 実施 |
| Workerのログ | `wrangler dev` の標準出力と標準エラーを一時ファイルへ保存して検索する | ローカルのみ実施。リモートへのデプロイは禁止 |
| `chrome.storage.local` | 拡張の設定画面のページ(拡張のオリジン)で `chrome.storage.local.get(null)` の全体を文字列にして検索する。置いてあるキーの一覧も固定して確かめる(`extension/e2e/z-canary.spec.ts`) | フェーズ3から実施 |
| IndexedDB | 拡張のオリジンとテストのページのオリジンで `indexedDB.databases()` を列挙し、各データベースの全オブジェクトストアの中身を検索する(同じ spec) | フェーズ3から実施 |
| Androidのlogcat | `adb -s emulator-5554 logcat -d` の全体(アプリのプロセスと `system_server` を含む)を、一時ファイルに取らずにその場で `grep -c` で本体用の目印(AGENTS.md)を検索する。`-b all` でも確かめる | フェーズ2から実施 |
| 拡張のコンソール(フェーズ3で追加) | Playwright で、service worker、ポップアップ(拡張のページ)、テストのページの `console` を worker の起動から終了まで集め、検索する(同じ spec) | フェーズ3から実施 |
| Chrome の一時プロファイル(フェーズ3で追加) | Playwright が使う一時プロファイル(作業フォルダの外の `%TEMP%\pwv-e2e-profile-*`)を、ブラウザを閉じたあとに全ファイル検索する(`extension/e2e/fixtures.ts` の後始末。見つかれば失敗) | フェーズ3から実施 |
| CLI と MCP(フェーズ3.5で追加) | `cli/test/` の vitest で、`pwm` と `pwm-mcp` の標準出力と標準エラーを集めて検索する。`pwm-mcp` は MCP の通信(標準出力の全体の JSON)を生のまま集める(`run` で子が値を出す場合を含む。`cli/test/mcp.test.ts` の 19)。`list_titles`・すべてのエラー・`pwm auto list`・`pwm sync` の出力にも目印が無いこと。テストで使った `PWM_HOME`(作業フォルダの外の一時フォルダ)の全ファイル(DPAPI のファイルと `.kdbx` を含む)を、後始末の前に検索する(`registerHomeScan`)。`cli/test/integration/` では `wrangler dev` の標準出力と標準エラーも検索する。探査の対象外にするのは、値を出す設計の2つだけ(`pwm read` の標準出力と、MCP の `read_credential` の応答)。`run` は伏せ字にした後の出力を検索する | フェーズ3.5から実施 |
| 監査とモックサーバー(フェーズ3.6で追加) | `cli/test/audit.test.ts`、`notifyMain.test.ts`、`postsave.test.ts`、`mcpAudit.test.ts` で、`pwm audit`(漏洩あり・なし・スキップ・エラー、英語と日本語)の標準出力と標準エラー、`auto add`・`update --value` のあとのチェックの出力、通知に渡した文言、MCP の `audit` の応答(生の標準出力の全体)と `pwm-mcp` の標準エラー、差し替えた `fetch` が受け取った URL とヘッダー(目印も、ハッシュの6文字目以降も無いこと)を探す。モックサーバー(`MockBreachServer`)が記録した要求のパス・ヘッダー・本文も探す(`cli/test/integration/audit.test.ts` は束ねた `dist/pwm.mjs` と `dist/pwm-mcp.mjs` を別のプロセスで動かして通す)。テストで使った `PWM_HOME` の全ファイルを後始末の前に検索し、監査の前後でファイルが増えないことも確かめる。ハッシュは、全体も先頭5文字も出力・通知・MCP の応答に出さない(先頭5文字がモックの記録に届くのは設計どおりで、記録の検査は「パスが `/range/<5文字>` の形だけであること」と「目印とハッシュの6文字目以降が無いこと」を確かめる) | フェーズ3.6から実施 |
| AI 連携(フェーズ5で追加) | ①つなぎの置き場 `<PWM_HOME>ridge\`: Playwright の `extension/e2e/z-canary.spec.ts` が、テスト中の `req-*.json`・`res-*.json` と、ホストの `PWM_HOME` の全ファイルを探す(本体用と自動処理用の両方。見つかれば失敗)。`extension/e2e/fixtures.ts` の後始末も、ブラウザを閉じたあと、フォルダを消す前に同じ探査を行う。`cli/test/bridge.test.ts` は依頼ファイルの欄が ID・項目名・url・AI の名前・時刻だけであることを確かめる。②`pwm-mcp` と `pwm-bridge` の標準エラー: `cli/test/mcpEmulation.test.ts`(実際のプロセス)と `mcpApprove.test.ts` が `pwm-mcp` の標準エラーを集めて探す(出てよいのは結果の種類まで。項目名も出ない)。`pwm-bridge` は標準エラーに何も出さないことを `bridge.test.ts` が確かめる。③拡張のコンソールと `chrome.storage.local`: `z-canary.spec.ts` が service worker・承認画面・設定画面・テストのページのコンソール全体に、目印と、使った項目名・ユーザー名が無いことを確かめ、`chrome.storage.local` のキー(`approvals` は任意)と、承認リストの1件がオリジンと時刻だけであることを確かめる。④`request_credential` の子のプロセス: 標準エラーが空であること、`PWM_HOME` の全ファイル(`registerHomeScan`)に本体の目印が無いこと(`cli/test/approve.test.ts`、`mcpEmulation.test.ts`)。探査の対象外にするのは、値を返す設計の `request_credential` の応答だけ(`read_credential` と同じ扱い)。台本のファイル(マスターパスワードを含む)は `PWM_HOME` の外の一時フォルダに置く | フェーズ5から実施 |
| 作業フォルダのファイル | テスト後に `npm run scan:canary` を実行する | 実施 |

作業フォルダは次の条件で探査します。

- 除外: `.git`、`node_modules`、カナリアを定義する `AGENTS.md`、テスト入力の `worker/test/tokens.ts`
- 除外(フェーズ1で追加): `android/app/src/test/` と `tests/xcheck/` の下で、Git で追跡しているファイル。追跡していないファイルは、同じフォルダにあっても探査する
- 作業フォルダの外の探査先(フェーズ1で追加): Android のビルドの出力先 `~/pwvault-build`。テストのソースをコンパイルしたクラスファイル(`compileDebugUnitTestKotlin/classes` の下)だけ除外する
- 作業フォルダの外の探査先(フェーズ1で追加): 環境変数 `PWV_XCHECK_DIR` を指定したときは、その出力先(kdbxweb との相互確認の .kdbx など)。除外は設けない
- 追加(フェーズ3): `extension/dist` と Playwright の出力(`extension/test-results`、`extension/playwright-report`)も探査対象。除外は設けない。拡張のテストのソース(`extension/test`、`extension/e2e`)は目印の文字列を実行時に組み立てて書かないので、除外も不要
- 追加(フェーズ5): `cli/dist/test/`(テスト用のビルド)も探査対象(`cli/dist` の下)。
- 追加(フェーズ3.5): `cli/dist`(`pwm.mjs` と `pwm-mcp.mjs`。フェーズ3.6からは `serve-breach.mjs` も)も探査対象。除外は設けない。`cli/test` のソースは目印の文字列を実行時に組み立てて書かないので、除外も不要。`cli/test/integration/` の `wrangler dev` の状態は作業フォルダの外の一時フォルダに置く
- 探査対象: `.wrangler` を含むファイル。本体用の文字列と自動処理用の接頭辞を検索
- シンボリックリンク: 追跡しない。存在を検出した時点で、未検査の経路があるため失敗
- 検出時の表示: 値そのものは出さず、ファイルの相対パスだけを表示して失敗
