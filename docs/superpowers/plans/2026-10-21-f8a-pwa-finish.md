# F8a PWAと画面の仕上げ Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 意思の詳細画面(通知の切り替え・一時停止/再開・取り下げ・もう一度預ける)と内容を直す画面、ホームとつながり一覧のオフライン表示、ホーム画面追加のPNGアイコンを実装し、#32の自動の部分をweb E2Eで証明して実機確認の手順書と監査の記録を残す。

**Architecture:** 画面はTanStack Queryで取得し、変更系の後は`["intents"]`を無効化する(既存の作法)。オフライン表示はTanStack Queryの公式の保存部品(`PersistQueryClientProvider`)に、利用者IDで紐づけるIndexedDBの自前のPersister(`idb-keyval`)を渡し、ホーム・つながり一覧の4キーだけを保存する。認証セッションは「保存済みのリフレッシュトークンがあり通信失敗で復元できない」状態を`offline`として保護画面を描画させ、接続の回復で復元をやり直す。workerは変更しない。

**Tech Stack:** React 19・react-router・TanStack Query v5(`@tanstack/react-query-persist-client@5.104.4`)・`idb-keyval@6.3.0`・vitest+Testing Library(happy-dom)・Playwright(web E2E)・vite-plugin-pwa(Workbox generateSW)・`@resvg/resvg-js@2.6.2`(アイコンの変換・開発用)・Lighthouse 13.5.0(監査・npx)

**Spec:** `docs/superpowers/specs/2026-10-21-f8a-pwa-finish-design.md`

## Global Constraints

- 応答・コメント・コミットメッセージ・文書は日本語。コミットは`git add <パス>`で対象を限定する(`git add -A`・`git commit -a`禁止)。コミットメッセージは`F8a: …`で始め、末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- `apps/web/src/styles/latch.css`は編集しない。見た目は`prototype/app/app.js`の`screens.intent`(668〜719行)・`screens.home`の帯(437行)と`prototype/project/{IntentDetail,IntentOccasion,IntentExpired,Offline}.dc.html`のクラス名・文言を移植する。足りない見た目は新しいCSS(`apps/web/src/screens/intent/intent.css`)へ
- 文言(設計書の固定値): 帯「オフラインです。最後に確かめた内容を表示しています。」/ オフラインの案内「オフラインのため、いまは読み解けません。」(読み解き)・「オフラインのため、送れませんでした。」(チャットの送信)・「オフラインのため、いまは操作できません。」(その他)/ スイッチ「提案をお知らせする」・説明「オフにすると通知はしません。提案は、預けている一覧に届きます。」/ 直す前の確認「直すと、届いている提案は取り消されます。」/ 取り下げの確認「この意思を取り下げます。届いている提案も取り消されます。」/ トースト「一時停止しました。」「再開しました。」「取り下げました。」「直しました。」/ version_conflict「ほかの画面で変更されました。最新の内容を読み直しました。」
- 用語: 文書・コメントでは「アプリ内通知」。「お知らせ」は画面名とprototypeの文言の引用だけ
- 保存期間は7日(`OFFLINE_MAX_AGE_MS = 7 * 24 * 3_600_000`)。保存するキーは`["intents"]`・`["latches","proposals"]`・`["latches","connections"]`・`["me"]`の4つだけ(完全一致)
- activeのPATCHで送れるのはtopic・time・participants・budget・soft_constraints・notification_levelだけ(預け方・期限・地域・お酒は表示のみ)。pausedはPATCHできない(スイッチは`disabled`)
- 時刻はJST(既存の`intents/submit.ts`・`latches/format.ts`の関数)。時計を直接読む関数を作らず`now: Date`を引数に取る
- 旧実装への言及をしない
- 毎コミット前に`pnpm lint`・`pnpm typecheck`・`pnpm --filter web exec vitest run`が緑
- 文書の変更は00 §3に従い、版数を上げ・冒頭に変更点行を追記し・前提文書欄と00 §1の版数表を揃える

## Review Focus

1. 同じ端末で別の利用者がサインインする → 前の利用者の保存内容を表示しない(Persisterが利用者IDの不一致で`undefined`を返し保存を消す・Task 6で試験)
2. オフラインで起動した後、接続が戻ったがサーバーがリフレッシュを拒否する → welcomeへ戻り、保存内容とメモリのキャッシュが消える(Task 5・Task 6で試験)
3. 内容を直す画面で何も変えずに保存する → PATCHを送らず確認も出さずに詳細へ戻る(Task 4で試験)
4. 詳細を開いている間に意思の状態が変わる(期限切れ・別の端末での一時停止)→ 操作の400 invalid_statusで単一取得を取り直し、状態どおりの操作に替わる(Task 2で試験)
5. [取り下げる]の確認の連打・オフラインでスイッチを切る → DELETEは1回、スイッチは失敗で元の値に戻り「オフラインのため、いまは操作できません。」(Task 2で試験)

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `apps/web/src/routes/paths.ts`・`apps/web/src/router.tsx`(変更) | `/intents/:id`・`/intents/:id/edit` |
| `apps/web/src/intents/queries.ts`(変更) | 単一取得・一時停止・再開・PATCH・削除のhooks |
| `apps/web/src/screens/RouteToast.tsx`(新規・`Connections.tsx`から移す) | 遷移元が渡したトーストを一度だけ出す |
| `apps/web/src/screens/intent/IntentDetail.tsx`・`intent.css`(新規) | 意思の詳細 |
| `apps/web/src/intents/FactsEditor.tsx`(新規・`Confirm.tsx`から切り出す) | 「読み解いた条件」の行内編集 |
| `apps/web/src/intents/submit.ts`(変更) | `confirmValuesFromIntent`・`buildIntentEditPatch` |
| `apps/web/src/screens/intent/IntentEdit.tsx`(新規) | 内容を直す |
| `apps/web/src/auth/session.ts`・`guard.tsx`(変更) | 利用者ID・オフライン中のセッション・破棄の通知 |
| `apps/web/src/offline/persister.ts`・`online.ts`・`errors.ts`・`OfflineBanner.tsx`・`reconnect.ts`(新規) | 保存・接続状態・通信失敗の判定・帯・回復 |
| `apps/web/src/App.tsx`(変更) | `PersistQueryClientProvider`と回復・破棄の配線 |
| `apps/web/vite.config.ts`・`index.html`・`public/*.png`・`scripts/make-icons.mjs`(変更・新規) | SWの除外・アイコン・マニフェスト |
| `apps/web/e2e/pwa-flow.spec.ts`(新規) | #32の自動の部分 |
| `docs/reports/f8a-pwa-device-check.md`・`docs/reports/f8a-lighthouse.md`(新規) | 実機確認の手順書と記録の雛形・監査の結果 |

### Task 1: URL・意思のhooks・ホームの行のリンク・トーストの共通化

**Files:**
- Modify: `apps/web/src/routes/paths.ts`・`apps/web/src/intents/queries.ts`・`apps/web/src/screens/Home.tsx`(237〜245行の`div`)・`apps/web/src/screens/chat/Connections.tsx`(127〜155行の`useRouteToast`・`RouteToast`を移す)
- Create: `apps/web/src/screens/RouteToast.tsx`
- Test: `apps/web/src/intents/queries.test.ts`(追記)・`apps/web/src/screens/Home.test.tsx`(追記)・`apps/web/src/screens/RouteToast.test.tsx`

**Interfaces:**
- Produces:
  - `PATHS.intent="/intents/:id"`・`PATHS.intentEdit="/intents/:id/edit"`・`intentPath(id: string): string`・`intentEditPath(id: string): string`(`encodeURIComponent`)
  - `intentQueryKey(id: string) = ["intents", id] as const`・`useIntentQuery(id: string)`(`GET /intents/{id}`・`retry`は既存の`shouldRetry`(`latches/queries.ts`)で404を再試行しない)
  - `usePauseIntent(id)`・`useResumeIntent(id)`(`POST /intents/{id}/pause|resume`)・`usePatchIntent(id)`(`PATCH /intents/{id}`・引数`PatchIntentRequest`)・`useDeleteIntent(id)`(`DELETE /intents/{id}`)。いずれも成功で`intentQueryKey(id)`へ応答を書き(削除は`removeQueries`)、`INTENTS_QUERY_KEY`を無効化する
  - `useRouteToast(): string | null`・`RouteToast({ text }: { text: string | null })`(挙動は移設前と同じ)

- [ ] **Step 1: 失敗する試験を書く**: `intentPath("a/b")`が`/intents/a%2Fb`。`usePauseIntent`の成功で`fetch`が`/v1/intents/I1/pause`へPOSTし`["intents"]`が無効化される。Homeでactiveの行が`link`で`/intents/I1`へ、draftの行は従来どおり`/compose?draft=…`。Homeが`location.state.toast="取り下げました。"`を`role="status"`で出す
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/intents src/screens/Home.test.tsx src/screens/RouteToast.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: 上のInterfacesどおり。Homeの行は`<Link className={…} to={intentPath(intent.id)}>`にし、「詳細画面はF3以降」のコメントを消す。Homeの各分岐に`<RouteToast text={toast} />`を置く(Connectionsと同じ置き方)
- [ ] **Step 4: 全試験を確かめる**: `pnpm --filter web exec vitest run` → PASS(Connectionsの既存試験も緑)
- [ ] **Step 5: コミット**: `F8a: 意思の取得と変更のhooksとホームから詳細への入口を足す`

### Task 2: 意思の詳細(`/intents/:id`)

**Files:**
- Create: `apps/web/src/screens/intent/IntentDetail.tsx`・`apps/web/src/screens/intent/intent.css`・`apps/web/src/offline/errors.ts`
- Modify: `apps/web/src/router.tsx`
- Test: `apps/web/src/screens/intent/IntentDetail.test.tsx`・`apps/web/src/offline/errors.test.ts`

**Interfaces:**
- Consumes: Task 1の全hooks・`intentEditPath`・`useConnectionsQuery`(`chat/queries.ts`)・`clearComposeState`・`savePendingCompose`・`INTENT_STATUS_LABELS`
- Produces:
  - `isOfflineError(error: unknown): boolean`(`error instanceof TypeError`または`navigator.onLine === false`。`ApiError`はfalse)
  - `OFFLINE_MESSAGES = { parse: "オフラインのため、いまは読み解けません。", send: "オフラインのため、送れませんでした。", generic: "オフラインのため、いまは操作できません。" } as const`
  - `countMatches(connections: LatchDTO[], intentId: string): number`(`my_intent_id === intentId`の件数・`IntentDetail.tsx`から出す)

- [ ] **Step 1: 失敗する試験を書く**:
  - errors: `new TypeError("Failed to fetch")`→true・`new ApiError("NOT_FOUND", …)`→false
  - 表示: つながり(active)で「預けて」「期限まで」「これまで」「2回つながった」(connectionsに`my_intent_id`一致2件)、条件に主題・条件・地域「指定なし(全国)」・人数「2人(あなたと相手)」・期限。機会で「開始・」「期限・」・日時・場所・人数・予算・お酒「含む(20歳以上の方どうし)」/「含まない」
  - 操作: active=[一時停止する]・[内容を直す](`/intents/I1/edit`)・[取り下げる]・スイッチ。paused=[再開する]・スイッチが`disabled`・説明「一時停止中は、提案が届きません。いつでも再開できます。」。expired=[もう一度預ける](`sessionStorage`の`latch.compose`に`raw_text`・`/compose`へ)・[一覧から消す]・「◯月◯日に期限が切れました。」。matched・cancelledは操作なし
  - スイッチのオフで`PATCH {notification_level:"muted"}`、オンで`"proposals_only"`
  - [一時停止する]の成功で「一時停止しました。」・[再開する]で「再開しました。」
  - [取り下げる]→確認のシート(「この意思を取り下げます。届いている提案も取り消されます。」)→[取り下げる]で`DELETE`が1回(連打してもRF 5)→`/home`へ`state.toast="取り下げました。"`
  - pauseが400 `VALIDATION_FAILED`(`reasons:["invalid_status"]`)を返すと単一取得をやり直す(RF 4)
  - スイッチのPATCHが`TypeError`で失敗すると元の値に戻り「オフラインのため、いまは操作できません。」(RF 5)
  - 404で「見つかりませんでした」とホームへのリンク
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/screens/intent src/offline` → FAIL
- [ ] **Step 3: 実装する**: prototype `screens.intent`の構造(`topbar`の戻る→ホーム・`.stats`・`dl.facts`・`.setting-row`の`.switch`・`.stack`の操作)を移植。日数は`now: Date`を受ける小関数で計算。確認のシートはF6bの`ChatMenu.tsx`の一段の確認と同じ作り。送信中はボタンを`disabled`にする
- [ ] **Step 4: 通ることを確かめる**: 同じコマンド → PASS
- [ ] **Step 5: コミット**: `F8a: 意思の詳細の画面を足す`

### Task 3: 「読み解いた条件」の行内編集の切り出し

**Files:**
- Create: `apps/web/src/intents/FactsEditor.tsx`
- Modify: `apps/web/src/intents/submit.ts`(`FactsValues`の型)・`apps/web/src/screens/Confirm.tsx`(行内編集の状態(142〜156行)と`topicRow`〜`alcoholRow`・`geoRow`(340〜640行付近)を移す)
- Test: `apps/web/src/intents/FactsEditor.test.tsx`・既存の`apps/web/src/screens/Confirm.test.tsx`(変更しない)

**Interfaces:**
- Produces: `FactsEditor(props: { form: IntentForm; values: FactsValues; onChange: (next: FactsValues) => void; errors: { topic?: string; start?: string }; readOnly?: ReadonlyArray<"alcohol"> })`。`FactsValues = Pick<ConfirmValues, "topic" | "startLocal" | "participants" | "budget" | "softConstraints" | "alcoholInvolved">`(`submit.ts`で型を出す)。`<dl className="facts">`の中身を描く(見出しは呼び出し側)。`readOnly`に`"alcohol"`を含むとお酒の行は表示のみ

- [ ] **Step 1: 失敗する試験を書く**: 主題の鉛筆→入力→確定で`onChange`に新しい`topic`。条件の追加・削除が`softConstraints`に反映。`readOnly={["alcohol"]}`でお酒のスイッチが無い
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/intents/FactsEditor.test.tsx` → FAIL
- [ ] **Step 3: 実装する**: Confirmの行内編集をそのまま移し、Confirmは`FactsEditor`を呼ぶ(422 ALCOHOL_RESTRICTEDの案内・期限の選択・預け方の選択はConfirmに残す)。見た目・文言・aria-labelを変えない
- [ ] **Step 4: 確かめる**: `pnpm --filter web exec vitest run src/screens/Confirm.test.tsx src/intents src/screens/onboarding-flow.test.tsx` → PASS(既存の試験は無修正)
- [ ] **Step 5: コミット**: `F8a: 読み解き確認の行内編集を共通部品へ切り出す`

### Task 4: 内容を直す(`/intents/:id/edit`)

**Files:**
- Create: `apps/web/src/screens/intent/IntentEdit.tsx`
- Modify: `apps/web/src/intents/submit.ts`・`apps/web/src/router.tsx`
- Test: `apps/web/src/intents/submit.test.ts`(追記)・`apps/web/src/screens/intent/IntentEdit.test.tsx`

**Interfaces:**
- Consumes: Task 1の`useIntentQuery`・`usePatchIntent`・`intentPath`、Task 3の`FactsEditor`・`FactsValues`、`validateConfirmValues`・Confirmの`REASON_MESSAGES`(`submit.ts`へ移して共有する)、Task 2の`isOfflineError`・`OFFLINE_MESSAGES`
- Produces:
  - `confirmValuesFromIntent(intent: IntentDTO): ConfirmValues`(`startLocal`は`time.start`の`localInputFromIso`・`softConstraints`は`soft_constraints`・`expiresInDays`は既定値)
  - `buildIntentEditPatch(before: IntentDTO, values: FactsValues): PatchIntentRequest | null`(変わった項目だけ。topicは`trim`後で比較・timeは`{start, end: null}`・budgetは機会だけ。変化なしは`null`)

- [ ] **Step 1: 失敗する試験を書く**:
  - submit: 主題だけ変えると`{topic:"新しい主題"}`だけ。条件の追加で`{soft_constraints:[…]}`だけ。何も変えないと`null`。つながりのbudgetは送らない
  - 画面: 初期値が意思の内容。預け方・期限・地域は表示のみ。変更して[直して預ける]→「直すと、届いている提案は取り消されます。」の確認→PATCH→`/intents/I1`へ`state.toast="直しました。"`。変更なしの保存はPATCHも確認も無く詳細へ戻る(RF 3)。400の`reasons`を`REASON_MESSAGES`の文で表示。`version_conflict`で「ほかの画面で変更されました。最新の内容を読み直しました。」と単一取得のやり直し。active以外の意思で開くと詳細へ`replace`で戻す。`TypeError`で「オフラインのため、いまは操作できません。」
  - 詳細(Task 2)が`state.toast`を出す
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/intents/submit.test.ts src/screens/intent` → FAIL
- [ ] **Step 3: 実装する**: 見た目は`Confirm.tsx`の`topbar`・`t-words`の本文・「読み解いた条件」の見出しに揃える(ボード無し・実装の裁量)。お酒は`readOnly={["alcohol"]}`。詳細にも`RouteToast`を置く
- [ ] **Step 4: 通ることを確かめる**: `pnpm --filter web exec vitest run` → PASS
- [ ] **Step 5: コミット**: `F8a: 意思の内容を直す画面を足す`

### Task 5: 認証セッションの利用者ID・オフライン中のセッション・破棄の通知

**Files:**
- Modify: `apps/web/src/auth/session.ts`・`apps/web/src/auth/guard.tsx`
- Test: `apps/web/src/auth/session.test.ts`(追記)・`apps/web/src/auth/guard.test.tsx`(新規または追記)

**Interfaces:**
- Produces(`authSession`へ追加):
  - `userId: string | null`(getter。アクセストークンのJWTの`sub`をbase64urlで読んだ値。`setTokens`・リフレッシュ成功で`localStorage`の`latch.uid`へ保存し、起動時は保存値を返す)
  - `offline: boolean`(getter。直近の`restore()`が`network_error`で、保存済みのリフレッシュトークンがあるときtrue。成功・拒否・`clear()`でfalse)
  - `onClear(listener: () => void): () => void`(`clear()`の最後に呼ぶ。戻り値で解除)
  - `clear()`は`latch.uid`も消す
- `RequireAuth`は`authSession.accessToken !== null || authSession.offline`で描画する

- [ ] **Step 1: 失敗する試験を書く**: `setTokens`(`sub:"U1"`のJWT)で`userId==="U1"`と`latch.uid`。`fetch`が`TypeError`の`restore()`で`offline===true`・`accessToken===null`・保存値は残る。続く`restore()`が200で`offline===false`。401で`offline===false`・`latch.refresh`と`latch.uid`が消え`onClear`の listener が1回呼ばれる(RF 2)。`RequireAuth`が`offline`のとき子を描画し、どちらも無いと`/welcome`へ
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/auth` → FAIL
- [ ] **Step 3: 実装する**: 401(rejected)の`restore()`は`authSession.clear()`を通して破棄する(listenerを呼ぶため)。`sub`の読み出しは署名を検証しない(表示用の紐づけだけ・コメントに明記)
- [ ] **Step 4: 通ることを確かめる**: `pnpm --filter web exec vitest run` → PASS
- [ ] **Step 5: コミット**: `F8a: オフライン中のセッションと利用者IDを認証セッションに足す`

### Task 6: 取得結果の保存と接続の回復

**Files:**
- Create: `apps/web/src/offline/persister.ts`・`apps/web/src/offline/reconnect.ts`
- Modify: `apps/web/src/App.tsx`・`apps/web/package.json`(`@tanstack/react-query-persist-client` `5.104.4`・`idb-keyval` `6.3.0`を`dependencies`へ・`pnpm install`でlockfileを更新)
- Test: `apps/web/src/offline/persister.test.ts`・`apps/web/src/offline/reconnect.test.ts`

**Interfaces:**
- Consumes: Task 5の`authSession.userId`・`offline`・`onClear`・`restore`
- Produces:
  - `OFFLINE_CACHE_KEY = "latch.offline-cache"`・`OFFLINE_MAX_AGE_MS`
  - `PERSISTED_QUERY_KEYS`(Global Constraintsの4キー)・`shouldPersistQuery(query: Query): boolean`(`status==="success"`かつ`queryHash`が4キーのいずれかの`hashKey`と一致)
  - `createOfflinePersister(getUserId: () => string | null, store?: { get; set; del }): Persister`。`persistClient`は`{ userId, client }`を保存(userIdがnullなら保存しない)。`restoreClient`は保存のuserIdが現在と異なれば保存を消して`undefined`(RF 1)。`removeClient`は`del`
  - `clearOfflineCache(queryClient: QueryClient): Promise<void>`(`queryClient.clear()`と`del(OFFLINE_CACHE_KEY)`)
  - `startReconnect(queryClient: QueryClient, target?: Window): () => void`(`online`イベントで`authSession.offline`なら`restore()`し、成功で`queryClient.invalidateQueries()`)
- App: `PersistQueryClientProvider`(`persistOptions: { persister, maxAge: OFFLINE_MAX_AGE_MS, dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery } }`)へ置き換え、モジュール読み込み時に`authSession.onClear(() => void clearOfflineCache(queryClient))`と`startReconnect(queryClient)`を1回ずつ登録する

- [ ] **Step 1: 失敗する試験を書く**(`store`はメモリの差し替え): `["latches","proposals"]`は保存対象・`["latches","L1"]`・`["messages","L1"]`・`["notifications"]`・失敗した`["intents"]`は対象外。U1で保存→U1で復元できる→U2で`undefined`かつ保存が消える(RF 1)。userIdなしは保存しない。`clearOfflineCache`でキャッシュと保存が空。`online`イベントで`restore`が呼ばれ成功で`invalidateQueries`。拒否なら`onClear`経由で保存が消える(RF 2)
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/offline` → FAIL
- [ ] **Step 3: 実装する**: 上のInterfacesどおり。`idb-keyval`の`get`・`set`・`del`を既定の`store`にする。IndexedDBが使えない(例外)ときは保存せず例外を外へ出さない
- [ ] **Step 4: 通ることを確かめる**: `pnpm --filter web exec vitest run` → PASS(`App.test.tsx`も緑。happy-domにIndexedDBが無ければ既定の`store`の例外を握りつぶすことで通る)
- [ ] **Step 5: コミット**: `F8a: ホームとつながり一覧の取得結果を端末に保存する`

### Task 7: オフラインの帯と操作の案内

**Files:**
- Create: `apps/web/src/offline/online.ts`・`apps/web/src/offline/OfflineBanner.tsx`
- Modify: `apps/web/src/screens/Home.tsx`(`PushOffBanner`の位置)・`apps/web/src/screens/chat/Connections.tsx`・`apps/web/src/screens/Reading.tsx`・`apps/web/src/screens/Compose.tsx`・`apps/web/src/screens/Confirm.tsx`・`apps/web/src/screens/latch/LatchScreen.tsx`(回答の失敗表示)・`apps/web/src/screens/chat/Chat.tsx`(送信の失敗)
- Test: `apps/web/src/offline/online.test.ts`・`apps/web/src/offline/OfflineBanner.test.tsx`・各画面の既存の試験へ追記

**Interfaces:**
- Consumes: Task 2の`isOfflineError`・`OFFLINE_MESSAGES`
- Produces: `useOnline(): boolean`(`useSyncExternalStore`で`navigator.onLine`と`online`/`offline`イベント)・`OfflineBanner()`(Offline.dc.htmlの`p.banner`とwifi-offの`svg`・文言は帯の固定文)

- [ ] **Step 1: 失敗する試験を書く**: `offline`イベントで`useOnline()===false`・`online`でtrue。Homeは`navigator.onLine=false`のとき帯を出し、通知オフの帯は出さない。Homeは一覧の再取得が`TypeError`で失敗してデータがあるとき帯を出す。Connectionsも同様。Readingは読み解きが`TypeError`で失敗すると`/compose`へ`state.toast="オフラインのため、いまは読み解けません。"`で戻る(parse-failedへ行かない)。Confirmの預ける・LatchScreenの回答の`TypeError`で「オフラインのため、いまは操作できません。」。Chatの送信の`TypeError`で「オフラインのため、送れませんでした。」のトースト(既存の[もう一度送る]は残る)
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/offline src/screens` → FAIL
- [ ] **Step 3: 実装する**: 帯の条件は`!useOnline() || (isRefetchError && isOfflineError(error))`。Composeは`RouteToast`を置く
- [ ] **Step 4: 通ることを確かめる**: `pnpm --filter web exec vitest run` → PASS
- [ ] **Step 5: コミット**: `F8a: オフラインの帯と操作の案内を足す`

### Task 8: Service Workerの除外・PNGアイコン・マニフェスト

**Files:**
- Create: `apps/web/scripts/make-icons.mjs`・`apps/web/public/apple-touch-icon.png`(180)・`icon-192.png`・`icon-512.png`・`icon-maskable-512.png`
- Modify: `apps/web/vite.config.ts`・`apps/web/index.html`(14行の`apple-touch-icon`)・`apps/web/package.json`(`@resvg/resvg-js` `2.6.2`を`devDependencies`へ・`"icons": "node scripts/make-icons.mjs"`)
- Test: `apps/web/src/pwa-config.test.ts`

**Interfaces:**
- Produces: `vite.config.ts`から`pwaManifest`(マニフェストのオブジェクト)と`pwaWorkbox`(workboxの設定)を名前付きで出し、試験から読む

- [ ] **Step 1: 失敗する試験を書く**: `pwaWorkbox.navigateFallbackDenylist`が`/v1/x`と`/healthz`に一致し`/home`に一致しない。`pwaWorkbox.importScripts`が`["push-sw.js"]`のまま。`pwaManifest.icons`に`icon-192.png`(192x192・any)・`icon-512.png`(512x512・any)・`icon-maskable-512.png`(512x512・maskable)・`icon.svg`(any)があり、`"any maskable"`の行が無い。`public/`に4つのPNGが実在する
- [ ] **Step 2: 失敗を確かめる**: `pnpm --filter web exec vitest run src/pwa-config.test.ts` → FAIL
- [ ] **Step 3: 実装する**: `make-icons.mjs`は`public/icon.svg`を`Resvg`で各サイズへ描く。maskableは512pxの背景`#EEF0F2`の中央に図柄を80%の大きさ(安全域)で置く(SVGを`<svg>`で包んで余白と背景を足してから描く)。`pnpm --filter web icons`で生成してPNGをコミットする。`index.html`は`<link rel="apple-touch-icon" href="/apple-touch-icon.png" />`
- [ ] **Step 4: 確かめる**: `pnpm --filter web exec vitest run` → PASS、`pnpm --filter web build`の出力の`dist/manifest.webmanifest`にPNGの4行、`dist/sw.js`に`navigateFallbackDenylist`の正規表現
- [ ] **Step 5: コミット**: `F8a: ホーム画面追加のPNGアイコンとService Workerの除外を足す`

### Task 9: web E2E(`pwa-flow.spec.ts`)

**Files:**
- Create: `apps/web/e2e/pwa-flow.spec.ts`

**Interfaces:**
- Consumes: `setUpUser`・`composeAndRead`・`placeAndBackToHome`・`fetchIntentsViaApi`・`captureAccessToken`・`expireLeftoverE2eIntents`(`e2e/helpers.ts`)。地域を使う試験はしない(提案を作らない)

- [ ] **Step 1: 試験を書く**(3本・各testの前に`expireLeftoverE2eIntents()`):
  1. **意思の詳細**: つながりの意思を預ける→ホームの行を押して`/intents/{id}`→[一時停止する]→「一時停止しました。」と「一時停止中」→[再開する]→スイッチを切る(`fetchIntentsViaApi`で`notification_level==="muted"`)→[内容を直す]→主題を直す→確認→「直しました。」と新しい主題→[取り下げる]→確認→`/home`で「取り下げました。」と行が消える
  2. **オフライン**: 意思を預けてホームを表示→`page.evaluate(() => navigator.serviceWorker.ready)`で制御を待ち、`page.reload()`で`navigator.serviceWorker.controller`が非null→`context.setOffline(true)`→`page.reload()`→帯「オフラインです。最後に確かめた内容を表示しています。」と預けた本文→[預ける]の入口から読み解きへ進むと「オフラインのため、いまは読み解けません。」→`context.setOffline(false)`で帯が消える。(ChromiumでsetOfflineがService Workerの取得に効かない場合は、`context.route("**/v1/**", r => r.abort("internetdisconnected"))`を併用し、その旨をspecのコメントに残す)
  3. **インストールの要件**: `request.get("/manifest.webmanifest")`の`name==="LATCH"`・`display==="standalone"`・`start_url`あり・各アイコンの`src`を`request.get`して200で`image/png`(SVGは`image/svg+xml`)。ページの`link[rel=apple-touch-icon]`が`/apple-touch-icon.png`
- [ ] **Step 2: 実行する**: `pnpm --filter web build && pnpm --filter web test:e2e` → 既存15本+3本=18本がPASS(ポートが埋まっていれば`LATCH_E2E_PORT=<空き>`)
- [ ] **Step 3: コミット**: `F8a: #32の自動の部分のweb E2Eを追加する`

### Task 10: 監査の実行と実機確認の手順書

**Files:**
- Create: `docs/reports/f8a-lighthouse.md`・`docs/reports/f8a-pwa-device-check.md`

- [ ] **Step 1: Lighthouseを実行する**: web E2Eと同じ手順で`wrangler dev --local`を起動し(本番ビルド・`VITE_DEV_AUTH`なし)、`npx lighthouse@13.5.0 http://localhost:<ポート>/welcome --only-categories=performance,accessibility,best-practices --form-factor=mobile --chrome-path="$(node -e 'console.log(require("@playwright/test").chromium.executablePath())')" --output=json --output-path=<scratchpad>/lh.json`。各カテゴリの点数と主な指摘(上位5件)を`f8a-lighthouse.md`へ表で記録する(実行日・Lighthouseの版・対象URL・端末の想定)。点数が低い指摘は直さず記録に留め、対応はF8b以降の判断とする旨を書く
- [ ] **Step 2: 手順書と記録の雛形を書く**(設計書 §4.3): 準備(`.dev.vars`で`LATCH_PUSH_MODE=real`・`pnpm --filter web build`・`wrangler dev --local --port 8787`・`cloudflared tunnel --url http://localhost:8787`で得たHTTPSのアドレス・終わったらトンネルを閉じる・鍵はテスト用)/提案を作る手順(2つの端末または端末とPCのブラウザで一致する意思を預ける)/iPhone Safari・Android Chromeそれぞれの項目表(ホーム画面に追加・枠なしで起動・通知の許可・Web Pushの受信と汎用文・タップでアプリ内通知の一覧(画面名「お知らせ」)・電波を切って帯と最後の内容)と記録欄(端末とOS・ブラウザの版・結果・日付)・Chrome開発者ツール(Application > Manifest)の「インストール可能」の表示の画面写しの欄
- [ ] **Step 3: コミット**: `F8a: Lighthouseの監査結果と実機確認の手順書を追加する`

### Task 11: 文書の更新

**Files:**
- Modify: `docs/12-development-roadmap.md`・`docs/10-test-env-nfr.md`・`docs/02-scope-acceptance.md`・`docs/01-requirements.md`・`docs/04-system-architecture.md`・`docs/08-privacy-safety.md`・`docs/00-document-roadmap.md`・`AGENTS.md`

- [ ] **Step 1: 書く**(設計書 §6):
  - 01冒頭の決定記録(2026-10-21・PWAと画面の仕上げ): 設計書 §0.3の1〜6を「決定内容/根拠/影響」で。§20にオフライン表示の保存範囲(意思の一覧・提案の一覧・つながり一覧・自分)・7日・ログアウトとログインの拒否での消去
  - 02 #32: 確認方法を「実機ブラウザでホーム画面追加・Web Push受信・最小限のオフライン表示を確認。マニフェストとService Workerの要件をweb E2Eで確かめ、Chrome開発者ツールのインストール可否と現行Lighthouseの監査(性能・アクセシビリティ・ベストプラクティス)を併用する(LighthouseのPWA監査はv12で廃止)」に改める
  - 04 §3・§4: `navigateFallbackDenylist`(`/v1/`・`/healthz`)・APIの応答はService Workerで保存しない・オフライン保存の構成(`PersistQueryClientProvider`・4キー・7日・利用者IDの紐づけ・消去の契機)・オフライン中のセッション(`authSession.offline`・接続の回復で復元)
  - 08: 端末に保存する個人の情報の範囲と消去の契機(同じ内容を01 §20と揃える)
  - 10 §4: F8aのゲート試験(pwa-flow.spec.tsの3本・単体・結合の分担・実機確認の記録は`docs/reports/f8a-pwa-device-check.md`・web E2E 18本)
  - 12 §2: F8をF8a・F8bに分ける決定記録(2026-10-21オーナー合意)・フェーズ表の内訳(F8a=#32(自動の部分は完了・実機確認はオーナーの記録待ち)/ F8b=#33)
  - AGENTS.md: 現在の状態にF8aの完了・#32の実機確認待ち・次はF8b(Cloudflareのアカウント/トークンの手配が前提)。注記の「意思ごとの通知設定…はF8」を実装済みへ
  - 各文書の版数・変更点行・前提文書欄と00 §1の版数表
- [ ] **Step 2: 確かめる**: `rg -n "F8a" docs AGENTS.md`で記載の漏れがなく、`rg -n "LighthouseのPWA監査を併用" docs`が0件、`rg -n "お知らせ" docs/0[0-9]*.md docs/1[0-2]*.md`の新規箇所が画面名・文言の引用に限られる
- [ ] **Step 3: コミット**: `F8a: PWAと画面の仕上げの完了とオーナー裁定を文書へ記録する`
