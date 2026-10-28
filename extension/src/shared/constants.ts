// 属性名と種類の値は Android の KdbxCodec / ItemTypes と同じ文字列(設計書 §2-1)。
export const ITEM_TYPE_FIELD = "ItemType";
export const ENVIRONMENT_FIELD = "Environment";
export const ANDROID_APP_FIELD = "AndroidApp";

export const ItemTypes = {
  PASSWORD: "password",
  APIKEY: "apikey",
} as const;

export const VAULT_NAME_RE = /^[a-z0-9-]{1,32}$/;
export const DEFAULT_VAULT_NAME = "main";
export const DEFAULT_SESSION_HOURS = 8;
export const MIN_SESSION_HOURS = 1;
export const MAX_SESSION_HOURS = 24;

/** 自動入力を待つ時間(文書の読み込みから。設計書 §6)。 */
export const WAIT_FOR_FORM_MS = 10_000;
/** コピーしたあとクリップボードを消すまでの時間。 */
export const CLIPBOARD_CLEAR_MS = 30_000;
