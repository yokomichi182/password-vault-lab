import type { Prompter } from "./ctx.ts";

/** 端末から1行を受け取る。echo が false のとき、入力した文字を端末に返さない。Ctrl+C は null。案内の文言は標準エラーに出す。 */
function readTty(label: string, echo: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(label);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let buf: string[] = [];
    const finish = (value: string | null) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      buf = [];
      resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003" || ch === "\u0004") return finish(null); // Ctrl+C / Ctrl+D
        if (ch === "\r" || ch === "\n") return finish(buf.join(""));
        if (ch === "\u007f" || ch === "\b") {
          buf.pop();
          continue;
        }
        if (ch < " ") continue; // 制御文字は入れない
        buf.push(ch);
        if (echo) process.stderr.write(ch);
      }
    };
    stdin.on("data", onData);
  });
}

export const ttyPrompter: Prompter = {
  hidden: (label) => readTty(label, false),
  line: (label) => readTty(label, true),
};
