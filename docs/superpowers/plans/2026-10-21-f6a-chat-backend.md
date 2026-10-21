# F6a チャット(バックエンド) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 成立LATCHのテキストチャットをDurable Objects+WebSocket(REST代替つき)で提供し、既読・読み取り専用化・表示から消す(DELETE)までをAPIとして完成させ、#25をworker E2Eで証明する。

**Architecture:** D1への書き込みは`src/chat/messages.ts`の純粋なD1操作に集め、送信はWebSocket・RESTとも`ChatRoomDO`の1か所を通して「条件付き保存→現在の参加者へ配信」を直列に行う。チケットは`src/chat/ticket.ts`がjose(HS256・JWT_SECRET・typ=ws_ticket)で発行し、Workerのルートが検証・D1で参加を再検証してからDOへ接続を委譲し、DOがjtiの使用済みを記録する。DELETEは既存の`leave`に`latch_members.hidden_at`の記録を重ね、離脱・削除の後はDOへ`closed`を最善努力で知らせる。

**Tech Stack:** TypeScript・Hono・drizzle-orm(D1)・Durable Objects(Hibernation API・SQLiteストレージ)・jose・ulid(monotonicFactory)・zod(@latch/shared)・vitest(@cloudflare/vitest-pool-workers 0.23)・Playwright(worker E2E・Node 22のグローバルWebSocket)

**Spec:** docs/superpowers/specs/2026-10-21-f6a-chat-backend-design.md

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。コメントは「docs/NN §x」「F6a設計 §x」で根拠を参照する慣習に従う
- コミットは `git add <パス>` で対象を限定する(`git add -A`・`git commit -a` は禁止)。コミットメッセージの先頭は `F6a: `、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 本文: 前後の空白を除いて1〜2,000字(zodの`trim().min(1).max(2000)`・保存は除いた形)。履歴は1頁50件・ID昇順返却。チケットはexp=発行から60秒
- client_id: 1〜64字の`[A-Za-z0-9_-]`。MessageDTOのclient_idは本人の送信にだけ値を入れ、他人の送信はnull
- 失敗の写像: 非参加・存在しない・保留中・本人がleft_atかhidden_atを持つ=一律404 NOT_FOUND / それ以外=400 VALIDATION_FAILEDの`details.reasons`に理由コード(`invalid_status`・`read_only`・`invalid_message`・`unknown_message`)/ WebSocketの認証の失敗=401 UNAUTHORIZED(理由を区別しない)/ Upgradeでない=426 UPGRADE_REQUIRED
- 送信の条件: LATCHがmatchedかつ送り手のleft_at・hidden_atがnull。判定は保存のINSERT文の中で行う(事前の読み出しだけで決めない)
- 時刻は`now`引数・`Clock`で受け取る。`systemClock`を使うのはルートとDOの合成の起点だけ(docs/04 §4)
- ログは許可リスト(`intent_id`・`latch_id`・`status`・`version`・`error_code`・`layer`・`count`・`latency`)だけ。本文・client_id・チケット・user_idは出さない
- 用語: 「つながりIntent」「機会Intent」「アプリ内通知」。docsにレガシー実装への言及をしない
- 毎コミットで `pnpm lint`・`pnpm typecheck`・該当パッケージの vitest が緑

## Review Focus

1. グループで1人が抜け、DOへの`closed`の知らせが失敗した → 抜けた人の開いたままの接続に以後のメッセージが届かず、次の配信で`closed`を受けて切断される(Task 5の試験⑥)
2. 同じ接続から間を置かずに3通送る → 受信の順・履歴APIの順・IDの昇順がすべて一致する(Task 5の試験⑤)
3. バイナリのフレーム・JSONでない文字列・未知のtypeを送る → 接続は切れずに`error(invalid_message)`が返り、その後の正しい送信は届く(Task 5の試験④)
4. WebSocketで送って応答を受け取れなかった画面がRESTで同じclient_idを再送する → 行は1件のまま、201で同じidのMessageDTOが返る(Task 6の試験⑦)
5. 1対1で相手が「表示から消す」を実行した後の残された側 → 成立一覧にstatus=cancelledで残り、`last_message`・`unread_count`が付き、履歴は読めて送信は400 read_only(Task 8の試験②)

---

### Task 1: マイグレーション0005(hidden_at・client_id)

**Files:**
- Modify: `apps/worker/src/db/schema.ts`(latchMembers・messages)
- Create: `apps/worker/migrations/0005_chat_hidden_client_id.sql`(drizzle-kit generateで生成し、ファイル名をこの名前にする。meta/のsnapshot・_journalも生成物をコミット)
- Create: `apps/worker/migrations_rollback/0005_rollback.sql`
- Test: `apps/worker/tests/migration.test.ts`

**Interfaces:**
- Produces: `latchMembers.hiddenAt`(`integer("hidden_at", { mode: "timestamp_ms" })`・null可)・`messages.clientId`(`text("client_id", { length: 64 })`・null可)・一意索引`messages_latch_id_user_id_client_id_uq` on (latch_id, user_id, client_id)

- [ ] **Step 1: 失敗する試験を書く** — `migration.test.ts`に0004と同じ形で4件追加: 「0005適用後、latch_membersにhidden_at列(null可)がある」「messagesにclient_id列(null可)がある」「同じ(latch_id, user_id, client_id)の2行目のINSERTが一意制約で失敗し、client_idがnullの2行は入る」「戻しマイグレーション0005の適用でhidden_at・client_id列と索引が消える」
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/migration.test.ts` / Expected: 追加4件がFAIL
- [ ] **Step 3: schema.tsに列と`uniqueIndex`を追加し、`pnpm --filter worker exec drizzle-kit generate`で生成、ファイル名を0005_chat_hidden_client_id.sqlへ揃える(_journalのtagも)。rollbackは0004_rollback.sqlと同じ見出しコメント(対の根拠docs/11 §3・失われる記録=消した印と再送の重複防止)で`DROP INDEX`→`ALTER TABLE … DROP COLUMN`×2**
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS。`pnpm --filter worker exec wrangler d1 migrations apply DB --local`も成功
- [ ] **Step 5: コミット** — `git add apps/worker/src/db/schema.ts apps/worker/migrations apps/worker/migrations_rollback/0005_rollback.sql apps/worker/tests/migration.test.ts` / `F6a: latch_members.hidden_atとmessages.client_idのマイグレーション0005を追加する`

### Task 2: 共有スキーマと定数

**Files:**
- Modify: `packages/shared/src/constants.ts`・`packages/shared/src/schema.ts`
- Test: `packages/shared/src/schema.test.ts`・`packages/shared/src/constants.test.ts`

**Interfaces:**
- Produces(constants): `LIMITS.MESSAGE_BODY_MAX_LENGTH = 2000`・`CHAT.MESSAGE_PAGE_SIZE = 50`・`CHAT.WS_TICKET_TTL_SECONDS = 60`・`CHAT.CLIENT_ID_MAX_LENGTH = 64`・`ERROR_CODES`に`"UPGRADE_REQUIRED"`(`ERROR_HTTP_STATUS`=426)・`CHAT_ERROR_CODES = ["read_only", "invalid_message", "internal"] as const`
- Produces(schema): `messageBodySchema`(`z.string().trim().min(1).max(2000)`)・`clientIdSchema`(`/^[A-Za-z0-9_-]{1,64}$/`)・`sendMessageRequestSchema`(`{body, client_id}`・strict)・`markReadRequestSchema`(`{last_read_message_id: ULID}`・strict)・`wsTicketRequestSchema`(`{scope: z.literal("chat"), latch_id: ULID}`・strict)・`wsTicketResponseSchema`(`{ticket, expires_in: 60}`)・`messageDtoSchema`(`{id, user_id, body, created_at: isoDateTime, client_id: string|null}`)・`messagePageSchema`(`{items: MessageDTO[], next_before: string|null}`)・`chatClientFrameSchema`(`{type:"message", body: messageBodySchema, client_id}`・strict)・`chatServerFrameSchema`(discriminatedUnion: `message`(MessageDTOの各キー+type)/`closed`/`error`(`code: CHAT_ERROR_CODES`・`client_id: string|null`))・`latchDtoSchema`へ`last_message: {body, created_at, user_id}.nullable().optional()`と`unread_count: z.number().int().min(0).optional()`
- 型: `MessageDTO`・`MessagePage`・`ChatClientFrame`・`ChatServerFrame`・`SendMessageRequest`・`MarkReadRequest`・`WsTicketRequest`

- [ ] **Step 1: 失敗する試験を書く** — schema.test.ts: 「本文は前後の空白を除いて保存形になる(`'  こんにちは \n'`→`'こんにちは'`)」「空白だけ・2,001字はNG、2,000字はOK」「client_idは65字・`a b`・空文字がNG」「sendMessageRequestの余分なキーはNG」「wsTicketRequestのscopeが`chat`以外はNG」「chatServerFrameのerrorはcodeが3種以外NG」「latchDtoSchemaはlast_message・unread_countなしでもあっても通る」。constants.test.ts: 「UPGRADE_REQUIREDは426」
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter shared exec vitest run` / Expected: 追加分がFAIL
- [ ] **Step 3: constants.tsとschema.tsに上記を実装する**(既存のIDスキーマ・isoDateTimeSchema・`.strict()`の書き方に揃える)
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS・`pnpm typecheck`が緑(ERROR_HTTP_STATUSのRecordが網羅を強制する)
- [ ] **Step 5: コミット** — `git add packages/shared/src` / `F6a: チャットの共有スキーマと定数を追加する`

### Task 3: メッセージのD1操作(`src/chat/messages.ts`)

**Files:**
- Create: `apps/worker/src/chat/messages.ts`
- Test: `apps/worker/tests/chat-messages.test.ts`

**Interfaces:**
- Consumes: Task 1の列・Task 2の`CHAT.MESSAGE_PAGE_SIZE`・`MessageDTO`
- Produces:
  - `interface StoredMessage { id: string; latchId: string; userId: string; body: string; createdAt: Date; clientId: string | null }`
  - `type ChatAccess = { kind: "not_found" } | { kind: "invalid_status" } | { kind: "readable"; writable: boolean }`
  - `chatAccess(db, latchId, userId): Promise<ChatAccess>` — §2.2の表。本人の行がない・left_atかhidden_atあり・candidate→not_found / matched→readable(writable=true) / completed・matched経由のcancelled(latch_status_eventsのto_status=matched)→readable(writable=false) / それ以外→invalid_status
  - `type SendResult = { ok: true; message: StoredMessage } | { ok: false; reason: "not_found" | "invalid_status" | "read_only" }`
  - `sendMessage(db, input: { latchId: string; userId: string; body: string; clientId: string; id: string; now: Date }): Promise<SendResult>` — bodyは検証済み(trim後)を受け取る。§2.1の1バッチ(INSERT…SELECT…WHERE EXISTS…ON CONFLICT DO NOTHING+last_message_atの条件付きUPDATE)。挿入0件なら同じclient_idの既存行→ok/`chatAccess`で not_found・invalid_status・それ以外read_only
  - `listMessages(db, latchId, before: string | null): Promise<{ items: StoredMessage[]; nextBefore: string | null }>` — id<beforeをid降順で51件取り、50件をID昇順にして返す。51件目があればnextBefore=返した中の最古ID
  - `markRead(db, latchId, userId, messageId): Promise<{ ok: true } | { ok: false; reason: "unknown_message" }>` — 当該LATCHのメッセージでなければunknown_message。chat_readsへUPSERTし`last_read_message_id`は既存値と大きい方(`CASE WHEN excluded.last_read_message_id > chat_reads.last_read_message_id …`)
  - `chatSummary(db, latchId, userId): Promise<{ lastMessage: { body: string; createdAt: Date; userId: string } | null; unreadCount: number }>` — unreadCountは`user_id != 本人 AND id > COALESCE(本人のlast_read_message_id, '')`の件数
  - `activeMemberIds(db, latchId): Promise<string[]>` — left_at・hidden_atがnullの参加者
  - `toMessageDto(m: StoredMessage, viewerId: string): MessageDTO` — client_idはm.userId===viewerIdのときだけ

- [ ] **Step 1: 失敗する試験を書く** — LATCH・members・status_eventsは既存の統合試験と同じく直接INSERTで配置し、usersは直接INSERTでよい(このファイルはAPIを通さない)。試験: ①matchedで保存でき、latches.last_message_atがnowになる ②completed・matched経由のcancelledはread_only、proposedはinvalid_status、非参加・left_at・hidden_atはnot_foundで、いずれも行もlast_message_atも変わらない ③同じclient_idの2回目は同じidの行を返し行は1件 ④別ユーザーが同じclient_idを使っても別行で保存される ⑤120件で`listMessages(null)`は最新50件をID昇順・nextBefore=その最古、続けて2回取り、3回目(20件)のnextBeforeはnull ⑥markReadは前にだけ進む(新→古の順に呼んでも新のまま)・別LATCHのIDはunknown_message ⑦chatSummaryは本人の送信を未読に数えず、既読後は0、メッセージ0件はlastMessage=null ⑧chatAccessの表の全行 ⑨activeMemberIdsはleft_at・hidden_atの人を除く
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/chat-messages.test.ts` / Expected: FAIL(モジュールが無い)
- [ ] **Step 3: 上記のシグネチャで`messages.ts`を実装する**(drizzleの`db.batch`・`sql`テンプレートは`src/latches/respond.ts`の書き方に揃える)
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS
- [ ] **Step 5: コミット** — `git add apps/worker/src/chat/messages.ts apps/worker/tests/chat-messages.test.ts` / `F6a: メッセージの条件付き保存・履歴・既読をD1操作として実装する`

### Task 4: WebSocket接続チケット(`src/chat/ticket.ts`)

**Files:**
- Create: `apps/worker/src/chat/ticket.ts`
- Modify: `apps/worker/src/auth/jwt.ts`(`verifyAccessToken`が`typ`クレームを持つトークンを`invalid`で拒否する)
- Test: `apps/worker/src/chat/ticket.test.ts`・`apps/worker/src/auth/jwt.test.ts`

**Interfaces:**
- Consumes: `Clock`・`CHAT.WS_TICKET_TTL_SECONDS`
- Produces:
  - `interface ChatTicketClaims { userId: string; latchId: string; jti: string; exp: number }`(expはUNIX秒)
  - `issueChatTicket(secret: string, clock: Clock, input: { userId: string; latchId: string }): Promise<{ ticket: string; expiresIn: 60 }>` — HS256・iss="latch"・`typ:"ws_ticket"`・`sub`・`latch_id`・`jti`(newUlid)・exp=iat+60
  - `verifyChatTicket(secret: string, token: string): Promise<ChatTicketClaims | null>` — 署名・iss・alg・期限・typ一致・各クレームの型を確認し、どれかが欠ければnull(理由を区別しない)

- [ ] **Step 1: 失敗する試験を書く** — ticket.test.ts(jwt.test.tsと同じく固定Clockで): ①発行→検証でuserId・latchId・jtiが戻りexp=iat+60 ②61秒後の時刻で署名したもの(Clockを61秒戻して発行)はnull ③別の鍵はnull ④アクセストークン(signAccessToken)をverifyChatTicketに渡すとnull ⑤改ざん(ペイロードの1文字置換)はnull。jwt.test.ts: ⑥チケットをverifyAccessTokenに渡すとAccessTokenError(kind="invalid")
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run src/chat/ticket.test.ts src/auth/jwt.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**(jwt.tsの`JWT_ISSUER`はexportして共用する。verifyAccessTokenはpayload.typが存在すれば拒否する1行の追加)
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS・`pnpm --filter worker exec vitest run tests/auth-middleware.test.ts`も緑
- [ ] **Step 5: コミット** — `git add apps/worker/src/chat/ticket.ts apps/worker/src/chat/ticket.test.ts apps/worker/src/auth/jwt.ts apps/worker/src/auth/jwt.test.ts` / `F6a: WebSocket接続チケットの発行と検証を追加する`

### Task 5: ChatRoomDOと内部呼び出し(`src/do/chat.ts`・`src/chat/notify.ts`)

**Files:**
- Modify: `apps/worker/src/do/chat.ts`
- Create: `apps/worker/src/chat/notify.ts`
- Test: `apps/worker/tests/chat-do.test.ts`

**Interfaces:**
- Consumes: Task 3の`sendMessage`・`activeMemberIds`・`toMessageDto`、Task 2の`chatClientFrameSchema`・`ChatServerFrame`
- Produces(DOの内部プロトコル。DOへはWorkerのルートからのみ`env.CHAT_DO.get(env.CHAT_DO.idFromName(latchId)).fetch(...)`で到達する。ホストは`https://chat-do`で固定):
  - `GET /connect`(`Upgrade: websocket`・ヘッダ`x-latch-id`・`x-user-id`・`x-ticket-jti`・`x-ticket-exp`(UNIX秒))→ 101(webSocket付き)/ jti使用済みは401。DOの`ctx.storage.sql`の表`used_tickets(jti TEXT PRIMARY KEY, exp INTEGER NOT NULL)`へ`INSERT … ON CONFLICT DO NOTHING`し、書き込み0行なら使用済み。挿入の前に`DELETE FROM used_tickets WHERE exp < 現在秒`。受け入れは`ctx.acceptWebSocket(server, [userId])`+`serializeAttachment({ userId, latchId })`。コンストラクタで`ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"))`
  - `POST /send`(JSON `{latch_id, user_id, body, client_id}`・bodyはtrim済み)→ 201 `{message: MessageDTO}`(送信者視点)/ 404 / 400 `{reason}`
  - `POST /closed`(JSON `{latch_id, user_ids: string[] | null}`)→ 204。nullは全接続、配列は該当タグの接続へ`{"type":"closed"}`を送って`close(1000, "closed")`
  - 送信の共通処理(WS・/sendとも): IDは`monotonicFactory()`(ulid)で採番 → `sendMessage` → 成功なら`activeMemberIds`を照会し、含まれる接続へ`message`(client_idは送信者の接続だけ)、含まれない接続へ`closed`+close。`not_found`は送信者へ`closed`+close(WS)/404(/send)。`invalid_status`・`read_only`は送信者へ`error(read_only)`/400。フレーム不正(バイナリ・JSON不正・スキーマ違反)は`error(invalid_message)`(client_idが読めればそれ、なければnull)で接続は維持。例外は`error(internal)`/500で外へ出さない
- Produces(`notify.ts`):
  - `forwardSend(env: Env, input: { latchId: string; userId: string; body: string; clientId: string }): Promise<{ ok: true; message: MessageDTO } | { ok: false; reason: "not_found" | "invalid_status" | "read_only" }>`
  - `notifyClosed(env: Env, latchId: string, userIds: string[] | null): Promise<void>` — 失敗はlogger.warn(`chat.notify_closed_failed`・latch_idのみ)で握りつぶす

- [ ] **Step 1: 失敗する試験を書く** — LATCHは直接INSERTで配置し、DOへは`env.CHAT_DO`のstubで直接`/connect`する(`res.webSocket.accept()`・受信は`message`イベントをPromiseで待つ小さな補助関数を試験内に置く)。①A・Bが接続、AがWSで送る→Bに`message`(client_id=null)、Aに`message`(自分のclient_id)、D1に1行 ②`/send`でBが送る→A・Bの接続に届き、応答201のmessage.client_idはBのもの ③同じjtiの2回目の`/connect`は401 ④バイナリ・`"not json"`・`{"type":"x"}`・空白だけの本文 → 各々`error(invalid_message)`、続く正しい送信は届く ⑤Aが3通連続で送る→Bの受信順=`listMessages`の順=IDの昇順 ⑥グループ3人(C接続中)でCのleft_atを直接UPDATE(closed通知なし)→Aの送信でCに`message`は届かず`closed`が届いて切断、A・Bには届く ⑦`/closed`(user_ids=[A])→Aだけ`closed`+切断、Bは接続のまま ⑧`/closed`(null)→全員切断 ⑨LATCHをcompletedへUPDATE→Aの送信は`error(read_only)` ⑩`ping`送信→`pong`
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/chat-do.test.ts` / Expected: FAIL
- [ ] **Step 3: `ChatRoomDO`(`DurableObject<Env>`・`fetch`・`webSocketMessage`・`webSocketClose`・`webSocketError`)と`notify.ts`を実装する**。D1は`drizzle(this.env.DB)`、時刻は`systemClock.now()`(合成の起点)
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS
- [ ] **Step 5: コミット** — `git add apps/worker/src/do/chat.ts apps/worker/src/chat/notify.ts apps/worker/tests/chat-do.test.ts` / `F6a: ChatRoomDOで接続・送信の直列処理・配信・closedを実装する`

### Task 6: チャットのREST・WebSocketルート(`src/routes/chat.ts`)

**Files:**
- Create: `apps/worker/src/routes/chat.ts`
- Modify: `apps/worker/src/index.ts`(`app.route("/v1", chatRoutes)`を`/v1/latches`のマウントより前に置く)
- Test: `apps/worker/tests/chat-api.test.ts`

**Interfaces:**
- Consumes: Task 3の`chatAccess`・`listMessages`・`markRead`・`toMessageDto`、Task 4の`issueChatTicket`・`verifyChatTicket`、Task 5の`forwardSend`とDOの`/connect`
- Produces(docs/05 §3.2の契約・F6a設計 §3.1・§3.4):
  - `POST /v1/ws-ticket`(requireRegistered・`wsTicketRequestSchema`)→ 200 `{ticket, expires_in:60}`。chatAccessがnot_found→404 / invalid_status→400 invalid_status / readable(writable=false)→400 read_only
  - `GET /v1/latches/:id/messages?before=`(requireRegistered)→ 200 MessagePage。beforeがULID形式外は400。not_found→404・invalid_status→400
  - `POST /v1/latches/:id/messages`(requireRegistered・`sendMessageRequestSchema`。本文不正は400 invalid_message、その他の形の不正は400 理由なし)→ `forwardSend` → 201 MessageDTO / 404 / 400 read_only・invalid_status
  - `POST /v1/latches/:id/read`(requireRegistered・`markReadRequestSchema`)→ chatAccessがreadableなら`markRead` → 204 / 400 unknown_message / 404 / 400 invalid_status
  - `GET /v1/latches/:id/ws?ticket=`(認証ミドルウェアなし)→ Upgradeでない→426 UPGRADE_REQUIRED / `verifyChatTicket`がnull・latch_idがパスと不一致・chatAccessがreadable(writable=true)でない→401 / それ以外はDOの`/connect`へ委譲し、その応答(101か401)をそのまま返す

- [ ] **Step 1: 失敗する試験を書く** — 登録は`latches-api.test.ts`と同じ実フロー(auth/token→POST /v1/users)、LATCHは直接INSERT。①ws-ticket: matchedで200・completedで400 read_only・proposedで400 invalid_status・非参加404・scope不正400 ②WS: `SELF.fetch(…/ws?ticket=…, {headers:{Upgrade:"websocket"}})`で101、Upgradeなし426、期限切れ(Clockを動かせないので`issueChatTicket`を過去のClockで直接発行)401、別LATCHのチケット401、再使用401、チケット発行後にleft_atを立てると401 ③履歴: 2人の送信が昇順・client_idは本人分だけ・before不正400・proposed 400・hidden_at 404 ④REST送信201とWS受信(②の接続で受ける) ⑤completedへの送信400 read_only・空白本文400 invalid_message ⑥read: 204・別LATCHのID 400 unknown_message・completedでも204 ⑦WSで送ったclient_idをRESTで再送→201・同じid・行は1件
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/chat-api.test.ts` / Expected: FAIL
- [ ] **Step 3: `chatRoutes`(`new Hono<AppEnv>()`)を実装し、index.tsへマウントする**(readJsonBody・validationFailed・notFoundは`routes/latches.ts`と同じ書き方)
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS・`pnpm --filter worker test`全体も緑
- [ ] **Step 5: コミット** — `git add apps/worker/src/routes/chat.ts apps/worker/src/index.ts apps/worker/tests/chat-api.test.ts` / `F6a: チャットのREST・チケット・WebSocket接続のルートを追加する`

### Task 7: LatchDTOの最終メッセージ・未読数と成立一覧の範囲

**Files:**
- Modify: `apps/worker/src/latches/view.ts`(`LatchDtoOptions.chat?`)・`apps/worker/src/routes/latches.ts`(`loadLatchDto`・`GET /`)
- Test: `apps/worker/tests/latches-api.test.ts`

**Interfaces:**
- Consumes: Task 3の`chatSummary`、Task 1の`hiddenAt`
- Produces: `LatchDtoOptions.chat?: { lastMessage: {...} | null; unreadCount: number }` — 渡されたとき(=membersと同じく成立後)だけ`last_message`(created_atはISO 8601)・`unread_count`をDTOに入れる。`loadLatchDto`は本人の`hidden_at IS NULL`を結合条件に加える(includeLeftのときも)。`GET /?type=matched`は`status IN (matched, completed) OR (status = cancelled AND EXISTS(latch_status_eventsのto_status=matched))`、結合条件に`hidden_at IS NULL`

- [ ] **Step 1: 失敗する試験を書く** — ①成立後のDTOに`last_message`(0件ならnull)と`unread_count`がある ②proposedのDTOにはキー自体が無い(`"last_message" in dto`がfalse) ③相手の送信2件で`unread_count`=2、既読記録で0、自分の送信は数えない ④1対1をleaveでcancelledにした後、残された側の`type=matched`一覧にcancelledで出て、leaveした本人には出ない ⑤matchedを経ないcancelledは出ない ⑥hidden_atを立てた本人の一覧・単一取得から消え(404)、相手の単一取得のmembers・participants_countは変わらない
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/latches-api.test.ts` / Expected: 追加分がFAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS・既存のlatches系試験(`tests/latches-*.test.ts`)も緑
- [ ] **Step 5: コミット** — `git add apps/worker/src/latches/view.ts apps/worker/src/routes/latches.ts apps/worker/tests/latches-api.test.ts` / `F6a: 成立後のLatchDTOに最終メッセージと未読数を加え、成立一覧にmatched経由のcancelledを含める`

### Task 8: 表示から消す(DELETE)と離脱後の`closed`

**Files:**
- Create: `apps/worker/src/latches/hide.ts`
- Modify: `apps/worker/src/routes/latches.ts`(`DELETE /:id`・`POST /:id/leave`の成功後に`notifyClosed`)
- Test: `apps/worker/tests/latches-delete.test.ts`

**Interfaces:**
- Consumes: 既存の`leave(db, latchId, userId, now): Promise<RespondResult>`、Task 5の`notifyClosed`
- Produces:
  - `type HideResult = { ok: true; closedFor: "all" | "self" | "none" } | { ok: false; reason: "not_found" | "invalid_status" }`
  - `hideLatch(db, latchId, userId, now): Promise<HideResult>` — F6a設計 §2.3: 本人行なし・candidate→not_found / hidden_atあり→ok none(冪等)/ left_atあり→not_found / matched→`leave`、成功ならhidden_atを記録し、読み直してcancelledなら`all`・matchedなら`self`。`leave`がinvalid_statusなら読み直して下の分岐へ / completed・matched経由のcancelled→`UPDATE … SET hidden_at=now WHERE hidden_at IS NULL`でok none / それ以外→invalid_status
  - `closedTargetsAfterLeave(db, latchId, userId): Promise<string[] | null>` — leave成功後のLATCHがcancelledならnull(全員)、matchedなら`[userId]`
  - ルート: DELETEは成功で`closedFor`に応じ`notifyClosed(env, id, null | [sub])`(noneは呼ばない)→204。失敗は既存のRespondFailureと同じ写像。`/leave`は成功後に`closedTargetsAfterLeave`→`notifyClosed`してから従来どおりの応答

- [ ] **Step 1: 失敗する試験を書く** — APIを通す(登録は実フロー・LATCHは直接INSERT)。①1対1のmatchedをAがDELETE→204・status=cancelled・Aのhidden_atとleft_at記録・AのGETは404 ②その後のB: 単一取得200(status=cancelled・members=[A])・一覧にあり・`last_message`・`unread_count`あり・履歴200・送信400 read_only ③3人グループ(min=2)でAがDELETE→matchedのまま・Aだけ外れ・B・Cは送れる ④2人に下限が2の3人グループで1人がleave済みのところへDELETE→cancelled ⑤completedをDELETE→204・status不変・left_atはnullのまま・相手のparticipants_count不変 ⑥proposedは400 invalid_status・非参加404・2回目のDELETEは204 ⑦DELETEとleaveで接続中の相手にclosedが届くか: 1対1のDELETEでBの接続に`closed`、グループのDELETEでAの接続だけ`closed`(Task 6と同じくWSを`SELF.fetch`で張る)
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/latches-delete.test.ts` / Expected: FAIL
- [ ] **Step 3: `hide.ts`とルートを実装する**
- [ ] **Step 4: 合格を確認** — 同じコマンドでPASS・`pnpm --filter worker test`全体も緑
- [ ] **Step 5: コミット** — `git add apps/worker/src/latches/hide.ts apps/worker/src/routes/latches.ts apps/worker/tests/latches-delete.test.ts` / `F6a: DELETE /v1/latches/{id}で表示から消し、離脱・削除後に接続へclosedを知らせる`

### Task 9: #25のworker E2E

**Files:**
- Create: `apps/worker/e2e/chat.spec.ts`
- Modify: `apps/worker/e2e/helpers.ts`(必要なら`connectChat(request, baseURL, token, latchId): Promise<ChatSocket>`と`nextFrame(socket, type)`を追加)

**Interfaces:**
- Consumes: 既存の`registerUser`・`createIntent`・`waitForLatch`・`respond`、Task 6のAPI
- Produces: `chat.spec.ts`の2つのtest(配置は`latches.spec.ts`の1対1つながりIntentの成立と同じ: 新規ユーザー・各testの前に`scripts/clean-e2e-data.mjs`・最後にIntentをDELETE)

- [ ] **Step 1: 試験を書く** — test「#25 成立LATCHでメッセージを双方向に送受信し、記録が残る」: 2人を成立→両者がチケット取得・`ws://`で接続(Node 22のグローバルWebSocket)→AがWS送信→Bに届く→BがREST送信→AにWSで届く→履歴APIで2件がID昇順・送り手がA・B→Aが既読→Aの一覧で`unread_count`=0・Bの一覧で`last_message`がB。test「表示から消すと相手側は読み取り専用で残る」: Aが`DELETE`→Bの接続に`closed`→BのREST送信は400 read_only→Bの履歴は200→AのGETは404→Aの古いチケットの再使用は401
- [ ] **Step 2: 実行する** — Run: `pnpm --filter web build && pnpm --filter worker test:e2e` / Expected: 新規2件を含め全件PASS(ポート競合時は`LATCH_E2E_PORT=<空きポート>`)
- [ ] **Step 3: 単体で再実行して安定を確認** — Run: `pnpm --filter worker exec playwright test e2e/chat.spec.ts --repeat-each=3` / Expected: 6件PASS
- [ ] **Step 4: コミット** — `git add apps/worker/e2e/chat.spec.ts apps/worker/e2e/helpers.ts` / `F6a: 成立LATCHのチャットの双方向送受信のゲートE2E(#25)を追加する`

### Task 10: 文書の更新とゲートの記録

**Files:**
- Modify: `docs/12-development-roadmap.md`・`docs/01-requirements.md`・`docs/02-scope-acceptance.md`・`docs/04-system-architecture.md`・`docs/05-data-model-api.md`・`docs/08-privacy-safety.md`・`docs/10-test-env-nfr.md`・`docs/11-release-plan.md`・`docs/00-document-roadmap.md`・`AGENTS.md`

- [ ] **Step 1: 内容の更新** — F6a設計 §7の一覧どおり。12: §2のF6の行にF6a(完了)/F6bの内訳と決定記録(2026-10-21・F6の2分割・#25をworker E2E chat.spec.tsで証明)、§3にF6bはF6aの後。01冒頭・02 D-08: 続いているLATCHの削除=本人の離脱の決定記録(決定内容/根拠/影響・F6a設計 §0.3の2)。05: §2.2(hidden_at・client_idと0005の戻す手順)・§3.1(UPGRADE_REQUIRED=426)・§3.2(DELETEの挙動)・§3.3(LatchDTOのlast_message・unread_count・MessageDTO・成立一覧のmatched経由のcancelled)・§3.4(Workerでの検証・1回限り・`retract`を`closed`へ・client_id・errorのcode・配信前の参加者確認)。04 §4・08 §11: チケットの検証位置と1回限り。10 §4: #25の証明。11 §3: 0005と戻す手順。AGENTS.md「現在の状態」: F6a完了・次はF6b
- [ ] **Step 2: 版数の同期** — 変更した各文書の版数を1つ上げて冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える。Run: `rg -n "文書バージョン" docs/0*.md docs/1*.md` で00 §1の表と突き合わせ、食い違いが0件
- [ ] **Step 3: 全体の確認** — Run: `pnpm lint && pnpm typecheck && pnpm test` / Expected: すべて緑
- [ ] **Step 4: コミット** — `git add docs/00-document-roadmap.md docs/01-requirements.md docs/02-scope-acceptance.md docs/04-system-architecture.md docs/05-data-model-api.md docs/08-privacy-safety.md docs/10-test-env-nfr.md docs/11-release-plan.md docs/12-development-roadmap.md AGENTS.md docs/superpowers/specs/2026-10-21-f6a-chat-backend-design.md` / `F6a: チャット(バックエンド)の完了とオーナー裁定を文書へ記録する`
