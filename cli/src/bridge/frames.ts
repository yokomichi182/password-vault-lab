// Native Messaging の枠: 4バイト(リトルエンディアン)の長さ + UTF-8 の JSON。
export const MAX_FRAME_BYTES = 64 * 1024;

export function encodeFrame(msg: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * 受け取ったバイト列から、枠を切り出す。1つの枠が上限を超えたら onTooBig を呼んで止める(これ以上読まない)。
 * JSON として読めない枠は捨てる(onMessage を呼ばない)。
 */
export class FrameReader {
  private buf: Buffer = Buffer.alloc(0);
  private stopped = false;
  constructor(
    private readonly onMessage: (msg: unknown) => void,
    private readonly onTooBig: () => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.stopped) return;
    this.buf = Buffer.concat([this.buf, chunk]);
    for (;;) {
      if (this.buf.length < 4) return;
      const len = this.buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) {
        this.stopped = true;
        this.onTooBig();
        return;
      }
      if (this.buf.length < 4 + len) return;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let msg: unknown;
      try {
        msg = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }
}
