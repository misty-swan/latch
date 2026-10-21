# F7a 安全のAPI 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ブロック(即時効果つき)・通報・飲酒年齢の判定をAPIとして作り、#26〜#30をworker E2Eで証明する。

**Architecture:** ブロックと通報はそれぞれ`src/safety/block.ts`・`src/safety/report.ts`の純粋なD1操作に置き、`src/routes/safety.ts`が`/v1`の下で公開する。ブロックはblocks行を先に書き、その後で既存の提案取り消し(Intent削除から切り出す`cancelOpenLatches`)と離脱(`leave`)を順に適用する。`proposeSet`の確保条件にblocksの不在を加えて、適用中に並行して作られる提案を塞ぐ。飲酒年齢はIntentを有効化する2経路で判定する。

**Tech Stack:** TypeScript・Hono・drizzle-orm(D1)・zod(@latch/shared)・vitest(@cloudflare/vitest-pool-workers)・Playwright(worker E2E)

**Spec:** docs/superpowers/specs/2026-10-21-f7a-safety-api-design.md

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。コメントは「docs/NN §x」「F7a設計 §x」で根拠を参照する慣習に従う
- コミットは `git add <パス>` で対象を限定する(`git add -A`・`git commit -a` は禁止)。コミットメッセージの先頭は `F7a: `、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 失敗の写像: 対象外の相手・存在しない相手/LATCH・参加していないLATCH=一律404 NOT_FOUND / 形の誤り=400 VALIDATION_FAILEDの`details.reasons`に理由コード / 飲酒年齢=422 ALCOHOL_RESTRICTED。応答は既存の`errorJson`(`src/http/errors.ts`)で作る
- 通報: reason=`spam|harassment|inappropriate|other`・target=`proposal|profile|icon|message`・noteは前後の空白を除いて0〜500字(保存は除いた形・未指定は空文字)
- 飲酒の満年齢は20(`ageAtYears(now, birthDate) < 20`で拒否)。値は重複定義せず、Layer 1の`LEGAL_DRINKING_AGE`をexportして使う
- 時刻は`now`引数で受け取る。`systemClock`を使うのはルートだけ(docs/04 §4)
- ログは許可リストの項目だけ。ブロック・通報の相手のuser_id・noteは出さない
- 用語: 「つながりIntent」「機会Intent」「アプリ内通知」「Layer 2 Candidate Retrieval」。docsにレガシー実装への言及をしない
- 毎コミットで `pnpm lint`・`pnpm typecheck`・該当パッケージの vitest が緑

## Review Focus

1. ブロックの効果の適用が途中で失敗し、利用者が同じブロックを再送する → 200が返り、残っていた提案の取り消し・離脱が最後まで適用される(Task 3の試験⑧)
2. 3人グループのmatchedで、ブロックされた人が既に抜けている(left_atあり)ときにブロックする → ブロックした本人は抜けない(2人がともに参加者のLATCHだけが対象)(Task 3の試験⑤)
3. 1対1の提案がまだ提示前(candidate・保留中)の段階でブロックする → 提示前の提案も取り消され、closed通知は作られない(Task 3の試験②)
4. 成立後の通報でmessage_idが同じLATCHの別の人の発言・別のLATCHの発言を指す → 404(Task 4の試験④)
5. 誕生日当日に満20歳になるユーザー・その前日のユーザーが飲酒の機会Intentを作成する → 当日は201、前日は422(Task 5の試験②)

---

### Task 1: マイグレーション0006(reportsのtarget・message_id)と共有スキーマ

**Files:**
- Modify: `apps/worker/src/db/schema.ts`(reports)
- Create: `apps/worker/migrations/0006_report_target.sql`(`drizzle-kit generate`の生成物をこの名前にする。meta/のsnapshot・_journalも生成物をコミット)
- Create: `apps/worker/migrations_rollback/0006_rollback.sql`
- Modify: `apps/worker/migrations_rollback/README.md`(0006の行)
- Modify: `packages/shared/src/schema.ts`・`packages/shared/src/constants.ts`
- Test: `apps/worker/tests/migration.test.ts`・`packages/shared/src/schema.test.ts`

**Interfaces:**
- Produces(worker): `reports.target`(`text("target").$type<ReportTarget>().notNull()`)・`reports.messageId`(`text("message_id", { length: 26 })`・null可)・索引`reports_reporter_latch_id_reportee_target_status_idx` on (reporter, latch_id, reportee, target, status)。`type ReportTarget = "proposal" | "profile" | "icon" | "message"`
- Produces(shared): `REPORT_REASONS`・`REPORT_TARGETS`(readonly配列)・`reportCreateRequestSchema`(zod: `{latch_id: string(26), target, reason, note?: string trim max(500), reportee_user_id?: string(26), message_id?: string(26)}`・`.strict()`)・`type ReportCreateRequest`・`blockDtoSchema`(`{user_id, display_name, has_icon, created_at}`)・`blockListResponseSchema`(`{blocks: BlockDTO[]}`)

- [ ] **Step 1: 失敗する試験を書く** — `migration.test.ts`に既存の0005と同じ形で「0006適用後にreportsへtarget・message_idがあり、0006_rollbackでtarget・message_id・索引が消える」を追加。`schema.test.ts`に`reportCreateRequestSchema`の受理(target=proposalでnote無し)・拒否(note 501字・未知のtarget・未知のキー)と、noteの前後空白が除かれる(`"  あ  "`→`"あ"`)ことを追加
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/migration.test.ts` と `pnpm --filter @latch/shared exec vitest run src/schema.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — schema.tsのreportsへ列と索引を足し、`pnpm --filter worker exec drizzle-kit generate`で生成してファイル名を`0006_report_target.sql`に揃える。既存行は無いためtargetのNOT NULLに既定値は付けない(生成SQLがテーブル再作成になる場合もそのまま使う)。rollbackは列と索引を落とす(0005_rollbackと同じ書き方)。sharedへ定数とスキーマを追加
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS。あわせて `pnpm --filter worker exec wrangler d1 migrations apply DB --local` が成功
- [ ] **Step 5: コミット** — `git add apps/worker/src/db/schema.ts apps/worker/migrations/0006_report_target.sql apps/worker/migrations/meta apps/worker/migrations_rollback/0006_rollback.sql apps/worker/migrations_rollback/README.md apps/worker/tests/migration.test.ts packages/shared/src/schema.ts packages/shared/src/constants.ts packages/shared/src/schema.test.ts` → `F7a: 通報の対象を記録するマイグレーション0006と共有スキーマを追加する`

### Task 2: 提案直前のブロック照合(`proposeSet`)と提案取り消しの切り出し

**Files:**
- Modify: `apps/worker/src/latches/propose.ts`(`secured`の条件)
- Create: `apps/worker/src/latches/cancel-open.ts`
- Modify: `apps/worker/src/routes/intents.ts`(`cancelOpenLatchesOf`・`proposeNextGroupsAfterCancel`を新ファイルの関数へ置き換える)
- Modify: `apps/worker/src/latches/hide.ts`(`wasMatched`をexport)
- Test: `apps/worker/tests/latches-propose.test.ts`

**Interfaces:**
- Produces: `cancelOpenLatches(db: DrizzleD1Database, latchIds: string[], actorUserId: string, now: Date): Promise<string[]>` — 渡されたLATCHのうちcandidate・proposed・partial_acceptのものを`closeLatch(..., "cancelled", { kind: "release" }, [...], now)`で閉じ、閉じた参加者のうち`actorUserId`以外の保留を`releaseHeld`で解放し、閉じたidを返す(現在の`cancelOpenLatchesOf`の本体から「Intentを含むLATCHの照会」を外したもの)
- Produces: `openLatchIdsOfIntent(db, intentId: string): Promise<string[]>`(現在の照会部分)・`proposeNextGroupsAfterCancel(db, closedLatchIds: string[], now: Date): Promise<void>`(routes/intents.tsから移す)
- Produces: `wasMatched(db, latchId: string): Promise<boolean>`(hide.tsからexport・中身は変えない)

- [ ] **Step 1: 失敗する試験を書く** — `latches-propose.test.ts`に「2人の間にblocks行(どちらの方向でも)があると`proposeSet`は`"skipped"`を返し、latches・latch_members・notificationsの行が作られず、proposal_historyの新規確保行が残らない(再提案の既存行はdeferred/expiredのまま)」を、1対1と3人集合(うち1ペアだけブロック)で追加
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/latches-propose.test.ts` / Expected: FAIL(提案が作られる)
- [ ] **Step 3: 実装** — `secured`を「確保数=ペア数 かつ `NOT EXISTS (SELECT 1 FROM blocks WHERE (blocker_user_id, blocked_user_id) IN (各ペアの両方向))`」にする(`notSecured`は`NOT (secured)`のまま。巻き戻しはこれで働く)。`cancel-open.ts`へ切り出し、routes/intents.tsの呼び出し2か所(削除・PATCH)を`cancelOpenLatches(db, await openLatchIdsOfIntent(db, id), sub, now)`に置き換える
- [ ] **Step 4: 通過を確認** — Run: `pnpm --filter worker exec vitest run tests/latches-propose.test.ts tests/intents-crud-api.test.ts tests/intents-lifecycle-api.test.ts tests/latches-group.test.ts` / Expected: PASS(既存の削除・PATCHの取り消し試験も緑)
- [ ] **Step 5: コミット** — 変更ファイルを列挙して`git add` → `F7a: 提案直前にブロックを照合し、進行中の提案の取り消しを共通化する`

### Task 3: ブロック(`src/safety/block.ts`・ルート)

**Files:**
- Create: `apps/worker/src/safety/block.ts`・`apps/worker/src/routes/safety.ts`
- Modify: `apps/worker/src/index.ts`(`app.route("/v1", safetyRoutes)`)
- Test: `apps/worker/tests/safety-block.test.ts`(登録・`call`の補助は`tests/latches-delete.test.ts`と同じものを複製する慣習に従う。LATCH・membersは直接INSERTで配置)

**Interfaces:**
- Consumes: `cancelOpenLatches`・`proposeNextGroupsAfterCancel`・`wasMatched`(Task 2)・`leave`(`src/latches/respond.ts`)・`closedTargetsAfterLeave`(`src/latches/hide.ts`)・`notifyClosed`(`src/chat/notify.ts`)
- Produces:
  - `type BlockOutcome = { ok: true; created: boolean; leftLatchIds: string[] } | { ok: false; reason: "not_found" | "self_block" }`
  - `blockUser(db, blockerId: string, targetId: string, now: Date): Promise<BlockOutcome>`
  - `unblockUser(db, blockerId: string, targetId: string): Promise<void>`
  - `listBlocks(db, blockerId: string): Promise<BlockDTO[]>`(新しい順。相手がdeletedなら`display_name="つながっていた相手"`・`has_icon=false`)
  - ルート: `POST /v1/users/:user_id/block`(201/200・本文なし)・`DELETE /v1/users/:user_id/block`(204)・`GET /v1/blocks`(200 `BlockListResponse`)。いずれも`requireRegistered`

`blockUser`の順序: (1) 自分なら`self_block` (2) 相手がstatus=activeで、2人がともにlatch_membersに居るLATCHのうち状態がmatched・completed、またはcancelledかつ`wasMatched`のものが1件以上無ければ`not_found` (3) blocks行をINSERT(PK衝突は何もしない。`created`はINSERTの行数) (4) 2人がともに参加者のcandidate・proposed・partial_acceptのLATCHを集めて`cancelOpenLatches(db, ids, blockerId, now)`→`proposeNextGroupsAfterCancel` (5) 2人がともにleft_atなしで参加するmatchedのLATCHごとに`leave(db, id, blockerId, now)`し、成功したidを`leftLatchIds`へ。ルートは`leftLatchIds`ごとに`notifyClosed(env, id, await closedTargetsAfterLeave(db, id, sub))`

- [ ] **Step 1: 失敗する試験を書く** — `safety-block.test.ts`に次を追加
  ① 自分=400(`reasons: ["self_block"]`)/成立前の提案だけを共有する相手・存在しないid・deletedの相手=404/matched・completed・matched経由のcancelledを共有する相手=201
  ② 進行中の提案の取り消し: 2人を含む提示済みの1対1(proposed)・提示前(candidate・保留)・3人のpartial_acceptがcancelledになり、proposal_historyの新規確保行が消える。提示済みだった提案の第三者にclosedのnotifications行があり、提示前の提案ではclosed行が作られない
  ③ 1対1のmatched→cancelled、両者のleft_atがnullのまま、ブロックされた側の`GET /v1/latches/{id}`が200でstatus=cancelled・`GET /v1/latches/{id}/messages`が200
  ④ 3人matchedでCをブロックしたA: Aだけleft_atを持ちLATCHはmatchedのまま(participants.min=2)。min=3なら全体cancelled
  ⑤ 3人matchedでCが既にleft_at済みのときAがCをブロック: Aは抜けない
  ⑥ completedを共有する相手のブロック: LATCHの状態・left_atは変わらない
  ⑦ `GET /v1/blocks`の並びとdeleted相手の表示名、`DELETE`の冪等(2回とも204)と解除後に行が無いこと
  ⑧ 再送: blocks行だけを直接INSERTした状態(効果の適用前に失敗した状況の再現)でPOSTすると200が返り、②・③の効果が適用される
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/safety-block.test.ts` / Expected: FAIL(404 route)
- [ ] **Step 3: 実装** — 上の順序で`block.ts`、ルートを`safety.ts`に書き、index.tsへマウント。照会は`latch_members`の自己結合で行う(48件チャンクは不要: 1人の相手との共有LATCHに限られる)
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git add apps/worker/src/safety/block.ts apps/worker/src/routes/safety.ts apps/worker/src/index.ts apps/worker/tests/safety-block.test.ts` → `F7a: ブロックのAPIと即時効果を追加する`

### Task 4: 通報(`src/safety/report.ts`・ルート・dev観測API)

**Files:**
- Create: `apps/worker/src/safety/report.ts`
- Modify: `apps/worker/src/routes/safety.ts`(`POST /v1/reports`)・`apps/worker/src/routes/dev.ts`(`GET /v1/dev/reports`・既存の`hideWhenDisabled`+`requireRegistered`)
- Test: `apps/worker/tests/safety-report.test.ts`・`apps/worker/tests/dev-observe-api.test.ts`

**Interfaces:**
- Consumes: `reportCreateRequestSchema`(Task 1)・`wasMatched`(Task 2)
- Produces:
  - `type ReportOutcome = { ok: true } | { ok: false; reason: "not_found" } | { ok: false; reason: "invalid"; reasons: string[] }`
  - `createReport(db, reporterId: string, input: ReportCreateRequest, now: Date): Promise<ReportOutcome>`
  - 形の理由コード: `reportee_not_allowed`・`message_not_allowed`(proposalで指定)・`reportee_required`(成立後で未指定)・`message_required`(message で未指定)・`message_not_allowed`(profile/iconで指定)
  - ルート: 201 `{received: true}`
  - dev: `GET /v1/dev/reports` → 200 `{reports: [{id, reportee, latch_id, target, reason, note, message_id, status, created_at}]}`(reporter=本人の行だけ・created_at降順。prodは404)

`createReport`の判定: target=proposal → 本人がlatch_membersに居てLATCHがproposed・partial_acceptでなければnot_found、自分以外の全参加者についてreportee行を統合保存。成立後 → 本人がleft_atなしの参加者でLATCHがmatched・completed・(cancelledかつ`wasMatched`)でなければnot_found、reporteeが自分以外のメンバーでなければnot_found、messageは`messages`のid・latch_id・user_id=reporteeが一致しなければnot_found。統合: 同じreporter・latch_id・reportee・target・message_id(nullはIS NULL)でstatus=openの行があればreason・note・created_atをUPDATE、無ければINSERT(id=ULID・status=open)

- [ ] **Step 1: 失敗する試験を書く** — `safety-report.test.ts`に
  ① 3人のproposed提案をAがtarget=proposalで通報→B・Cの2行(reason・note・target・latch_id)、LATCHの状態は不変、応答本文は`{received: true}`だけ
  ② candidate(提示前)・matchedのLATCHへのtarget=proposal・非参加のLATCH=404
  ③ 成立後のprofile/icon/message: reportee必須・message_id必須/不可の400と理由コード
  ④ message_idが別の人の発言・別LATCHの発言=404。reporteeが自分・非メンバー=404
  ⑤ 同じ通報の再送で行が1件のまま、reason・noteが上書きされる。statusをresolvedにした後の再送は新しい行
  ⑥ 通報後、被通報者の`GET /v1/latches/{id}`・`GET /v1/latches`の応答本文に通報に関する値が無い(JSON文字列に`report`を含まない)
  を追加。`dev-observe-api.test.ts`に`GET /v1/dev/reports`が本人の行だけを返すことを追加
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/safety-report.test.ts tests/dev-observe-api.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — 上の判定で`report.ts`、ルート、dev APIを書く
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS
- [ ] **Step 5: コミット** — 変更ファイルを列挙して`git add` → `F7a: 通報のAPIとdev専用の観測APIを追加する`

### Task 5: 飲酒年齢の判定(#30)

**Files:**
- Modify: `apps/worker/src/intents/validation.ts`・`apps/worker/src/pipeline/layer1.ts`(`LEGAL_DRINKING_AGE`をexport)・`apps/worker/src/routes/intents.ts`(POSTのactive作成・PATCHのdraft→active)
- Test: `apps/worker/src/intents/validation.test.ts`・`apps/worker/tests/intents-create-api.test.ts`・`apps/worker/tests/intents-lifecycle-api.test.ts`

**Interfaces:**
- Produces: `isAlcoholRestricted(f: { form: IntentForm | null; alcoholInvolved: boolean }, birthDate: string, now: Date): boolean` — form=occasion かつ alcoholInvolved かつ `ageAtYears(now, birthDate) < LEGAL_DRINKING_AGE`

判定位置: POSTでstatus=activeのとき・PATCHでdraft→activeのとき、`validateIntentForActive`の400の後・ACTIVE_INTENT_LIMITの前。本人のbirth_dateは`users`から読む。activeのPATCHはalcohol_involvedを変えられない(可変フィールド外)ため判定しない(設計書§4の(c)は現行の可変範囲では生じない。文書更新時に§4へ注記する)。拒否時のログは`logger.warn("intents.create.rejected", { error_code: "ALCOHOL_RESTRICTED" })`(PATCHは既存の対応するイベント名)

- [ ] **Step 1: 失敗する試験を書く** — validation.test.tsに`isAlcoholRestricted`の表(occasion+飲酒+19歳=true / 20歳=false / connection=false / 飲酒なし=false)。API試験に① 19歳で飲酒の機会IntentをPOST(active)→422 `ALCOHOL_RESTRICTED`・draftのPOSTは201 ② 誕生日当日に満20歳=201・前日=422(注入しないsystemClockの現在日から誕生日を逆算して登録する) ③ 19歳のdraftをPATCHでactiveへ→422・行はdraftのまま ④ 5件上限かつ19歳の飲酒→422 ALCOHOL_RESTRICTED(上限より先)
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run src/intents/validation.test.ts tests/intents-create-api.test.ts tests/intents-lifecycle-api.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装** — 関数を追加し、ルートの2か所へ挿入
- [ ] **Step 4: 通過を確認** — Step 2のコマンド / Expected: PASS
- [ ] **Step 5: コミット** — 変更ファイルを列挙して`git add` → `F7a: 20歳未満の飲酒を含む機会Intentの有効化を拒否する`

### Task 6: #26〜#30のworker E2E(`e2e/safety.spec.ts`)

**Files:**
- Create: `apps/worker/e2e/safety.spec.ts`
- Modify: `apps/worker/e2e/helpers.ts`(`registerUser(request, displayName?, birthDate = "2000-01-01")`)

**Interfaces:**
- Consumes: `registerUser`・`createIntent`・`runCron`・`waitForLatch`・`respond`・`listDevLatches`(既存)、`GET /v1/dev/match-events`・`GET /v1/dev/reports`

- [ ] **Step 1: 試験を書く** — 各testの名前は番号で始める
  - `#26`: AとBを1対1で成立させ、AがBをブロック→Bの`GET /v1/latches/{id}`がstatus=cancelled。A・Bに一致する新しいIntentを置いて評価が終わるまで待ち、Bの新しいIntentのmatch_eventsのpayloadの`l1_exclusions.blocked`が1以上・A-B間のLATCHが新たに作られない(成立による恒久排除より先にブロックで除外される記録で証明する。成立済みのペアは履歴でも除外されるため、候補が出ないことだけでは証明にならない)
  - `#27`: 提示済み提案をtarget=proposalで通報(201)と、成立後にBの発言をtarget=messageで通報(201)し、`GET /v1/dev/reports`に2件(target・reason・latch_id・reportee)
  - `#28`: 提示済みの提案を相手側で一覧・単一取得し、応答のJSON文字列に自分のIntentのraw_textの文・negative_constraintsの語が含まれず、`proposal`・`members`が無い
  - `#29`: 地理つきの機会Intentどうしを成立させ、相手側の`proposal.region_name`が文字列で、応答のJSONに`lat`・`lng`・`radius_m`・`distance`のキーが無い
  - `#30`: 現在日から19歳になる生年月日で登録したユーザーの飲酒の機会Intent→422 `ALCOHOL_RESTRICTED`、20歳のユーザーは201
- [ ] **Step 2: 実行** — Run: `pnpm --filter web build && pnpm --filter worker test:e2e` / Expected: 新規5本を含め全本PASS(従来39本+5本)
- [ ] **Step 3: コミット** — `git add apps/worker/e2e/safety.spec.ts apps/worker/e2e/helpers.ts` → `F7a: #26〜#30のworker E2Eを追加する`

### Task 7: 文書の更新とゲートの記録

**Files:**
- Modify: `docs/01-requirements.md`(冒頭の決定記録へ設計書§0.3の裁定2〜4)・`docs/05-data-model-api.md`(§2.2 reports・§3.2のブロック/通報API・§3.3の応答形状と判定・マイグレーション0006と戻す手順)・`docs/08-privacy-safety.md`(§8: ブロックされた側のNOT_FOUNDの撤回・グループの扱い・提案段階の通報の対象者・通報者内の統合)・`docs/10-test-env-nfr.md`(§4: F7aのゲート試験の分担)・`docs/12-development-roadmap.md`(§2: F7の3分割の決定記録=裁定1・F7aの完了・#26〜#30の証明)・`docs/00-document-roadmap.md`(§1の版数表)・`AGENTS.md`(現在の状態へF7aの完了)・`docs/superpowers/specs/2026-10-21-f7a-safety-api-design.md`(§4の(c)の注記・§5.1の#26を除外記録`l1_exclusions.blocked`による証明へ直す・§1と§2.2の順次適用は修正済み)

- [ ] **Step 1: 更新** — docs/00 §3の規則に従い、変更した文書の版数を上げ、冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える。数値(note 500字・満20歳)と用語を文書横断で一致させる
- [ ] **Step 2: 確認** — Run: `rg -n "NOT_FOUND" docs/08-privacy-safety.md`(ブロックされた側の記述が残っていない)・`pnpm lint` / Expected: 該当なし・緑
- [ ] **Step 3: コミット** — 変更した文書を列挙して`git add` → `F7a: 安全のAPIの完了とオーナー裁定を文書へ記録する`
