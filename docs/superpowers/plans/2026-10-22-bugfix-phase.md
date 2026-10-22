# 不具合の修正工程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GitHubのissue #2〜#10を直してstagingで確かめ、そのうえでF8bで延期した負荷試験の全規模の計測と報告書(02 §4 #33)を仕上げる。

**Architecture:** 評価の流れは「第1段がベクトルをメッセージに載せて第2段を即時に投入し、別に遅延付きの反映確認イベントを投入する。反映を確かめたら30分抑制の例外として1回だけ評価し直す」に改める(設計書 §2)。#8は原因が未特定のため、最初にstagingで調べる。web側の修正(#2・#4・#6)と設定値の修正(#3)は互いに独立している。

**Tech Stack:** TypeScript・Cloudflare Workers(Hono・D1・Queues・Vectorize)・drizzle・vitest(@cloudflare/vitest-pool-workers)・React 19・Playwright・k6(tools/load)

**Spec:** `docs/superpowers/specs/2026-10-22-bugfix-phase-design.md`

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。コメントは「docs/NN §x」で根拠を参照する慣習に合わせる
- コミットは`git add <パス>`で対象を限定する(`git add -A`・`git commit -a`は禁止)。作業はmainで直接行う
- コミットメッセージの末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 用語: 「Layer 2 Candidate Retrieval」(「Vector Search」と呼ばない)・「アプリ内通知」・「機会Intent」「つながりIntent」。数値の単位は「p95 0.5秒」の形式
- 旧実装・旧リポジトリへの言及をしない
- stagingのURL・アカウントIDは文書・設定・コミット・報告書・issue・ログの貼り付けに書かない。URLはgit管理外の`.superpowers/sdd/2026-10-22-f8b-staging-load-test/staging-url`から読む。k6は必ず`tools/load/run.mjs`経由で実行する
- Cloudflareの資源の新規作成・削除は事前にオーナーの承認を取る。stagingへのデプロイとstagingのD1のマイグレーションは承認済み。stagingのシークレットの登録し直しは承認が要る(Task 11)
- 本工程で新しく見つけた不具合は直さずにまず`gh issue create`で登録し、コントローラーへ報告する
- ログは`src/logging/logger.ts`の許可リスト方式。新しい項目名を出すなら許可リストへ足す(個人情報は出さない)
- 各タスクの終わりに `pnpm lint && pnpm typecheck && pnpm test` が緑であること(web E2E・worker E2Eを触るタスクはそのE2Eも)
- docsを変えるときは00 §3の運用(版数を上げ・冒頭へ変更点行・前提文書欄と00 §1の版数表を揃える)

## Review Focus

1. 反映確認の待ちのあいだに意思が直された(versionが進んだ)とき: 古い版の反映確認は`stale_version`で終わり、古いベクトル(metadataのversionが古い)を「反映した」と誤らない → Task 3の試験
2. 反映確認の待ちのあいだに意思が一時停止・削除されたとき: 評価せず`skipped`で終わる → Task 3の試験
3. デプロイの切り替わりで`vector`の無い`embedding_completed`のメッセージが届いたとき: 従来どおり`getByIds`で評価する(失敗しない) → Task 2の試験
4. 即時の評価で提案済みの組が、反映後の評価し直しで二重に提案されない → Task 3の試験
5. refreshが中継の400(LATCHのエラー形式でない本文)を受けたとき: セッションを残す → Task 6の試験

---

### Task 1: #8 直した意思の再評価の失敗の原因を突き止めて直す

**Files:**
- 調査で決まる(原因の箇所と、その試験)
- 記録: GitHub issue #8 へコメント

**Interfaces:**
- Consumes: なし(現在のmainのコードとstaging)
- Produces: 原因の記録。原因が評価の流れの作り替え(Task 2・3)と重なる場合は、直さずにコントローラーへ報告する(Task 2・3の実装者へ申し送る)

superpowers:systematic-debuggingに従う。

- [ ] **Step 1: stagingで提案のある状態を作る** — 負荷試験の道具と同じ規則の試験用利用者(subject `load-<runId>-x<連番>`・runIdは12桁の数字)を2人作る。dev専用サインイン(`POST /v1/dev/idp-token`→`POST /v1/auth/token`→`POST /v1/users`)のあと、同じ主題のつながりIntentを2件`status=active`で保存する。#7のため提案はCronのバックフィル経由で約5〜9分後にできる。stagingのD1で`latches`に2人の行ができたことを確かめる。URLは`staging-url`のファイルから読み、出力に出さない
- [ ] **Step 2: 失敗を観察する** — `pnpm --filter worker exec wrangler tail --env staging --format json`を流しながら、片方のIntentの主題をPATCHで変える。`pipeline.stage2.failed error_code=INTERNAL`と、新しいversionの`embedding_completed`が`failed`になることを確かめる
- [ ] **Step 3: 例外の中身を見る** — 例外の文が出なければ、`consumer.ts`の第2段の`catch`に、例外の名前と`message`の先頭200字・`stack`の先頭5行を出す一時的な`console.error`を足し、`pnpm --filter worker deploy:staging`でstagingへだけ入れて、Step 2を繰り返す。この変更はコミットしない
- [ ] **Step 4: 一時的な変更を戻す** — 作業ツリーを戻し(`git checkout -- <パス>`)、`pnpm --filter worker deploy:staging`でmainのコードに戻す
- [ ] **Step 5: 原因を手元の試験で再現する** — 原因に合う試験を書き(置き場所は原因の箇所の既存の試験ファイル)、失敗を確かめる。Vectorizeでしか起きない振る舞い(反映の遅れ・古いベクトルの残りなど)が原因なら、Task 2のインメモリVectorStoreの差し替え口(`holdMemoryVectorWrites`)が要るので、Step 6へ進まずにコントローラーへ報告する
- [ ] **Step 6: 直して試験を通す** — Run: `pnpm --filter worker exec vitest run <試験ファイル>` / Expected: PASS。あわせて`pnpm lint && pnpm typecheck && pnpm test`
- [ ] **Step 7: 後始末と記録** — 手順書 §7.4のとおり`LATCH_LOAD_BASE_URL="$(cat .superpowers/sdd/2026-10-22-f8b-staging-load-test/staging-url)" node tools/load/cleanup.mjs`で試験用の利用者の意思を消す(`load-`で始まる利用者を全員拾う。引数は取らない)。issue #8へ原因・直し方(またはTask 2・3への申し送り)をコメントする。URL・個人情報は書かない
- [ ] **Step 8: コミット** — `不具合修正: 直した意思の再評価が失敗する原因を直す(#8)`

### Task 2: 第1段は待たずに第2段へベクトルを渡す(#7の前半)

**Files:**
- Modify: `packages/shared/src/constants.ts`(`MatchQueueMessage`・`MATCH_EVENT_TYPES`・`PIPELINE`)・`packages/shared/src/constants.test.ts`
- Modify: `apps/worker/src/vectorstore/types.ts`・`vectorize.ts`・`memory.ts`(・`memory.test.ts`)
- Modify: `apps/worker/src/pipeline/events.ts`・`consumer.ts`・`evaluate.ts`
- Test: `apps/worker/tests/pipeline-consumer.test.ts`・`apps/worker/tests/pipeline-evaluate.test.ts`

**Interfaces:**
- Produces(shared): `MatchQueueMessage = { event_id: string; vector?: number[] }`。`MATCH_EVENT_TYPES`に`"vector_reflection"`を足す。`PIPELINE.EMBED_CONFIRM_INTERVAL_MS`・`EMBED_CONFIRM_TIMEOUT_MS`を削除し、`REFLECTION_DELAYS_S: [2, 4, 8, 16, 30]`・`REFLECTION_GIVE_UP_MS: 5 * 60_000`を足す
- Produces(vectorstore): `StoredVector.metadata.version?: number`(Vectorizeへは数値で書き、読み出しで復元する。不在はundefined)。試験専用の`holdMemoryVectorWrites(): void`・`releaseMemoryVectorWrites(): void`(`memory.ts`から直接export・index.tsからは再exportしない。hold中のupsertは保留され、`query`・`getByIds`から見えない。release・`resetMemoryVectorStore`で反映/破棄)
- Produces(events): `EmitMatchEventOptions`に`vector?: number[]`を足し、送るメッセージを`{ event_id, vector }`にする。`sendToMatchQueue(env, eventId, opts)`をexportする(Task 3の送り直しで使う)
- Produces(evaluate): `EvaluateOptions = { jev?; vector?: number[]; ignoreSuppression?: boolean }`。`vector`があれば`getByIds`で自分のベクトルを読まずにLayer 2 Candidate Retrievalへ使う。`ignoreSuppression`はこのタスクでは型と分岐だけ足す(Task 3で使う)
- Produces(consumer): `runEmbeddingStage`は反映確認の待ち(`waitUntilReflected`)を持たない。upsertのmetadataへ`version: intent.version`を載せ、`embedding_completed`を`vector`付きで即時に投入する。`consumeEvent(env, eventId, clock, vector?: number[])`で、第2段は`evaluateIntent(env, id, clock, { vector })`を呼ぶ。第2段のpayloadの組み立てを`stage2Payload(result: Stage2Result): Record<string, unknown>`へ切り出す(Task 3で再利用)

- [ ] **Step 1: 失敗する試験を書く**
  - `pipeline-consumer.test.ts`: 既存「Embedding→upsert→反映確認→…」を改め、`holdMemoryVectorWrites()`の状態でも第1段がprocessedになり、`MATCH_QUEUE.send`が`{ event_id, vector }`(vectorは`stubEmbedding`の値と一致)で呼ばれ、upsertしたmetadataに`version: 1`があること
  - `pipeline-consumer.test.ts`「embedding_completedはメッセージのvectorで評価し、getByIdsを呼ばない」: `memoryVectorStore().getByIds`をspyし、vector付きのメッセージで第2段を回して呼ばれないこと・起点がprocessedでpayloadに`retrieval_count`があること
  - `pipeline-consumer.test.ts`「vectorの無いembedding_completedは従来どおりgetByIdsで評価する」(Review Focus 3)
  - `pipeline-evaluate.test.ts`「options.vectorで照会し、ストアに自分のベクトルが無くても評価する」: 自分のベクトルをupsertせず、相手のベクトルだけ置いて`evaluateIntent(..., { vector })`が`null`でなく`retrievalCount >= 1`
  - `memory.test.ts`: hold中のupsertは`getByIds`・`query`で見えず、releaseで見える
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter worker exec vitest run tests/pipeline-consumer.test.ts tests/pipeline-evaluate.test.ts src/vectorstore/memory.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — Interfacesのとおり。`handleMainQueueBatch`は`message.body.vector`が数値の配列のときだけ`consumeEvent`へ渡す。Cronのバックフィル(`emitCompleted: false`)の呼び方は変えない
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS。続けて `pnpm lint && pnpm typecheck && pnpm test`
- [ ] **Step 5: コミット** — `不具合修正: 第1段は反映を待たず第2段へベクトルを渡す(#7)`

### Task 3: 反映確認のイベントと評価し直し・(h)の抑制の例外(#7の後半・#10)

**Files:**
- Create: `apps/worker/src/pipeline/reflection.ts`(反映確認の消費と遅延の計算)
- Modify: `apps/worker/src/pipeline/consumer.ts`(`vector_reflection`の振り分け・第1段からの投入)・`evaluate.ts`(`ignoreSuppression`)・`cron.ts`((h))
- Test: Create `apps/worker/tests/pipeline-reflection.test.ts`・`apps/worker/src/pipeline/reflection.test.ts`。Modify `apps/worker/tests/pipeline-cron.test.ts`

**Interfaces:**
- Consumes: Task 2の`sendToMatchQueue`・`EvaluateOptions`・`stage2Payload`・`holdMemoryVectorWrites`/`releaseMemoryVectorWrites`・`PIPELINE.REFLECTION_*`
- Produces: `nextReflectionDelaySeconds(elapsedMs: number): number | null`(純粋関数)。確認の時点は作成から2・6・14・30秒、以後30秒ごとで、次の時点までの秒数(切り上げ・最小1)を返す。`elapsedMs >= REFLECTION_GIVE_UP_MS`ならnull
- Produces: `consumeReflectionEvent(env: Env, event: MatchEventRow, clock: Clock): Promise<void>`(設計書 §2.3の1〜5)。payloadは`stage2Payload(result)`に`reflect_ms`(作成から反映を確かめた時点までのミリ秒)を足したもの。打ち切りは`failed`(ログ`pipeline.reflection.timeout`・`error_code=REFLECTION_TIMEOUT`)
- Produces: `runEmbeddingStage`はupsertと`embedded_at`の更新の後に`vector_reflection`(同version・`delaySeconds: REFLECTION_DELAYS_S[0]`)を投入する(`emitCompleted: false`でも投入する)。この投入の失敗はログを出して握り、第1段の結果を`failed`にしない

- [ ] **Step 1: 失敗する試験を書く**
  - `reflection.test.ts`: `nextReflectionDelaySeconds`が 0→2・2_000→4・6_000→8・14_000→16・30_000→30・45_000→15・60_000→30・299_000→1・300_000→null
  - `pipeline-reflection.test.ts`(`handleQueueBatch`を直接呼ぶ。キューの送信は`vi.spyOn(MATCH_QUEUE, "send")`で捕まえる):
    - 「未反映なら同じevent_idを次の遅延で送り直し、行はpendingのまま」
    - 「作成から5分を過ぎて未反映ならfailed」
    - 「metadataのversionが古いベクトルは未反映とみなす」(Review Focus 1)
    - 「versionが進んでいればstale_versionでprocessed・評価しない」(Review Focus 1)
    - 「pausedや削除済みならskippedでprocessed・評価しない」(Review Focus 2)
    - 「反映済みなら30分抑制の内側でも1回評価し、payloadにreflect_msと第2段の項目が載る」
    - 「同時に預けた2件: hold中に両方の第1段・第2段を回すと提案は無く、release後に反映確認を回すと2人の提案が1件できる」
    - 「即時の評価で提案済みの組は、評価し直しで二重に提案されない」(Review Focus 4)
    - 「第1段は`vector_reflection`を遅延2秒で投入する」
  - `pipeline-cron.test.ts`: 既存の遅延再評価の試験の`lastEvaluatedAt`を`BASE - 10 * MIN`(埋め込みの直後に評価済みという通常の状態)に改め、評価されて`lastEvaluatedAt`が`FIXED_NOW`になること(#10)
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter worker exec vitest run tests/pipeline-reflection.test.ts src/pipeline/reflection.test.ts tests/pipeline-cron.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — Interfacesのとおり。`evaluateIntent`は`ignoreSuppression`のとき30分抑制の判定だけを飛ばす(active・formの判定は残す)。(h)の`runDelayedReevalSweep`は`evaluateIntent(env, row.id, clock, { ignoreSuppression: true })`を呼ぶ
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS。続けて `pnpm lint && pnpm typecheck && pnpm test`。web をビルドしてから `pnpm --filter worker test:e2e` / Expected: 47本PASS
- [ ] **Step 5: コミット** — `不具合修正: 反映を確かめてから1回評価し直し、遅延再評価を抑制の例外にする(#7・#10)`

### Task 4: 負荷試験の集計に反映時間を足す

**Files:**
- Modify: `tools/load/lib/queries.mjs`・`tools/load/report.mjs`
- Test: `tools/load/lib/queries.test.mjs`・`tools/load/report.test.mjs`

**Interfaces:**
- Consumes: Task 3の`vector_reflection`行のpayload`reflect_ms`
- Produces: `buildQueries(runId)`の戻り値に`reflection`(実行の印の(b)(d)の利用者のIntentの`vector_reflection`行の`json_extract(payload, '$.reflect_ms')`と`status`)。`reflectionFromRows(rows): Array<number | null>`(processed以外・値の無いものはnull)。report.mjsの表に「Vectorizeの反映」の行(件数・欠け・p50・p95・最大)を足す

- [ ] **Step 1: 失敗する試験を書く** — `queries.test.mjs`: `buildQueries("202610221200").reflection`が`event_type = 'vector_reflection'`と(b)(d)の絞り込みを含む/`reflectionFromRows`が`[{status:"processed",reflect_ms:1200},{status:"failed",reflect_ms:null}]`→`[1200, null]`。`report.test.mjs`: 表に「Vectorizeの反映」の行が出る
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter load exec vitest run` / Expected: FAIL
- [ ] **Step 3: 実装する** — 既存の`retrieval`の組み立てと同じ形で足す。01 §20に目標値が無い項目なので、合否は付けず実測だけを出す
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS
- [ ] **Step 5: コミット** — `不具合修正: 負荷試験の集計にVectorizeの反映時間を足す(#7)`

### Task 5: Cronが評価して作った提案のWeb Pushをその場で送る(#9)

**Files:**
- Modify: `apps/worker/src/push/dispatch.ts`(`flushPush`)・`apps/worker/src/pipeline/cron.ts`(`runScheduledPipeline`)
- Test: `apps/worker/tests/push-flush.test.ts`・`apps/worker/tests/pipeline-cron.test.ts`

**Interfaces:**
- Produces: `flushPush(db, sender, clock, opts: { minAgeMs: number; createdFrom?: Date })`。`createdFrom`があれば`created_at >= createdFrom`の行だけを対象にする
- `runScheduledPipeline`は開始時に`const startedAt = clock.now()`を取り、`runIsolated("next_group", …)`の直後に`runIsolated("push_fresh", () => flushPush(drizzle(env.DB), pushSenderOf(env), clock, { minAgeMs: 0, createdFrom: startedAt }))`を呼ぶ。既存の`runPushSweep`(30秒以上・最後)は変えない

- [ ] **Step 1: 失敗する試験を書く** — `push-flush.test.ts`「createdFromより前の行は拾わない」。`pipeline-cron.test.ts`「Cronのバックフィルの評価で作られた提案の通知は、同じ実行の中で送信を試みる」(提案ができる2件を埋め込み未完了で置き、`runScheduledPipeline`の後に`type='proposal'`の行の`push_attempted_at`が入っている。LATCH_PUSH_MODEは既定stub)。既存の「runPushSweep: …20秒前はpendingのまま」が通り続けること
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter worker exec vitest run tests/push-flush.test.ts tests/pipeline-cron.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — Interfacesのとおり
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS。続けて `pnpm lint && pnpm typecheck && pnpm test`
- [ ] **Step 5: コミット** — `不具合修正: Cronが評価して作った提案のWeb Pushをその場で送る(#9)`

### Task 6: refreshでセッションを捨てるのはサーバーの明示の拒否だけにする(#4)

**Files:**
- Modify: `apps/web/src/auth/session.ts`(`performRefresh`・`RefreshOutcome`の説明コメント)
- Test: `apps/web/src/auth/session.test.ts`

**Interfaces:**
- 応答が`!response.ok`のとき、`rejected`は「401」または「400で本文のJSONの`error.code`が`"VALIDATION_FAILED"`」だけ。それ以外(404・408・429・5xx・本文が読めない400など)は`network_error`

- [ ] **Step 1: 失敗する試験を書く** — `session.test.ts`の`describe("authSession")`へ: 「restoreは中継の404ではlocalStorageのトークンを残す」「restoreは503ではトークンを残す」「restoreはLATCH形式でない400ではトークンを残す」(Review Focus 5)「restoreはLATCH形式の400(VALIDATION_FAILED)ではトークンを除去する」。既存の401の試験は通り続ける
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter web exec vitest run src/auth/session.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — Interfacesのとおり
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS。続けて `pnpm lint && pnpm typecheck && pnpm test`
- [ ] **Step 5: コミット** — `不具合修正: refreshが中継の404・5xxでセッションを捨てないようにする(#4)`

### Task 7: 通知の許可が未決のあいだは預けた画面から自動で移らない(#2)

**Files:**
- Modify: `apps/web/src/screens/Placed.tsx`
- Test: `apps/web/src/screens/Placed.test.tsx`

**Interfaces:**
- 自動遷移のタイマーは`askPush`が偽(granted・denied・unsupported)のときだけ張る。`AUTO_REDIRECT_MS`のコメントに「通知の枠を出す端末では張らない」を足す

- [ ] **Step 1: 失敗する試験を書く** — 既存「数秒後に自動でhomeへ進む」を、`permission()`が`"granted"`の条件に改める(`"denied"`でも進むことを同じ試験か別の試験で確かめる)。「通知の枠を出しているあいだ(permission=default)は4秒たっても自動で進まない」を足す
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter web exec vitest run src/screens/Placed.test.tsx` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS。続けて `pnpm lint && pnpm typecheck && pnpm test`。`pnpm --filter web test:e2e` / Expected: 18本PASS(預けた後の遷移に頼るE2Eがあれば、ボタンで進むよう直す)
- [ ] **Step 5: コミット** — `不具合修正: 通知の許可が未決のあいだは預けた画面から自動で移らない(#2)`

### Task 8: 試験用VAPIDの送信者をAppleが受け付ける値にし、prodで仮の送信者を拒む(#3)

**Files:**
- Modify: `apps/worker/scripts/lib/test-fixtures.mjs`(`vapidSubject`)・`apps/worker/vitest.config.ts`・`apps/worker/src/push/sender.test.ts`・`apps/worker/src/env.ts`(`assertEnvSafety`)・`docs/reports/f8a-pwa-device-check.md`(1-3)
- Test: `apps/worker/src/env.test.ts`

**Interfaces:**
- 試験用の値は`mailto:dev@example.com`
- `assertEnvSafety`(prod)は、`VAPID_SUBJECT`が`mailto:`で、@の後のドメインが`.invalid`で終わるか`example.com`・`example.org`・`example.net`(大文字小文字を区別しない)のとき`ENV_PLACEHOLDER_VAPID_SUBJECT: …`で投げる
- `env.test.ts`のprodの正常な値(現在`mailto:ops@example.com`)は`mailto:ops@latch.app`へ変える(試験の中だけの値・外へ送らない)

- [ ] **Step 1: 失敗する試験を書く** — `env.test.ts`: prodで`mailto:dev@latch.invalid`・`mailto:dev@example.com`・`mailto:x@EXAMPLE.ORG`は投げる/`mailto:ops@latch.app`は投げない/local・stagingでは`mailto:dev@example.com`でも投げない
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter worker exec vitest run src/env.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — Interfacesのとおり。`f8a-pwa-device-check.md`の1-3へ「`sub`に`.invalid`などの予約ドメインを使うとAppleが403 BadJwtTokenで拒否する。既定は`mailto:dev@example.com`」を足す
- [ ] **Step 4: 通ることを確かめる** — Run: Step 2と同じ / Expected: PASS。`node apps/worker/scripts/prepare-dev-vars.mjs`(既存の.dev.varsを上書きしない作りなら、生成結果の文字列を確かめる試験か目視)で`VAPID_SUBJECT=mailto:dev@example.com`。続けて `pnpm lint && pnpm typecheck && pnpm test`
- [ ] **Step 5: コミット** — `不具合修正: 試験用VAPIDの送信者をAppleが受け付ける値にする(#3)`

### Task 9: icon.svgに幅と高さを足し、マニフェストの警告が消えたことを確かめる(#6)

**Files:**
- Modify: `apps/web/public/icon.svg`
- Test: `apps/web/e2e/pwa-flow.spec.ts`(「ホーム画面追加の要件(manifestとアイコン)を満たす」)

**Interfaces:**
- `icon.svg`のルート要素に`width="512" height="512"`
- 試験はChromiumのCDPセッション(`page.context().newCDPSession(page)`)で`Page.getAppManifest`を呼び、`errors`に`icon.svg`を含むものと「square icons」を含むものが無いこと(screenshotsの警告はF10の判断のため検査しない)

- [ ] **Step 1: 試験を足して失敗を確かめる** — Run: `pnpm --filter web build && pnpm --filter web exec playwright test e2e/pwa-flow.spec.ts` / Expected: 足した検査がFAIL(警告3・4が出ている)。出なければ実際の`errors`の中身を記録してコントローラーへ報告する
- [ ] **Step 2: 直す** — `icon.svg`へ幅と高さを足す。それでも消えなければ、manifestのiconsからSVGを外す(`apps/web/vite.config.ts`のmanifest設定)
- [ ] **Step 3: 通ることを確かめる** — Run: Step 1と同じ / Expected: PASS。続けて `pnpm lint && pnpm typecheck && pnpm test`
- [ ] **Step 4: コミット** — `不具合修正: マニフェストのアイコンの警告を直す(#6)`

### Task 10: 文書を更新する

**Files:**
- Modify: `docs/06-matching-pipeline.md`(§2・§4・§7)・`docs/05-data-model-api.md`(§2.3)・`docs/04-system-architecture.md`(§4)・`docs/12-development-roadmap.md`(§2)・`docs/00-document-roadmap.md`(§1の版数表)・各文書の前提文書欄
- Modify: `docs/runbooks/staging.md`(§7.6・§7.7・§7.8の「不具合#7が直るまでは」の注記を、直した後の扱い(待ちの既定と反映の評価し直し・Vectorizeの反映の行)へ改める)

- [ ] **Step 1: 内容を反映する** — 設計書 §7の一覧どおり。12 §2の決定記録は「決定内容: 第1段はVectorizeへの反映を待たず、自分のベクトルを載せて第2段を即時に投入し、別に遅延付きの反映確認(2・6・14・30秒、以後30秒ごと・5分で打ち切り)で新しい版の反映を確かめたら30分抑制の例外として1回だけ評価し直す。(h)も抑制の例外とする/根拠: stagingの本物のVectorizeで反映が5秒の確認待ちを超え、新しい意思がCronの回収(約5〜9分後)でしか評価されなかった(issue #7)。待つだけでは前からいる相手との提案も反映時間だけ遅れ、待たないだけでは同時に預けた2人が互いを見落とす/影響: 06 §2・§4・§7・05 §2.3(metadataのversion・event_typeのvector_reflection)・負荷試験の集計(反映時間)」の形で書く(2026-10-22オーナー合意)。04 §4のrefreshの失敗時の扱いとprodの起動ガード(仮の送信者)を書き足す
- [ ] **Step 2: 版数を揃える** — 変更した文書ごとに版数を上げ変更点行を追記し、前提文書欄と00 §1の版数表を揃える。Run: `rg -n "文書バージョン: v" docs/0*.md docs/1*.md`で00 §1の表と突き合わせる
- [ ] **Step 3: 用語と数値を確かめる** — Run: `rg -n "upsert完了を確認してから|EMBED_CONFIRM|Vector Search|お知らせ" docs/0*.md docs/1*.md` / Expected: 新しい順序と食い違う記述・禁止の用語が無い(「お知らせ」は画面名の引用だけ)
- [ ] **Step 4: 確認** — Run: `pnpm lint && pnpm typecheck && pnpm test` / Expected: PASS
- [ ] **Step 5: コミット** — `不具合修正: 評価の流れの変更と修正を文書へ反映する`

### Task 11: stagingへ出して直ったことを確かめる(コントローラーが行う)

**Files:**
- 記録: issue #3・#7・#8・#9・#10へコメント(確かめられたら閉じる)

- [ ] **Step 1: シークレットの登録し直しの承認を取る** — オーナーへ`VAPID_SUBJECT`を`mailto:dev@example.com`へ登録し直すことの承認を求める
- [ ] **Step 2: 登録し直す** — Run: `printf 'mailto:dev@example.com' | pnpm --filter worker exec wrangler secret put VAPID_SUBJECT --env staging`(値だけを標準入力で渡す。他のシークレットは触らない)
- [ ] **Step 3: mainをGitHubへ送り、CIとstagingへのデプロイを待つ** — Run: `git push origin main`→`gh run watch` / Expected: ci・web-e2e・deploy-stagingが緑。スモーク(手順書の確認)が通る
- [ ] **Step 4: #7・#10を確かめる** — 試験用利用者(Task 1と同じ規則)で同じ主題のつながりIntentを2件ほぼ同時に預け、stagingのD1で: `embedding_completed`が数秒でprocessed/`vector_reflection`がprocessedで`reflect_ms`が入る/2人の提案ができる
- [ ] **Step 5: #8を確かめる** — 片方を直し、新しいversionの`embedding_completed`・`vector_reflection`がprocessed
- [ ] **Step 6: #9を確かめる** — Cron経由の提案(埋め込みを止めずに作るのは難しいため、反映確認の評価し直しかCronの評価でできた提案)の`push_attempted_at − created_at`が5秒以内。Cron経由の提案を作れなければ、その旨と単体試験で確かめた範囲をissueへ書く
- [ ] **Step 7: 後始末と記録** — Task 1 Step 7と同じ後始末。各issueへ結果(URLは書かない)を書き、確かめられたものを閉じる。#2・#4・#5・#6はオーナーの実機確認(設計書 §5.3)を依頼して開いたままにする(#6はTask 9の自動の試験で確かめたので閉じてよい)

### Task 12: F8b Task 10 負荷試験の全規模の計測と報告書

**Files:**
- Create: `docs/reports/f8b-load-test.md`
- Modify: `docs/02-scope-acceptance.md`(§4 #33)・`docs/12-development-roadmap.md`(§2)・`docs/00-document-roadmap.md`(§1の版数表・索引へ報告書)・`AGENTS.md`(現在の状態)・`.superpowers/sdd/2026-10-22-f8b-staging-load-test/progress.md`(git管理外)

- [ ] **Step 1: 実行して集計する** — 手順書`docs/runbooks/staging.md` §7のとおり、`LATCH_LOAD_BASE_URL`をファイルから読み、`RUN_ID`(12桁)を1つ決めて全シナリオで使う。順番は次のとおり。後始末で意思とその記録(match_events)が消えるため、(b)・(d)はそれぞれ**後始末の前に集計して結果をファイルへ残す**。各シナリオの前に、stagingのD1で`SELECT count(*) FROM match_events WHERE status='pending'`が0になるまで待つ。提案の待ちは`-e PROPOSAL_WAIT_SEC=300`(反映の評価し直しの分の余裕)
  1. `cleanup.mjs` → (a) → `cleanup.mjs`
  2. (b)(`MODE=staggered`) → `node tools/load/report.mjs $RUN_ID > tools/load/results/$RUN_ID-report-b.md` → `cleanup.mjs`
  3. (d)(`MODE=burst`・`--summary-export tools/load/results/$RUN_ID-d.json`) → `report.mjs`を`-report-d.md`へ → `cleanup.mjs`
  4. (c) → `report.mjs`を`-report-ac.md`へ((a)・(c)のk6の結果) → `cleanup.mjs`
- [ ] **Step 2: 集計の結果を確かめる** — 3つの表のファイルに、(a)のIntent保存・Parser、(b)(d)の初期判定・通知・Candidate Retrieval・Vectorizeの反映、(c)のチャットの値が出ていること。「—(欠けあり)」の行は手順書 §7.8の注記に従って理由を確かめる
- [ ] **Step 3: 報告書を書く** — F8bの計画のTask 10 Step 3の項目に、反映時間の分布と、本工程の修正(#7・#9)の後の計測である旨を足す。URL・アカウントIDは書かない
- [ ] **Step 4: 外れた項目と新しい不具合をissueへ登録する** — F8bの計画のTask 10 Step 4のとおり。番号を報告書に書く
- [ ] **Step 5: 文書を更新する** — 02 #33は「stubでの計測済み・LLM real接続後の測り直し待ち」(01冒頭の決定記録(stagingと負荷試験))。12 §2のフェーズ表のF8bと不具合の修正工程を完了にする。AGENTS.mdの「現在の状態」を、不具合の修正工程の完了・#33の状態・残り(#32の実機確認・#5)へ更新する。版数を揃える
- [ ] **Step 6: 確認** — Run: `pnpm lint && pnpm typecheck && pnpm test` / Expected: PASS
- [ ] **Step 7: コミット** — `F8b: 負荷試験の結果を記録する`
