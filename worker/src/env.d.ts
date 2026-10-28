declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    /** JSON: {"<トークンの SHA-256 の16進>": "<保管庫名>"} */
    TOKENS: string;
  }
}
interface Env extends Cloudflare.Env {}
