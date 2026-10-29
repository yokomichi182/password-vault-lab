// 文言(英語を既定、日本語を用意。設計書 §5-1)。
// 失敗の文言には、値・ユーザー名・URL・参照の文字列を入れない。入れてよいのは件数・例外の型の名前・終了コードだけ。
export type Lang = "en" | "ja";

type P = Record<string, string | number>;

const messages = {
  unknownArg: {
    en: () => "Unknown or unsupported argument. (Values, tokens and passwords are never accepted as arguments.)",
    ja: () => "知らない引数です。(値・トークン・パスワードは引数では受け取りません。)",
  },
  badRef: {
    en: () => "The reference is not valid. Use TITLE or TITLE/FIELD.",
    ja: () => "参照の形が正しくありません。「タイトル」か「タイトル/欄」で指定してください。",
  },
  unknownField: {
    en: () => "Unknown field name. Use password, username, url, notes, type, environment or expires.",
    ja: () => "知らない欄の名前です。password、username、url、notes、type、environment、expires のどれかを指定してください。",
  },
  notFound: { en: () => "No matching item.", ja: () => "該当なし" },
  ambiguous: {
    en: (p: P) => `More than one item matches (${p.count}).`,
    ja: (p: P) => `タイトルが一致する項目が複数あります(${p.count}件)。`,
  },
  noAutomation: {
    en: () => "The automation vault is not set up on this PC.",
    ja: () => "自動処理用の保管庫がありません。",
  },
  noMain: {
    en: () => "The main vault is not set up on this PC. Run `pwm main setup` first.",
    ja: () => "本体の保管庫の設定がありません。先に `pwm main setup` を実行してください。",
  },
  noConfig: {
    en: () => "The sync URL is not set. Give --sync-url.",
    ja: () => "同期先の URL が未設定です。--sync-url を指定してください。",
  },
  badSyncUrl: {
    en: () => "The sync URL must be https, or http on localhost.",
    ja: () => "同期先の URL は https、または localhost の http にしてください。",
  },
  badVaultName: {
    en: () => "The vault name must match ^[a-z0-9-]{1,32}$.",
    ja: () => "保管庫の名前は ^[a-z0-9-]{1,32}$ に合う形にしてください。",
  },
  dpapiProtect: {
    en: (p: P) => `Could not protect the data with DPAPI (exit code ${p.code}).`,
    ja: (p: P) => `DPAPI で守れませんでした(終了コード ${p.code})。`,
  },
  dpapiOpen: {
    en: (p: P) => `Could not open the data with DPAPI (exit code ${p.code}).`,
    ja: (p: P) => `DPAPI で開けませんでした(終了コード ${p.code})。`,
  },
  cannotOpen: {
    en: (p: P) => `Cannot open the vault (${p.label}).`,
    ja: (p: P) => `保管庫を開けません(${p.label})。`,
  },
  cannotOpenServer: {
    en: (p: P) => `The vault on the sync server cannot be opened with this key (${p.label}). Nothing was changed.`,
    ja: (p: P) => `同期先の保管庫をこの鍵では開けません(${p.label})。何も変えていません。`,
  },
  needTty: {
    en: () => "This needs an interactive terminal (stdin must be a TTY). Nothing was done.",
    ja: () => "この操作は端末(標準入力が TTY)でだけ行えます。何もしていません。",
  },
  cancelled: { en: () => "Cancelled. Nothing was written.", ja: () => "中止しました。何も書いていません。" },
  mismatch: {
    en: () => "The two inputs do not match. Nothing was written.",
    ja: () => "2回の入力が一致しません。何も書いていません。",
  },
  emptyInput: { en: () => "The input is empty. Nothing was written.", ja: () => "入力が空です。何も書いていません。" },
  syncAuth: {
    en: () => "The sync server refused the token (401/403). Nothing was changed.",
    ja: () => "同期先がトークンを受け付けませんでした(401/403)。何も変えていません。",
  },
  syncSkipped: {
    en: () => "Skipped: the sync server could not be reached. Nothing was changed.",
    ja: () => "スキップしました: 同期先に通信できません。何も変えていません。",
  },
  offlineNoWrite: {
    en: () => "The sync server could not be reached. Offline writes are not supported; nothing was changed.",
    ja: () => "同期先に通信できません。オフラインでは書き込めません。何も変えていません。",
  },
  syncEmpty: {
    en: () => "The sync server has no version of this vault. Nothing was changed.",
    ja: () => "同期先にこの保管庫の版がありません。何も変えていません。",
  },
  syncRejected: {
    en: (p: P) => `The sync server rejected the write (status ${p.status}). Nothing was changed.`,
    ja: (p: P) => `同期先が書き込みを受け付けませんでした(状態 ${p.status})。何も変えていません。`,
  },
  syncDone: {
    en: (p: P) => `Synced (version ${p.version}).`,
    ja: (p: P) => `同期しました(版 ${p.version})。`,
  },
  conflictGiveUp: {
    en: (p: P) => `The server version kept changing (${p.count} conflicts). Nothing was changed.`,
    ja: (p: P) => `同期先の版が変わり続けました(競合 ${p.count} 回)。何も変えていません。`,
  },
  serverHasVersion: {
    en: () => "The sync server already has a version of this vault. Its key file is not on this PC, so it cannot be opened. Nothing was created.",
    ja: () => "同期先にはすでにこの保管庫の版があります。そのキーファイルは手元にないので開けません。何も作っていません。",
  },
  saved: { en: () => "Saved.", ja: () => "保存しました。" },
  created: { en: () => "Created the automation vault.", ja: () => "自動処理用の保管庫を作りました。" },
  duplicateTitle: {
    en: () => "An item with that title already exists. Nothing was changed.",
    ja: () => "同じタイトルの項目がすでにあります。何も変えていません。",
  },
  nothingToChange: {
    en: () => "Nothing to change. Give at least one option.",
    ja: () => "変える項目の指定がありません。オプションを1つ以上指定してください。",
  },
  badItemType: { en: () => "The type must be password or apikey.", ja: () => "種類は password か apikey にしてください。" },
  badExpires: { en: () => "The expiry must be YYYY-MM-DD.", ja: () => "期限は YYYY-MM-DD の形にしてください。" },
  badTitle: { en: () => "The title is empty.", ja: () => "タイトルが空です。" },
  badEnvSpec: {
    en: () => "Each --env must be NAME=REFERENCE, where NAME matches ^[A-Za-z_][A-Za-z0-9_]{0,63}$.",
    ja: () => "--env は 名前=参照 の形にしてください。名前は ^[A-Za-z_][A-Za-z0-9_]{0,63}$ に合う形です。",
  },
  envExists: {
    en: () => "That variable name already exists in the environment; overriding it is not allowed.",
    ja: () => "その変数名はすでに環境にあります。上書きする指定はできません。",
  },
  noEnv: { en: () => "Give at least one --env NAME=REFERENCE.", ja: () => "--env 名前=参照 を1つ以上指定してください。" },
  noCommand: { en: () => "Give the command to run after `--`.", ja: () => "`--` のあとに実行するコマンドを指定してください。" },
  badTimeout: { en: () => "The timeout must be a positive number of seconds.", ja: () => "--timeout は正の秒数にしてください。" },
  spawnFailed: { en: () => "Could not start the command.", ja: () => "コマンドを起動できませんでした。" },
  confirmRemove: { en: () => "Remove this item? (y/N): ", ja: () => "この項目を削除しますか?(y/N): " },
  promptToken: { en: () => "Sync token: ", ja: () => "同期トークン: " },
  promptMaster: { en: () => "Master password: ", ja: () => "マスターパスワード: " },
  promptValue: { en: () => "Value: ", ja: () => "値: " },
  promptValueAgain: { en: () => "Value (again): ", ja: () => "値(もう一度): " },
  promptNotes: { en: () => "Notes: ", ja: () => "メモ: " },
  lastSync: { en: (p: P) => `Offline. Using the last synced copy (last sync: ${p.at}).`, ja: (p: P) => `オフラインです。前回の同期の写しを使います(前回の同期: ${p.at})。` },
  noLastSync: { en: () => "The sync server could not be reached and there is no saved copy.", ja: () => "同期先に通信できず、保存した写しもありません。" },
  unexpected: { en: (p: P) => `Unexpected error (${p.label}).`, ja: (p: P) => `予期しないエラーです(${p.label})。` },
  mcpToolError: { en: (p: P) => `The tool failed (${p.label}).`, ja: (p: P) => `ツールが失敗しました(${p.label})。` },
  mcpBadTimeout: {
    en: (p: P) => `timeout_seconds must be between 1 and ${p.max}.`,
    ja: (p: P) => `timeout_seconds は 1 から ${p.max} の間にしてください。`,
  },
  mcpBadCommand: { en: () => "command must be a non-empty array of strings.", ja: () => "command は空でない文字列の配列にしてください。" },
} as const;

export type MsgKey = keyof typeof messages;

export function detectLang(environ: Record<string, string | undefined>): Lang {
  const forced = environ.PWM_LANG;
  if (forced === "en" || forced === "ja") return forced;
  let locale = "en";
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    // 既定の英語のまま
  }
  return locale.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export function msg(lang: Lang, key: MsgKey, params: P = {}): string {
  const entry = messages[key] as Record<Lang, (p: P) => string>;
  return entry[lang](params);
}
