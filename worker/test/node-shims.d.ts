// @types/node を入れずに、設定ファイル側の Node 標準モジュールだけ最小限の型を与える。
declare module "node:path" {
  const path: { join(...parts: string[]): string };
  export default path;
}
declare module "node:crypto" {
  export function createHash(alg: string): {
    update(data: string): { digest(enc: "hex"): string };
  };
}
interface ImportMeta {
  readonly dirname: string;
}
