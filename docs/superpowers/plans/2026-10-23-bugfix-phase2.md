# 不具合の修正工程(第2回) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** issue #15〜#26と#6の残り・#12を直し、stagingで原因と修正を確かめ、負荷試験を流し直して報告書を更新する。

**Architecture:** エラーの分類と段ごとの記録を最初に入れて、staging上で原因を切り分けられるようにする。そのうえで、毎分Cronの隔離、反映確認と修復の切り離し、第1段の段ごとの再試行、削除の書き戻しの防止と孤立したベクトルの自己修復、メッセージごとの通知の送出を入れる。初期判定の目標は「相手が先に反映済み」の場合に限る定義へ改め、負荷試験の(b)と集計をそれに合わせる。

**Tech Stack:** Cloudflare Workers(Hono)・D1(drizzle)・Queues・Vectorize・Analytics Engine・vitest(@cloudflare/vitest-pool-workers)・Playwright・k6(`tools/load/run.mjs` 経由)

**Spec:** docs/superpowers/specs/2026-10-23-bugfix-phase2-design.md

## Global Constraints

- 応答・コミットメッセージ・文書・コードのコメントは日本語。コミットは `git add <パス>` で対象を限定する(`git add -A`・`git commit -a` は禁止)。コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- mainで直接作業する。pushはコントローラーがオーナーの承認を取ってから行う(実装の担当はpushしない)
- レガシー実装への言及をしない。用語は AGENTS.md の「用語の統一」に従う(「Layer 2 Candidate Retrieval」・「アプリ内通知」・「p95 0.5秒」の形の単位)
- docsを変えたら docs/00 §3 に従い版数を上げ、冒頭に変更点行を足し、前提文書欄と 00 §1 の版数表を揃える。前提文書欄だけが変わる文書も「前提文書欄の同期のみの改版」で版数を上げる
- stagingのURL・CloudflareのアカウントIDは、文書・設定・コミット・issue・報告書に書かない。k6は必ず `tools/load/run.mjs` 経由で実行する
- Cloudflareの資源の作成・削除と、stagingのベクトルの手での削除は、事前にオーナーの承認を取る。stagingへのデプロイとstagingのD1のマイグレーションは承認済みの範囲
- ログは許可リスト方式(`apps/worker/src/logging/logger.ts`)。許可リストの項目は増やさず、`error_code`・`layer`・`latency`・`count`・`intent_id`・`version` の範囲で出す。個人情報・例外の文の中身は出さない
- キューの消費・Cronの走査は例外を外へ出さない(失敗は行のstatusとログに記録する)
- 新しく見つけた不具合は、直さずにまずGitHubのissueへ登録し、報告に書く
- 数値: `PIPELINE.REFLECTION_GIVE_UP_MS = 8 * 60_000`・`PIPELINE.REPAIR_GRACE_MS = 10 * 60_000`・`PIPELINE.STAGE1_RETRY_DELAYS_S = [10, 30, 60]`・`PIPELINE.ORPHAN_DELETE_MAX = 10`・`PIPELINE.VECTOR_GET_MAX = 20`・主キューの `max_batch_timeout = 1`
- 確認のコマンド: `pnpm lint`・`pnpm typecheck`・`pnpm test`。E2Eは `pnpm --filter web build` の後に `pnpm --filter worker test:e2e`、web E2Eは `pnpm --filter web test:e2e`(ポートが塞がっていたら `LATCH_E2E_PORT` で避ける)

## Review Focus

1. 再試行中のメッセージ(第1段の `retry`)が、10分の残留の掃査(`PENDING_STALE_MS`)より先に終わり、行を `failed` にされないこと(遅延10+30+60秒・`max_retries: 3`)→ Task 5の試験で、最後の再試行の時刻が10分より前であることを固定する
2. 意思を削除した直後に、Cronの修復・バックフィル・状態の同期・第1段のどれが動いても、ベクトルが書き戻されないこと → Task 6の試験で、各経路について「行を読んだ後・upsertの前に削除」を差し込む
3. 自己修復が、反映待ちの新しい意思のベクトル(D1に行はある)を消さないこと → Task 6の試験で、行のあるhitは消さないことを固定する
4. メッセージごとの通知の送出と、バッチの最後の送出が重なっても、同じ通知を2回送らないこと → Task 8の試験で送信の回数を固定する
5. 反映確認の打ち切りを8分にしたとき、最後の確認が残留の掃査(10分)より前に終わること → Task 4の試験で、`nextReflectionDelaySeconds` の積み上げの最後が8分30秒以内であることを固定する

---

### Task 1: エラーの分類と段ごとの記録

**Files:**
- Modify: `apps/worker/src/pipeline/errors.ts`
- Modify: `apps/worker/src/pipeline/consumer.ts`(第1段のログに `layer`・書いた経路の `layer`)
- Modify: `apps/worker/src/routes/intents.ts`(削除APIの段ごとの所要時間・ベクトル削除の失敗の分類)
- Test: `apps/worker/tests/pipeline-errors.test.ts`(新規)・既存の `tests/intents-crud-api.test.ts`

**Interfaces:**
- Produces: `errorCodeOf(error: unknown, fallback?: string): string`(シグネチャは変えず、分類を広げる)。後続の全Taskがこの分類を使う

- [ ] **Step 1: 失敗する試験を書く** — `pipeline-errors.test.ts` に次を置く
  - `new Error("VECTOR_GET_ERROR (code = 40007): too many ids")` → `"VECTOR_GET_40007"`
  - `new Error("VECTOR_UPSERT_ERROR (code = 40012): x")` → `"VECTOR_UPSERT_40012"`
  - `cause` に `new Error("D1_ERROR: D1 DB is overloaded. Requests queued for too long.")` を持つ `new Error("Failed query: delete from …")` → `"D1_OVERLOADED"`
  - `cause` に `new Error("D1_ERROR: no such table")` → `"D1_ERROR"`
  - `new Error("Queue send failed: …")` → `"QUEUE_SEND_FAILED"`
  - `new Error("3040: Capacity temporarily exceeded")` → `"AI_3040"`
  - `new TypeError("x")` → `"TypeError"`
  - 従来どおり `new Error("EMBEDDING_TIMEOUT: …")` → `"EMBEDDING_TIMEOUT"`、文字列や判定できないものは `fallback`
- [ ] **Step 2: 実行して落ちることを確かめる** — `pnpm --filter worker exec vitest run tests/pipeline-errors.test.ts`
- [ ] **Step 3: `errorCodeOf` を実装する** — `cause` を最大3段辿り、内側から順に上の規則で判定する。どれにも合わなければ従来の判定、それでもだめなら `fallback`。出すのは分類名だけ
- [ ] **Step 4: 第1段・削除APIの記録を足す**
  - `runEmbeddingStage` の失敗ログ `pipeline.stage1.failed` に `layer`(`embed`・`upsert`・`d1`・`emit`)を付ける。段の判定は各 `await` を別の `try` で包む(戻り値の形はTask 5で変える。ここではログだけ)
  - `pipeline.stage1.completed` に書いた経路の `layer`(`queue`・`backfill`・`repair`)を付ける。`runEmbeddingStage` の `options` に `source?: "queue" | "backfill" | "repair"`(既定 `queue`)を足し、Cronの2か所から渡す
  - 削除API: 段ごとに `logger.info("intents.delete.timing", { intent_id, layer, latency })`(`layer` は `vector`・`d1_children`・`d1_intent`)。`intents.delete.vector_failed` の `error_code` を `errorCodeOf(error)` にする
  - 既存の試験でログの形を固定しているものがあれば合わせる。削除APIの試験に「`intents.delete.timing` が3段出る」ことを足す
- [ ] **Step 5: 試験を通す** — `pnpm --filter worker exec vitest run tests/pipeline-errors.test.ts tests/intents-crud-api.test.ts tests/pipeline-consumer.test.ts`、続けて `pnpm lint`・`pnpm typecheck`
- [ ] **Step 6: コミット**(メッセージ例「不具合修正: エラーの分類と段ごとの記録を足す(#16・#17・#20の切り分け)」)

### Task 2: 計測の起点・結合の鍵・書き込みの隔離(#24)

**Files:**
- Modify: `apps/worker/src/pipeline/metrics.ts`・`apps/worker/src/pipeline/evaluate.ts`・`apps/worker/src/pipeline/reflection.ts`・`apps/worker/src/pipeline/consumer.ts`・`apps/worker/src/pipeline/cron.ts`
- Test: 既存の計測の試験(`rg -l writeStage2Metrics apps/worker/tests` で探す)

**Interfaces:**
- Produces: `type EvaluateOrigin = "embedding_completed" | "vector_reflection" | "cron_backfill" | "cron_delayed" | "cron_other"`。`EvaluateOptions.origin?: EvaluateOrigin`(既定 `cron_other`)。`Stage2MetricsData` に `origin: EvaluateOrigin` と `joinKey: string` を足す

- [ ] **Step 1: 失敗する試験を書く**
  - `stage2` のデータ点の blobs が `["stage2", <除外内訳JSON>, origin, joinKey]`、`stage2_group` が `["stage2_group", origin, joinKey]` で、2件の joinKey が同じ・評価ごとに違う(2回の評価で別の値)こと
  - joinKey に意思のid・イベントのidが含まれないこと
  - `PIPELINE_AX.writeDataPoint` が例外を出しても `evaluateIntent` は結果を返し、提案は残り、`pipeline.metrics.failed` の warn が出ること
  - blobs が21個以上になる経路が無いこと(厳しく検査する偽物を使う・#26)
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — joinKey は `crypto.randomUUID()`(どこにも保存しない)。`writeStage2Metrics` の中で `writeDataPoint` を `try/catch` で包む。呼び出し側は origin を渡す(第2段=`embedding_completed`・反映確認=`vector_reflection`・Cronのバックフィル=`cron_backfill`・(h)=`cron_delayed`・その他のCron=`cron_other`)
- [ ] **Step 4: 試験を通す**(該当ファイル・`pnpm lint`・`pnpm typecheck`)
- [ ] **Step 5: コミット**

### Task 3: 毎分Cronが止まらないようにする(#15)

**Files:**
- Modify: `apps/worker/src/vectorstore/vectorize.ts`・`apps/worker/src/vectorstore/memory.ts`・`apps/worker/src/pipeline/cron.ts`・`packages/shared/src/constants.ts`
- Test: `apps/worker/tests/pipeline-cron.test.ts`・Vectorize実装の既存の試験(`rg -l createVectorizeStore apps/worker/tests`)

**Interfaces:**
- Produces: `PIPELINE.VECTOR_GET_MAX = 20`。試験専用 `setMemoryVectorLimits(limits: { getByIds?: number } | null): void`(`memory.ts`・index.tsからは再exportしない。`resetMemoryVectorStore` で解除)

- [ ] **Step 1: 失敗する試験を書く**
  - Vectorize実装: 45件の `getByIds` が、偽の `VectorizeIndex` に対して20・20・5件の3回で呼ばれ、入力順で結果を返す
  - `deleteByIds` の上限を公式の文書で確かめ、上限があれば同様に分割の試験を書く(無ければ報告に書く)
  - インメモリ: `setMemoryVectorLimits({ getByIds: 20 })` の下で21件の `getByIds` が例外になる
  - Cron: 上限20の下で、有効な意思25件(埋め込み済み・10分より前)があっても `runScheduledPipeline` が例外を出さず、修復が全件を点検する
  - Cron: 前半の走査(例: `runBucketSweep` が使う問い合わせ)が失敗しても、後ろの走査(Pushの回収など)が動き、`cron.sweep.failed` に `layer` が付く
  - 予算アラートの試験も上限付きの偽物の下で通る(#26)
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — `getByIds` は `vectorize.ts` の中で `PIPELINE.VECTOR_GET_MAX` 件ずつ呼び、結果を入力順に並べる。`runScheduledPipeline` の前半7走査(bucket・catch_up・expiry・backfill・unevaluated・delayed・retention)を `runIsolated` で包み、修復を `runBackfillSweep` から切り出して `runIsolated("repair", …)` で呼ぶ。既存の「前半の失敗は伝播させる」試験とコメントは新しい方針に直す
- [ ] **Step 4: 試験を通す**
- [ ] **Step 5: コミット**

### Task 4: 反映確認の打ち切り・修復の除外・確認中の例外(#21・#23)

**Files:**
- Modify: `packages/shared/src/constants.ts`・`apps/worker/src/pipeline/reflection.ts`・`apps/worker/src/pipeline/consumer.ts`・`apps/worker/src/pipeline/cron.ts`
- Test: `apps/worker/tests/pipeline-reflection.test.ts`・`apps/worker/tests/pipeline-cron.test.ts`

**Interfaces:**
- Consumes: Task 3の修復の切り出し
- Produces: `PIPELINE.REFLECTION_GIVE_UP_MS = 8 * 60_000`・`PIPELINE.REPAIR_GRACE_MS = 10 * 60_000`。`type ConsumeOutcome = { retryDelaySeconds: number } | undefined`。`consumeEvent(...)` と `consumeReflectionEvent(...)` は `Promise<ConsumeOutcome>` を返し、`handleMainQueueBatch` は結果があれば `message.retry({ delaySeconds })` を呼ぶ(Task 5も同じ形を使う)

- [ ] **Step 1: 失敗する試験を書く**
  - `nextReflectionDelaySeconds` を2秒から積み上げたとき、最後に null を返す直前の確認の時刻が 8分30秒以内(Review Focus 5)
  - 反映が7分30秒かかる場合でも評価し直しが起き、8分を超えると `REFLECTION_TIMEOUT` で failed
  - 修復: 現在のversionの `vector_reflection` の行が pending の意思は、`embedded_at` から10分を過ぎていても点検しない。pending でなく `embedded_at` から10分以内の意思も点検しない。10分を過ぎ反映確認が終わった意思でベクトルが無いものは埋め込み直す
  - 反映確認の `getByIds` が例外を出しても、次の遅延で送り直され(`sendToMatchQueue` が呼ばれ)、行は pending のまま
  - 送り直しの `sendToMatchQueue` が例外を出したら、`handleQueueBatch` の結果でそのメッセージが `retry`(`retryMessages` に含まれる)になり、ログは `pipeline.reflection.failed` に `intent_id` 付き
  - not_found(意思が無い)で `skipped: "not_found"` の processed になる(#26)
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — 修復の対象の取り出しで `REPAIR_GRACE_MS` を使い、pending の反映確認の行を持つ意思を除く(`NOT EXISTS` の副問い合わせ)。`consumeReflectionEvent` は `getByIds` の例外を未反映として扱い、送り直しの例外は `{ retryDelaySeconds: 次の遅延 }` を返す
- [ ] **Step 4: 試験を通す**
- [ ] **Step 5: コミット**

### Task 5: 第1段の段ごとの扱いと再試行・バックフィル直後の評価(#17・#22)

**Files:**
- Modify: `apps/worker/src/pipeline/consumer.ts`・`apps/worker/src/pipeline/cron.ts`・`packages/shared/src/constants.ts`
- Test: `apps/worker/tests/pipeline-consumer.test.ts`・`apps/worker/tests/pipeline-cron.test.ts`

**Interfaces:**
- Consumes: Task 4の `ConsumeOutcome` と `handleMainQueueBatch` の `retry`
- Produces: `type EmbeddingStageResult = { status: "embedded"; vector: number[] } | { status: "failed"; layer: "embed" | "upsert" | "d1" | "emit" }`。`PIPELINE.STAGE1_RETRY_DELAYS_S = [10, 30, 60]`

- [ ] **Step 1: 失敗する試験を書く**
  - Embeddingの例外: 起点の行は pending のまま、メッセージは `retry`(1回目10秒・`attempts: 2` で30秒・`attempts: 3` で60秒)
  - upsert・`embedded_at` の更新の例外も同じ
  - `max_retries` を超えたものはDLQで dead になり、5分後のバックフィル(e)が拾って評価する
  - 遅延の合計(10+30+60秒)が `PENDING_STALE_MS`(10分)より短いことを定数の試験で固定する(Review Focus 1)
  - 投入(emit)だけの失敗: ベクトルと `embedded_at` は書かれ、メッセージは `retry`。再配信では埋め込み・upsertを繰り返さず(Embeddingの呼び出し回数が増えない)、`embedding_completed` と `vector_reflection` だけを投入する(判定は `embedded_at >= 起点の行の created_at` かつ version 一致)
  - バックフィル(e): 反映の遅れるインメモリ(`holdMemoryVectorWrites`)の下でも、作り直した直後の評価で提案ができる。評価が null のときは `cron.backfilled` に数えない
  - #9の試験(Cronのバックフィルで作った提案をその場で送る)を、反映の遅れる設定の下で書き直す
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — `runEmbeddingStage` の段ごとの `try` から `failed` と `layer` を返す。`consumeEvent` は第1段の `failed` で `markFailed` せず `{ retryDelaySeconds: STAGE1_RETRY_DELAYS_S[min(attempts-1, 2)] }` を返す(`attempts` は `handleMainQueueBatch` から渡す)。バックフィルは返ったベクトルを `evaluateIntent(..., { vector, origin: "cron_backfill" })` へ渡す。コメントの「再試行なし(06 §5)」を新しい方針に直す
- [ ] **Step 4: 試験を通す**
- [ ] **Step 5: コミット**

### Task 6: 削除の後の書き戻しの防止と孤立したベクトルの自己修復(#20)

**Files:**
- Modify: `apps/worker/src/pipeline/cron.ts`・`apps/worker/src/vectorstore/sync-status.ts`・`apps/worker/src/pipeline/consumer.ts`・Layer 1でD1の行を読む箇所(`apps/worker/src/pipeline/evaluate.ts` または `layer1.ts`)・`packages/shared/src/constants.ts`
- Test: `apps/worker/tests/pipeline-cron.test.ts`・`apps/worker/tests/pipeline-evaluate.test.ts`・状態の同期の既存の試験

**Interfaces:**
- Produces: `PIPELINE.ORPHAN_DELETE_MAX = 10`

- [ ] **Step 1: 失敗する試験を書く**(Review Focus 2・3)
  - Cronのバックフィル・Cronの修復(埋め込み直しとmetadataの修正)・`syncVectorStatus`・第1段(Embeddingの後)のそれぞれで、行を読んだ後・upsertの前に意思を削除すると、ベクトルが書かれない(Embedderの偽物の中で行を消す等で差し込む)
  - Layer 2のhitにD1の行が無いidがあると、そのidが `deleteByIds` で消え、件数だけのログ(`pipeline.orphan.deleted`・`count`)が出る。1回の評価で消すのは10件まで
  - 行のあるhit(反映待ち・paused 等)は消さない
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — 各経路のupsertの直前に、意思の行を `id` で読み直し、無い・status が合わないなら書かない。自己修復はLayer 1が hit のidでD1を読んだ結果との差を使う(追加の照会をしない)
- [ ] **Step 4: 試験を通す**
- [ ] **Step 5: コミット**

### Task 7: 削除APIとD1の問い合わせ・後始末のスクリプト(#16)

**Files:**
- Modify: `apps/worker/src/db/schema.ts`・Create: `apps/worker/migrations/0008_*.sql`(`drizzle-kit generate` で作る)
- Modify: `apps/worker/src/routes/intents.ts`・`tools/load/cleanup.mjs`
- Test: `apps/worker/tests/intents-crud-api.test.ts`・`tools/load/cleanup.test.mjs`

- [ ] **Step 1: 失敗する試験を書く**
  - 削除API: 本人の意思を含む `group_candidates` の行だけが消え、他人だけの行は残る(既存の試験があれば流用)。D1の削除が1回の `batch` で行われる(子の削除の途中で失敗したとき、どの行も消えていない)
  - `cleanup.mjs`: `fetch` が時間切れ(既定30秒)になったら同じ要求を最大3回までやり直し、それでもだめならその意思を残して次へ進み、最後に残った件数を出す
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する**
  - `match_events(source_intent_id)` と `match_events(status, created_at)` の索引を schema に足し、`pnpm --filter worker exec drizzle-kit generate` でマイグレーションを作る。手元で `wrangler d1 execute DB --local --command "EXPLAIN QUERY PLAN …"` を流し、削除APIと残留の掃査の問い合わせが索引を使うことを報告に書く
  - `group_candidates` の削除は、本人の意思を含む候補のidを先に絞ってから消す(全件の `json_each` をやめる。絞り方は `match_candidates` や `group_candidates` の既存の列で決め、報告に書く)
  - ベクトル削除の後のD1の変更(候補・イベント・通知・意思の削除)を `db.batch` にまとめる。提案の取り消し(`cancelOpenLatches`)と次集合の提案は今の順番のまま
- [ ] **Step 4: 試験を通す**(`pnpm --filter worker exec vitest run tests/intents-crud-api.test.ts`・`pnpm --filter load exec vitest run` 相当(`tools/load/package.json` の試験のコマンド))
- [ ] **Step 5: コミット**(マイグレーションのファイルと `meta/` を含める)

### Task 8: メッセージごとの通知の送出とキューの待ち(#19)

**Files:**
- Modify: `apps/worker/src/pipeline/consumer.ts`・`apps/worker/wrangler.jsonc`
- Test: `apps/worker/tests/push-flush.test.ts`・`apps/worker/tests/wrangler-envs.test.ts`・`apps/worker/tests/pipeline-cron.test.ts`

- [ ] **Step 1: 失敗する試験を書く**
  - 2件のメッセージのバッチで、1件目が提案(通知)を作り、2件目の処理を遅らせたとき、1件目の通知の送信試行が2件目の処理の終わりより前に起きる
  - 同じ通知への送信は1回だけ(メッセージごとの送出とバッチの最後の送出が重なっても・Review Focus 4)
  - `wrangler.jsonc` の主キューの消費者(既定とstaging)の `max_batch_timeout` が1
  - Cronの試験で、購読の無い利用者の通知が `no_subscription` まで進むこと・push_fresh の失敗が後ろの走査を止めないこと(#26)
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — `handleMainQueueBatch` に `ctx` を渡し、メッセージごとに処理の開始時刻を `createdFrom` にした `flushPush` を `ctx.waitUntil` で呼ぶ(そのメッセージで通知が作られたときだけ。判定は `notifications` の件数の差か、評価の結果の提案数で行い、報告に書く)。`max_batch_timeout` の設定できる範囲を公式の文書で確かめる
- [ ] **Step 4: 試験を通す**
- [ ] **Step 5: コミット**

### Task 9: 初期判定の振り分けと負荷試験の(b)の2段化(#18)

**Files:**
- Modify: `tools/load/scenarios/bd-proposal.js`・`tools/load/lib/queries.mjs`・`tools/load/lib/stats.mjs`・`tools/load/report.mjs`・`tools/load/lib/pairs.mjs`(必要なら)
- Test: `tools/load/lib/queries.test.mjs`・`tools/load/lib/stats.test.mjs`・`tools/load/report.test.mjs`

**Interfaces:**
- Produces: 集計の表で、初期判定の行を「初期判定(相手が先に反映済み)」(目標 p95 10秒)と「初期判定(同時・参考)」(目標なし)に分ける

- [ ] **Step 1: 失敗する試験を書く**
  - 組ごとに、相手の `vector_reflection` の行が processed になった時刻と自分の `intent_created` の行の作成時刻を比べ、前者が先なら「相手が先に反映済み」、そうでなければ「同時」へ振り分ける(境界の同時刻は「同時」)
  - 欠けの内訳を `skipped` と `failed` に分けて出す・quantile と p95 の重複をなくす・`renderReferenceTable` の試験(#26)
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する** — (b)は組の片方が先に保存し、`GET /v1/dev/match-events` で相手の `vector_reflection` が processed になるまで待ってから(上限は `PROPOSAL_WAIT_SEC` と同じ扱い)、もう片方が保存する。(d)は従来どおり同時の組
- [ ] **Step 4: 試験を通す**(`tools/load` の試験のコマンド)
- [ ] **Step 5: コミット**

### Task 10: 小さな直し(#6の残り・#12・#26の残り)

**Files:**
- Modify: `apps/web/vite.config.ts`・`apps/web/e2e/pwa-flow.spec.ts`・`apps/worker/playwright.config.ts`・`apps/web/playwright.config.ts`・`apps/worker/scripts/clean-e2e-data.mjs`(必要なら)・`apps/web/src/auth/session.test.ts`・通知の許可の試験(Placed画面の試験)・`apps/worker/src/env.ts`・`apps/worker/tests/env.test.ts`(既存の名前を確かめる)・`apps/worker/e2e/group-latches.spec.ts`

- [ ] **Step 1: 試験を書く/直す**
  - マニフェストの `icons` にSVGが無く、PNG(192・512・maskable 512)だけ。pwa-flow のSVGの検査は「マニフェストにSVGが無い」と「アイコンのPNGが正方形」の検査に置き換える(属性の書き方に依存しない)
  - `session.test.ts`: リフレッシュの408・429は `network_error`(セッションを保つ)
  - 通知の許可の試験は、許可の状態(`default`)を試験の中で設定する
  - `assertEnvSafety`: `mailto:dev@example.com.`(末尾のドット)・`mailto:dev@example.com?x=1`・前後の空白付きも拒否
  - group-latches E2E: LATCH一覧に同じLATCHが重複しない
- [ ] **Step 2: 落ちることを確かめる**(E2Eは実装の後でよい)
- [ ] **Step 3: 実装する**
  - `vite.config.ts` の `icons` からSVGを外す(`icon.svg` のファイルとファビコンは残す)
  - worker E2E・web E2Eの `wrangler d1 migrations apply`・`clean-e2e-data.mjs`・`wrangler dev` に同じE2E専用の `--persist-to <apps/worker/.wrangler/e2e-state>` を渡す(.gitignore に含まれるか確かめる)。CIの手順は変えない
- [ ] **Step 4: 試験を通す** — `pnpm test`・`pnpm --filter web build`・`pnpm --filter worker test:e2e`・`pnpm --filter web test:e2e`
- [ ] **Step 5: コミット**

### Task 11: 文書(#25を含む)

**Files:**
- Modify: `docs/06-matching-pipeline.md`・`docs/05-data-model-api.md`・`docs/04-system-architecture.md`・`docs/01-requirements.md`・`docs/02-scope-acceptance.md`・`docs/10-test-env-nfr.md`・`docs/12-development-roadmap.md`・`docs/00-document-roadmap.md`・`AGENTS.md`・前提文書欄だけが変わる文書・Task 1〜10のコードのコメントで古くなったもの

- [ ] **Step 1: 06** — §2(打ち切り8分・修復の除外(pendingの反映確認・10分)・前半7走査の隔離・書き戻しの防止・孤立したベクトルの自己修復・#25の2件(修復後は評価し直しが起きない/反映の窓の中のpauseで同期が何もしない)・修復の点検の500件の制約)・§5(第1段の段ごとの扱いと再試行10・30・60秒)・§7(データ点のblobの並び: origin・joinKey)
- [ ] **Step 2: 05** — §2.3の索引・マイグレーション0008と戻す手順
- [ ] **Step 3: 04** — §4の主キューの `max_batch_timeout = 1` とメッセージごとの通知の送出
- [ ] **Step 4: 01・02・10** — 01冒頭の決定記録(2026-10-23・初期判定の目標の定義: 決定内容/根拠/影響)と§20。02 #33の定義(状態は「stubでの計測済み・LLM real接続後の測り直し待ち」のまま)。10 §5(目標の定義と集計の振り分け)
- [ ] **Step 5: 12** — §2のフェーズ表と決定記録(本工程・オーナー合意4件。PC向けの画面の工程を後で設ける: 根拠はポートフォリオとして面接の相手にURLを送る場面がありPCで開かれるため・時期はその工程の開始時に決める・issue #14)
- [ ] **Step 6: 00・AGENTS.md・版数** — 00 §1の版数表と変更点行、全文書の前提文書欄、AGENTS.md の現在の状態(第2回の修正工程の記録)。`rg` で古い版の参照が0件であることを確かめる
- [ ] **Step 7: 確認とコミット** — `pnpm lint`

### Task 12: stagingでの確認(コントローラーが承認を取ってから)

**Files:** なし(結果は報告とissueのコメント)

- [ ] **Step 1: push** — コントローラーがオーナーの承認を取ってpushする。CI(ci・web-e2e・deploy-staging)が緑であることを確かめる
- [ ] **Step 2: マイグレーション** — stagingのD1へ0008を当てる(`docs/runbooks/staging.md` の手順)
- [ ] **Step 3: 確認** — `wrangler tail --env staging --format json` を事件名で絞り、次を記録する(URLは出さない)
  - 毎分Cronで `cron.sweep.failed` が出ないこと(#15)
  - 小さな負荷((a)の小規模・`tools/load/run.mjs` 経由)で、第1段の失敗の `layer`・`error_code` と、再試行で回復したか(#17)
  - 削除の `intents.delete.timing` と失敗の `error_code`(#16)
  - `wrangler vectorize info` のベクトル数とD1の意思の数。残っている1件が自己修復で消えたか(#20)
- [ ] **Step 4: 想定と違ったもの** — 新しいissueに登録し、コントローラーへ報告する(コントローラーがオーナーへ報告する)。残ったベクトルを手で消す必要があれば、コントローラーがオーナーの承認を取る

### Task 13: 負荷試験の流し直しと報告書

**Files:**
- Modify: `docs/reports/f8b-load-test.md`・(結果に応じて)`docs/02-scope-acceptance.md`・`docs/10-test-env-nfr.md`・`docs/12-development-roadmap.md`・`docs/00-document-roadmap.md`・`AGENTS.md`

- [ ] **Step 1: 計測** — 手順書7章どおり、後始末→(a)→(b)→(d)→(c)を同じRUN_IDで流す。集計(`tools/load/report.mjs`)は各後始末の前に行う
- [ ] **Step 2: 報告書** — 「測り直し(第2回の修正工程の後)」の節を足す。初期判定は「相手が先に反映済み」(目標の行)と「同時・参考」に分けて書く。前回との差、#15〜#24の修正の効果、新しく見つけた不具合のissue番号。stagingのURLは書かない
- [ ] **Step 3: 文書** — 10 §5・12 §2・00・AGENTS.md の状態を更新する(#33は「stubでの計測済み・LLM real接続後の測り直し待ち」のまま)。版数の規則に従う
- [ ] **Step 4: issue** — 対象のissueに結果を書いて閉じる(#18は目標の定義の変更と測り直しの結果を書いて閉じる)。直っていないものは開いたまま理由を書く
- [ ] **Step 5: コミット**
