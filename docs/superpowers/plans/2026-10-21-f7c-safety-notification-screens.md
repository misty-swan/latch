# F7c 安全と通知の画面・規約ページ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F7a・F7bの安全と通知のAPIの上に、お知らせ・自分・プロフィール・通知と表示・ブロックしたユーザー・通報・ブロック・お酒と年齢・プッシュの許可・規約ページの画面を`prototype/`基準で実装し、#16の画面部分をweb E2Eで証明する。

**Architecture:** 画面はTanStack Queryで取得し、変更系の後は関係するキーを無効化する(既存の`latches/queries.ts`・`chat/queries.ts`の作法)。プッシュの許可と購読はブラウザのAPIを差し替えられる`src/push/subscription.ts`に閉じ、受信は`vite-plugin-pwa`の自動生成のService Workerへ`workbox.importScripts`で`public/push-sw.js`を足す(設計書 §3.2の案A)。workerは変更しない。

**Tech Stack:** React 19・react-router・TanStack Query v5・vitest+Testing Library(happy-dom)・Playwright(web E2E)・vite-plugin-pwa(Workbox generateSW)・zod(`@latch/shared`)

**Spec:** `docs/superpowers/specs/2026-10-21-f7c-safety-notification-screens-design.md`

## Global Constraints

- 応答・コメント・コミットメッセージ・文書は日本語。コミットは`git add <パス>`で対象を限定する(`git add -A`・`git commit -a`禁止)。コミットメッセージは`F7c: …`で始め、末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- `apps/web/src/styles/latch.css`は編集しない。見た目は`prototype/app/app.js`の`screens.notices`・`screens.me`・`screens.profile`・`screens.settings`・`screens.report`・`screens.block`と`prototype/project/{Notices,NoticesEmpty,Me,Profile,Settings,PushOff,Report,Block,AlcoholRestricted,ChatMenu,Proposal}.dc.html`のクラス名・文言を移植する。足りない見た目は新しいCSSファイル(`apps/web/src/screens/me/me.css`等)へ
- 画面名は「お知らせ」(prototypeの表示語)。文書・コメントの用語は「アプリ内通知」
- 退会・ヘルプ/お問い合わせの行、意思ごとの通知設定は作らない(設計書 §0.3)
- 字数: 表示名1〜40字(`LIMITS.DISPLAY_NAME_MAX_LENGTH`)・ひとこと0〜200字(`LIMITS.BIO_MAX_LENGTH`)・通報の補足0〜500字・アイコン1MB(`LIMITS.ICON_MAX_BYTES`)・PNG/JPEG/WebP
- 時刻はJST(既存の`latches/format.ts`・`chat/format.ts`の関数を使う)。時計を直接読む関数を作らず`now: Date`を引数に取る
- 通報・ブロックの404は理由を区別せず「この操作はできませんでした。」。その他の失敗は「送れませんでした。時間をおいて、もう一度お試しください。」
- 旧実装への言及をしない
- 毎コミット前に`pnpm lint`・`pnpm typecheck`・`pnpm --filter web exec vitest run`が緑
- 文書の変更は00 §3に従い、版数を上げ・冒頭に変更点行を追記し・前提文書欄と00 §1の版数表を揃える

## Review Focus

1. ログアウトした端末にプッシュが届き続ける → ログアウトで購読があれば外し、`DELETE /v1/push-subscriptions`を試みてから(失敗は無視)トークンを消す(Task 3で試験)
2. お知らせ一覧を開いた直後にもう1件届く → 既読は表示した先頭のidまでなので、後から届いた行は未読のまま(`up_to_id`に表示中の先頭idを使う・Task 2で試験)
3. 回答期限を過ぎた提案のお知らせ → 「回答期限 … まで」を出さず、押すと既存のLatchScreenが状態どおりの画面を出す(Task 2で試験)
4. 通報の[通報する]の連打 → 送信中は押せず、`POST /v1/reports`は1回(Task 7で試験)
5. 自分の発言には「このメッセージを通報する」が出ない・グループで抜けた(left)相手もブロック・通報の相手の候補から消えない(LatchDTO.membersのまま・APIが判定する)(Task 8で試験)

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `apps/web/src/routes/paths.ts`・`apps/web/src/router.tsx`(変更) | 新しいURL(設計書 §1.1) |
| `apps/web/src/me/queries.ts`(新規) | `useMeQuery`(`chat/queries.ts`から移す)・プロフィール・アイコン・ブロック一覧と解除 |
| `apps/web/src/notices/queries.ts`(新規)・`apps/web/src/notices/format.ts`(新規) | お知らせの取得・未読数・既読・行の文言 |
| `apps/web/src/screens/TopbarActions.tsx`(新規) | 右上のベルと自分(Home・Connectionsで共有) |
| `apps/web/src/screens/notices/Notices.tsx`(新規) | お知らせ一覧 |
| `apps/web/src/screens/me/{Me,Profile,Settings,Blocked}.tsx`(新規)・`me.css` | 自分・プロフィール・通知と表示・ブロックしたユーザー |
| `apps/web/src/screens/legal/{Terms,Privacy,LegalPage}.tsx`(新規) | 規約2文書(草案) |
| `apps/web/src/push/subscription.ts`(新規)・`apps/web/public/push-sw.js`(新規)・`apps/web/vite.config.ts`(変更) | プッシュの許可・購読・受信 |
| `apps/web/src/safety/queries.ts`(新規)・`apps/web/src/screens/safety/Report.tsx`(新規) | 通報・ブロックの送信と通報画面 |
| `apps/web/src/auth/session.ts`(変更) | `logout()` |
| 既存画面(変更) | Home・Connections・Placed・Proposal・ChatMenu・MessageList・Chat・Confirm・SignIn・Consent |
| `apps/web/e2e/notices-flow.spec.ts`(新規)・`apps/web/e2e/helpers.ts`(変更) | web E2E |

---

### Task 1: URL・自分の取得・お知らせの取得・右上のベル

**Files:**
- Modify: `apps/web/src/routes/paths.ts`・`apps/web/src/chat/queries.ts`(`useMeQuery`・`ME_QUERY_KEY`を削除し`me/queries.ts`から再輸入)・`apps/web/src/screens/Home.tsx`・`apps/web/src/screens/chat/Connections.tsx`
- Create: `apps/web/src/me/queries.ts`・`apps/web/src/notices/queries.ts`・`apps/web/src/screens/TopbarActions.tsx`
- Test: `apps/web/src/notices/queries.test.tsx`・`apps/web/src/screens/TopbarActions.test.tsx`(Home・Connectionsの既存試験は右上の期待を更新)

**Interfaces:**
- Produces:
  - `PATHS.notices="/notices"`・`PATHS.me="/me"`・`PATHS.profile="/me/profile"`・`PATHS.settings="/settings"`・`PATHS.blocked="/settings/blocked"`・`PATHS.report="/latches/:id/report"`・`PATHS.terms="/terms"`・`PATHS.privacy="/privacy"`
  - `reportPath(id: string, message?: {messageId: string; userId: string}): string`(`?message=…&user=…`)
  - `me/queries.ts`: `ME_QUERY_KEY`・`useMeQuery()`(移設のみ・挙動は不変)
  - `notices/queries.ts`: `NOTICES_QUERY_KEY=["notifications"]`・`useNoticesQuery()`(`useInfiniteQuery`・`GET /v1/notifications?cursor=`)・`useUnreadCount(): number`(`["notifications","unread"]`・1頁目の`unread_count`・`refetchInterval: 60_000`・`refetchOnWindowFocus: true`)・`markNoticesRead(upToId: string): Promise<void>`
  - `TopbarActions()`: ベル(`<Link to=PATHS.notices>`・aria-label=`お知らせ` / 未読時`お知らせ(未読N件)`・未読時に`<span className="dot"/>`)と自分(`<Link to=PATHS.me aria-label="自分">`・`Avatar`に`useMeQuery`の`id`・`has_icon`)

- [ ] **Step 1: 失敗する試験を書く**: `TopbarActions`が未読0で`aria-label="お知らせ"`・点なし、`unread_count: 3`で`お知らせ(未読3件)`と`.dot`、ベルの遷移先`/notices`・自分の遷移先`/me`。`useUnreadCount`が`/v1/notifications`の`unread_count`を返す
- [ ] **Step 2: 試験が失敗することを確かめる**: `pnpm --filter web exec vitest run src/screens/TopbarActions.test.tsx src/notices/queries.test.tsx` → FAIL(モジュールなし)
- [ ] **Step 3: 実装する**: 上のInterfacesどおり。Home・Connectionsの右上の飾り(`role="img"`の`span`)を`<TopbarActions />`に置き換える
- [ ] **Step 4: 全試験が通ることを確かめる**: `pnpm --filter web exec vitest run` → PASS(Home・Connectionsの試験のfetchモックに`/v1/notifications`と`/v1/users/me`を足す)
- [ ] **Step 5: コミット**: `F7c: 右上のお知らせと自分の入口を足す`

### Task 2: お知らせ一覧(`/notices`)

**Files:**
- Create: `apps/web/src/notices/format.ts`・`apps/web/src/screens/notices/Notices.tsx`
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/src/notices/format.test.ts`・`apps/web/src/screens/notices/Notices.test.tsx`

**Interfaces:**
- Consumes: Task 1の`useNoticesQuery`・`markNoticesRead`・`PATHS.notices`。`latchPath`・`chatPath`。`clearComposeState`・`savePendingCompose`(`intents/composeState.ts`)。`formatAgo`(`chat/format.ts`)
- Produces: `noticeText(n: NotificationDTO): string`・`isLiveProposal(n, now: Date): boolean`(`response_deadline > now`)

- [ ] **Step 1: 失敗する試験を書く**:
  - format: proposal=「提案が届いています」/ matched(`display_names: ["ミナト","ソラ"]`)=「ミナト・ソラさんとつながりました」/ closed=「この提案は成立しませんでした」/ intent_expired=「預けていた意思の期限が切れました」
  - 画面: 4種の行と遷移先(proposal→`/latches/L1`・matched→`/latches/L2/chat`・closedは`link`でない)。期限内のproposalだけ「回答期限 … まで」(Review Focus 3)。未読行に`is-unread`。空で「お知らせは、まだありません。」と「提案が届いたときや、期限が来たときに、ここでお伝えします。」。1頁目の取得後に`POST /v1/notifications/read`を`{up_to_id: 先頭のid}`で1回(Review Focus 2)。`next_cursor`があれば[さらに表示]で2頁目。intent_expiredの[もう一度預ける]で`sessionStorage`の`latch.compose`に`raw_text`が入り`/compose`へ
- [ ] **Step 2: 試験が失敗することを確かめる**: `pnpm --filter web exec vitest run src/notices src/screens/notices` → FAIL
- [ ] **Step 3: 実装する**: prototypeの`screens.notices`の構造(`topbar`の戻る→ホーム・`ul.rise`・`.notice`・`glyph`)を移植。既読化は1頁目の読み込み成功時の`useEffect`で先頭idが変わったときだけ送り、成功後に`["notifications","unread"]`を無効化。[もう一度預ける]は`clearComposeState()`→`savePendingCompose({raw_text, draft_id: null})`→`navigate(PATHS.compose)`
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: お知らせ一覧の画面を足す`

### Task 3: 自分(`/me`)・ログアウト・外部送信と同意の閲覧

**Files:**
- Create: `apps/web/src/screens/me/Me.tsx`・`apps/web/src/screens/me/me.css`
- Modify: `apps/web/src/auth/session.ts`・`apps/web/src/screens/Consent.tsx`・`apps/web/src/router.tsx`
- Test: `apps/web/src/screens/me/Me.test.tsx`・`apps/web/src/auth/session.test.ts`・`apps/web/src/screens/Consent.test.tsx`

**Interfaces:**
- Consumes: Task 1の`useMeQuery`・`PATHS`。Task 5の`disablePush`は未作成のため、ここでは`logout`の引数で後始末を受け取る
- Produces: `authSession.logout(beforeClear?: () => Promise<void>): Promise<void>`(`beforeClear`を待ち(失敗は無視)→保存中のrefresh_tokenを付けて`POST /v1/auth/logout`(失敗は無視)→`clear()`)

- [ ] **Step 1: 失敗する試験を書く**: Meが表示名・ひとこと(空なら「ひとことは未設定です」)・「このプロフィールは、つながった相手にだけ表示されます。」・[プロフィールを編集]→`/me/profile`・通知と表示→`/settings`・ブロックしたユーザー→`/settings/blocked`・外部送信と同意→`/consent?view=1`・利用規約→`/terms`・プライバシーポリシー→`/privacy`を出し、「退会する」「ヘルプ」は出さない。[ログアウト]で`POST /v1/auth/logout`(本文に`refresh_token`)→localStorageのトークンが消え`/welcome`へ。`logout`は`beforeClear`が投げても`clear()`まで進む(Review Focus 1)。Consentは`?view=1`で[同意して進む]を出さず、戻る→`/me`
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/me src/auth src/screens/Consent.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: prototypeの`screens.me`を移植(`me__card`・`list-row`・アバターは`Avatar size="l"`)。Meのログアウトは`authSession.logout(() => disablePushQuietly())`とし、`disablePushQuietly`はTask 5で中身を入れる前提で`src/push/subscription.ts`に空の実装(`async () => {}`)を置いておく
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: 自分の画面とログアウトを足す`

### Task 4: プロフィール編集(`/me/profile`)

**Files:**
- Create: `apps/web/src/screens/me/Profile.tsx`
- Modify: `apps/web/src/me/queries.ts`・`apps/web/src/router.tsx`
- Test: `apps/web/src/screens/me/Profile.test.tsx`

**Interfaces:**
- Produces: `useUpdateProfile()`(`PATCH /v1/users/me`・成功で`ME_QUERY_KEY`へ応答を反映)・`useUploadIcon()`(`POST /v1/users/me/icon`・本文はFileそのもの)・`useResetIcon()`(`DELETE /v1/users/me/icon`)・`validateIconFile(file: File): "too_large" | "bad_type" | null`(`image/png`・`image/jpeg`・`image/webp`以外は`bad_type`)

- [ ] **Step 1: 失敗する試験を書く**: 初期値がmeの値・カウンター「N / 40」「N / 200」。表示名を空にすると[保存]が押せない。ひとことだけ変えて[保存]→`PATCH`の本文が`{bio}`だけ→`/me`。1MB超・GIFは送らず「PNG・JPEG・WebP、1MBまで。」の注意。PNGを選ぶと`POST /v1/users/me/icon`。[既定のアイコンに戻す]で`DELETE`。PATCH失敗で画面に留まり共通の失敗文
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/me/Profile.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: prototypeの`screens.profile`を移植。ファイル選択は`<input type="file" accept="image/png,image/jpeg,image/webp" hidden>`を[画像を選ぶ]から開く。アイコンの変更・削除の成功時に`ME_QUERY_KEY`を無効化する。`Avatar`(`screens/latch/art.tsx`)に任意の`version?: number`を足して`src`へ`?v=<version>`を付け、Me・Profile・TopbarActionsは`useMeQuery`の`dataUpdatedAt`を渡す(変更直後に古い画像のキャッシュを出さない)
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: プロフィール編集の画面を足す`

### Task 5: プッシュの許可・購読・受信

**Files:**
- Create/Modify: `apps/web/src/push/subscription.ts`(Task 3の空実装を埋める)・`apps/web/public/push-sw.js`・`apps/web/vite.config.ts`・`apps/web/src/screens/Placed.tsx`・`apps/web/src/screens/Home.tsx`
- Test: `apps/web/src/push/subscription.test.ts`・`apps/web/src/push/push-sw.test.ts`・`apps/web/src/screens/Placed.test.tsx`・`apps/web/src/screens/Home.test.tsx`

**Interfaces:**
- Produces:
  - `type PushEnv = { permission(): NotificationPermission | "unsupported"; requestPermission(): Promise<NotificationPermission>; pushManager(): Promise<PushManager | null> }`・`browserPushEnv: PushEnv`(`Notification`・`navigator.serviceWorker.ready`が無ければ`unsupported`/`null`)
  - `type PushStatus = "unsupported" | "denied" | "off" | "on"`・`getPushStatus(env?): Promise<PushStatus>`(`on`=許可済みかつ`getSubscription()`あり)
  - `enablePush(env?): Promise<PushStatus>`(許可を求める→`GET /v1/push/vapid-public-key`→`subscribe({userVisibleOnly: true, applicationServerKey})`→`POST /v1/push-subscriptions`に`subscription.toJSON()`の`endpoint`・`keys`。どこかで失敗したら作った購読を外して`off`)
  - `disablePush(env?): Promise<void>`(購読があれば`DELETE /v1/push-subscriptions`に`{endpoint}`→`unsubscribe()`)・`disablePushQuietly(env?)`(失敗を飲む)
  - `usePushStatus()`(`["push-status"]`のuseQuery)
  - `push-sw.js`: `self.latchPush = { notificationFrom(data: unknown): {title: "LATCH", body: string}, openNotices(clients): Promise<void> }`と`push`・`notificationclick`のリスナー。既定の本文は「提案が届いています。詳細はアプリでご確認ください。」
- Consumes: `PATHS.notices`(SW側は文字列`/notices`を直書き)

- [ ] **Step 1: 失敗する試験を書く**:
  - subscription(`PushEnv`の偽物と`fetch`のモック): 許可→購読→POSTの順で`on`/拒否で`denied`・POSTなし/非対応で`unsupported`/POSTが500なら`unsubscribe()`が呼ばれ`off`/`disablePush`がDELETEの本文`{endpoint}`
  - push-sw(ファイルを`fs`で読み`new Function("self", src)`で偽の`self`に評価): `notificationFrom({type:"matched", body:"つながりが成立しました。詳細はアプリでご確認ください。"})`の本文がそのまま・壊れた入力で既定の本文・`openNotices`は既存の窓があれば`navigate("/notices")`して`focus()`、無ければ`openWindow("/notices")`
  - Placed: [通知を受け取る]で`enablePush`が呼ばれた後`/home`へ。許可が`denied`/`unsupported`/`on`の端末ではpush-askを出さない
  - Home: `getPushStatus`が`denied`のとき帯「通知がオフです。提案はアプリ内のお知らせでお伝えします。」と[設定]→`/settings`
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/push src/screens/Placed.test.tsx src/screens/Home.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: `vite.config.ts`の`VitePWA`に`workbox: { importScripts: ["push-sw.js"] }`。`applicationServerKey`はbase64urlの公開鍵を`Uint8Array`へ変換して渡す。`push-sw.js`は`event.data?.json()`を`try`で読み、`event.waitUntil(self.registration.showNotification(title, {body}))`。`notificationclick`は`event.notification.close()`→`openNotices(self.clients)`
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS。`pnpm --filter web build`で`dist/sw.js`に`importScripts("push-sw.js")`が含まれ`dist/push-sw.js`があることを`rg -n "push-sw" apps/web/dist/sw.js`で確かめる
- [ ] **Step 5: コミット**: `F7c: プッシュの許可と購読と受信を足す`

### Task 6: 通知と表示(`/settings`)・ブロックしたユーザー(`/settings/blocked`)

**Files:**
- Create: `apps/web/src/screens/me/Settings.tsx`・`apps/web/src/screens/me/Blocked.tsx`
- Modify: `apps/web/src/me/queries.ts`・`apps/web/src/router.tsx`
- Test: `apps/web/src/screens/me/Settings.test.tsx`・`apps/web/src/screens/me/Blocked.test.tsx`

**Interfaces:**
- Consumes: Task 5の`usePushStatus`・`enablePush`・`disablePush`。`useTheme`(`theme.tsx`)
- Produces: `BLOCKS_QUERY_KEY=["blocks"]`・`useBlocksQuery()`・`useUnblock()`(`DELETE /v1/users/{user_id}/block`→`BLOCKS_QUERY_KEY`を無効化)

- [ ] **Step 1: 失敗する試験を書く**:
  - Settings: `on`でスイッチがチェック・オフにすると`disablePush`/`off`でオンにすると`enablePush`・結果が`off`なら「アプリ内のお知らせでお伝えします」の注意/`denied`でスイッチが`disabled`と「ブラウザの設定で通知がオフになっています。提案は、アプリ内のお知らせでお伝えします。」/`unsupported`で`disabled`と同じ趣旨の注意。テーマのラジオ3つで`setMode`。「意思ごとのお知らせは…」の文は出さない
  - Blocked: 行に表示名・「10月2日にブロック」(created_atのJST)・[解除]→`DELETE /v1/users/u9/block`→再取得。0件で「ブロックしたユーザーはいません。」。注記の文言(設計書 §1.6)
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/me` → FAIL
- [ ] **Step 3: 実装する**: prototypeの`screens.settings`(両分岐)を移植。スイッチは操作中`disabled`
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: 通知と表示とブロックしたユーザーの画面を足す`

### Task 7: 通報画面と提案画面の「…」

**Files:**
- Create: `apps/web/src/safety/queries.ts`・`apps/web/src/screens/safety/Report.tsx`
- Modify: `apps/web/src/screens/latch/Proposal.tsx`・`apps/web/src/router.tsx`
- Test: `apps/web/src/screens/safety/Report.test.tsx`・`apps/web/src/screens/latch/Proposal.test.tsx`

**Interfaces:**
- Consumes: `useLatchQuery`・`reportPath`・`chatPath`・`latchPath`
- Produces: `useReport()`(`POST /v1/reports`・`ReportCreateRequest`)・`useBlock(latchId: string)`(`POST /v1/users/{user_id}/block`→`latchQueryKey(latchId)`・`CONNECTIONS_QUERY_KEY`・`NOTICES_QUERY_KEY`・`BLOCKS_QUERY_KEY`を無効化)・`safetyErrorText(error: unknown): string`(404=「この操作はできませんでした。」・他=共通の失敗文)。`Report`は`location.state?.quote: string`があれば発言を引用表示する

- [ ] **Step 1: 失敗する試験を書く**:
  - 提案(status=proposed): 対象の欄なし→理由「スパム・勧誘」→[通報する]で本文`{latch_id, target:"proposal", reason:"spam"}`(`reportee_user_id`なし)→「通報を受け付けました。」→[閉じる]で`/latches/L1`
  - 成立後の1対1: 対象「プロフィール(表示名・ひとこと)」「アイコン」→`reportee_user_id`は唯一の相手
  - 成立後のグループ: 「相手」のラジオ(自分以外のmembers)を選ぶまで[通報する]が押せない
  - `?message=M1&user=u2`: 対象・相手の欄なし・`state.quote`の引用・本文`{target:"message", message_id:"M1", reportee_user_id:"u2"}`
  - くわしく501字は入らない(maxLength 500)。送信中は[通報する]が`disabled`で連打してもPOSTは1回(Review Focus 4)。404で「この操作はできませんでした。」
  - Proposal: 右上「…」(aria-label「この提案について」)でシート→「この提案を通報する」→`/latches/L1/report`→[閉じる]
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/safety src/screens/latch/Proposal.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: prototypeの`screens.report`と提案のシート(`sheet`・`list-row`・`flag`アイコン)を移植。理由の値はspam/harassment/inappropriate/other。[やめる]と完了後の[閉じる]の戻り先は、LATCHが提案段階なら`latchPath`、それ以外は`chatPath`
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: 通報の画面と提案からの入口を足す`

### Task 8: チャットの通報・ブロック・メッセージの操作

**Files:**
- Modify: `apps/web/src/screens/chat/ChatMenu.tsx`・`apps/web/src/screens/chat/MessageList.tsx`・`apps/web/src/screens/chat/Chat.tsx`・`apps/web/src/screens/chat/chat.css`
- Test: `apps/web/src/screens/chat/ChatMenu.test.tsx`・`apps/web/src/screens/chat/MessageList.test.tsx`・`apps/web/src/screens/chat/Chat.test.tsx`

**Interfaces:**
- Consumes: Task 7の`useBlock`・`reportPath`
- Produces: `MessageList`のPropsに`onMessageMenu(message: MessageDTO): void`。`ChatMenu`の`Step`に`"pick-block" | "confirm-block"`

- [ ] **Step 1: 失敗する試験を書く**:
  - ChatMenu: 「通報する」→`/latches/L1/report`。1対1の「ブロックする」→確認「ミナトさんを、ブロックしますか。」と3項目(設計書 §1.8)→[ブロックする]で`POST /v1/users/u2/block`→`onBlocked`が呼ばれる(既存のF6bの試験の「通報する」「ブロックする」が出ない期待は削除する)。グループ: 相手を選ぶ段→確認「このグループから抜けます。チャットは読み取り専用になります。」を含む3項目→`POST /v1/users/{選んだ人}/block`。404で「この操作はできませんでした。」
  - MessageList: 相手の発言にだけ`aria-label="このメッセージの操作"`のボタンがあり、押すと`onMessageMenu`。発言の`contextmenu`でも同じ。自分の発言には無い(Review Focus 5)
  - Chat: メッセージの操作→シート「このメッセージについて」→「このメッセージを通報する」→`/latches/L1/report?message=M1&user=u2`(stateに`quote`)
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/chat` → FAIL
- [ ] **Step 3: 実装する**: メニューの行はprototypeの`ChatMenu.dc.html`の`flag`・`block`の`list-row`。ChatMenuのPropsに`onBlocked(): void`を足し、ブロック成功時に呼ぶ。Chatは`onBlocked`でシートを閉じるだけ(`useBlock`がLATCHのキーを無効化し、再取得で読み取り専用の表示になる)。操作ボタンは`chat.css`の`.msg__more`(相手の吹き出しの横・44px四方の押せる範囲)
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: チャットに通報とブロックとメッセージの操作を足す`

### Task 9: お酒と年齢・規約ページ・サインインのリンク

**Files:**
- Create: `apps/web/src/screens/legal/LegalPage.tsx`・`Terms.tsx`・`Privacy.tsx`
- Modify: `apps/web/src/screens/Confirm.tsx`・`apps/web/src/screens/SignIn.tsx`・`apps/web/src/screens/Consent.tsx`・`apps/web/src/router.tsx`
- Test: `apps/web/src/screens/Confirm.test.tsx`・`apps/web/src/screens/legal/legal.test.tsx`・`apps/web/src/screens/SignIn.test.tsx`

**Interfaces:**
- Produces: `LegalPage({title, children})`(冒頭の印「この文書は法務確認前の草案です。」・戻るは`navigate(-1)`、履歴が無ければ`/welcome`)。`/terms`・`/privacy`は`RequireAuth`の外

- [ ] **Step 1: 失敗する試験を書く**:
  - Confirm: 機会・お酒オンで[預ける]→422 ALCOHOL_RESTRICTED→「お酒を含む機会は、20歳以上の方が預けられます。」「「お酒」をオフにすると、このまま預けられます。」が出て[預ける]が`disabled`→お酒をオフにすると押せる
  - legal: 両ページに草案の印。利用規約に「転職」「売買」「交際」「営業」の禁止と「CC BY 2.0 JP」「CC BY 4.0」。プライバシーポリシーに外部AI事業者への送信と「7日」。未ログインで開ける
  - SignIn: 「利用規約」→`/terms`・「プライバシーポリシー」→`/privacy`
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/Confirm.test.tsx src/screens/legal src/screens/SignIn.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: Confirmは`alcoholRestricted`状態を持ち、422で立て・お酒のオフで下ろす。文言の配置はAlcoholRestrictedボード(お酒の行の下の`note`と足元の注記)。規約本文は設計書 §1.10の項目を章立てで書く(会社名・連絡先・施行日は「法務確認時に確定」と明記)。Consent画面の規約リンクも`/terms`・`/privacy`へ
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F7c: お酒と年齢の表示と規約ページの草案を足す`

### Task 10: web E2E(`notices-flow.spec.ts`)

**Files:**
- Create: `apps/web/e2e/notices-flow.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`(必要なら`fetchDevReports(page, token)`)

**Interfaces:**
- Consumes: `setUpUser`・`createConnectionIntent`・`waitForDevLatch`・`establishLatch`・`expireLeftoverE2eIntents`。地域はweb専用のsite 44・45・46(latch-flow 40・41/chat-flow 42・43と分ける)

- [ ] **Step 1: 試験を書く**(3本・各testの前に`expireLeftoverE2eIntents()`):
  1. **#16の画面部分**(site 44): 2人のつながりIntentで提案→Aの`/home`でベルが「お知らせ(未読1件)」→押して`/notices`→「提案が届いています」→提案画面で[参加する]→BはAPIでyes→Aのお知らせを開き直すと「E2Eゆうひさんとつながりました」→押すと`/latches/{id}/chat`→ホームのベルが「お知らせ」(未読0)
  2. 通報(site 45): 提案の「…」→「この提案を通報する」→理由→[通報する]→「通報を受け付けました。」。`establishLatch`後にBがAPIで1通送り、Aのチャットで「このメッセージの操作」→「このメッセージを通報する」→送信。`GET /v1/dev/reports`にtarget=proposalとtarget=message(message_id一致)の行
  3. ブロック(site 46): `establishLatch`→Aのチャットの操作メニュー→「ブロックする」→確認→Aは`/settings/blocked`にBの表示名。Bのチャットは「このつながりは終了しました」と入力欄なし
- [ ] **Step 2: 実行する**: `pnpm --filter web build && pnpm --filter web test:e2e` → 既存12本+3本=15本がPASS(ポートが埋まっていれば`LATCH_E2E_PORT=<空き>`)
- [ ] **Step 3: コミット**: `F7c: #16の画面部分と通報とブロックのweb E2Eを追加する`

### Task 11: 文書の更新

**Files:**
- Modify: `docs/12-development-roadmap.md`・`docs/10-test-env-nfr.md`・`docs/02-scope-acceptance.md`・`docs/01-requirements.md`・`docs/08-privacy-safety.md`・`docs/11-release-plan.md`・`docs/00-document-roadmap.md`・`AGENTS.md`

- [ ] **Step 1: 書く**(設計書 §6):
  - 01冒頭の決定記録(2026-10-21・安全と通知の画面): 設計書 §0.2の3件を「決定内容/根拠/影響」で
  - 12 §2: F7cの完了・#16の画面部分をweb E2E(notices-flow.spec.ts)で証明・#31は草案を配置し法務確認はオーナー(未了)
  - 10 §4: web E2Eの一覧にnotices-flow.spec.tsの3本(web E2E 15本)
  - 02 #16の合格証拠に画面部分・#31は草案の配置を注記
  - 08 §8: グループでのブロックの導線と成立後の通報の対象の選び方(メッセージから)/§10: 草案は`apps/web/src/screens/legal/`
  - 11 §1: 規約の配置の行に草案配置済み・法務確認未了
  - AGENTS.md: 現在の状態にF7cの完了・次はF8
  - 各文書の版数・変更点行・前提文書欄と00 §1の版数表
- [ ] **Step 2: 確かめる**: `rg -n "F7c" docs AGENTS.md`で記載の漏れがなく、`rg -n "お知らせ" docs/0[0-9]*.md docs/1[0-2]*.md`の新規箇所が画面名の引用に限られる(用語は「アプリ内通知」)
- [ ] **Step 3: コミット**: `F7c: 安全と通知の画面の完了とオーナー裁定を文書へ記録する`
