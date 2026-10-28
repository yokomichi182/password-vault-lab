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
| 作業フォルダのファイル | テスト後に `npm run scan:canary` を実行する | 実施 |

作業フォルダは次の条件で探査します。

- 除外: `.git`、`node_modules`、カナリアを定義する `AGENTS.md`、テスト入力の `worker/test/tokens.ts`
- 除外(フェーズ1で追加): `android/app/src/test/` と `tests/xcheck/` の下で、Git で追跡しているファイル。追跡していないファイルは、同じフォルダにあっても探査する
- 作業フォルダの外の探査先(フェーズ1で追加): Android のビルドの出力先 `~/pwvault-build`。テストのソースをコンパイルしたクラスファイル(`compileDebugUnitTestKotlin/classes` の下)だけ除外する
- 作業フォルダの外の探査先(フェーズ1で追加): 環境変数 `PWV_XCHECK_DIR` を指定したときは、その出力先(kdbxweb との相互確認の .kdbx など)。除外は設けない
- 追加(フェーズ3): `extension/dist` と Playwright の出力(`extension/test-results`、`extension/playwright-report`)も探査対象。除外は設けない。拡張のテストのソース(`extension/test`、`extension/e2e`)は目印の文字列を実行時に組み立てて書かないので、除外も不要
- 探査対象: `.wrangler` を含むファイル。本体用の文字列と自動処理用の接頭辞を検索
- シンボリックリンク: 追跡しない。存在を検出した時点で、未検査の経路があるため失敗
- 検出時の表示: 値そのものは出さず、ファイルの相対パスだけを表示して失敗
