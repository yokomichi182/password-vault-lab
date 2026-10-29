import { spawn } from "node:child_process";

// Windows のトースト通知を、Windows PowerShell 5.1 の子プロセスで出す(DPAPI と同じ方式)。
// スクリプトは値を含まない固定のもの(-EncodedCommand)。表示する文言は標準入力で渡す(UTF-8 の base64)。
// 文言に入れてよいのは、固定の語句と件数の数字だけ(項目名・値は入れない。設計書 §14-2)。
const SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $text = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(([Console]::In.ReadToEnd()).Trim()))
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $xml = New-Object Windows.Data.Xml.Dom.XmlDocument
  $xml.LoadXml('<toast><visual><binding template="ToastGeneric"><text>' + [System.Security.SecurityElement]::Escape($text) + '</text></binding></visual></toast>')
  $toast = New-Object Windows.UI.Notifications.ToastNotification $xml
  $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)
  exit 0
} catch {
  exit 2
}
`;

const ENCODED_SCRIPT = Buffer.from(SCRIPT, "utf16le").toString("base64");

/** トーストを1つ出す。出せなかったときは例外(呼び出し側が「通知を出せませんでした」とだけ出す)。 */
export function windowsToast(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED_SCRIPT], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        shell: false,
      });
    } catch {
      reject(new Error("toast spawn failed"));
      return;
    }
    child.on("error", () => reject(new Error("toast spawn failed")));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`toast failed (${code ?? 1})`))));
    child.stdin.on("error", () => undefined);
    child.stdin.end(Buffer.from(text, "utf8").toString("base64") + "\n");
  });
}
