# F6b チャット(画面) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F6aのチャットAPIの上に、つながり一覧・チャット・操作メニュー・送信失敗の画面を`prototype/`基準で実装し、2人の送受信・取り消し・表示から消すをweb E2Eで確かめる。

**Architecture:** 受信はWebSocket(画面を開いている間だけ・チケットは接続ごとに取得・切れたら待ち時間を倍にして再接続)、送信はREST(`client_id`付き・失敗は同じ`client_id`で再送)の案A。履歴と一覧はTanStack Queryの頁送り(`useInfiniteQuery`)で持ち、WebSocketで届いたメッセージは履歴のキャッシュへ足す。接続処理は`src/chat/socket.ts`に閉じ、WebSocketと時計を差し替えて単体試験する。workerは変更しない。

**Tech Stack:** React 19・react-router・TanStack Query v5・vitest+Testing Library(happy-dom)・Playwright(web E2E)・zod(`@latch/shared`)

**Spec:** `docs/superpowers/specs/2026-10-21-f6b-chat-screens-design.md`

## Global Constraints

- 応答・コメント・コミットメッセージ・文書は日本語。コミットは`git add <パス>`で対象を限定する(`git add -A`・`git commit -a`禁止)。コミットメッセージは`F6b: …`で始め、末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- `apps/web/src/styles/latch.css`は編集しない。見た目は`prototype/app/app.js`の`screens.chat`・`screens.connections`・`chatHead`と`prototype/project/{Chat,ChatGroup,ChatEnded,ChatMenu,SendFailed,Connections,ConnectionsEmpty}.dc.html`のクラス名・文言を移植する。足りない見た目はapps/web側の新しいCSSファイルへ
- 1通の上限は2,000字(`LIMITS.MESSAGE_BODY_MAX_LENGTH`を使う。prototypeの1,000字は使わない)
- 通報・ブロック・アンケート・アプリ内通知アイコン・オフラインの帯は作らない(設計書 §0.3)
- 終了したつながりの名前: 成立後のcancelled=「つながっていた相手」+無地のアイコン(`avatar--gone`)、completed=実名
- 時刻はJST(UTC+9固定オフセット・Intlは使わない)。時計を直接読む関数を作らず`now: Date`を引数に取る
- 旧実装への言及をしない。用語は「アプリ内通知」「つながりIntent」「機会Intent」
- 毎コミット前に`pnpm lint`・`pnpm typecheck`・`pnpm --filter web exec vitest run`が緑
- 文書の変更は00 §3に従い、版数を上げ・冒頭に変更点行を追記し・前提文書欄と00 §1の版数表を揃える

## Review Focus

1. 送信中にWebSocketで同じメッセージが先に届き、その後RESTの201が届く → 吹き出しは1つだけ(Task 6で試験)
2. 再接続の直後に、切れていた間の相手の発言が表示される(最新頁の取り直し)→ 重複なく時系列順(Task 2の`appendMessage`とTask 6で試験)
3. 自分が「参加を取り消す」を押した直後に自分の接続へ`closed`が届く → 画面は読み取り専用の表示のまま、再接続しない(Task 3・Task 7で試験)
4. 空白・改行だけの入力 → [送る]は押せず、Ctrl/⌘+Enterでも送らない(Task 6で試験)
5. 本人だけが抜けたグループ(leaveの応答がstatus=matched)→ `/connections`へ戻る。チャット画面に残って404を出し続けない(Task 7で試験)

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `apps/web/src/latches/format.ts`(変更) | 内部の`hm`・`md`・`dayIndex`を`formatHm`・`formatMd`・`jstDayIndex`として公開 |
| `apps/web/src/chat/format.ts`(新規) | 名前・副題・日付の区切り・経過時刻・終了の判定 |
| `apps/web/src/chat/queries.ts`(新規) | 一覧・履歴・送信・既読・me・leave・DELETE・チケット |
| `apps/web/src/chat/socket.ts`(新規) | WebSocketの接続・再接続・ping |
| `apps/web/src/screens/latch/art.tsx`(変更) | `LatchArtState`に`"ended"` |
| `apps/web/src/screens/TabBar.tsx`(新規) | 下部タブ(Homeから切り出し) |
| `apps/web/src/screens/chat/Connections.tsx`(新規) | つながり一覧 |
| `apps/web/src/screens/chat/Chat.tsx`・`MessageList.tsx`・`Composer.tsx`・`ChatMenu.tsx`(新規) | チャット |
| `apps/web/src/screens/chat/chat.css`(新規) | ボードに無い見た目(送信中の吹き出し) |
| `apps/web/src/routes/paths.ts`・`apps/web/src/router.tsx`(変更) | `/connections`・`/latches/:id/chat` |
| `apps/web/src/screens/Home.tsx`・`screens/latch/Matched.tsx`・`screens/latch/NotEstablished.tsx`・`screens/latch/LatchScreen.tsx`(変更) | 設計書 §1.7 |
| `apps/web/e2e/chat-flow.spec.ts`(新規)・`apps/web/e2e/helpers.ts`(変更) | web E2E |

---

### Task 1: 表示文字列と終了の判定(chat/format.ts)

**Files:**
- Modify: `apps/web/src/latches/format.ts`
- Create: `apps/web/src/chat/format.ts`
- Test: `apps/web/src/chat/format.test.ts`

**Interfaces:**
- Produces(latches/format.ts): `formatHm(ms: number): string`(`H:MM`・時は0埋めなし)・`formatMd(ms: number): string`(`M月D日`)・`jstDayIndex(ms: number): number`。既存の関数は中身を変えずこれらを使う
- Produces(chat/format.ts):
  - `ENDED_PARTNER_NAME = "つながっていた相手"`
  - `isEndedConnection(latch: LatchDTO): boolean` — status が `completed` または `cancelled`
  - `connectionName(latch: LatchDTO): string` — cancelled→`ENDED_PARTNER_NAME`/それ以外は`members`の`display_name`を`・`でつなぐ(membersが空なら`ENDED_PARTNER_NAME`)
  - `connectionSubtitle(latch: LatchDTO): string[]` — `[主題, 形式]`に終了なら`"終了"`を足した配列(主題が`null`なら省く。形式は`connection`→`つながり`・`occasion`→`機会`)。画面は`<span class="sep">·</span>`でつなぐ
  - `senderName(latch: LatchDTO, userId: string): string` — membersに居ればその`display_name`、居なければ`ENDED_PARTNER_NAME`
  - `formatAgo(iso: string, now: Date): string` — prototype `ago`: 1分未満`いま`/1時間未満`N分前`/同じ日`H:MM`/前日`昨日`/7日未満`N日前`/それ以外`M月D日`
  - `formatDayLabel(iso: string, now: Date): string` — 同じ日`今日`/それ以外`M月D日`
  - `isSameJstDay(a: string, b: string): boolean`

- [ ] **Step 1: 失敗する試験を書く**
  - `formatAgo`: 30秒前→`いま`・59分前→`59分前`・同日3時間前→`H:MM`・JSTの前日(UTC 14:59と15:00をまたぐ例)→`昨日`・6日前→`6日前`・7日前→`M月D日`
  - `formatDayLabel`: 同日→`今日`・前日→`M月D日`
  - `connectionName`: matched 1対1→相手名/グループ3人→`ゆう・ちひろ`/completed→実名/cancelled→`つながっていた相手`
  - `connectionSubtitle`: matched→`["イラスト仲間","つながり"]`/completed→`[…,"終了"]`/topic null→形式から始まる
  - `senderName`: membersに居ない`u9`→`つながっていた相手`
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/chat/format.test.ts src/latches/format.test.ts` → FAIL(モジュール無し)
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** — 同コマンドでPASS(既存のlatches/format.test.tsも緑)
- [ ] **Step 5: コミット** — `F6b: つながりとチャットの表示文字列を追加する`

---

### Task 2: 取得・送信のhooks(chat/queries.ts)

**Files:**
- Create: `apps/web/src/chat/queries.ts`
- Test: `apps/web/src/chat/queries.test.tsx`

**Interfaces:**
- Consumes: `apiFetch`・`ApiError`(`src/api/client.ts`)、`LATCHES_QUERY_KEY`・`latchQueryKey`(`src/latches/queries.ts`)、`@latch/shared`の`LatchDTO`・`MessageDTO`・`MessagePage`・`UserDTO`
- Produces:
  - `CONNECTIONS_QUERY_KEY = ["latches", "connections"] as const`(`LATCHES_QUERY_KEY`配下なので既存の無効化で取り直される)
  - `messagesQueryKey(id: string) = ["messages", id] as const`(LATCHの無効化で履歴まで取り直さないよう別系統)
  - `ME_QUERY_KEY = ["me"] as const`・`useMeQuery()` → `GET /users/me`の`UserDTO`(`staleTime: Infinity`)
  - `useConnectionsQuery()` → `useInfiniteQuery`。`/latches?type=matched&limit=50`(続きは`&cursor=<next_cursor>`)・`getNextPageParam`は`next_cursor`
  - `useMessagesQuery(id: string)` → `useInfiniteQuery`。`/latches/{id}/messages`(続きは`?before=<next_before>`)・`getNextPageParam`は`next_before`。pages[0]が最新頁
  - `flattenMessages(pages: MessagePage[]): MessageDTO[]` — 全頁をID昇順に並べ、同じIDは1つにする
  - `appendMessage(client: QueryClient, id: string, message: MessageDTO): void` — 既にどの頁にも同じIDがあれば何もしない。無ければpages[0]の`items`末尾へ足す(キャッシュが無ければ何もしない)
  - `refreshLatestMessages(client: QueryClient, id: string): Promise<void>` — `GET /latches/{id}/messages`(最新頁)を取り、各メッセージを`appendMessage`する(古い頁は保ったまま取りこぼしを埋める)
  - `postMessage(id: string, body: string, clientId: string): Promise<MessageDTO>` — `POST /latches/{id}/messages`
  - `newClientId(): string` — `crypto.randomUUID()`
  - `useMarkRead(id: string): (messageId: string) => void` — `POST /latches/{id}/read {last_read_message_id}`。直前に送ったIDと同じなら送らない。失敗は握りつぶす
  - `requestWsTicket(id: string): Promise<string>` — `POST /ws-ticket {scope:"chat", latch_id:id}`の`ticket`
  - `useLeaveMutation(id: string)` → `POST /latches/{id}/leave`の`LatchDTO`。成功で`latchQueryKey(id)`へ`setQueryData`し`LATCHES_QUERY_KEY`を無効化
  - `useHideMutation(id: string)` → `DELETE /latches/{id}`(204)。成功で`latchQueryKey(id)`と`messagesQueryKey(id)`を`removeQueries`し`LATCHES_QUERY_KEY`を無効化

- [ ] **Step 1: 失敗する試験を書く**(`fetch`をモック・`createTestQueryClient()`)
  - `useConnectionsQuery`が1頁目を`/v1/latches?type=matched&limit=50`で取り、`fetchNextPage()`で`&cursor=C1`を付ける
  - `useMessagesQuery`の`fetchNextPage()`が`?before=<next_before>`を付ける
  - `appendMessage`: 同じIDは足さない/新しいIDはpages[0]の末尾/`flattenMessages`はID昇順で重複なし(Review Focus 2)
  - `useMarkRead`: `"M2"`を2回呼ぶとPOSTは1回・`"M3"`で2回目
  - `useHideMutation`成功後、`latchQueryKey("L1")`のキャッシュが消える
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/chat/queries.test.tsx` → FAIL
- [ ] **Step 3: 実装** — `src/latches/queries.ts`と同じ書き方
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F6b: つながり一覧・履歴・送信・既読・離脱のhooksを追加する`

---

### Task 3: WebSocketの接続(chat/socket.ts)

**Files:**
- Create: `apps/web/src/chat/socket.ts`
- Test: `apps/web/src/chat/socket.test.ts`

**Interfaces:**
- Consumes: `chatServerFrameSchema`(`@latch/shared`)・`ApiError`
- Produces:
  - `RECONNECT_BASE_MS = 1_000`・`RECONNECT_MAX_MS = 30_000`・`PING_INTERVAL_MS = 25_000`
  - `type ChatSocketEvent = { type: "open" } | { type: "message"; message: MessageDTO } | { type: "closed" } | { type: "stopped" }`(`open`=接続成功・再接続成功のたび/`closed`=サーバーの`closed`フレーム/`stopped`=チケット取得が`ApiError`(`NOT_FOUND`または`VALIDATION_FAILED`)で再接続をやめた)
  - `type ChatSocketDeps = { fetchTicket(latchId: string): Promise<string>; createSocket(url: string): WebSocket; setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval }`
  - `chatSocketUrl(latchId: string, ticket: string, location: Pick<Location, "protocol" | "host">): string` — `ws(s)://host/v1/latches/{id}/ws?ticket=…`(`https:`なら`wss`)
  - `openChatSocket(latchId: string, onEvent: (e: ChatSocketEvent) => void, deps: ChatSocketDeps): { close(): void }`
- 振る舞い: チケット取得→接続。`open`で待ち時間を`RECONNECT_BASE_MS`へ戻し、`PING_INTERVAL_MS`ごとに文字列`"ping"`を送る。受信は`"pong"`を無視し、それ以外は`chatServerFrameSchema`で検証(不正は無視)。`message`→`{type:"message", message}`(`type`を除いたMessageDTO)・`closed`→通知して以後再接続しない・`error`フレームは無視(送信はRESTのため)。予期しない切断・チケット取得の通信失敗は待ち時間後に再接続(待ち時間は毎回2倍・上限`RECONNECT_MAX_MS`)。`close()`はタイマーを止め、接続を閉じ、以後何もしない

- [ ] **Step 1: 失敗する試験を書く**(偽のWebSocketクラスとvitestの偽タイマー)
  - 接続URLに`ticket`が付き、`open`で`{type:"open"}`
  - サーバーの`message`フレーム→`{type:"message", message}`/`"pong"`・不正JSONは何も通知しない
  - 切断が3回続くと再接続まで1秒・2秒・4秒待つ/接続成功後の切断は再び1秒(偽タイマーで早送り)
  - 待ち時間は30秒で頭打ち
  - 25秒ごとに`"ping"`を送る
  - `closed`フレーム→`{type:"closed"}`の後、切断されても再接続しない(Review Focus 3)
  - チケット取得が`ApiError("NOT_FOUND")`→`{type:"stopped"}`で再接続しない
  - `close()`後は再接続もpingもしない
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/chat/socket.test.ts` → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F6b: チャットのWebSocket接続(再接続とping)を追加する`

---

### Task 4: 下部タブとつながり一覧

**Files:**
- Create: `apps/web/src/screens/TabBar.tsx`・`apps/web/src/screens/chat/Connections.tsx`
- Modify: `apps/web/src/screens/Home.tsx`(`HomeTabbar`を`TabBar`へ置き換え)・`apps/web/src/routes/paths.ts`・`apps/web/src/router.tsx`・`apps/web/src/screens/latch/art.tsx`(`LatchArtState`へ`"ended"`)
- Test: `apps/web/src/screens/TabBar.test.tsx`・`apps/web/src/screens/chat/Connections.test.tsx`

**Interfaces:**
- Consumes: Task 1・Task 2、既存`Avatar`・`LatchArt`(`screens/latch/art.tsx`)
- Produces:
  - `PATHS.connections = "/connections"`・`PATHS.chat = "/latches/:id/chat"`・`chatPath(id: string): string`
  - `TabBar({ current }: { current: "home" | "connections" })` — Homeの既存のタブのSVGと構造を移し、預けている=`/home`・置く=`/compose`・つながり=`/connections`のリンク。現在の頁は`aria-current="page"`
  - `Connections()` — 設計書 §1.2。行は`<Link className="conn">`で`chatPath(id)`へ。アイコンはcancelled=`<span class="avatar avatar--gone">`・グループ=`avatars avatars--stack`に先頭2人・1対1=`Avatar`。経過時刻は`last_message.created_at`、無ければ`matched_at`を`formatAgo`。未読は`<span class="unread" aria-label="未読N件">N</span>`
  - ルート`/connections`(RequireAuth)
- [ ] **Step 1: 失敗する試験を書く**
  - TabBar: `current="connections"`で「つながり」が`aria-current="page"`・「預けている」は`/home`へのリンク
  - Connections: matched・completed・cancelledの3件で「つながっている」に1件・「終了」に2件/cancelledの行は「つながっていた相手」/最終メッセージ無し→「最初のひとことを送ってみましょう」/`unread_count: 2`→`未読2件`/0件→「まだ、つながりはありません。」/`next_cursor`ありで[さらに表示]を押すと2頁目を要求/行のリンク先が`/latches/L1/chat`
  - Homeの既存試験が緑のまま(タブの「つながり」が`/connections`へのリンクになる)
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/TabBar.test.tsx src/screens/chat src/screens/Home.test.tsx`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F6b: つながり一覧と共有の下部タブを追加する`

---

### Task 5: チャット画面(表示と履歴)

**Files:**
- Create: `apps/web/src/screens/chat/Chat.tsx`・`apps/web/src/screens/chat/MessageList.tsx`
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/src/screens/chat/Chat.test.tsx`・`apps/web/src/screens/chat/MessageList.test.tsx`

**Interfaces:**
- Consumes: Task 1・Task 2・Task 4の`chatPath`、`useLatchQuery`(`src/latches/queries.ts`)・`latchPath`
- Produces:
  - `MessageList({ latch, meId, messages, now, pending, onRetry })` — 設計書 §1.3の本文。`pending: PendingMessage[]`は自分の未確定の吹き出し(Task 6が渡す。Task 5では空配列)
  - `type PendingMessage = { clientId: string; body: string; state: "sending" | "failed" }`
  - `Chat()` — `/latches/:id/chat`の親。見出し・冒頭(`.chat__origin`)・`MessageList`・入力欄の場所(Task 6)・終了後の`.ended-bar`。上端の番兵要素が見えたら(IntersectionObserver・無い環境では[古いメッセージを読み込む]ボタン)`fetchNextPage`し、読み込み前後で`scrollHeight`の差だけ`scrollTop`を足して位置を保つ。初回表示で最下部へ
  - 振り分け: LATCHの取得が404、または`matched_at === null`(成立前・成立せず閉じた)→`latchPath(id)`へ`replace`遷移
  - ルート`/latches/:id/chat`(RequireAuth)
- [ ] **Step 1: 失敗する試験を書く**
  - MessageList: 2日にまたがる3件で区切りが「M月D日」「今日」/`user_id === meId`は`msg--mine`/グループの相手の発言に`msg__who`(抜けた人は「つながっていた相手」)/1対1では`msg__who`無し/0件で「最初のひとことは、短くて大丈夫です。」
  - Chat: 見出しに名前と「主題·形式」・「M月D日 H:MM につながりました」/completedで`.ended-bar`「このつながりは終了しました」が出て入力欄が無い/cancelledで名前が「つながっていた相手」/`status: "proposed"`(matched_at null)で`/latches/L1`へ遷移/404で`/latches/L1`へ遷移/[古いメッセージを読み込む]で`before=`付きの要求
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/chat`
- [ ] **Step 3: 実装** — 見出しの戻るは`/connections`、右上は`aria-label="このつながりについて"`のボタン(Task 7で中身)
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F6b: チャット画面の表示と履歴の読み込みを追加する`

---

### Task 6: 送信・受信・既読

**Files:**
- Create: `apps/web/src/screens/chat/Composer.tsx`・`apps/web/src/screens/chat/chat.css`
- Modify: `apps/web/src/screens/chat/Chat.tsx`
- Test: `apps/web/src/screens/chat/Composer.test.tsx`・`apps/web/src/screens/chat/Chat.test.tsx`(追記)

**Interfaces:**
- Consumes: Task 2の`postMessage`・`newClientId`・`appendMessage`・`refreshLatestMessages`・`useMarkRead`・`requestWsTicket`、Task 3の`openChatSocket`
- Produces:
  - `Composer({ onSend }: { onSend(body: string): void })` — `.composer`。`maxLength={LIMITS.MESSAGE_BODY_MAX_LENGTH}`・前後の空白を除いて空なら[送る]`disabled`・高さは`scrollHeight`に合わせ最大140px・Ctrl/⌘+Enterで送信・送信後に空へ戻す。`onSend`には前後の空白を除いた本文を渡す
  - `Chat`の送信: `pending`へ`sending`で積み→`postMessage`→成功で`appendMessage`し`pending`から外す/`ApiError`の`NOT_FOUND`または`details.reasons`に`read_only`・`invalid_status`→`pending`から外しLATCHを取り直す(`invalidateQueries(latchQueryKey(id))`)/それ以外の失敗→`failed`。[もう一度送る]は同じ`clientId`で`sending`へ戻して再送
  - 表示時の重複排除: `pending`のうち`clientId`が確定済みメッセージの`client_id`と一致するものは描かない(Review Focus 1)
  - 受信: LATCHが`matched`の間だけ`openChatSocket`(`fetchTicket=requestWsTicket`・`createSocket=(url)=>new WebSocket(url)`・`window.location`)。`message`→`appendMessage`/`open`→`refreshLatestMessages`/`closed`・`stopped`→LATCHを取り直す。画面を離れる・matchedでなくなると`close()`。画面に戻ったとき(windowの`focus`)も`refreshLatestMessages`
  - 既読: 表示中の最新メッセージIDが変わるたびに`markRead(id)`(終了後も)
  - `chat.css`: `.msg.is-sending .msg__bubble { opacity: .55; }`(Chat.tsxでimport)
- [ ] **Step 1: 失敗する試験を書く**
  - Composer: 空白と改行だけでは[送る]が`disabled`で、Ctrl+Enterでも`onSend`が呼ばれない(Review Focus 4)/`"  こんにちは \n"`→`onSend("こんにちは")`/⌘+Enterで送信/`maxLength`が2000
  - Chat(偽の`WebSocket`をグローバルへ差し込む): 送信で`POST /v1/latches/L1/messages`に`{body, client_id}`/応答前は`is-sending`の吹き出し/WebSocketで同じ`client_id`のメッセージが先に届いても吹き出しは1つ(Review Focus 1)/500→「送信できませんでした」と[もう一度送る]→再送の`client_id`が1回目と同じ/400 `read_only`→失敗表示を出さずLATCHを取り直す/WebSocketの`message`で相手の吹き出しが増え、`POST /read`がその最新IDで送られる/completedのLATCHでは`WebSocket`を作らない/windowの`focus`で最新頁(`before`無し)を取り直す
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/chat`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F6b: チャットの送信・受信・既読と送信失敗の表示を追加する`

---

### Task 7: 操作メニュー

**Files:**
- Create: `apps/web/src/screens/chat/ChatMenu.tsx`
- Modify: `apps/web/src/screens/chat/Chat.tsx`
- Test: `apps/web/src/screens/chat/ChatMenu.test.tsx`

**Interfaces:**
- Consumes: Task 2の`useLeaveMutation`・`useHideMutation`、`PATHS.connections`
- Produces:
  - `ChatMenu({ latch, onClose, onLeft, onHidden })` — `.backdrop`+`.sheet-layer[role=dialog][aria-label="このつながりについて"]`(Shelved.tsxのシートと同じ構造)。項目と説明文は設計書 §1.6の表の文言どおり。項目→確認(「参加を取り消しますか。元には戻せません。」[取り消す]/[やめる]、「表示から消しますか。元には戻せません。」[消す]/[やめる])。送信中はボタン`disabled`。失敗は「この操作は、いまはできません。」をシート内に出し、LATCHを取り直す
  - `onLeft(result: LatchDTO)`: Chatは`result.status === "cancelled"`ならその場に留まり読み取り専用の表示へ、それ以外(本人だけが抜けた)なら`/connections`へ`replace`遷移。どちらもトースト「参加を取り消しました。」(`TOAST_MS = 2400`・Shelved.tsxと同じ)
  - `onHidden()`: `/connections`へ遷移し、遷移先でトースト「一覧から消しました。」(react-routerの`state: { toast }`で渡し、Connectionsが表示する)
- [ ] **Step 1: 失敗する試験を書く**
  - matched 1対1: 項目が「参加を取り消す」「表示から消す」で、説明文が設計書 §1.6の1対1の行と一致
  - matched グループ: 「このつながりから抜けます。」・「このつながりから抜けて、自分の一覧から消します。相手の側には履歴が残ります。」
  - completed: 「表示から消す」だけで「自分の一覧から消します。相手の側には残ります。」
  - 「参加を取り消す」→確認→[やめる]で要求を送らない/[取り消す]で`POST /v1/latches/L1/leave`を1回
  - leaveの応答がcancelled→「このつながりは終了しました」と「参加を取り消しました。」/応答がmatched(本人だけ抜けた)→`/connections`(Review Focus 5)
  - 「表示から消す」→[消す]で`DELETE /v1/latches/L1`→`/connections`に「一覧から消しました。」
  - leaveが400→「この操作は、いまはできません。」
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/chat`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F6b: つながりの操作メニュー(参加の取り消し・表示から消す)を追加する`

---

### Task 8: 既存画面からの導線

**Files:**
- Modify: `apps/web/src/screens/latch/Matched.tsx`・`apps/web/src/screens/latch/NotEstablished.tsx`・`apps/web/src/screens/latch/LatchScreen.tsx`
- Test: `apps/web/src/screens/latch/Matched.test.tsx`・`NotEstablished.test.tsx`・`LatchScreen.test.tsx`(追記)

**Interfaces:**
- Consumes: Task 4の`chatPath`
- Produces:
  - Matched: `.screen__foot`の先頭に`<Link className="btn btn--primary btn--block" to={chatPath(latch.id)}>メッセージを送る</Link>`、「あとで」は残す
  - NotEstablished: 任意の`chatTo?: string`。`variant="ended"`で`chatTo`があれば[預けている一覧へ]の上に`btn btn--primary btn--block`の[チャットを見る]
  - LatchScreen: `ended`の表示に`chatTo={chatPath(latch.id)}`を渡す
- [ ] **Step 1: 失敗する試験を書く** — Matchedに`/latches/L1/chat`への「メッセージを送る」/completedのLATCHの`/latches/L1`に「チャットを見る」(`/latches/L1/chat`)/成立しなかった(`closed`)には出ない
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/latch`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** — `pnpm --filter web exec vitest run`(全体)が緑
- [ ] **Step 5: コミット** — `F6b: つながりました・終了の画面からチャットへの導線を追加する`

---

### Task 9: web E2E

**Files:**
- Create: `apps/web/e2e/chat-flow.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes: 既存`signInAndRegister`・`captureAccessToken`・`createConnectionIntent`・`waitForDevLatch`・`expireLeftoverE2eIntents`(latch-flow.spec.tsの`setUpUser`・`setUpProposal`と同じ流れ)
- Produces(helpers.ts):
  - `setUpUser(browser: Browser, displayName: string): Promise<{ page: Page; token: string }>` — latch-flow.spec.tsから移し、両specで共有する
  - `establishLatch(browser: Browser, site: number, names: [string, string]): Promise<{ a; b; latchId: string }>` — 2人を登録し、同じtopic(`e2e-web-chat-${uuid8}`)・同じsiteのつながりIntentを投入→`waitForDevLatch(status === "proposed")`→2人とも`page.request.post("/v1/latches/{id}/response", { data: { response: "yes" }, headers })`→`waitForDevLatch(status === "matched")`(回答の画面はlatch-flow.spec.tsで証明済みのためAPIで進める)
- siteはweb専用の42・43(latch-flow.spec.tsの40・41と分ける)。前後に`expireLeftoverE2eIntents()`
- [ ] **Step 1: 試験を書く**
  - `test("2人が画面で送り合い、一覧に最終メッセージと未読が出る")`(site 42): Aが`/latches/{id}`(つながりました)の[メッセージを送る]→チャット。Bは`/latches/{id}/chat`を開いておく→Aが送信→Bの画面に再読み込みなしで出る→Bが返信→Aに出る→Aは`/connections`へ移ってからBがもう1通送る→Aの一覧を再表示すると最終メッセージと`未読1件`→行を押してチャットを開き、`/connections`へ戻ると未読表示が消える
  - `test("参加を取り消すと相手は読み取り専用になり、表示から消すと一覧から消える")`(site 43): A・Bともチャットを開く→Aが「このつながりについて」→「参加を取り消す」→[取り消す]→Aに「このつながりは終了しました」→Bの画面も(`closed`で)入力欄が消え「このつながりは終了しました」→Bの`/connections`の「終了」に「つながっていた相手」→Bがチャットから「表示から消す」→[消す]→Bの一覧にその行が無く「一覧から消しました。」
- [ ] **Step 2: 実行** — `pnpm --filter web build && pnpm --filter web exec playwright test e2e/chat-flow.spec.ts`(ポート競合時は`LATCH_E2E_PORT=<空き>`)→ PASS
- [ ] **Step 3: 全E2Eの確認** — `pnpm --filter web test:e2e`(既存10本+新規2本=12本)と`pnpm --filter worker test:e2e`(39本)が緑
- [ ] **Step 4: コミット** — `F6b: チャットの画面のweb E2Eを追加する`

---

### Task 10: 文書の更新

**Files:**
- Modify: `docs/01-requirements.md`・`docs/10-test-env-nfr.md`・`docs/12-development-roadmap.md`・`docs/00-document-roadmap.md`・`prototype/README.md`・`AGENTS.md`(と、版数が変わる文書を前提文書に挙げる各文書の前提文書欄)

- [ ] **Step 1: 01** — 冒頭に決定記録(2026-10-21・プロダクトオーナー・チャットの画面)を「決定内容/根拠/影響」で追加: (1)「表示から消す」の説明文を状態で分ける(続いているつながり=「このつながりを終えて、自分の一覧から消します。相手の側には履歴が残ります。」・終了後=「自分の一覧から消します。相手の側には残ります。」) (2)「参加を取り消す」「表示から消す」は確認を一段挟む (3)1通の上限はAPIの2,000字に揃える。§10の「一覧の操作ラベルにその違いを反映する」の文に、この記録への参照を足す。版数・変更点行
- [ ] **Step 2: 12** — §2のF6行を「F6b=画面(完了)」に、F6の2分割の決定記録の影響へ「F6bは完了した(web E2E(chat-flow.spec.ts: 2人の送受信と一覧の未読、参加の取り消しで相手が読み取り専用になることと表示から消す)で確かめた)」を追記。版数・変更点行
- [ ] **Step 3: 10** — §4のweb E2Eの本数(`rg -n "web E2E" docs/10-test-env-nfr.md`)を12本へ更新し、chat-flow.spec.tsを分担に追記。版数・変更点行
- [ ] **Step 4: prototype/README.md** — §7の表に#7として「チャットの入力欄の上限(試作品1,000字 / 05 §2.2 2,000字)」「2026-10-21オーナー裁定で2,000字に揃えた(01冒頭の決定記録)。試作品のボードは更新しない」を追記
- [ ] **Step 5: 版数の整合** — 00 §1の版数表と、01・10・12を前提文書に挙げる文書の前提文書欄を揃える(`rg -n "01 要件定義書 v|10 テスト環境|12 開発ロードマップ v" docs`)
- [ ] **Step 6: AGENTS.md** — 「現在の状態」へF6b(つながり一覧・チャット(受信WebSocket・送信REST・再接続・既読)・送信失敗と再送・操作メニュー(状態別の説明文と確認)・つながりました/終了画面からの導線)の完了とweb E2E 12本を追記し、「次はF6b」をF7へ、注記の「チャット画面・つながり一覧はF6b」を外す
- [ ] **Step 7: 確認** — `rg -n "F6b" docs AGENTS.md`で記載の食い違いが無いこと・`pnpm lint`
- [ ] **Step 8: コミット** — `F6b: チャットの画面の完了とオーナー裁定を文書へ記録する`
