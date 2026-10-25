# 不具合の修正工程(第4回) 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** #32・#37・#42〜#47を直し、LLM realのままstagingで負荷試験(02 #33)を測り直す。

**Architecture:** #47は直近に埋め込んだ意思のベクトルをD1の新しい表`recent_vectors`に15分控え、評価でVectorizeの照会の結果に最大50件補う(Vectorizeの読み取りの一貫性に頼らない)。他は既存の経路の局所的な直し(1文へのまとめ・短いやり直し・読み取りの一括化・記録の追加)。

**Tech Stack:** Cloudflare Workers(Hono)・D1(drizzle)・Vectorize・Queues・Durable Objects・vitest(@cloudflare/vitest-pool-workers)・Playwright・k6

**Spec:** `docs/superpowers/specs/2026-10-25-bugfix-phase4-design.md`(読み取りの調べの根拠は同 §0.4)

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。コミットの末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- コミットは `git add <パス>` のみ(`git add -A`・`git commit -a` は禁止)。作業は main で直接。pushはコントローラーがオーナーの承認を得て行う
- レガシー実装への言及をしない
- docsを変えたら docs/00 §3 の規則(版数・変更点行・前提文書欄・00 §1の表)に従う。用語は「Layer 2 Candidate Retrieval」「アプリ内通知」、数値は「p95 0.5秒」の形
- 検索は `rg`
- ログは許可リスト方式(`apps/worker/src/logging/logger.ts`)。新しい項目は許可リストへ足す。個人情報・本文を出さない
- 精度ゲートの指紋の対象(`tools/eval/lib/fingerprint.ts` の FINGERPRINT_FILES。`apps/worker/src/llm/mode.ts` を含む)を変えない。変えた場合は `pnpm eval:gate` で採り直し `eval/records/gate.json` をコミットする
- D1のスキーマを変えたら `pnpm --filter worker exec drizzle-kit generate` でマイグレーションを生成してコミットし、`apps/worker/migrations_rollback/` に戻す手順を足す(0008の形にならう)
- stagingのURL・アカウントID・Accessの値・APIキーを文書・設定・コミット・出力に書かない
- 時刻依存のロジックは Clock を受け取る(`systemClock` を直接使わない。所要時間の計測は `performance.now()` でよい)
- 定数は `packages/shared/src/constants.ts` の `PIPELINE` に置く: `RECENT_VECTOR_TTL_MS: 15 * 60_000`・`RECENT_VECTOR_SUPPLEMENT_MAX: 50`・`STAGE1_UPSERT_RETRY_DELAYS_MS: [1_000, 2_000]`・`RELEASE_AFTER_DELETE_BUDGET_MS: 20_000`
- 単体・統合: `pnpm test`。worker E2E: `pnpm --filter web build` の後 `pnpm --filter worker test:e2e`。web E2E: `pnpm --filter web test:e2e`。整形: `pnpm lint`・型: `pnpm typecheck`

## Review Focus

1. 補い(#47)の行が別formの意思・paused・期限切れ・自分自身・ブロックの相手を候補に入れない(form・statusはSQLで絞り、ブロック等はLayer 1が従来どおり落とす) → Task 3 の統合試験
2. 埋め込み直し(内容の変更)の後に、古い版のベクトルが補いに使われない(recent_vectorsは同じintent_idで上書き・version不一致の行はLayer 1以降の既存の版の照合で落ちる) → Task 2・Task 3 の試験
3. 同じ利用者が同時に2件をactiveで保存しても上限5件を超えない(1文にまとめた後の競り合い) → Task 4 の試験
4. 保留の解放の一括化の後も、通知上限に届いた参加者を含む保留は昇格しない・昇格の順番(機会=対象時刻の近い順→つながり=score降順)が変わらない → Task 7 の試験
5. 応答の後の第1段のやり直しの待ち(最大3秒)を足しても、応答の後の処理が30秒の上限に収まり、やり直しが尽きたら従来どおりキューのやり直しへ回る → Task 6 の試験

---

### Task 1: #37 web E2Eの時間の差への依存

**Files:**
- Modify: `apps/web/e2e/flow.spec.ts`

**Interfaces:**
- Consumes: `apps/web/e2e/helpers.ts` の `expireLeftoverE2eIntents()`(既存・他のspecと同じ使い方)

- [ ] **Step 1:** `flow.spec.ts` に、`pwa-flow.spec.ts`・`notices-flow.spec.ts` と同じ形の `test.beforeEach`(と既存の形にならって必要なら `afterAll`)で `expireLeftoverE2eIntents()` を呼ぶ
- [ ] **Step 2:** 2と3の意思の本文に stub のJevの目印 `__jev_low__` を付ける(2は手で直した後の主題にも付ける)。期待(「預けている」の表示など)は緩めない
- [ ] **Step 3:** `pnpm --filter web build` の後、`pnpm --filter web exec playwright test e2e/flow.spec.ts --repeat-each 2` が全件通る。続けて `pnpm --filter web test:e2e` が全件通る
- [ ] **Step 4:** コミット(`git add apps/web/e2e/flow.spec.ts`)

### Task 2: #47 recent_vectors の表・書き込み・期限の削除

**Files:**
- Modify: `apps/worker/src/db/schema.ts`(表 `recentVectors`)
- Create: `apps/worker/migrations/0009_*.sql`(drizzle-kit generate の生成物)・`apps/worker/migrations_rollback/0009_rollback.sql`・`apps/worker/migrations_rollback/README.md` の追記
- Create: `apps/worker/src/pipeline/recent-vectors.ts`
- Modify: `apps/worker/src/pipeline/consumer.ts`(第1段の本体・embedded_at の更新の直後)・`apps/worker/src/pipeline/cron.ts`(保持期間の処理)・`packages/shared/src/constants.ts`
- Test: `apps/worker/tests/pipeline-recent-vectors.test.ts`・`apps/worker/tests/migration.test.ts`(既存の形にならい0009を足す)

**Interfaces:**
- Produces(`recent-vectors.ts`):
  - `encodeVector(values: number[]): ArrayBuffer`(Float32Array の並び)・`decodeVector(blob: ArrayBuffer | Uint8Array): number[]`
  - `saveRecentVector(db: D1Database, intentId: string, embeddedAt: Date, values: number[]): Promise<void>`(同じ intent_id は上書き。例外を外へ出さず、失敗は `pipeline.recent_vector.failed`(error_code=errorCodeOf)のログだけ)
  - `deleteExpiredRecentVectors(db: D1Database, now: Date): Promise<number>`(embedded_at < now − RECENT_VECTOR_TTL_MS の行を消し件数を返す)
- 表 `recent_vectors`: `intent_id TEXT PRIMARY KEY REFERENCES intents(id) ON DELETE CASCADE`・`embedded_at INTEGER NOT NULL`(timestamp_ms)・`vector BLOB NOT NULL`。索引 `recent_vectors_embedded_at_idx(embedded_at)`

- [ ] **Step 1: 失敗する試験を書く**(`pipeline-recent-vectors.test.ts`)
  - `encodeVector`→`decodeVector` で1,024次元の値が float32 の精度で戻る
  - `saveRecentVector` を同じ intent_id で2回呼ぶと行は1つで、2回目の値になる
  - 意思の行を削除すると recent_vectors の行も消える(CASCADE。D1で外部キーが効くことを確かめる)
  - `deleteExpiredRecentVectors(db, now)` が embedded_at=now−15分−1ms の行を消し、now−15分+1ms の行を残し、消した件数1を返す
  - 第1段(`handleQueueBatch` で embedding_requested を消費)の成功の後、recent_vectors に意思の行があり、embedded_at が intents.embedded_at と等しい
  - recent_vectors への書き込みが失敗しても(表を一時的に壊す等ではなく、`saveRecentVector` が例外を出さないことを単体で確かめれば足りる)第1段は成功扱い
- [ ] **Step 2:** `pnpm --filter worker exec vitest run tests/pipeline-recent-vectors.test.ts` が失敗することを確かめる
- [ ] **Step 3:** 表・マイグレーション(drizzle-kit generate)・戻す手順・定数・`recent-vectors.ts` を実装する。第1段では embedded_at の更新が成功した(`updated.length > 0`)直後に、更新に使った時刻と `values` で `saveRecentVector` を呼ぶ(第1段の本体を共有するバックフィルも同じ経路で書かれる)。毎分Cronの保持期間の処理(`runRetentionSweep`)で `deleteExpiredRecentVectors` を呼び、件数をログの既存の形で出す
- [ ] **Step 4:** 試験が通る・`pnpm --filter worker exec vitest run tests/migration.test.ts` が通る・`pnpm typecheck`
- [ ] **Step 5:** コミット

### Task 3: #47 評価での補いと記録

**Files:**
- Modify: `apps/worker/src/pipeline/recent-vectors.ts`・`apps/worker/src/pipeline/evaluate.ts`(Layer 2 Candidate Retrieval の照会の直後)・`apps/worker/src/pipeline/metrics.ts`(または stage2 の計測の書き込みの箇所)・`apps/worker/src/logging/logger.ts`(許可リスト)
- Test: `apps/worker/tests/pipeline-recent-vectors.test.ts`(単体の追加)・`apps/worker/tests/pipeline-evaluate.test.ts`(統合)

**Interfaces:**
- Consumes: Task 2 の `decodeVector`・表 `recent_vectors`・`cosineSimilarity`(`src/vectorstore/similarity.ts`)・試験専用の `holdMemoryVectorWrites`/`releaseMemoryVectorWrites`(`src/vectorstore/memory.ts`)
- Produces:
  - `loadRecentVectors(db: D1Database, opts: { form: string; selfId: string; now: Date; limit: number }): Promise<{ id: string; values: number[] }[]>`(intents と結合し form 一致・status='active'・embedded_at ≥ now−RECENT_VECTOR_TTL_MS・自分以外を embedded_at の新しい順に limit 件)
  - `mergeSupplement(hits: { id: string; score: number }[], recent: { id: string; values: number[] }[], own: number[], topK: number): { hits: { id: string; score: number }[]; supplemented: number }`(hits に無い id だけ類似度を計算して加え、score降順・同点はid昇順で topK に切る。own と次元の違う行は読み飛ばす。supplemented は切った後に残った補いの件数)
  - 記録の項目名: `retrieval_count`(照会が返した件数・既存の値)と `supplement_count`(補って残った件数)。match_events.payload(stage2Payload)と `pipeline.stage2.timing`(または評価の完了のログ)に載せる

- [ ] **Step 1: 失敗する単体試験**(`mergeSupplement`)
  - 照会の結果にある id は重複させない(supplemented に数えない)
  - 補った行が類似度の順に混ざり、topK で切られる(topK=3・照会3件・補い2件で、補いの1件が上位に入ると supplemented=1)
  - 次元の違う行は読み飛ばす
- [ ] **Step 2: 失敗する統合試験**(`pipeline-evaluate.test.ts`)
  - `holdMemoryVectorWrites()` の後に相手Aの第1段を消費する(Aのベクトルは照会に出ないが、recent_vectors にはAの行がある)。その状態でBを評価すると、AがLayer 1以降へ進み提案が作られ、match_events の payload に `supplement_count: 1` が記録される
  - 同じ状態で、Aが paused・別form・embedded_at が15分より前・B自身 の場合は補わない(supplement_count: 0・提案なし)
  - Aが内容を直して version が上がった後も、補われたAは現在の version で候補行が作られる(古い版の候補にならない)
  - 照会の結果に既にAがあるとき(保留なし)は supplement_count: 0 で、結果は従来と同じ
- [ ] **Step 3:** 試験が失敗することを確かめる
- [ ] **Step 4:** 実装する。evaluate.ts の照会の直後に `loadRecentVectors`(limit=RECENT_VECTOR_SUPPLEMENT_MAX)→`mergeSupplement`(topK=PIPELINE.TOP_K_RETRIEVAL)をはさみ、以降は合わせた hits を従来どおり使う。`retrievalCount` は照会の件数のまま。recent_vectors の読み取りが失敗したら補いなしで続ける(ログ `pipeline.recent_vector.failed`・layer=load)。照会と並べて計測の段(timer.lap)を "supplement" として分ける
- [ ] **Step 5:** 試験が通る。`pnpm --filter worker exec vitest run tests/pipeline-evaluate.test.ts tests/pipeline-inline.test.ts tests/pipeline-reflection.test.ts` も通る
- [ ] **Step 6:** コミット

### Task 4: #32 Intent保存の往復を1回減らす

**Files:**
- Modify: `apps/worker/src/routes/intents.ts`(作成の上限の確認と挿入・`intents.create.timing`)・`apps/worker/src/logging/logger.ts`(必要なら)
- Test: `apps/worker/tests/intents-crud-api.test.ts`

**Interfaces:**
- 応答は変えない: active で上限(LIMITS.ACTIVE_INTENTS_PER_USER=5)に達しているときは 422 `ACTIVE_INTENT_LIMIT`(本文と `intents.create.rejected` のログも従来どおり)。draft は数えない

- [ ] **Step 1: 失敗する(または既存の振る舞いを固定する)試験**
  - active が4件ある利用者の5件目の作成は201・6件目は422 ACTIVE_INTENT_LIMIT
  - active が4件ある利用者が active の作成を `Promise.all` で同時に2件送ると、201が1件・422が1件で、active は5件
  - draft の作成は active が5件でも201
  - `intents.create.timing` に段 `auth`・`limit`(または1文にまとめた `insert`)が載る
- [ ] **Step 2:** 実装する。active の作成では、上限の確認と挿入を条件付きの1文(`INSERT INTO intents (…) SELECT … WHERE (SELECT count(*) FROM intents WHERE user_id = ? AND status = 'active') < 5 RETURNING …`。drizzle の insert…select か `sql` の生文)にまとめ、返った行が0なら 422。draft は従来の挿入。認証(KVの読み)と上限の段の所要時間を `intents.create.timing` に分けて載せる
- [ ] **Step 3:** `pnpm --filter worker exec vitest run tests/intents-crud-api.test.ts` と Intent 関係の既存の試験が通る
- [ ] **Step 4:** コミット

### Task 5: #43 削除と評価の競り合い

**Files:**
- Modify: `apps/worker/src/pipeline/evaluate.ts`(孤立したベクトルの削除の位置)・`apps/worker/src/pipeline/candidates.ts`
- Test: `apps/worker/tests/pipeline-evaluate.test.ts`(または新しい `pipeline-candidates.test.ts`)

**Interfaces:**
- Produces: `upsertCandidateRows` の振る舞いの拡張: batch が `errorCodeOf(error) === "D1_CONSTRAINT"` で失敗したら、行の相手の意思(intentAId・intentBId)のうち D1 に行の無いものを含む行を除いて1回だけやり直す。やり直しも失敗したら例外を外へ出す(従来どおり)。除いた行は戻り値の Map に入らない

- [ ] **Step 1: 失敗する試験**
  - `upsertCandidateRows` に、存在しない意思を参照する行1件と正常な行2件を渡すと、正常な2件が保存され戻り値に2件入り、例外を出さない
  - 全部の行が消えた相手のときは空の Map を返す
  - 評価全体: Layer 1 の後に相手の1人を削除した状況(上の関数の単体で足りる。統合では、相手を削除した直後に削除前に読んだ候補で評価が完了し他の候補の提案が作られることを、可能なら試験用の差し込み口なしで再現する。再現できなければ単体だけでよい)
- [ ] **Step 2:** 実装する。evaluate.ts の `deleteOrphanVectors` の呼び出しを `upsertCandidateRows` の後(候補行の保存の後)へ移す(消す対象の決め方は変えない)
- [ ] **Step 3:** 試験と `tests/pipeline-*.test.ts` が通る
- [ ] **Step 4:** コミット

### Task 6: #44 第1段のupsertのやり直しと削除の例外の分類

**Files:**
- Modify: `apps/worker/src/pipeline/errors.ts`・`apps/worker/src/pipeline/consumer.ts`(第1段の upsert)・`apps/worker/src/vectorstore/memory.ts`(試験専用のフック)
- Test: `apps/worker/tests/pipeline-errors.test.ts`・`apps/worker/tests/pipeline-consumer.test.ts`(または `pipeline-inline.test.ts`)

**Interfaces:**
- errors.ts の Vectorize の正規表現を `^VECTOR_(GET|UPSERT|DELETE)_ERROR \(code = (\d+)\)` に広げる(実際の Vectorize の削除の例外の文言が違えば、`vectorstore/vectorize.ts` の deleteByIds の例外をこの形に包む)
- memory.ts に試験専用 `failMemoryVectorUpserts(n: number): void`(次の n 回の upsert が `VECTOR_UPSERT_ERROR (code = 40041)` で失敗する・`resetMemoryVectorStore` で解除・index.ts からは再exportしない)
- 第1段の upsert は失敗したら PIPELINE.STAGE1_UPSERT_RETRY_DELAYS_MS(1秒・2秒)だけ待って最大2回やり直す。待ちは Clock ではなく `scheduler.wait`/`setTimeout`(試験では短くできるよう、遅延の配列を第1段の内部オプションで上書きできるようにしてよい)

- [ ] **Step 1: 失敗する試験**
  - `errorCodeOf(new Error("VECTOR_DELETE_ERROR (code = 40041)"))` が `VECTOR_DELETE_40041`
  - upsert が1回失敗して2回目に成功すると第1段は成功(embedded_at が書かれ、`pipeline.stage1.failed` が出ない)
  - 3回失敗すると第1段は従来どおり失敗(layer=upsert・error_code=VECTOR_UPSERT_40041)し、キューのやり直しへ回る
- [ ] **Step 2:** 実装・試験が通る・`tests/pipeline-*.test.ts` が通る
- [ ] **Step 3:** コミット

### Task 7: #45 削除の後の保留の解放

**Files:**
- Modify: `apps/worker/src/latches/release.ts`・`apps/worker/src/latches/cancel-open.ts`(`releaseAfterCancel` から予算を渡す)
- Test: `apps/worker/tests/latches-release.test.ts`・`apps/worker/tests/latches-delete.test.ts`

**Interfaces:**
- `releaseHeld(db, now, userIds?, opts?: { budgetMs?: number }): Promise<number>`(既存の呼び出しは opts なしで従来どおり。`releaseAfterCancel` は `{ budgetMs: PIPELINE.RELEASE_AFTER_DELETE_BUDGET_MS }` を渡す)
- 走査の順番・各保留の判断(期限・対象時刻・参加者の状態・提示の上限 `canPresent`・昇格 `promote`)は変えない

- [ ] **Step 1: 失敗する試験**
  - 対象の保留が30件あるとき、`releaseHeld` が意思の行と参加者の行を走査の前にまとめて読む(D1 の select の回数が保留の件数に比例しない。D1 の呼び出しを数える包みか、ログの段の回数で確かめる)
  - 通知上限に届いた参加者を含む保留は昇格せず、その参加者を含む後続の保留では `canPresent` の照会を省く(結果は従来と同じ)
  - `budgetMs: 0` 相当(極小)を渡すと、走査は途中で止まり、残りの保留は candidate のまま(毎分Cronの `releaseHeld` で後から昇格する)
  - 既存の `latches-release.test.ts`・`latches-delete.test.ts`・#27 の試験が全部通る
- [ ] **Step 2:** 実装する。`heldTargets` の後に、対象の全保留の `intentIds` の意思の行(チャンク分割)と `latchMembers` の行をまとめて読み、`releaseOne` はそれを引数で受け取る。`canPresent` が false だった参加者を記憶し、その参加者を含む保留は照会せずに飛ばす(promote で上限が増える方向には変わらないため安全)。予算は `performance.now()` で測り、超えたら残りを処理せず返す(ログ `release.budget_exhausted` に残り件数)
- [ ] **Step 3:** 試験が通る
- [ ] **Step 4:** コミット

### Task 8: #42 外部送信の集計のやり直し

**Files:**
- Modify: `apps/worker/src/llm/external-send.ts` のみ(`llm/mode.ts` は変えない)
- Test: `apps/worker/tests/` の既存の外部送信の試験(`rg -l recordExternalSend apps/worker/tests` で探す)へ追加

**Interfaces:**
- `recordExternalSend` の契約は変えない(例外を外へ出さない)
- 失敗が `errorCodeOf(error)` で `D1_OVERLOADED`・`D1_BUSY`・`D1_RESET` のときだけ、50ms・100ms 待って最大2回やり直す(待ちの合計は最大150ms)。それ以外はやり直さない
- 失敗のログ `external_send.record.failed` の error_code は `errorCodeOf(error)` の値

- [ ] **Step 1: 失敗する試験**(D1 の包みで失敗を差し込む)
  - 1回目が D1_OVERLOADED・2回目が成功 → count が1増え、失敗のログが出ない
  - 3回とも D1_OVERLOADED → 例外を出さず、ログの error_code が `D1_OVERLOADED`
  - D1_CONSTRAINT は1回で諦める
- [ ] **Step 2:** 実装・試験が通る。`git diff --stat` に `llm/mode.ts` と FINGERPRINT_FILES の対象が含まれないことを確かめる
- [ ] **Step 3:** コミット

### Task 9: #46 チャットの接続の切断の記録

**Files:**
- Modify: `tools/load/scenarios/c-chat.js`・`tools/load/report.mjs`・`apps/worker/src/do/chat.ts`(`webSocketClose`/`webSocketError`)・`apps/worker/src/logging/logger.ts`(許可リスト)
- Test: `tools/load/report.test.mjs`・`apps/worker/tests/chat-do.test.ts`・`apps/worker/src/logging/logger.test.ts`

**Interfaces:**
- k6 の指標: `chat_closed_early`(Counter・open の後、予定の保持時間の前に閉じた接続)・`chat_close_code`(閉じた理由のコードごとの件数が分かる形。Counter にタグ `code` を付ける)・`chat_hold_ms`(Trend・open から close までのミリ秒)
- report.mjs: (c)の報告に、途中で閉じた接続の数・理由のコード別の件数・保持時間の最小とp50を出す(既存の chat の表の形にならう)
- ChatRoomDO: 接続が閉じたときに `chat.ws.closed`(close_code・hold_ms・latch_id)を出す。個人情報(本文・利用者の表示名)は出さない。hold_ms は接続の受け入れ時刻を接続の添付(serializeAttachment)に持たせて計算する
- 製品の動き(送信・配信・閉じ方)は変えない

- [ ] **Step 1: 失敗する試験**: report.test.mjs に、途中で閉じた接続を含む k6 の要約を入れると新しい行が出る試験。chat-do.test.ts に、接続を閉じると `chat.ws.closed` のログが close_code 付きで出る試験。logger の許可リストの試験
- [ ] **Step 2:** 実装・試験が通る(`pnpm test`)
- [ ] **Step 3:** コミット

### Task 10: 文書と手元の全体の確認

**Files:**
- Modify: `docs/05-data-model-api.md`(§2 recent_vectors)・`docs/06-matching-pipeline.md`(§2 既知の制約と補い・§3 Layer 2 Candidate Retrieval の補い・§7 retrieval_count・supplement_count・第1段のupsertのやり直し・保留の解放の予算)・`docs/12-development-roadmap.md`(§2 第4回の工程の行とオーナー決定(#47 案2b)を決定内容/根拠/影響の形で)・`docs/00-document-roadmap.md`(§1 の版数表)・前提文書欄を持つ他の文書(版数の同期)
- 設計書 §0.3 のオーナー決定を根拠に書く。結果(負荷試験)は Task 11・12 で書く

- [ ] **Step 1:** 文書を改める(docs/00 §3 の規則)
- [ ] **Step 2:** `pnpm lint`・`pnpm typecheck`・`pnpm test`・`pnpm --filter web build`・`pnpm --filter worker test:e2e`・`pnpm --filter web test:e2e` がすべて通る。落ちたら原因を直す(製品の不具合なら直し、試験の不安定さなら記録してコントローラーへ報告)
- [ ] **Step 3:** コミット

### Task 11: 負荷試験の流し直し(staging)

コントローラーがオーナーの承認(push・stagingへの反映・費用の概算 約2米ドル・約2時間)を得てから担当へ渡す。

- [ ] **Step 1:** push の後、CI(ci・web-e2e・deploy-staging)の成功と stagingへの反映を確かめる。マイグレーション0009が staging の D1 に適用されていることを確かめる(手順書 `docs/runbooks/staging.md` の方法で。適用が CI に含まれなければコントローラーへ報告し、適用はオーナーの承認を得てから)
- [ ] **Step 2:** `wrangler tail` を全区間で取る(記録は `.superpowers/sdd/<この計画の作業場所>/tail/`・管理外)
- [ ] **Step 3:** 小さな確かめ: (b)を LOAD_SCALE=0.2・PROPOSAL_WAIT_SEC=540 で流して集計し、supplement_count の記録が出る・pipeline.inline.failed 0件・push.failed 0件・D1_OVERLOADED 0件を確かめる。満たさなければ止めて報告(BLOCKED)
- [ ] **Step 4:** 全規模: 手順書7章どおり(後始末→(a)→後始末→(b)→8分以上待って集計→後始末→(d)→8分以上待って集計→後始末→(c)→集計→後始末)。k6 は `tools/load/run.mjs` 経由。集計(report.mjs)は後始末の前に行い、失敗したら後始末しない
- [ ] **Step 5:** 外部送信の件数(usage_counters の差・日付をまたげば両日を足す)と費用の概算
- [ ] **Step 6:** 指標を集める: 01 §20 の各項目のp95と前回(§10)との比較・#47(初期判定(相手が先に反映済み)の遅い標本・supplement_count が1以上で提案になった件数・「同時」の参考値)・#32(保存の段ごとの内訳)・#43(D1_CONSTRAINT)・#44(VECTOR_UPSERT・VECTOR_DELETE の件数)・#45(release の p95・最大・release.budget_exhausted)・#42(external_send.record.failed)・#46(途中で閉じた接続・理由のコード)
- [ ] **Step 7:** 報告書 `docs/reports/f8b-load-test.md` に「## 11. 不具合の修正工程(第4回)の後の測り直し」を §10 と同じ構成で追記し、新しく見つけた不具合は「登録すべき新しい不具合」に書く(issue はコントローラーが登録)。秘密を書かない。tail を止め、`load-` の利用者の意思が0件であることを確かめる
- [ ] **Step 8:** コミット(`docs/reports/f8b-load-test.md` のみ・push しない)

### Task 12: 状態の更新とissue(コントローラー)

- [ ] **Step 1:** 02 §4 #33: 01 §20 の項目がすべて目標内なら完了。残るなら目標外の項目とissueを明記する
- [ ] **Step 2:** 12 §2・10 §5・00・AGENTS.md・報告書の冒頭に第4回の記録と #33 の状態を書く(版数の規則)
- [ ] **Step 3:** 対象の issue(#32・#37・#42〜#47)に結果を書いて閉じる。直っていないものは開いたまま理由を書くか、オーナーと扱いを決めて記録する
- [ ] **Step 4:** コミット。push はオーナーの承認を得てから
