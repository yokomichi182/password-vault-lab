# パスワード管理ツール（実験・学習用）

## 正本
- 設計書: `C:\Vault\05_Projects\パスワード管理ツール\設計書v0.3.md`（これだけを使う。このフォルダの `01_設計書.md` は古い v0.1）
- 精査の記録: `C:\Vault\05_Projects\パスワード管理ツール\ハーネス精査_v0.2.md`

## 構成
- `worker/` … Cloudflare Worker + D1（フェーズ0）
- `android/` … Android アプリ（フェーズ1・2）
- `extension/` … Chrome 拡張（フェーズ3）
- `cli/` … PC 用 CLI（フェーズ3.5）

## 絶対に守ること
- 暗号を自作しない。鍵の導出・暗号化・KDBX の読み書きは、設計書に挙げたライブラリ（kotpass、kdbxweb、argon2 の WASM）だけで行う。乱数は `crypto.getRandomValues` / `SecureRandom` だけを使う。
- パスワード、マスターパスワード、鍵、同期トークンを、ログ・例外のメッセージ・エラーレスポンス・ファイルに出さない。
- テストには架空のデータだけを使う。テスト用のパスワードには目印 `CANARY-7f3e9a1c` を含める（設計書 §13-1）。
- 実在するサービスのアカウント、本物のパスワード、本物の同期トークンを使わない、書かない。
- 次のコマンドは実行しない（必要なら止めて Opus に返す）: `wrangler deploy`、`wrangler login`、`wrangler secret put`、`wrangler d1 ... --remote`、`git push`、`adb install`（実機）。
- コードや設定、テストのデータを、外部の AI（Gemini Flash の delegate.ps1 など）に渡さない。
- 秘密の値は `.dev.vars`（git 管理外）に置く。コミットしない。

## 進め方
- フェーズの完了は自分で宣言しない。テストを実行し、結果をそのまま報告する。完了の判定は Opus が精査して行う。
- 依存パッケージの追加が必要なら、パッケージ名と理由を報告して止まる（`npm install` は Opus が実行する）。
- 設計書と食い違う実装が必要になったら、勝手に変えず、理由を報告する。
