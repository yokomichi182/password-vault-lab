import { usernameHint } from "../shared/hint.ts";
import { isLoginType, itemOrigin, matchItems } from "../shared/match.ts";
import type { Session } from "../shared/storage.ts";

// request_fill の処理(設計書 §11-3、実装指示_フェーズ5 の 3-4・3-5)。外とのつながりは引数で受け取る(単体テストで差し替える)。
// AI に返すのは結果の語だけ。値、ユーザー名、オリジンは返さない。ここから先のログにも項目名・ユーザー名・値を出さない。

export type FillResult = "filled" | "denied" | "not_found" | "locked" | "unavailable";

export interface FillRequest {
  id: string;
  title: string;
  /** AI が渡した URL。照合には使わない。渡されたときは、実際のタブのオリジンと違えば入力しない */
  url?: string;
  /** 要求した AI の名前(自己申告) */
  client: string;
}

export interface FillTarget {
  tabId: number;
  /** コンテンツスクリプトが返したオリジン(入力してよいページのものだけ) */
  origin: string;
}

export interface ApprovalAsk {
  origin: string;
  title: string;
  /** ユーザー名の一部(先頭2文字のあと … ) */
  userHint: string;
  client: string;
  tabId: number;
}

export interface FillDeps {
  getSession(): Promise<Session | null>;
  /** 最後にフォーカスした通常の窓の、表示中のタブ。入力してよいページでなければ null */
  getTarget(): Promise<FillTarget | null>;
  isApproved(origin: string): Promise<boolean>;
  addApproval(origin: string): Promise<void>;
  /** 承認画面を出して、本人の答え(承認 true、拒否・時間切れ・窓を閉じた false)を待つ */
  askApproval(ask: ApprovalAsk): Promise<boolean>;
  /** 入力する(見える欄だけ、最上位のフレームだけ。送り先でもオリジンを確かめ直す)。入れる欄が無ければ false */
  fillTab(tabId: number, origin: string, username: string, password: string): Promise<boolean>;
}

export async function handleFill(deps: FillDeps, req: FillRequest): Promise<FillResult> {
  try {
    const session = await deps.getSession();
    if (!session) return "locked";

    const target = await deps.getTarget();
    if (!target) return "not_found";
    if (req.url !== undefined) {
      // AI の URL は照合に使わない。実際のタブと違うなら、AI の誤りか誘導なので入力しない
      const expected = itemOrigin(req.url);
      if (expected === null || expected !== target.origin) return "not_found";
    }

    // 種類がパスワードの項目だけ(matchItems が API キーと知らない種類を除く)。項目名の完全一致で、1件だけのとき
    const hits = matchItems(session.items, target.origin).filter((i) => i.title === req.title);
    if (hits.length !== 1) return "not_found";
    let item = hits[0]!;

    const approved = await deps.isApproved(target.origin);
    if (!approved) {
      const yes = await deps.askApproval({
        origin: target.origin,
        title: item.title,
        userHint: usernameHint(item.username),
        client: req.client,
        tabId: target.tabId,
      });
      if (!yes) return "denied";
      // 入力の直前に、タブとオリジンを確かめ直す(承認画面を出したときと同じタブ ID で、同じオリジンのとき)
      const again = await deps.getTarget();
      if (!again || again.tabId !== target.tabId || again.origin !== target.origin) return "not_found";
      const session2 = await deps.getSession();
      if (!session2) return "locked";
      const latest = session2.items.find((i) => i.id === item.id);
      if (!latest || !isLoginType(latest.itemType) || matchItems([latest], again.origin).length !== 1) return "not_found";
      item = latest;
    }

    const filled = await deps.fillTab(target.tabId, target.origin, item.username, item.password);
    if (!filled) return "not_found";
    // 承認リストに足すのは、入力できたとき(入れる欄が無かったときは足さない)
    if (!approved) await deps.addApproval(target.origin).catch(() => undefined);
    return "filled";
  } catch {
    return "unavailable";
  }
}
