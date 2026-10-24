# 不具合の修正工程(第3回) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** issue #27〜#35を直し、stagingで原因と修正を確かめ、LLM real(LATCH_LLM_MODE=real)のままで負荷試験(02 #33)を流し直して報告書・文書を更新する。

**Architecture:** 先にLLMまわり(#35の失敗の種類・#31の指示文とゴールドセット)を直して精度ゲートを採り直す。次に第1段の成功の後に同じ実行で第2段を続け(#30)、実行ごとの計測の書き込みの残り(#28)を入れる。原因の確定していない#27・#29・#32は記録を足してstagingで確かめてから直し、#33・#34は集計と手順書を直す。最後に負荷試験を流し直して報告書 §9 と文書を更新する。

**Tech Stack:** Cloudflare Workers(Hono)・D1(drizzle)・Queues・Vectorize・Analytics Engine・vitest(@cloudflare/vitest-pool-workers・tools/eval と tools/load はNodeのvitest)・Playwright・k6(`tools/load/run.mjs` 経由)

**Spec:** docs/superpowers/specs/2026-10-24-bugfix-phase3-design.md

## Global Constraints

- 応答・コミットメッセージ・文書・コードのコメントは日本語。コミットは `git add <パス>` で対象を限定する(`git add -A`・`git commit -a` は禁止)。コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- mainで直接作業する。pushとCloudflareの資源の作成・削除は、コントローラーが毎回オーナーの承認を取ってから行う(実装の担当はpush・デプロイ・資源の操作をしない)。stagingへのデプロイは、コントローラーがオーナーへ一声かけてから行う
- 負荷試験と `pnpm eval:gate` は課金が発生する。コントローラーが費用の概算を示してオーナーの承認を取ってから実行する(eval:gateは1回約1ドル・負荷試験はLLMの外部送信が約1.7米ドル)
- レガシー実装への言及をしない。用語は AGENTS.md の「用語の統一」に従う(「Layer 2 Candidate Retrieval」・「アプリ内通知」・「p95 0.5秒」の形の単位)
- docsを変えたら docs/00 §3 に従い版数を上げ、冒頭に変更点行を足し、前提文書欄と 00 §1 の版数表を揃える
- stagingのURL・CloudflareのアカウントID・Accessの値・APIキーは、文書・設定・コミット・issue・報告書・出力に書かない。値は `.superpowers/sdd/2026-10-22-f8b-staging-load-test/`(staging-url・access.env・k6)と `tools/eval/.env` にある。k6は必ず `tools/load/run.mjs` 経由で実行する
- ログは許可リスト方式(`apps/worker/src/logging/logger.ts`)。許可リストの項目は増やさず、`error_code`・`layer`・`latency`・`count`・`intent_id`・`latch_id`・`version` の範囲で出す。個人情報・例外の文の中身は出さない
- キューの消費・Cronの走査は例外を外へ出さない(失敗は行のstatusとログに記録する)
- 新しく見つけた不具合は、直さずにまずGitHubのissueへ登録し、報告に書く(GitHubのAPIは回数の上限に近いので、照会はまとめて行う)
- 数値: 計測の書き込みの残り `PIPELINE.METRICS_WRITES_PER_INVOCATION = 240`(上限250件の手前)・反映確認の打ち切り8分(変えない)
- 精度ゲートの指紋の対象は `tools/eval/lib/fingerprint.ts` の `FINGERPRINT_FILES`(prompts.ts・anthropic.ts・parser.ts・jev-typesafe.ts・jev-anthropic.ts・llm/expiry.ts・intents/expiry.ts・llm/mode.ts・pipeline/normalize.ts・2つのゴールドセット)。これらを変えたら負荷試験の前に採り直す
- 確認のコマンド: `pnpm lint`・`pnpm typecheck`・`pnpm test`。E2Eは `pnpm --filter web build` の後に `pnpm --filter worker test:e2e`、web E2Eは `pnpm --filter web test:e2e`(ポートが塞がっていたら `LATCH_E2E_PORT` で避ける)

## Review Focus

1. 第1段の続きで評価が例外になったとき、embedding_completedの行がpendingのまま残らず、キューへ送られて今の第2段の経路で処理されること。キューへの送信も失敗したら、行はpendingのまま残り10分の残留の掃査と未評価の回収(g)に任されること → Task 4の試験で両方を固定する
2. 第1段の続きの評価で作られた提案のWeb Pushが、今と同じくメッセージごとの送出(`flushFreshPush`)で送られること → Task 4の試験で、続きの評価で作った通知が同じメッセージの処理の後に送出の対象になることを固定する
3. 計測の書き込みの残りが、同時に動く別の実行(isolateが同時に扱う要求)と共有されないこと → Task 5の試験で、2つの残りを交互に使っても互いに減らないことを固定する
4. #35の切り替えで、TypeSafeの400番台(鍵の誤り)が予備へ切り替わらず、予備も `unavailable` で失敗したときに今と同じheld.failedになること → Task 1の試験で固定する
5. topicの採点で、`topic_none` の語が `topic_any` の語の一部として含まれる例(例: 期待「渋谷系の音楽」と禁止「渋谷」)を誤って不合格にしないよう、ゴールドセットにそういう組を置かないこと → Task 2のゴールドセットの読み込みの試験で、同じ項目の `topic_any` と `topic_none` の語が互いを含まないことを検査する

---

### Task 1: Jevの予備への切り替えに接続の失敗と5xxを加える(#35)

**Files:**
- Modify: `apps/worker/src/llm/types.ts`(`LlmFailureKind`・`isFallbackEligible`)
- Modify: `apps/worker/src/llm/real/jev-typesafe.ts`
- Modify: `apps/worker/src/llm/real/anthropic.ts`(Parser・予備のJevが使う共通の分類)
- Test: `apps/worker/src/llm/real/jev-typesafe.test.ts`・`apps/worker/src/llm/real/anthropic.test.ts`・切り替えの共通部の既存の試験(`apps/worker/src/llm/mode.test.ts`・`apps/worker/src/jev/runner.ts` の試験)

**Interfaces:**
- Produces: `LlmFailureKind = "timeout" | "rate_limited" | "overloaded" | "unavailable" | "invalid_output" | "other"`。`isFallbackEligible(kind)` は timeout・rate_limited・overloaded・unavailable で真

- [ ] **Step 1: 失敗する試験を書く**
  - jev-typesafe: fetchが例外(timeoutでない)→ `unavailable`。500・502 → `unavailable`。503・529 → `overloaded`。429 → `rate_limited`。400・401 → `other`
  - anthropic: 同じ表(Anthropicの529・503はoverloaded、500・502・接続の失敗はunavailable)
  - 切り替えの共通部: 第一候補が `unavailable` なら予備が呼ばれる。`invalid_output`・`other` なら呼ばれない。予備も `unavailable` なら結果は失敗(今のheld.failedの経路)
- [ ] **Step 2: 実行して落ちることを確かめる** — `pnpm --filter worker exec vitest run src/llm`
- [ ] **Step 3: 実装する** — 型に `unavailable` を足し、2つのreal実装の分類を上の表に合わせる。コメントの「07 §5」の説明も改める
- [ ] **Step 4: 試験を流して通ることを確かめる** — `pnpm --filter worker exec vitest run src/llm`、続けて `pnpm typecheck`(`LlmFailureKind` の網羅のswitchがあれば直す)
- [ ] **Step 5: コミット**

### Task 2: topicに地名を入れない指示文とゴールドセット・採点(#31)

**Files:**
- Modify: `apps/worker/src/llm/real/prompts.ts`(Parserの指示文)
- Modify: `eval/goldset/parser.yaml`(`version: 2`・`topic_none` の追加。`approved_by_owner` はTask 3でオーナーの承認後に更新するまで今の値のまま)
- Modify: `tools/eval/lib/goldset.ts`・`tools/eval/lib/score.ts`
- Test: `tools/eval/lib/goldset.test.ts`・`tools/eval/lib/score.test.ts`・`apps/worker/src/llm/real/parser.test.ts`(指示文の含む文言の検査があれば)

**Interfaces:**
- Produces: ゴールドセットの期待値のキー `topic_none?: string[]`。topicの判定は「`topic_any`(または `topic`)のどれかを含み、かつ `topic_none` のどれも含まない」。比較は今の `norm`(NFKC・小文字)

- [ ] **Step 1: 失敗する試験を書く**
  - score: `topic_any: ["カレー"]`・`topic_none: ["渋谷"]` で、出力「渋谷でカレー」は不一致、「カレーを食べに行く」は一致
  - goldset: `topic_none` を読める。`topic_none` の語が同じ項目の `topic_any` の語を含む、またはその逆なら例外(Review Focus 5)。`topic_none` だけで `topic_any` も `topic` も無い項目は例外
- [ ] **Step 2: 実行して落ちることを確かめる** — `pnpm --filter eval exec vitest run`
- [ ] **Step 3: 採点と読み込みを実装する**
- [ ] **Step 4: 指示文を直す** — Parserの指示文のtopicの説明に「地名・店名・駅名・施設名をtopicに入れない。場所の言及はwarningsの `{field:"geo"}` で知らせる」を足す。既存のgeoのwarningsの指示と矛盾させない
- [ ] **Step 5: ゴールドセットの下書き** — `raw_text` に地名・店名・駅名・施設名を含むすべての項目へ `topic_none`(その項目の地名など)を足し、`version: 2` にする。変えた項目の一覧(id・raw_text・足した語)を報告に書く(Task 3でオーナーに見せる)
- [ ] **Step 6: 試験を流して通ることを確かめる** — `pnpm test`(tools/evalの記録の照合の試験は、ゴールドセットの指紋が変わったため落ちるのが正しい。落ちる試験の名前を報告し、Task 3の採り直しで直ることを書く。ほかの試験は緑)
- [ ] **Step 7: コミット**

### Task 3: ゴールドセットの承認と精度ゲートの採り直し(コントローラー)

**Files:**
- Modify: `eval/goldset/parser.yaml`(`approved_by_owner`)・`eval/records/gate.json`

- [ ] **Step 1: オーナーの承認** — Task 2のStep 5の一覧をオーナーに見せ、承認を受けたら `approved_by_owner: "<承認日>"` に更新する
- [ ] **Step 2: 費用の承認** — 約1ドルの見込みを示して承認を取る
- [ ] **Step 3: 採点** — `pnpm eval:gate`。合格なら次へ。不合格なら原因(どの項目・どの欄)を報告し、指示文を直して採り直す。3回で合格しないときは止めてオーナーに相談する
- [ ] **Step 4: 確認とコミット** — `pnpm test` が緑(記録の照合の試験を含む)。`eval/goldset/parser.yaml`・`eval/records/gate.json` をコミットする

### Task 4: 第1段の成功の後に同じ実行で第2段を続ける(#30)

**Files:**
- Modify: `apps/worker/src/pipeline/events.ts`(行だけを作る関数の切り出し)
- Modify: `apps/worker/src/pipeline/consumer.ts`
- Test: `apps/worker/tests/pipeline-consumer.test.ts`

**Interfaces:**
- Produces: `recordMatchEvent(env: Env, params: EmitMatchEventParams, clock: Clock): Promise<string>`(pendingの行を作り、UNIQUE衝突なら既存の行のidを返す。キューへは送らない)。`emitMatchEvent` はこれを使って作った後に送る(振る舞いは変えない)
- Produces: consumer.ts 内の `runStage2(env: Env, event: MatchEventRow, clock: Clock, vector?: number[]): Promise<void>`(今のembedding_completedの枝の本体: 古い版の除外・`evaluateIntent`・`markProcessed`。評価の例外は投げ返す)

- [ ] **Step 1: 失敗する試験を書く**(intent_createdのメッセージ1件を `handleQueueBatch` に渡す)
  - 第1段の成功の後、embedding_completedの行が `processed` で、payloadが今の第2段と同じ形(`stage2Payload`)。キューへはembedding_completedが送られず、vector_reflectionだけが送られる
  - 評価(`evaluateIntent`)が例外のとき: embedding_completedの行のidがベクトル付きでキューへ送られ、行は `pending` のまま。intent_createdのメッセージはackされる
  - 上の送信も失敗したとき: 行は `pending` のまま、例外は外へ出ない(Review Focus 1)
  - 続きの評価で作られた提案の通知が、同じメッセージの処理の後の送出の対象になる(Review Focus 2)
  - Cronのバックフィル(`emitCompleted=false`)は今のまま(embedding_completedの行を作らない)
- [ ] **Step 2: 実行して落ちることを確かめる**
- [ ] **Step 3: 実装する**
  - キューの経路の `runEmbeddingStage` は、embedding_completedを送る代わりに `recordMatchEvent` で行を作り、vector_reflectionを今どおり投入して、`{ status: "embedded", vector, completedEventId }` を返す(Cronの経路は今のまま)
  - `consumeEvent` の第1段は、`embedded` のとき起点の行を `processed` にした後、`runStage2` を呼ぶ。例外なら `pipeline.stage2.failed`(error_code・intent_id)をログし、`sendToMatchQueue(env, completedEventId, { vector })` で送る(失敗はログだけ)
  - 既存のembedding_completedの消費の枝は `runStage2` を呼ぶ形にする(失敗時の `markFailed` は今のまま)
  - 投入だけのやり直しの経路(embedded_atが書かれた後の再配信)は今のまま(embedding_completedをvector無しで送る)
- [ ] **Step 4: 試験を流して通ることを確かめる** — worker全体の `pnpm --filter worker test`
- [ ] **Step 5: コミット**

### Task 5: 実行ごとの計測の書き込みの残り(#28)

**Files:**
- Create: `apps/worker/src/pipeline/metrics-budget.ts`
- Modify: `apps/worker/src/pipeline/metrics.ts`・`apps/worker/src/pipeline/evaluate.ts`(options)・`apps/worker/src/pipeline/cron.ts`(予算アラートの書き込み・Cronの評価の呼び出し)・`apps/worker/src/pipeline/consumer.ts`(バッチごとに1つ作って渡す)・`packages/shared` の `PIPELINE` 定数
- Test: `apps/worker/src/pipeline/metrics-budget.test.ts`(新規)・`apps/worker/tests/pipeline-cron.test.ts`

**Interfaces:**
- Produces: `interface MetricsBudget { take(n: number): boolean }`・`createMetricsBudget(limit?: number): MetricsBudget`(既定 `PIPELINE.METRICS_WRITES_PER_INVOCATION`)。`take` は残りがn以上なら減らして真、足りなければ減らさず偽で、最初の偽のときだけ `pipeline.metrics.skipped`(count=その時点の残り)をwarnする
- Produces: `writeStage2Metrics(env, data, budget: MetricsBudget)`・`evaluateIntent(..., { ..., metricsBudget?: MetricsBudget })`(省略時はその呼び出しだけの新しい残り)

- [ ] **Step 1: 失敗する試験を書く**
  - 残り3で `take(2)` 真・`take(2)` 偽(残り1のまま)・`take(1)` 真。警告は1回だけ
  - 2つの残りを交互に使っても互いに減らない(Review Focus 3)
  - `writeStage2Metrics` は残り1のとき `writeDataPoint` を1回も呼ばない
  - Cronの1回の実行で評価が121件以上あっても、`writeDataPoint` の呼び出しが240回を超えない(評価の件数が多い場面は既存のCronの試験の作り方に合わせて用意する)
- [ ] **Step 2: 実行して落ちることを確かめる**
- [ ] **Step 3: 実装する** — 残りはモジュールの変数にせず、実行の入口(`handleQueueBatch` のバッチごと・`scheduled` の1回ごと)で作って渡す
- [ ] **Step 4: 試験を流して通ることを確かめる** — `pnpm --filter worker test`
- [ ] **Step 5: コミット**

### Task 6: 原因を探すための記録(#27・#29・#32)

**Files:**
- Modify: `apps/worker/src/routes/intents.ts`(削除・保存の段ごとの所要時間)
- Modify: `apps/worker/src/latches/cancel-open.ts`(取り消しと保留の解放を分けて測れるようにする)
- Modify: `apps/worker/src/index.ts`(Accessの証明の検証の所要時間)
- Modify: `apps/worker/src/pipeline/errors.ts`(D1の分類の細分)
- Modify: `cron.item.failed` を出す7か所(`apps/worker/src/pipeline/cron.ts`・`apps/worker/src/latches/release.ts`・`apps/worker/src/latches/complete.ts`)
- Test: `apps/worker/tests/pipeline-errors.test.ts`・`apps/worker/tests/pipeline-cron.test.ts`・既存の削除・保存の試験(ログの検査があるもの)

**Interfaces:**
- Produces: `intents.delete.timing` の `layer` に `open_latches`・`cancel`・`release`・`next_group` を足す(既存の `vector`・`d1` は残す)。`intents.create.timing`(layer=`d1`・`emit`)。`access.verify.timing`(latency)
- Produces: `cancelOpenLatches(db, latchIds, actorUserId, now, opts?: { onTiming?: (layer: "cancel" | "release", startedAt: number) => void })`(戻り値は今のまま)
- Produces: `cron.item.failed` の `layer` に処理の名前: `cron_evaluate`・`cron_repair`・`cron_backfill`・`cron_delayed_reeval`・`cron_answer_expire`・`release_held`・`complete`
- Produces: `errorCodeOf` のD1の分類: `D1_CONSTRAINT`(UNIQUE・FOREIGN KEY・constraint の語)・`D1_BUSY`(busy・locked)・`D1_TIMEOUT`(timeout・timed out)・`D1_RESET`(reset・network connection lost)・`D1_OVERLOADED`(今のまま)・それ以外は `D1_ERROR`

- [ ] **Step 1: 失敗する試験を書く** — errorCodeOfの上の6分類(`D1_ERROR: UNIQUE constraint failed: …` → `D1_CONSTRAINT` など。causeの内側でも判定される)。cron.item.failedのlayerは、既存のCronの試験で1件の失敗を起こす箇所があればそこで検査する
- [ ] **Step 2: 実行して落ちることを確かめる**
- [ ] **Step 3: 実装する** — 所要時間は `systemClock` で測る(既存の `logDeleteTiming` の形)。Accessの検証の記録は staging の経路(検証を行うとき)だけで出す
- [ ] **Step 4: 試験を流して通ることを確かめる** — `pnpm --filter worker test`
- [ ] **Step 5: コミット**

### Task 7: 集計の反映の内訳と(d)の通知の分け方(#34・#33)

**Files:**
- Modify: `tools/load/lib/queries.mjs`(`reflectionBreakdown`・通知の行の照会)・`tools/load/report.mjs`(注記の文)
- Modify: `docs/runbooks/staging.md` 7章(Task 11で版数と合わせて改める部分の下書きはここで書いてよい)
- Test: `tools/load/report.test.mjs`(または `tools/load/lib/` の該当試験)

**Interfaces:**
- Produces: `reflectionBreakdown(rows)` の戻り値 `{ skipped, failed, pending, other }`(`status === "pending"` を `pending` に数える)。報告の内訳の行は「skipped n件・failed n件・確認中(pending) n件・その他 n件」

- [ ] **Step 1: 失敗する試験を書く** — pendingの行が `pending` に数えられ `other` に入らない。報告の文に「確認中(pending)」が出る
- [ ] **Step 2: (d)に(b)の通知が混ざった理由を確かめる** — `buildQueries` の通知の照会と、(b)(d)の振り分け(`load-<runId>-b<n>`・`-d<n>`)を読み、前回(d)の120件に最初の(b)の60件が入った経路を特定する。後始末で消えない通知の行が同じsubjectの後の利用者に結び付いた等、照会で直せるなら照会を直して試験で固定する。照会で直せず実行の印を分ける運用で避けるなら、手順書7章に「集計に失敗したシナリオを流し直すときは新しい実行の印を使う」を書く。どちらにしたかを報告する
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 試験を流して通ることを確かめる** — `pnpm test`
- [ ] **Step 5: コミット**

### Task 8: 手元の全体の確認

- [ ] **Step 1:** `pnpm lint`・`pnpm typecheck`・`pnpm test` が緑
- [ ] **Step 2:** `pnpm --filter web build` → `pnpm --filter worker test:e2e`(47本)→ `pnpm --filter web test:e2e`(18本)が緑。落ちたら原因を直す(この工程の変更による失敗なら該当Taskの直しとして直す。そうでなければissueに登録して報告する)
- [ ] **Step 3:** 結果(本数と所要時間)を報告する

### Task 9: stagingでの原因の確認(コントローラーが承認を取ってから)

**Files:** なし(結果は報告とissueのコメント)

- [ ] **Step 1: pushとデプロイ** — コントローラーがオーナーの承認を取ってpushし、オーナーへ一声かけてから `deploy:staging`(手順書5章)。CIが緑であることを確かめる
- [ ] **Step 2: #34の行の照会** — stagingのD1で、実行の印202610240317の(b)の利用者の反映確認(vector_reflection)の行の状態と `payload` を照会する(行が残っていれば)。pendingが残っていた/残っているなら仮説どおり。残っていなければ、Step 3の試し実行の(b)で同じ照会を行う
- [ ] **Step 3: 小さな試し実行**((a)(b)の小規模・`tools/load/run.mjs` 経由。#33の証拠には使わない)の間に `wrangler tail --env staging --format json` を事件名で絞って記録する(URLは出さない)
  - `intents.delete.timing` の段ごとの値(後始末の削除で出る・#27)
  - `intents.create.timing` と `access.verify.timing`(#32)
  - `cron.item.failed` の `layer`・`error_code`(#29。出なければ出なかったと書く)
  - `pipeline.metrics.skipped`(#28)と `pipeline.metrics.failed` が出ないこと
  - 第1段の続きの評価の後の `pipeline.stage2.failed` の有無(#30)
- [ ] **Step 4: 原因の報告** — #27・#29・#32・#34の原因と、Task 10で当てる直し方をコントローラーへ報告する(コントローラーは、設計 §5 の方針の範囲ならそのまま進め、範囲を超えるならオーナーに相談する)。想定外の不具合はissueに登録する

### Task 10: 確かめた原因の直し

**Files:** Task 9の結果による(主に `apps/worker/src/routes/intents.ts`・`apps/worker/src/latches/cancel-open.ts`・`apps/worker/src/index.ts`・`apps/worker/src/auth/access.ts`・`apps/worker/src/llm/mode.ts`・`apps/worker/src/llm/external-send.ts`)

設計 §5 の方針の範囲で、原因ごとに次の形で直す。各直しは「失敗する試験 → 実装 → 試験が緑 → コミット」の順で行う。

- [ ] **#27(遅いのが保留の解放・次の組の提案の場合)** — 削除APIとPATCHは、取り消し(`cancel`)までを応答の前に行い、保留の解放と次の組の提案を `c.executionCtx.waitUntil` で応答の後に行う。試験: 削除の応答の時点で取り消しは済んでおり、応答の後の処理の失敗が応答に波及しない(失敗はログ)。毎分Cronの保留の解放((i))が拾い直すことを既存の試験で確かめる
- [ ] **#27(遅いのが取り消しそのものの場合)** — `closeLatch` の繰り返しのD1の書き込みを、閉じるLATCHをまとめた1回のbatchにする(条件付きの更新で、閉じた件数を数える振る舞いは変えない)。試験: 閉じたLATCHのidの一覧と参加者の保留の解放の対象が今と同じ
- [ ] **#29** — 原因の処理と分類に合わせて直す(例: 制約違反なら競合の条件を足す)。直しがオーナーの判断に関わるならコントローラーが相談する
- [ ] **#32** — 原因に合わせて直す(例: Accessの検証の公開鍵の取得を初回の要求で待たない工夫・外部送信の集計の書き込みを `waitUntil` に回す等)。`apps/worker/src/llm/mode.ts` を変えたら、Task 3と同じ手順で精度ゲートを採り直す(費用の承認を取る)
- [ ] **#34(仮説が外れた場合)** — 原因に合わせて直す
- [ ] **確認** — Task 8を流し直し、コントローラーがオーナーへ一声かけてからpush・`deploy:staging` を行う

### Task 11: 文書

**Files:**
- Modify: `docs/01-requirements.md`(冒頭の決定記録)・`docs/06-matching-pipeline.md`(§2・§7)・`docs/07-jev-llm-spec.md`(§3・§5・§6)・`docs/12-development-roadmap.md`(§2)・`docs/runbooks/staging.md`(7章)・`docs/00-document-roadmap.md`(§1の版数表)・前提文書欄だけが変わる文書・Task 1〜10のコードのコメントで古くなったもの

- [ ] **Step 1: 01** — 冒頭の決定記録(2026-10-24・Jevの予備への切り替えに接続の失敗とサーバーのエラー(5xx)を加える: 決定内容/根拠/影響)
- [ ] **Step 2: 06** — §2(第1段の成功の後に同じ実行で第2段を続ける・失敗時はキューの第2段に任せる)・§7(実行ごとの計測の書き込みの残り240件・超えた分は書かずに警告1回・match_events.payloadは変わらない)
- [ ] **Step 3: 07** — §3(topicに地名・店名・駅名・施設名を入れない・場所の言及はwarningsで確認UIへ)・§5(切り替えの条件に `unavailable` を加え、400番台とinvalid_outputは切り替えないことを明記)・§6(topicの採点の `topic_none`・ゴールドセットの版2)
- [ ] **Step 4: 12** — §2の決定記録(第1段から第2段への続行・オーナー合意2026-10-24。p95 10秒を超えたら案Bを改めて相談する)と工程の記録
- [ ] **Step 5: 手順書** — 7章(#34の集計の前の待ち・#33の実行の印の扱い)
- [ ] **Step 6: 00と版数** — 00 §1の版数表と変更点行、全文書の前提文書欄。`rg` で古い版の参照が0件であることを確かめる
- [ ] **Step 7: 確認とコミット** — `pnpm lint`

### Task 12: 負荷試験の流し直しと報告書(コントローラーが承認を取ってから)

**Files:**
- Modify: `docs/reports/f8b-load-test.md`(§9を追加)

- [ ] **Step 1: 費用の承認** — 前回の実績(LLMの外部送信 約1.7米ドル)をもとに概算を示し、オーナーの承認を取る
- [ ] **Step 2: 計測** — 手順書7章どおり、後始末→(a)→後始末→(b)→集計→後始末→(d)→集計→後始末→(c)→集計→後始末。集計(`tools/load/report.mjs`)は後始末の前に行い、集計が失敗したら後始末しない。集計の前に反映確認の終わりを待つ(Task 7・手順書)
- [ ] **Step 3: 報告書** — 「9. 不具合の修正工程(第3回)の後の測り直し」の節を足す(実行条件・件数・01 §20の目標との比較(前回 §8.3 との差)・チャット(参考)・直した不具合の確かめ(#27〜#30・#32〜#34)・外部送信の件数と費用・登録したissue)。stagingのURLは書かない
- [ ] **Step 4: コミット**

### Task 13: 状態の更新とissue(コントローラー)

**Files:**
- Modify: `docs/02-scope-acceptance.md`(#33)・`docs/12-development-roadmap.md`(§2)・`docs/00-document-roadmap.md`・`AGENTS.md`(現在の状態)

- [ ] **Step 1: 02 #33** — 01 §20の項目がすべて目標内なら完了。残るなら目標外の項目とissueを明記する
- [ ] **Step 2: 12 §2・00・AGENTS.md** — 第3回の修正工程の記録(対象・オーナー合意3件・結果)。版数の規則に従う
- [ ] **Step 3: issue** — #27〜#35に結果を書いて閉じる。直っていないものは開いたまま理由を書くか、オーナーと扱いを決めて記録する
- [ ] **Step 4: コミット** — コミットの後、pushはオーナーの承認を取ってから行う
