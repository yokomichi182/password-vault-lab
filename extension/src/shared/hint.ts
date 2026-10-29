/** ユーザー名の一部。先頭2文字のあとを … にする。2文字以下なら … だけ(承認画面で、全部は見せない)。 */
export function usernameHint(username: string): string {
  const chars = Array.from(username);
  return chars.length <= 2 ? "…" : chars.slice(0, 2).join("") + "…";
}

/** 表示用に、制御文字を空白にして、長さを切る(要求した AI の名前は自己申告)。 */
export function displayName(raw: string, max = 64): string {
  const flat = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  const cut = Array.from(flat).slice(0, max).join("").trim();
  return cut === "" ? "(unknown)" : cut;
}
