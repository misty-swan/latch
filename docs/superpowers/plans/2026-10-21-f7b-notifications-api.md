# F7b 通知のAPI 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** アプリ内通知の一覧・既読、Web Pushの購読・送信(stub/real)、Intent期限切れの通知、mutedの抑制を作り、#16のAPI部分をworker E2Eで証明する。

**Architecture:** 通知行は既存の提案化・保留の解放・成立がこれまでどおり書き、Web Push対象の行に`push_state='pending'`を付ける。送出は入口側(変更系APIの応答後・キューのバッチ後)で`flushPush`をwaitUntilで呼び、毎分Cronが取りこぼしを回収する。送信の判断(muted・購読なし・送信)は`src/push/dispatch.ts`に集め、送り手は`PushSender`の差し替え口(stub/real)で切り替える。realはRFC 8291暗号化とVAPID署名を自前で行う。

**Tech Stack:** TypeScript・Hono・drizzle-orm(D1)・zod(@latch/shared)・jose(VAPID署名・base64url)・WebCrypto(ECDH/HKDF/AES-GCM)・vitest(@cloudflare/vitest-pool-workers)・Playwright(worker E2E)

**Spec:** docs/superpowers/specs/2026-10-21-f7b-notifications-api-design.md

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。コメントは「docs/NN §x」「F7b設計 §x」で根拠を参照する
- コミットは `git add <パス>` で対象を限定する(`git add -A`・`git commit -a` は禁止)。メッセージ先頭は `F7b: `、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- Web Push対象はproposal・matchedだけ(作成時`pending`)。closed・intent_expiredは`none`。mutedはWeb Pushだけを止め、通知行は作る(F7b設計 §0.3の1)
- 本文は固定の汎用文2つ(proposal「提案が届いています。詳細はアプリでご確認ください。」/ matched「つながりが成立しました。詳細はアプリでご確認ください。」)。ペイロードは`{type, body}`だけでIDを載せない
- 数値: 一覧20件/頁・購読10件/人・endpoint 1,024字・p256dh 65バイト(先頭0x04)・auth 16バイト・回収は作成から30秒以上/再試行間隔60秒/10分でfailed/1回100件・TTL proposal=回答期限までの秒(60〜86,400)・matched=86,400・VAPID exp=12時間後
- 送信先ホストの許可リスト: `fcm.googleapis.com`・`updates.push.services.mozilla.com`・`*.push.apple.com`・`*.notify.windows.com`(https限定)
- 失敗の写像は既存の`errorJson`(`src/http/errors.ts`): 形の誤り=400 VALIDATION_FAILEDの`details.reasons`に理由コード(`push_endpoint_not_allowed`・`push_subscription_limit`・`invalid_push_keys`)
- 時刻は`now`引数で受け取る。`systemClock`はルート・入口だけ(docs/04 §4)
- ログは許可リストの項目だけ。endpoint・鍵・本文・相手のuser_idは出さない
- 用語: 「アプリ内通知」(「お知らせ」は画面名としてだけ使う)・「つながりIntent」「機会Intent」。docsにレガシー実装への言及をしない
- 毎コミットで `pnpm lint`・`pnpm typecheck`・該当パッケージの vitest が緑

## Review Focus

1. 同じ通知行を入口のflushとCronの回収が同時に拾う → 送信は1回だけ(Task 3の試験「順番の取り合い」)
2. 1人が複数端末の購読を持ち、1件が410・1件が成功 → 行は`sent`、410の購読だけ`failed`(Task 3の試験⑥)
3. 端末で別アカウントにサインインし直して同じendpointを登録 → 前のユーザーの行が新しいユーザーへ付け替わり、前のユーザーへの通知はその端末へ届かない(Task 4の試験④)
4. 1対1を本人が表示から消した(hidden_at)・グループから抜けた(left_at)後のお知らせ → そのLATCHの通知は一覧にも未読数にも出ない。全体cancelledで残った1対1の参加者(left_atなし)には出る(Task 5の試験③)
5. 期限切れのCronが途中で失敗して次の分に再実行される → intent_expiredは1行だけ(Task 6の試験②)

---

### Task 1: マイグレーション0007・push_stateの書き込み・共有スキーマ

**Files:**
- Modify: `apps/worker/src/db/schema.ts`(notifications)
- Create: `apps/worker/migrations/0007_notification_push.sql`(`drizzle-kit generate`の生成物の名前を揃える・meta/も生成物をコミット)・`apps/worker/migrations_rollback/0007_rollback.sql`
- Modify: `apps/worker/migrations_rollback/README.md`
- Modify: `apps/worker/src/latches/propose.ts`・`release.ts`・`respond.ts`・`close.ts`(通知のINSERT … SELECTの値)
- Modify: `packages/shared/src/constants.ts`・`packages/shared/src/schema.ts`
- Test: `apps/worker/tests/migration.test.ts`・`apps/worker/tests/latches-propose.test.ts`・`latches-respond.test.ts`・`packages/shared/src/schema.test.ts`

**Interfaces:**
- Produces(worker): `notifications.intentId`(`text("intent_id",{length:26})`・null可)・`notifications.pushState`(`text("push_state").$type<PushState>().notNull().default("none")`)・`notifications.pushAttemptedAt`(`integer("push_attempted_at",{mode:"timestamp_ms"})`)・`uniqueIndex("notifications_intent_id_type_uniq").on(intentId, type)`・`index("notifications_push_state_created_at_idx").on(pushState, createdAt)`
- Produces(shared): `NOTIFICATION_TYPES`へ`"intent_expired"`を追加(`system`は残す)・`PUSH_STATES = ["none","pending","sent","muted","no_subscription","failed"] as const`・`type PushState`・`PUSH_LIMITS = {SUBSCRIPTIONS_PER_USER: 10, ENDPOINT_MAX_LENGTH: 1024, NOTIFICATIONS_PAGE_SIZE: 20}`・`notificationDtoSchema`(typeで分かれるdiscriminatedUnion: 共通`{id, type, read_at: string|null, created_at}`+proposal`{latch_id, response_deadline}`/matched`{latch_id, display_names: string[]}`/closed`{latch_id}`/intent_expired`{intent:{id, raw_text}}`)・`type NotificationDTO`・`notificationListResponseSchema`(`{items, next_cursor: string|null, unread_count: number}`)・`notificationReadRequestSchema`(`{up_to_id: string(26)}`.strict())・`pushSubscriptionRequestSchema`(`{endpoint: string url max 1024, keys:{p256dh: string, auth: string}}`.strict())・`pushSubscriptionDeleteRequestSchema`(`{endpoint}`.strict())

- [ ] **Step 1: 失敗する試験を書く** — `migration.test.ts`へ0006と同じ形で「0007適用後に3列と2索引があり、既存行のpush_stateが`none`、0007_rollbackで消える」。`latches-propose.test.ts`へ「提示したproposal行は`push_state='pending'`」、`latches-respond.test.ts`へ「成立のmatched行は`pending`・deferで閉じた提示済み提案のclosed行は`none`」。`schema.test.ts`へ各スキーマの受理1件・拒否(未知のキー・endpoint 1,025字・up_to_idの長さ違い)
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/migration.test.ts tests/latches-propose.test.ts tests/latches-respond.test.ts` と `pnpm --filter @latch/shared exec vitest run` / Expected: FAIL
- [ ] **Step 3: 実装** — 列を末尾に足して生成する。INSERT … SELECTは列順に依存するため、4ファイルの通知のSELECTへ`NULL, 'pending', NULL`(proposal・matched)または`NULL, 'none', NULL`(closed)を追加し、propose.tsの`latch_members`と同様に列順の注意コメントを置く。release.tsの提示もproposalとして`pending`
- [ ] **Step 4: 通過を確認** — Step 2のコマンド+`pnpm --filter worker test` / Expected: PASS。`pnpm --filter worker exec wrangler d1 migrations apply DB --local`が成功
- [ ] **Step 5: コミット** — 上記ファイルを個別に`git add` → `F7b: 通知のPush記録の列を足すマイグレーション0007と共有スキーマを追加する`

### Task 2: RFC 8291暗号化・VAPID署名・本文

**Files:**
- Create: `apps/worker/src/push/encrypt.ts`・`vapid.ts`・`payload.ts`
- Test: `apps/worker/src/push/encrypt.test.ts`・`vapid.test.ts`・`payload.test.ts`

**Interfaces:**
- Produces: `encryptAes128gcm(plaintext: Uint8Array, uaPublicKey: Uint8Array, authSecret: Uint8Array, inject?: {salt: Uint8Array; asKeyPair: CryptoKeyPair}): Promise<Uint8Array>`(本文=ヘッダ(salt16・rs=4096・idlen65・送信者公開鍵)+1レコード・区切り0x02)
- Produces: `interface VapidKeys {publicKey: string /* base64url 65バイト */; privateJwk: JsonWebKey; subject: string}`・`vapidAuthorization(endpoint: string, keys: VapidKeys, now: Date): Promise<string>`(`vapid t=<JWT>, k=<publicKey>`。JWTはES256・`aud`=endpointのorigin・`exp`=now+12時間・`sub`=subject)
- Produces: `type PushNotificationType = "proposal" | "matched"`・`PUSH_BODIES: Record<PushNotificationType, string>`・`pushPayload(type): string`(`JSON.stringify({type, body})`)・`pushTtlSeconds(type, now: Date, responseDeadline: Date | null): number`

- [ ] **Step 1: 失敗する試験を書く** — `encrypt.test.ts`: RFC 8291 §5(https://www.rfc-editor.org/rfc/rfc8291#section-5)の平文・UA公開鍵・auth secret・AS鍵対・saltを写し、出力のbase64urlがRFCの本文と完全一致。`vapid.test.ts`: joseの`jwtVerify`で検証でき、`aud`が`https://fcm.googleapis.com`(endpoint `https://fcm.googleapis.com/fcm/send/x`)・`exp−iat≤86,400`・`sub`一致、ヘッダ値が`vapid t=`で始まり`, k=<publicKey>`を含む。`payload.test.ts`: 本文2つの完全一致・ペイロードのキーが`type`・`body`だけ・TTL(回答期限まで30秒→60/2時間→7,200/48時間→86,400/matched→86,400)
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run src/push` / Expected: FAIL(モジュール無し)
- [ ] **Step 3: 実装** — RFC 8291 §3.3〜§3.4の鍵導出(`WebPush: info\0`+ua_public+as_public でIKM、`Content-Encoding: aes128gcm\0`でCEK16、`Content-Encoding: nonce\0`でNONCE12)をWebCryptoのECDH・HKDF・AES-GCMで行う。base64urlはjoseの`base64url`を使う。injectが無ければsaltは乱数・鍵対は毎回生成
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `F7b: Web Pushの暗号化(RFC 8291)・VAPID署名・汎用文の本文を追加する`

### Task 3: 送り手の差し替え口・送信の判断(`dispatchPush`・`flushPush`)・設定

**Files:**
- Create: `apps/worker/src/push/sender.ts`・`dispatch.ts`
- Create: `apps/worker/tests/fixtures/test-vapid.json`(`{publicKey, privateJwk}`。Nodeの`crypto.subtle.generateKey`(ECDSA P-256)で一度だけ生成してコミット)
- Modify: `apps/worker/src/env.ts`・`apps/worker/vitest.config.ts`(bindings)・`apps/worker/scripts/prepare-dev-vars.mjs`・`apps/worker/wrangler.jsonc`(`LATCH_PUSH_MODE: "stub"`)・`apps/worker/src/logging/logger.ts`
- Test: `apps/worker/tests/push-dispatch.test.ts`・`apps/worker/src/env.test.ts`

**Interfaces:**
- Consumes: Task 2の`encryptAes128gcm`・`vapidAuthorization`・`pushPayload`・`pushTtlSeconds`
- Produces: `interface PushTarget {endpoint: string; p256dh: string; auth: string}`・`type PushSendResult = {kind:"ok"} | {kind:"gone"} | {kind:"rejected"; status: number} | {kind:"retry"; status: number | null}`・`interface PushSender {send(target: PushTarget, payload: string, opts: {ttl: number; urgency: "high"}): Promise<PushSendResult>}`・`stubPushSender: PushSender`(常にok)・`realPushSender(keys: VapidKeys, fetchImpl?: typeof fetch): PushSender`(2xx→ok・404/410→gone・400/403/413→rejected・429/5xx/例外→retry)・`pushSenderOf(env: Env): PushSender`
- Produces: `dispatchPush(db: DrizzleD1Database, sender: PushSender, now: Date, ids: string[]): Promise<void>`・`flushPush(db, sender, now, opts: {minAgeMs: number}): Promise<number>`(対象=`pending`・作成からminAgeMs以上かつ10分以内・未試行または試行から60秒以上・id昇順100件。戻り値は渡した件数)
- Produces(Env): `LATCH_PUSH_MODE?: string`・`VAPID_PUBLIC_KEY?: string`・`VAPID_PRIVATE_KEY?: string`(JWKのJSON)・`VAPID_SUBJECT?: string`・`vapidKeysOf(env): VapidKeys`

- [ ] **Step 1: 失敗する試験を書く** — `push-dispatch.test.ts`(行を直接INSERTで配置・送り手は呼び出しを記録する試験実装): ①proposals_onlyの参加Intent+active購読1件→`sent`・購読の`last_success_at`更新・ペイロードがproposalの汎用文 ②本人の参加Intentがmuted→`muted`で送り手を呼ばない(相手側はsent) ③購読なし→`no_subscription` ④status=failedの購読だけ→`no_subscription` ⑤retryだけ→`pending`のまま・`push_attempted_at`=now ⑥2件のうち1件gone・1件ok→`sent`・goneの購読は`failed` ⑦全件rejected→`failed` ⑧順番の取り合い: 同じidで`dispatchPush`を2回並行→送り手の呼び出しは1回 ⑨`flushPush`: minAgeMs=30,000で作成20秒前の行は拾わず・40秒前は拾う・試行から30秒の行は拾わない・11分前の行は拾わない・`none`は拾わない。`env.test.ts`: productionで`LATCH_PUSH_MODE`がreal以外・VAPID_*の欠落・`VAPID_PUBLIC_KEY`がテスト鍵(fixture)と同じ、の各々で`assertEnvSafety`が例外(`ENV_UNSAFE_PUSH`・`ENV_MISSING_VAPID`・`ENV_UNSAFE_TEST_KEY`で始まる文言)
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/push-dispatch.test.ts src/env.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — 順番の取得は設計 §5.1の条件付きUPDATE(1行更新したときだけ送る)。mutedの判定は`latches.intent_ids`のうち`intents.user_id`=通知の本人のIntentの`notification_level`。matchedの本文・TTLは`latches.response_deadline`を使わない。結果は1文の条件付きUPDATEで`push_state`を書く。ログは`push.sent`・`push.failed`(許可リストへ`notification_id`・`http_status`・`push_result`を追加)。テスト鍵の公開鍵は`env.ts`に定数で持つ(fixtureと一致することを`env.test.ts`で確かめる)。`.dev.vars`とvitestのbindingsへfixtureの鍵と`VAPID_SUBJECT=mailto:dev@latch.invalid`を加える
- [ ] **Step 4: 通過を確認** — Step 2のコマンド+`pnpm --filter worker test` / Expected: PASS
- [ ] **Step 5: コミット** — `F7b: Web Pushの送り手(stub/real)と送信の判断・起動ガードを追加する`

### Task 4: 購読のAPI(`src/routes/push.ts`)

**Files:**
- Create: `apps/worker/src/push/endpoints.ts`・`apps/worker/src/routes/push.ts`
- Modify: `apps/worker/src/index.ts`(`app.route("/v1", pushRoutes)`)
- Test: `apps/worker/src/push/endpoints.test.ts`・`apps/worker/tests/push-api.test.ts`

**Interfaces:**
- Consumes: Task 1の`pushSubscriptionRequestSchema`・`pushSubscriptionDeleteRequestSchema`・`PUSH_LIMITS`、Task 3の`vapidKeysOf`
- Produces: `isAllowedPushEndpoint(url: string): boolean`・`pushRoutes`(GET `/push/vapid-public-key`→200`{public_key}` / POST `/push-subscriptions`→201・200(本文なし) / DELETE `/push-subscriptions`→204)。いずれも`requireRegistered`

- [ ] **Step 1: 失敗する試験を書く** — `endpoints.test.ts`: 許可(`https://fcm.googleapis.com/fcm/send/a`・`https://web.push.apple.com/x`・`https://wns2-par02p.notify.windows.com/w`・`https://updates.push.services.mozilla.com/wpush/v2/a`)・拒否(http・`https://evil.example/`・`https://push.apple.com.evil.example/`・`https://fcm.googleapis.com.evil.example/`・不正URL)。`push-api.test.ts`: ①公開鍵がfixtureと一致 ②新規201→同じ要求で200(行は1つ) ③p256dhが64バイト・先頭0x04以外・authが15バイト→400`invalid_push_keys` ④別ユーザーが同じendpointを登録→行のuser_idが付け替わり鍵が更新・status=active ⑤active 10件の後の11件目→400`push_subscription_limit`(failedの購読は数えない) ⑥許可外ホスト→400`push_endpoint_not_allowed` ⑦DELETEは本人の行だけ消し、2回目・他人のendpointも204(他人の行は残る) ⑧未登録トークン→401
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run src/push/endpoints.test.ts tests/push-api.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — ホストは完全一致または`.push.apple.com`・`.notify.windows.com`の接尾辞一致。付け替えはendpointのUNIQUEに対する`onConflictDoUpdate`(user_id・p256dh・auth・status=active)。上限は「本人のactive件数(このendpointの行を除く)≥10」で判定
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `F7b: Web Pushの購読のAPIを追加する`

### Task 5: アプリ内通知の一覧と既読(`src/routes/notifications.ts`)

**Files:**
- Create: `apps/worker/src/routes/notifications.ts`
- Modify: `apps/worker/src/index.ts`(`app.route("/v1/notifications", notificationRoutes)`)・`apps/worker/src/safety/block.ts`(`DELETED_DISPLAY_NAME`をexport)
- Test: `apps/worker/tests/notifications-api.test.ts`

**Interfaces:**
- Consumes: Task 1の`NotificationDTO`・`notificationListResponseSchema`・`notificationReadRequestSchema`
- Produces: `notificationRoutes`(GET `/`・POST `/read`→204)

- [ ] **Step 1: 失敗する試験を書く** — ①4種別の行を配置し、各項目が種別の欄だけを持つ(proposalの`response_deadline`=LATCHの回答期限・matchedの`display_names`=本人以外・退会者は「つながっていた相手」・closedは`latch_id`だけ・intent_expiredは`intent.raw_text`)、`push_state`を含まないことを`notificationListResponseSchema.parse`と`Object.keys`で確かめる ②25件で1頁目20件+`next_cursor`、2頁目5件+`null`・id降順 ③left_atあり・hidden_atありのLATCHの通知は一覧・`unread_count`に出ず、全体cancelledで残る1対1の参加者には出る ④`system`の行は出ない ⑤`POST /read {up_to_id}`でid≤up_to_idだけ既読・再送も204・他人の行は変わらない・不正な形は400 ⑥他人の通知は一覧に出ない
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/notifications-api.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — 頁送りはGET /v1/latchesと同じ方式(cursor=前頁の最終id・limit+1件取得)。除外は「latch_idがnullでないなら本人のlatch_members行でleft_at・hidden_atがともにnull」「intent_expiredはintentsと結合できる」。unread_countは同じ条件の件数
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `F7b: アプリ内通知の一覧と既読のAPIを追加する`

### Task 6: Cron(Pushの回収・Intent期限切れの通知)とIntent削除の後始末

**Files:**
- Modify: `apps/worker/src/pipeline/cron.ts`(`runExpiryWindows`の第1窓・`runPushSweep`を追加し`runScheduledPipeline`で`runIsolated("push", …)`)
- Modify: `apps/worker/src/routes/intents.ts`(DELETEでintent_idの通知行を削除)
- Test: `apps/worker/tests/pipeline-cron.test.ts`・`apps/worker/tests/intents-crud-api.test.ts`

**Interfaces:**
- Consumes: Task 3の`flushPush`・`pushSenderOf`
- Produces: `runPushSweep(env: Env, clock: Clock): Promise<void>`(作成から10分を過ぎた`pending`を`failed`へ倒した後、`flushPush(…, {minAgeMs: 30_000})`)

- [ ] **Step 1: 失敗する試験を書く** — `pipeline-cron.test.ts`: ①期限切れでexpired化したIntentごとに本人へintent_expired(intent_id付き・`none`)が1行 ②第1窓を走らせた後、同じIntentへのintent_expiredの書き込み(Step 3のINSERT … SELECT)をもう一度実行しても行は1つのまま(UNIQUE(intent_id, type)と`onConflictDoNothing`) ③`runPushSweep`: 作成40秒前の`pending`が`sent`へ・11分前の`pending`が`failed`へ・20秒前は`pending`のまま。`intents-crud-api.test.ts`: DELETEでそのIntentのintent_expired行が消え、他の通知は残る
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/pipeline-cron.test.ts tests/intents-crud-api.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — intent_expiredはexpired化の条件付きUPDATEと同じチャンクの`db.batch`に、`INSERT … SELECT … FROM intents WHERE id IN (…) AND status='expired'`を`onConflictDoNothing`で置く(expired化が0行なら書かれない)。新しい走査は既存のF4a走査と同じ隔離
- [ ] **Step 4: 通過を確認** — Step 2のコマンド+`pnpm --filter worker test` / Expected: PASS
- [ ] **Step 5: コミット** — `F7b: CronのPush回収とIntent期限切れのアプリ内通知を追加する`

### Task 7: 入口での送出(変更系APIの後・キューのバッチの後)

**Files:**
- Create: `apps/worker/src/push/flush-middleware.ts`
- Modify: `apps/worker/src/routes/latches.ts`・`intents.ts`・`safety.ts`(`*.use("*", pushFlushAfterWrite)`)・`apps/worker/src/pipeline/consumer.ts`(`handleQueueBatch`の主キューの処理後に`ctx.waitUntil(flushPush(…, {minAgeMs: 0}))`)
- Test: `apps/worker/tests/push-flush.test.ts`

**Interfaces:**
- Consumes: Task 3の`flushPush`・`pushSenderOf`
- Produces: `pushFlushAfterWrite: MiddlewareHandler<AppEnv>`(`await next()`の後、メソッドがPOST・PATCH・DELETEで応答が2xxのときだけ`c.executionCtx.waitUntil(flushPush(drizzle(c.env.DB), pushSenderOf(c.env), systemClock.now(), {minAgeMs: 0}))`。flushの失敗はログだけ)

- [ ] **Step 1: 失敗する試験を書く** — `push-flush.test.ts`(SELFで要求・`cloudflare:test`の`waitOnExecutionContext`が使えない場合はwaitUntil完了までポーリング): ①双方yes待ちの1対1でPOST /response(yes)が成立すると、両者のmatched行が`sent`/`no_subscription`になる(片方だけ購読を登録) ②GET /v1/latchesでは送出しない(`pending`のまま) ③キュー: 提案化を起こすバッチを`handleQueueBatch`で消費した後、proposal行が`pending`以外になる
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/push-flush.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — ミドルウェアを3つのルーターの先頭へ。consumerの`_ctx`を使う形へ変える
- [ ] **Step 4: 通過を確認** — Step 2のコマンド+`pnpm --filter worker test` / Expected: PASS
- [ ] **Step 5: コミット** — `F7b: 変更系APIとキューの後にWeb Pushを送り出す`

### Task 8: dev観測APIと#16のworker E2E

**Files:**
- Modify: `apps/worker/src/routes/dev.ts`(GET `/notifications`)
- Create: `apps/worker/e2e/notifications.spec.ts`
- Modify: `apps/worker/e2e/helpers.ts`(`listDevNotifications`・`subscribePush`)
- Test: `apps/worker/tests/dev-observe-api.test.ts`

**Interfaces:**
- Produces: GET `/v1/dev/notifications`(`hideWhenDisabled`→`requireRegistered`→本人の全行をid降順で`{notifications:[{id, type, latch_id, intent_id, push_state, push_attempted_at, read_at, created_at}]}`)・`listDevNotifications(request, accessToken): Promise<DevNotification[]>`・`subscribePush(request, accessToken, endpoint: string): Promise<void>`(鍵はRFC 8291 §5のUA公開鍵とauth secretを使う)

- [ ] **Step 1: 試験を書く** — `dev-observe-api.test.ts`: 本人の行だけ返す・テスト鍵モードでないとき404。`notifications.spec.ts`(配置はsafety.spec.tsと同じ: 新規ユーザー・test前のclean-e2e-data・離れた地域・最後にIntentをDELETE): ①proposals_onlyの2人(Aだけ購読)で提案 → 双方にproposalの通知・Aは`sent`・Bは`no_subscription`(10 §4のiOS未インストールの確認ケース)、GET /v1/notificationsで双方にproposalが見える ②Aの意思をPATCHでmutedにしてから(購読あり)提案 → Aは`muted`で通知行あり・LATCHはproposed・Aがyesで回答できる ③①の続きで双方yes → matchedの通知と記録(購読ありは`sent`)、POST /v1/notifications/readで`unread_count`=0
- [ ] **Step 2: 実行** — Run: `pnpm --filter web build && pnpm --filter worker test:e2e` / Expected: 既存44本+新規が緑
- [ ] **Step 3: コミット** — `F7b: #16のAPI部分のworker E2Eとdev観測APIを追加する`

### Task 9: 文書の更新とゲートの記録

**Files:** `docs/01`・`02`・`04`・`05`・`06`・`08`・`10`・`12`・`00`(§1の版数表と前提文書欄)・`AGENTS.md`

- [ ] **Step 1: 更新** — 設計 §7の各項目を反映する。01冒頭の決定記録へ「mutedはWeb Pushだけを止める」を決定内容/根拠/影響の形で追加。05 §3.2のAPI一覧へ購読3本とdev API、§3.3へNotificationDTO・購読の検証・既読、§2.2へ列・種別・索引・push_state、§2.5へIntent削除。12 §2の表と決定記録の影響へF7b完了(#16のAPI部分をworker E2E notifications.spec.tsで証明)。各文書の版数を上げ変更点行を追記し、前提文書欄と00 §1を揃える。AGENTS.mdの現在の状態へF7bの要約と「次はF7c」
- [ ] **Step 2: 確認** — Run: `rg -n "お知らせ" docs/0*.md docs/1*.md`で用語の新規混入が無いこと(画面名としての既存の用法は除く)、`pnpm lint` / Expected: 新たな不一致なし
- [ ] **Step 3: コミット** — `F7b: 通知のAPIの完了とオーナー裁定を文書へ記録する`
