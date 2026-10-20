# F4a 1対1の提案〜成立 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F3の第2段評価の後段にLayer 4 Jev(stub)・Layer 5・提案化・通知上限と保留・回答・双方YES成立・期限切れ・機会の排他・再提案を実装し、ゲート#12・#14・#15・#18・#19・#20・#23と#17のAPI部分(02 §4)をworker E2Eで証明する。

**Architecture:** `evaluateIntent`(L2→L1→L3→match_candidates保存)の末尾で、`src/jev/`の実行器(K_j=8・並列・フォールバック・予算・circuit breaker)→`pipeline/layer5.ts`(H再検証・L算出・ペア単位の最大1件)→`src/latches/propose.ts`(proposal_historyの確保を条件とする1バッチ書き込み・提示/保留)を同一処理内で呼ぶ。回答は`src/latches/respond.ts`の状態遷移(1バッチ・YES数をDB内で数える)を`src/routes/latches.ts`から呼ぶ。期限切れ・保留の解放・予算アラートは毎分Cronに追加する。

**Tech Stack:** TypeScript(strict)・Hono・Zod v4(shared)・Drizzle(D1・`db.batch`)・KV・Queues・Cron Triggers・Analytics Engine・vitest(vitest-pool-workers)・Playwright(APIレベルE2E)。

**Spec:** `docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md`(本計画の正本。以下「spec」)。根拠は spec 冒頭の正本欄(01 §8・§10・§13 / 05 §2.2・§3 / 06 §2〜§6 / 07 §2・§5 / 02 §4)。

## Global Constraints

- コミットは `git add <パス>` で対象限定(`git add -A`・`-a`禁止)。コミットメッセージは日本語・接頭辞「F4a: 」・末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 毎コミット: `pnpm lint`・`pnpm typecheck`・`pnpm test` が緑。字下げタブ・文字列ダブルクォート。コメントは「docs/NN §x」で根拠参照(既存慣習)
- 時刻の規律(04 §4): 製品コードは`Clock`注入。`Date.now()`/`new Date()`直接呼び出し禁止(ルートとindex.tsのエントリのみsystemClock)
- ログ規律(08 §6): `createLogger`の許可8フィールドのみ。user_id・topic・表示名・raw_text・座標はログ・Analytics Engine・match_events.payloadに出さない
- **課金ゼロ原則**: vitest・E2E・CIはstub Jevのみ。`LATCH_LLM_MODE=real`は従前どおり`LLM_REAL_NOT_IMPLEMENTED`例外(real接続はF9前の独立工程・spec §0.2)
- 数値(spec・docsどおり): 閾値 L > 0.60(0.60ちょうどは提案しない)・K_j=8・C=1・Jev予算 1Intent/日40回・1ユーザー/日120回・全体1日30,000回・1か月600,000回・アラート80%・breaker 5分窓10連続失敗で30分オープン・通知上限 1ユーザー1日6件(JST)・1Intent同時進行3件・機会は対象時刻まで75分未満なら提案しない・回答期限 機会=min(max(提示+15分, min(提示+2時間, 対象時刻−60分)), Intent期限最小)/つながり=min(提示+24時間, Intent期限最小)・再提案抑制 min(24時間, (対象時刻−見送り時刻)/2)・Cron1走査上限500件・usage_counters保持90日・pending残留掃査10分・バックフィル連続5件失敗で打ち切り
- マイグレーションは「戻すマイグレーション」(`migrations_rollback/NNNN_rollback.sql`)と対で作る(12 §4.2)
- エラー応答は05 §3.1の形状のみ(`errorJson`)。参加しない・存在しない・保留中(candidate)のLATCHは一律404
- **F4aスコープ外**(spec §0.3): グループ(F4b)・画面(F4c)・completed判定(F5)・#21の証明(F5)・feedback/DELETE latch(F5)・チャット(F6)・Web Push/GET notifications/ブロック通報API/geofeatures取り込み(F7)・Parser/Jev real(F9前)

## Review Focus

1. **両側のイベントが同時に同じペアを提案しようとする**(AとBがほぼ同時にIntentを作成し、双方の評価が互いを候補にする)→ LATCHは1件だけ・proposal_historyは1行 → Task 10の「並行2回呼び出しで1件」試験
2. **回答期限を過ぎたがCronがまだ走っていない提案への回答** → 400 deadline_passed で拒否され、状態は変わらない → Task 13
3. **Jev実行中〜提案化までの間にIntentがpause・削除・期限切れ・ブロック** → Layer 5のH再検証で提案されない → Task 11
4. **retractと相手のYESの競合**(相手のYESでmatchedになった直後に自分のretractが届く)→ matchedが維持され、retractは400 invalid_status → Task 13
5. **機会Intentが成立した後、そのIntentを含む保留中の提案が残る** → 排他で cancelled となり、以後の保留解放で提示されない → Task 13・Task 12

---

## ファイル構成

| 区分 | パス | 責務 |
|---|---|---|
| 作成 | `apps/worker/migrations/0003_latch_proposal.sql` / `migrations_rollback/0003_rollback.sql` | spec §6の列・索引 |
| 作成 | `apps/worker/src/pipeline/errors.ts` | `errorCodeOf`の共通化(掃除3) |
| 作成 | `apps/worker/src/jev/budget.ts` | usage_countersの予算加算・判定 |
| 作成 | `apps/worker/src/jev/breaker.ts` | circuit breaker(KV) |
| 作成 | `apps/worker/src/jev/runner.ts` | K_j枠・並列・フォールバック・計測 |
| 作成 | `apps/worker/src/pipeline/layer4.ts` | Jev対象選択・再利用・jev_result保存 |
| 作成 | `apps/worker/src/pipeline/layer5.ts` | L算出・閾値・ペア最大1件・H再検証 |
| 作成 | `apps/worker/src/latches/deadline.ts` | 回答期限・75分判定・対象時刻 |
| 作成 | `apps/worker/src/latches/content.ts` | latches.proposalの組み立て |
| 作成 | `apps/worker/src/latches/region.ts` | 座標→地名の逆引き |
| 作成 | `apps/worker/src/latches/caps.ts` | 通知上限の判定 |
| 作成 | `apps/worker/src/latches/propose.ts` | 履歴確保+1バッチ書き込み・提示/保留 |
| 作成 | `apps/worker/src/latches/close.ts` | クローズ共通(状態・履歴・closed通知・状態記録) |
| 作成 | `apps/worker/src/latches/release.ts` | 保留の解放・保留の期限切れ |
| 作成 | `apps/worker/src/latches/respond.ts` | 回答・取り消し・leave・見送り理由・成立後処理 |
| 作成 | `apps/worker/src/latches/view.ts` | LatchDTOへの変換(表示範囲) |
| 作成 | `apps/worker/src/routes/latches.ts` | `/v1/latches`系API |
| 変更 | `apps/worker/src/db/schema.ts` | 追加列・索引 |
| 変更 | `packages/shared/src/constants.ts` / `schema.ts` | `LATCH`定数・LatchDTO等のzod |
| 変更 | `apps/worker/src/llm/types.ts` / `mode.ts` / `stub/jev.ts` | Jevの非同期化・失敗型・目印 |
| 変更 | `apps/worker/src/clock/clock.ts` | `jstMonthKey`・`jstDayStart` |
| 変更 | `apps/worker/src/pipeline/evaluate.ts` / `consumer.ts` / `cron.ts` / `events.ts` / `metrics.ts` | 後段連結・掃除・Cron追加 |
| 変更 | `apps/worker/src/routes/intents.ts` | 削除時のLATCH取り消し |
| 変更 | `apps/worker/src/routes/dev.ts` | backdate・観測拡張 |
| 変更 | `apps/worker/src/env.ts` / `wrangler.jsonc` / `src/index.ts` | `PIPELINE_KV`・ルート登録 |
| 作成 | `apps/worker/e2e/latches.spec.ts` | ゲートE2E |

---

### Task 1: マイグレーション0003・定数・KVバインディング

**Files:**
- Create: `apps/worker/migrations/0003_latch_proposal.sql`(drizzle-kit generateで生成)・`apps/worker/migrations_rollback/0003_rollback.sql`
- Modify: `apps/worker/src/db/schema.ts`(latchStatusEvents・latches・proposalHistory・notifications)・`packages/shared/src/constants.ts`・`packages/shared/src/constants.test.ts`・`apps/worker/src/clock/clock.ts`・`apps/worker/src/env.ts`・`apps/worker/wrangler.jsonc`
- Test: `apps/worker/tests/migration.test.ts`・`apps/worker/src/clock/clock.test.ts`(既存なら追記)

**Interfaces:**
- Produces:
  - schema列: `latchStatusEvents.latchId`(text 26 notNull)・`fromStatus`(LatchStatus|null)・`toStatus`(LatchStatus notNull)/ `latches.proposedAt`(timestamp_ms null可)/ `proposalHistory.updatedAt`(timestamp_ms notNull・既存行は`created_at`で埋める)
  - 索引: `latches_status_response_deadline_idx`(status, response_deadline)・`latches_status_proposed_at_idx`(status, proposed_at)・`notifications_user_id_type_created_at_idx`(user_id, type, created_at)・`latch_status_events_latch_id_idx`(latch_id)
  - `LATCH` 定数(shared): `{ THRESHOLD: 0.6, CALIBRATION_C: 1, JEV_CALLS_PER_EVENT: 8, CONCURRENT_PER_INTENT: 3, OCCASION_MIN_LEAD_MS: 75*60_000, OCCASION_DEADLINE_MIN_MS: 15*60_000, OCCASION_DEADLINE_MAX_MS: 2*60*60_000, OCCASION_DEADLINE_BEFORE_START_MS: 60*60_000, CONNECTION_DEADLINE_MS: 24*60*60_000, REPROPOSAL_SUPPRESSION_MAX_MS: 24*60*60_000, BREAKER_WINDOW_MS: 5*60_000, BREAKER_FAILURES: 10, BREAKER_OPEN_MS: 30*60_000, BUDGET_ALERT_RATIO: 0.8, COUNTER_RETENTION_DAYS: 90, PENDING_STALE_MS: 10*60_000, BACKFILL_FAILURE_ABORT: 5 }`(1日6件は既存`LIMITS.NOTIFICATIONS_PER_DAY`、Jev予算は既存`LIMITS.JEV_*`を使う)
  - `DEFER_REASONS = ["no_capacity","schedule_mismatch","just_not_now","other"] as const`・`type DeferReason`(shared)
  - `jstMonthKey(d: Date): string`(`YYYY-MM`)・`jstDayStart(d: Date): Date`(当日JST 0時のUTC時刻)(clock.ts)
  - `Env.PIPELINE_KV: KVNamespace`(wrangler.jsoncのkv_namespacesへ`PIPELINE_KV`・id=ゼロ埋め32桁プレースホルダ・コメント「circuit breaker・予算アラートの送信済み印(docs/06 §5・§6)」)

- [ ] **Step 1: 失敗する試験を書く** — `migration.test.ts`へ「0003適用後、latch_status_eventsにlatch_id/from_status/to_status、latchesにproposed_at、proposal_historyにupdated_atがあり、4索引が存在する」(PRAGMA table_info / index_list で確認)。`constants.test.ts`へ`LATCH`の値の`toEqual`。clockへ`jstMonthKey(new Date("2026-10-31T15:00:00Z")) === "2026-11"`・`jstDayStart(new Date("2026-10-20T16:00:00Z")).toISOString() === "2026-10-20T15:00:00.000Z"`
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/migration.test.ts` / `pnpm --filter @latch/shared exec vitest run` → FAIL
- [ ] **Step 3: schema.ts・定数・clock・env・wranglerを実装し、`pnpm --filter worker exec drizzle-kit generate --name latch_proposal`で0003を生成。** proposal_history.updated_atのNOT NULL追加は生成SQLが表再作成になる場合、既存行を`created_at`で埋める`INSERT … SELECT`を確認する。rollbackは0002_rollbackの書式に倣い列・索引を戻す
- [ ] **Step 4: 通過を確認** — 同コマンド → PASS。`pnpm typecheck` 緑
- [ ] **Step 5: コミット** — `git add apps/worker/migrations apps/worker/migrations_rollback apps/worker/src/db/schema.ts packages/shared/src apps/worker/src/clock apps/worker/src/env.ts apps/worker/wrangler.jsonc apps/worker/tests/migration.test.ts` → `F4a: 提案化のマイグレーション0003と定数・PIPELINE_KVを追加`

### Task 2: F3掃除リスト1・2・3・5

**Files:**
- Create: `apps/worker/src/pipeline/errors.ts`
- Modify: `apps/worker/src/pipeline/consumer.ts`・`cron.ts`・`events.ts`(と`emitMatchEvent`の全呼び出し元: `rg -n "emitMatchEvent\(" apps/worker/src`)
- Test: `apps/worker/tests/pipeline-consumer.test.ts`・`pipeline-events.test.ts`

**Interfaces:**
- Produces: `errorCodeOf(error: unknown, fallback?: string): string`(errors.ts。Errorのmessageが`/^[A-Z_]+(?::|$)/`で始まればその接頭辞、それ以外はfallback既定`"INTERNAL"`)。`emitMatchEvent(env, params, options, clock: Clock)`(第4引数にClock・createdAtは`clock.now()`)

- [ ] **Step 1: 失敗する試験** — (a) `errorCodeOf(new Error("EMBEDDING_FAILED: x")) === "EMBEDDING_FAILED"`・`errorCodeOf("x") === "INTERNAL"`・`errorCodeOf(new Error("boom"), "EMBEDDING_FAILED") === "EMBEDDING_FAILED"` (b) pipeline-events: fixedClockで発行した行の`created_at`が固定時刻 (c) pipeline-consumer: embedding_completed消費でevaluateIntentが例外のとき`pipeline.stage2.failed`ログ(console spy)が出て`stage1.failed`は出ない・`stage1.completed`ログに`count`がある
- [ ] **Step 2: 失敗を確認** — Run: `pnpm --filter worker exec vitest run tests/pipeline-consumer.test.ts tests/pipeline-events.test.ts` → FAIL
- [ ] **Step 3: 実装** — consumer/cronの`errorCodeOf`をerrors.tsへ置換(cronは`"INTERNAL"`、Embedding経路は`"EMBEDDING_FAILED"`をfallbackに渡して従来値を保つ)。consumeEventのembedding_completed枝をtry/catchで囲み`pipeline.stage2.failed`を出して`markFailed`。emitMatchEventへClock引数を追加し呼び出し元はsystemClock(ルート)/注入Clock(pipeline)を渡す
- [ ] **Step 4: 通過を確認** — `pnpm --filter worker exec vitest run` → PASS
- [ ] **Step 5: コミット** — `F4a: F3掃除(stage2失敗ログ分離・errorCodeOf共通化・emitMatchEventのClock引数化)`

### Task 3: Jevの差し替え口とstub

**Files:**
- Modify: `apps/worker/src/llm/types.ts`・`mode.ts`・`stub/jev.ts`・`stub/jev.test.ts`・`mode.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type JevFailureKind = "timeout" | "rate_limited" | "overloaded" | "invalid_output" | "other";
  export type JevOutcome = { ok: true; axes: JevAxes } | { ok: false; kind: JevFailureKind };
  export type JevFn = (input: JevInput) => Promise<JevOutcome>;
  // Llm.jev を { primary: JevFn; fallback: JevFn } に変更
  ```
  `stubJev: JevFn`・`JEV_LOW_MARKER = "__jev_low__"`(既存)・`JEV_TIMEOUT_MARKER = "__jev_timeout__"`(新設)
- 切替対象: `isFallbackEligible(kind: JevFailureKind): boolean`(timeout/rate_limited/overloaded のみtrue・07 §5)を types.ts に置く

- [ ] **Step 1: 失敗する試験** — stub: 既定で`{ok:true}`かつ7軸0.9 / normalizedAかBが`__jev_low__`始まりで0.3 / どちらかが`__jev_timeout__`始まりで`{ok:false, kind:"timeout"}` / 同一入力で同一出力。`isFallbackEligible`の5種の真偽。mode: `createLlm(stub env).jev.primary`と`.fallback`が関数
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run src/llm` → FAIL
- [ ] **Step 3: 実装** — stubJevを`async`に。primary・fallbackの両方にstubJevを割り当てる
- [ ] **Step 4: 通過を確認** — 同上 → PASS・`pnpm typecheck`緑
- [ ] **Step 5: コミット** — `F4a: Jevの差し替え口を非同期・失敗型付きにしstubへtimeout目印を追加`

### Task 4: Jev予算(usage_counters)

**Files:**
- Create: `apps/worker/src/jev/budget.ts`・`apps/worker/src/jev/budget.test.ts`(vitest-pool-workersのD1を使う統合試験。既存単体試験の置き場の慣習に合わせ、D1が要るなら`apps/worker/tests/jev-budget.test.ts`へ)

**Interfaces:**
- Produces:
  ```ts
  export type JevBudgetScope = "jev_intent" | "jev_user" | "jev_global_daily" | "jev_global_monthly";
  export type BudgetResult = { ok: true } | { ok: false; exhausted: JevBudgetScope };
  export const reserveJevCall = (db: DrizzleD1Database, origin: { intentId: string; userId: string }, now: Date): Promise<BudgetResult>;
  ```
  4行を`INSERT … ON CONFLICT(scope,key,period) DO UPDATE SET count = count + 1 RETURNING count`で1回ずつ加算(db.batchで1往復)。上限は`LIMITS.JEV_PER_INTENT_PER_DAY`等。加算後の値が上限を**超えた**ら(> 上限)ok:false。period: 日次=`jstDayKey(now)`・月次=`jstMonthKey(now)`・global keyは`"-"`

- [ ] **Step 1: 失敗する試験** — 40回目までok・41回目に`{ok:false, exhausted:"jev_intent"}` / 同一ユーザーの別Intent3つで計121回目に`jev_user` / JSTの日付が変わると(now+1日)再びok / global_dailyの行を29,999に事前INSERTして2回目で`jev_global_daily`
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: Jev予算の4カウンタ加算と判定を追加`

### Task 5: circuit breaker

**Files:**
- Create: `apps/worker/src/jev/breaker.ts`・`apps/worker/tests/jev-breaker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BREAKER_KEY = "jev:breaker";
  export const isBreakerOpen = (kv: KVNamespace, now: Date): Promise<boolean>;
  export const recordJevOutcome = (kv: KVNamespace, ok: boolean, now: Date): Promise<void>;
  ```
  KV値はJSON `{failures: number, windowStartMs: number, openUntilMs: number | null}`。失敗: `now - windowStartMs > BREAKER_WINDOW_MS`なら`failures=1, windowStartMs=now`、そうでなければ+1。`failures >= BREAKER_FAILURES`で`openUntilMs = now + BREAKER_OPEN_MS`。成功: failures=0・openUntilMsは保持(オープン中の成功はあり得ない)。`isBreakerOpen`は`openUntilMs !== null && now < openUntilMs`

- [ ] **Step 1: 失敗する試験** — 9連続失敗でclosed・10回目でopen / openから30分後にclosed / 失敗5回→5分超経過→失敗5回でclosed(窓リセット)/ 失敗9回→成功→失敗1回でclosed
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: Jevのcircuit breakerをKVで実装`

### Task 6: Jev実行器

**Files:**
- Create: `apps/worker/src/jev/runner.ts`・`apps/worker/tests/jev-runner.test.ts`

**Interfaces:**
- Consumes: `JevFn`・`isFallbackEligible`(Task 3)・`reserveJevCall`(Task 4)・`isBreakerOpen`/`recordJevOutcome`(Task 5)
- Produces:
  ```ts
  export interface JevTarget { key: string; input: JevInput }   // keyはmatch_candidates.id
  export type JevHeldReason = "budget" | "breaker" | "failed" | "cap";
  export interface JevRunResult {
    axes: Map<string, JevAxes>;
    calls: number;                               // 実呼び出し数(フォールバック含む・≤8)
    held: Record<JevHeldReason, number>;
    latencyMs: number;
  }
  export const runJev = (
    deps: { jev: { primary: JevFn; fallback: JevFn }; db: DrizzleD1Database; kv: KVNamespace; clock: Clock },
    origin: { intentId: string; userId: string },
    targets: JevTarget[],   // Layer 3スコア降順で渡される
  ): Promise<JevRunResult>;
  ```
- 枠の規則(spec §2.3): 枠=`LATCH.JEV_CALLS_PER_EVENT`。ループ「待ち行列=フォールバック待ち(先)+未実行の対象(後)。`n = min(枠, 待ち行列長)`件を取り出し、各件で`reserveJevCall`→okなら呼び出し(並列)→`recordJevOutcome`、枠-=n」を枠0か待ち行列空まで繰り返す。開始時と各波の前に`isBreakerOpen`ならその時点の残り全件を`breaker`保留。予算切れ(1件でもok:false)以降の残りは`budget`保留(呼び出さない)。第一候補失敗で`isFallbackEligible`ならフォールバック待ちへ、そうでなければ`failed`。フォールバックの失敗は`failed`。枠切れで残った対象は`cap`

- [ ] **Step 1: 失敗する試験** — (a) 対象20件・全成功 → calls=8・axes.size=8・held.cap=12 (b) 対象3件で1件が`__jev_timeout__`(primaryがtimeout・fallbackは成功するfakeを注入)→ calls=4・axes.size=3 (c) primary・fallbackとも`{ok:false,kind:"timeout"}`のfake・対象2件 → calls=4・held.failed=2 (d) primaryが`invalid_output`を返すfake → フォールバックせずheld.failed=1・calls=1 (e) breakerを事前にopen → calls=0・held.breaker=対象数 (f) jev_intentの当日カウンタを40に事前設定 → calls=0・held.budget=対象数 (g) 8件の呼び出しが並列であること(各呼び出しが50ms待つfakeで、clockではなく呼び出し開始順の記録により全8件の開始が最初の完了より前であることを確認)
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: Jev実行器(K_j=8枠・並列・フォールバック・予算・breaker)を追加`

### Task 7: Layer 4(対象選択・再利用・保存)

**Files:**
- Create: `apps/worker/src/pipeline/layer4.ts`・`apps/worker/tests/pipeline-layer4.test.ts`

**Interfaces:**
- Consumes: `runJev`(Task 6)・`buildNormalizedText`(normalize.ts)
- Produces:
  ```ts
  export interface L4Candidate { rowId: string; origin: IntentRow; other: IntentRow; cheapScore: number }  // rowId=match_candidates.id
  export interface L4Result { axesByRow: Map<string, JevAxes>; reused: number; run: JevRunResult }
  export const runLayer4 = (env: Env, clock: Clock, candidates: L4Candidate[]): Promise<L4Result>;
  ```
  候補(Layer 3降順)ごとに match_candidates行の`jev_result`を読み、非nullなら再利用(`reused`+1・Jev呼ばない)。nullのものだけ`JevTarget`にする。JevInputの`normalizedA/B`は**行の正規化順**(intent_a=小さいid側)で作る。実行結果を`UPDATE match_candidates SET jev_result=? , updated_at=? WHERE id=?`で保存。Jev関数は`createLlm(env, clock).jev`、kvは`env.PIPELINE_KV`

- [ ] **Step 1: 失敗する試験** — (a) jev_result既存の行は再利用されcalls=0 (b) 新規行はjev_resultに7軸すべての数値が保存され`would_a_accept_b`・`would_b_accept_a`を含む(#15の根拠)(c) intent_aがoriginでない行で、JevInput.normalizedAがintent_a側のテキスト(`__jev_low__`をintent_a側topicに置き、両方向とも0.3になることで確認)
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: Layer 4(Jev対象選択・jev_result再利用と保存)を追加`

### Task 8: Layer 5(スコア・選択・H再検証)

**Files:**
- Create: `apps/worker/src/pipeline/layer5.ts`・`apps/worker/src/pipeline/layer5.test.ts`(純関数部分)・`apps/worker/tests/pipeline-layer5.test.ts`(H再検証)

**Interfaces:**
- Consumes: `fetchL1Data`・`layer1Judge`・`pairKey`(layer1.ts)
- Produces:
  ```ts
  export const latchScore = (axes: JevAxes, h: 0 | 1): number;   // h × min(would_a_accept_b, would_b_accept_a) × LATCH.CALIBRATION_C
  export interface L5Item { rowId: string; pair: string; score: number }   // pair=pairKey(userA,userB)
  export const pickProposals = (items: L5Item[]): L5Item[];   // score > LATCH.THRESHOLD のみ・pairごとに最大1件(同点はrowId昇順)・score降順(同点rowId昇順)
  export const recheckHard = (db: DrizzleD1Database, originId: string, otherIds: string[], now: Date): Promise<Set<string>>;
  ```
  `recheckHard`は起点Intentを**読み直し**(active以外なら空集合)、`fetchL1Data`+`layer1Judge`で合格したotherIdの集合を返す

- [ ] **Step 1: 失敗する試験** — latchScore: `{would_a_accept_b:0.9, would_b_accept_a:0.7,…}`で0.7・h=0で0。pickProposals: 0.6ちょうどは除外・0.61は残る / 同pairの0.8と0.9で0.9のみ / 出力がscore降順。recheckHard: 候補側をpaused・blocks行追加・proposal_history(outcome=rejected)追加・起点をexpiredにした各ケースで除外
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装** — latchScoreの算出後、match_candidates.latch_scoreへの保存は呼び出し側(Task 11)
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: Layer 5(LATCH Score・閾値・ペア単位選択・H再検証)を追加`

### Task 9: 提案の純関数(期限・中身・地名)

**Files:**
- Create: `apps/worker/src/latches/deadline.ts`・`deadline.test.ts`・`content.ts`・`content.test.ts`・`region.ts`・`apps/worker/tests/latches-region.test.ts`
- Modify: `packages/shared/src/schema.ts`(LatchProposal型)

**Interfaces:**
- Produces:
  ```ts
  // deadline.ts
  export const occasionTargetAt = (a: IntentRow, b: IntentRow): Date;   // 遅い方のstarts_at
  export const minExpiry = (a: IntentRow, b: IntentRow): Date;
  export const responseDeadline = (form: IntentForm, presentedAt: Date, targetAt: Date | null, minIntentExpiry: Date): Date;
  export const isTooLate = (targetAt: Date, now: Date): boolean;      // targetAt - now < 75分
  // content.ts(shared schema.tsにlatchProposalSchema/型LatchProposalを定義して使う)
  // LatchProposal = { form, topic: string|null, time_window: {start: string, end: string}|null, region_name: string|null,
  //                   participants: {min: number, max: number}, budget: {min: number, max: number}|null }
  export const baseIntentOf = (a: IntentRow, b: IntentRow): IntentRow;  // created_atの早い方・同値はid昇順
  export const buildProposal = (a: IntentRow, b: IntentRow, regionName: string | null): LatchProposal;
  // region.ts
  export const gridKeyOf = (lat: number, lng: number): string;   // `${Math.floor(lat*100)}_${Math.floor(lng*100)}`(05へ記録)
  export const lookupRegionName = (db: DrizzleD1Database, center: { lat: number; lng: number }): Promise<string | null>;
  ```
  - time_window: 機会のみ。start=遅い方のstarts_at、end=早い方の終端(ends_at ?? expires_at)。ISO文字列
  - participants: `{min: max(minA,minB), max: min(maxA,maxB)}`。budget: 機会かつ双方非nullのときのみ共通区間(無ければnull)
  - lookupRegionName: 丸めた中心のgrid_keyと周囲8セルのgrid_keyで`inArray`検索し、丸め代表点(セル中心)からのハバーシン最近傍の`name`。該当なしnull

- [ ] **Step 1: 失敗する試験** — deadline(機会・提示10:00): 対象13:00 → 12:00(=min(2h, 対象−60分)) / 対象11:20 → 10:20(=max(15分, 対象−60分=10:20)) / Intent期限11:00・対象14:00 → 11:00 / つながり: 提示+24h、Intent期限が+10hなら+10h。isTooLate: 74分59秒→true・75分→false。content: 主題・地域が先に作られた側から取られる・人数の共通部分・つながりはtime_window/budgetがnull。region: geofeaturesへ2行INSERTし近い方の名前・データ空でnull
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: 回答期限・提案の中身・地名逆引きの関数を追加`

### Task 10: 提案化(履歴確保・1バッチ・提示/保留)

**Files:**
- Create: `apps/worker/src/latches/caps.ts`・`apps/worker/src/latches/propose.ts`・`apps/worker/tests/latches-propose.test.ts`

**Interfaces:**
- Consumes: Task 9の関数・`LATCH`定数
- Produces:
  ```ts
  // caps.ts
  export const canPresent = (db: DrizzleD1Database, userIds: string[], intentIds: string[], now: Date): Promise<boolean>;
  //   各userの type=proposal かつ created_at >= jstDayStart(now) の通知 < LIMITS.NOTIFICATIONS_PER_DAY
  //   かつ 各intentを含む status IN (proposed, partial_accept) のlatch < LATCH.CONCURRENT_PER_INTENT
  //   (latches.intent_idsのJSONは json_each で照合)
  // propose.ts
  export type ProposeOutcome = "proposed" | "held" | "skipped";
  export interface ProposeInput { rowId: string; a: IntentRow; b: IntentRow; score: number }  // a.id < b.id
  export const proposePair = (db: DrizzleD1Database, input: ProposeInput, now: Date): Promise<ProposeOutcome>;
  ```
- 処理(spec §3.2〜§3.4・§3.6):
  1. 機会で`isTooLate(occasionTargetAt)`なら`skipped`
  2. 既存proposal_history行を読む。行があり、つながり → `skipped`。機会でoutcomeがdeferred/expired以外 → `skipped`。deferred/expiredなら再提案条件(抑制経過 `now >= updated_at + min(REPROPOSAL_SUPPRESSION_MAX_MS, (targetAt - updated_at)/2)`・かつ「前回latch.scoreとinput.scoreが異なる」か「a/bのupdated_atのどちらかが前回latch.created_atより後」)を満たさなければ`skipped`。前回latch.scoreを`match_candidates.prev_latch_score`へ書く
  3. `canPresent`で提示か保留かを決める
  4. `db.batch`で次を順に実行。1文目=履歴確保: 手順2で行が無かった場合は `INSERT … ON CONFLICT(user_low,user_high) DO NOTHING`(outcome=proposed・latch_id=新id)。行があった(再提案)場合は `UPDATE proposal_history SET outcome='proposed', latch_id=?新id, updated_at=?now WHERE id=? AND outcome IN ('deferred','expired') AND updated_at=?(手順2で読んだ値)`。2文目以降はすべて`… WHERE EXISTS (SELECT 1 FROM proposal_history WHERE latch_id = ?新id)`付き: latches INSERT(status=proposed|candidate・proposed_at=now|null・response_deadline=期限|minExpiry・expires_at=minExpiry・last_message_at=now・proposal=buildProposal・score)・latch_members 2行・latch_status_events(from=null,to=status)・match_candidates.status='proposed'・提示時のみnotifications 2行(type=proposal)
  5. バッチ後にlatches行の存在を確認し、無ければ`skipped`
  - region: `baseIntentOf`が地理ありなら`lookupRegionName`

- [ ] **Step 1: 失敗する試験** — (a) 新規ペアでproposed・LATCH1件・members2・通知2・history(outcome=proposed, latch_id一致)(b) **同じinputでproposePairを`Promise.all`で2回 → LATCHは1件・片方はskipped**(Review Focus 1)(c) history outcome=matched / rejected → skipped (d) つながりでoutcome=deferred → skipped (e) 機会でdeferred・抑制期間内 → skipped / 経過後かつscore同一・Intent未更新 → skipped / 経過後かつIntent更新 → proposed (f) 片方ユーザーの当日proposal通知が6件 → held(status=candidate・proposed_at=null・通知0)(g) Intentの進行中3件 → held (h) 機会で対象まで74分 → skipped
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: 提案化(proposal_history確保を条件とする1バッチ書き込みと通知上限の保留)を追加`

### Task 11: 評価への連結と計測

**Files:**
- Modify: `apps/worker/src/pipeline/evaluate.ts`・`consumer.ts`・`metrics.ts`
- Test: `apps/worker/tests/pipeline-evaluate.test.ts`(追記)

**Interfaces:**
- Consumes: `runLayer4`(Task 7)・`latchScore`/`pickProposals`/`recheckHard`(Task 8)・`proposePair`(Task 10)
- Produces: `Stage2Result`へ追加 `jevCalls: number; jevReused: number; jevHeld: Record<JevHeldReason, number>; jevLatencyMs: number; l5OverThreshold: number; proposed: number; held: number`。consumerのpayloadキーは `jev_calls / jev_reused / jev_held / jev_latency / l5_over_threshold / proposed / held_proposals`。metrics.tsのdata pointへ同値を追加

- [ ] **Step 1: 失敗する試験** — (a) 一致するつながりIntent 2件(別ユーザー)を配置しevaluateIntent → LATCH 1件proposed・payloadの`jev_calls>=1`・`proposed=1` (b) 候補25件を配置 → `jev_calls<=8`(#14)(c) 候補側topicを`__jev_low__…`にする → latch_score=0.3保存・proposed=0 (d) Layer 4完了後〜Layer 5前に候補Intentをpausedにする(runLayer4をvi.spyOnで包みその中でUPDATE)→ 提案されない(Review Focus 3)
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装** — evaluateIntentのupsert後: L4Candidateを組み立て`runLayer4` → 各行`latchScore`(h=1)をlatch_scoreへ保存 → `pickProposals` → `recheckHard`で不合格を除外 → 順に`proposePair`。match_candidatesのupsert`set`はjev_result・latch_scoreを上書きしない(既存どおり)
- [ ] **Step 4: 通過を確認** — `pnpm --filter worker exec vitest run tests/pipeline-evaluate.test.ts tests/pipeline-consumer.test.ts` → PASS
- [ ] **Step 5: コミット** — `F4a: 第2段評価にLayer 4・Layer 5・提案化を連結し計測を拡張`

### Task 12: クローズ共通と保留の解放

**Files:**
- Create: `apps/worker/src/latches/close.ts`・`apps/worker/src/latches/release.ts`・`apps/worker/tests/latches-release.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // close.ts
  export type CloseTo = "rejected" | "expired" | "cancelled";
  export const closeLatch = (db: DrizzleD1Database, latchId: string, to: CloseTo,
    historyOutcome: "rejected" | "deferred" | "expired" | null, fromStatuses: LatchStatus[], now: Date): Promise<boolean>;
  //   1バッチ: UPDATE latches SET status=to WHERE id=? AND status IN fromStatuses → (EXISTS変更後行で条件付け)
  //   latch_status_events・proposal_history(historyOutcome非nullなら outcome/updated_at を更新・latch_id一致行)・
  //   proposed_atありならclosed通知(参加者全員・UNIQUEはON CONFLICT DO NOTHING)。更新できたらtrue
  // release.ts
  export const expireHeld = (db: DrizzleD1Database, now: Date): Promise<number>;
  export const releaseHeld = (db: DrizzleD1Database, now: Date, userIds?: string[]): Promise<number>;
  ```
  - expireHeld: status=candidate で expires_at <= now、または機会で`isTooLate`の行を`closeLatch(…, "expired", "expired", ["candidate"])`
  - releaseHeld: status=candidate(userIds指定時はその参加者のもの)を 機会=対象時刻(proposal.time_window.start)昇順 → つながり=score降順・id昇順 で最大500件走査し、`canPresent`ならproposedへ昇格(1バッチ: status・proposed_at・response_deadline=提示時刻で再計算・status_event・proposal通知)。先にexpireHeldを呼ぶ

- [ ] **Step 1: 失敗する試験** — (a) 上限で保留した提案が、当日分の通知を前日付にずらす(UPDATE created_at)とreleaseHeldでproposed・期限は提示時刻基準 (b) つながり保留3件(score 0.7/0.9/0.8)・空き1件 → 0.9が昇格 (c) 保留中にIntent期限経過 → expired・通知0・history=expired (d) closeLatchで提示済み提案を閉じるとclosed通知2件、未提示は0件 (e) 保留(candidate)をcloseLatchでcancelledにした後のreleaseHeldで昇格しない(status=cancelledのまま・通知0)。加えて、参加Intentがmatched・expired・cancelled・不在の保留はreleaseHeldでcancelledに閉じ、pausedの保留は昇格も取り消しもせず保留のまま残す(排他の取りこぼしの安全網・Review Focus 5・pauseは提案を継続する06 §2)
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: 提案クローズの共通処理と保留の解放・期限切れを追加`

### Task 13: 回答の状態遷移と成立後処理

**Files:**
- Create: `apps/worker/src/latches/respond.ts`・`apps/worker/tests/latches-respond.test.ts`

**Interfaces:**
- Consumes: `closeLatch`・`releaseHeld`(Task 12)
- Produces:
  ```ts
  export type RespondFailure = "not_found" | "invalid_status" | "deadline_passed" | "already_responded" | "not_deferred";
  export type RespondResult = { ok: true; latchId: string } | { ok: false; reason: RespondFailure };
  export const respond = (db: DrizzleD1Database, latchId: string, userId: string, response: LatchResponseValue, now: Date): Promise<RespondResult>;
  export const retract = (db, latchId, userId, now): Promise<RespondResult>;
  export const leave = (db, latchId, userId, now): Promise<RespondResult>;
  export const saveDeferReason = (db, latchId, userId, reason: DeferReason): Promise<RespondResult>;
  ```
  - 参加者でない・LATCH不在・status=candidate → not_found
  - yes: 有効な(retracted_atなし)回答が既にあれば already_responded。1バッチ=latch_responses UPSERT(retract後の再回答はUPDATEでretracted_at=null)→ spec §4.3のCASE更新(WHERE status IN (proposed, partial_accept) AND response_deadline > now)→ status_event。更新0行なら再読込し、期限超過ならdeadline_passed・それ以外invalid_status(回答行の書き込みも同バッチ内でEXISTS条件付けにして残さない)。matchedになったら`onMatched`
  - defer / no: 回答記録 → `closeLatch(…, "rejected", "deferred" | "rejected", ["proposed","partial_accept"])`(期限内条件は事前判定)→ releaseHeld(参加者)
  - retract: 自分のyesが有効・status=partial_accept・期限内のみ。retracted_at=now・status=proposed(条件付きUPDATE)
  - leave: status=matched のみ → cancelled(historyはmatchedのまま=historyOutcome null)
  - saveDeferReason: 自分の回答がdeferのときのみ(それ以外not_deferred)・既にdefer_reasonありならalready_responded
  - onMatched(内部): history=matched・matched通知2・機会なら両Intent status=matched と、そのIntentを含む他のlatch(candidate/proposed/partial_accept)を`closeLatch(…, "cancelled", "expired", [...])`・最後に`releaseHeld(参加者)`

- [ ] **Step 1: 失敗する試験** — (a) A yes → partial_accept・B yes → matched・history=matched・通知matched2 (b) **A・Bのyesを`Promise.all`で同時 → matched**(4.3)(c) defer → rejected・history=deferred・closed通知 (d) no → history=rejected (e) **期限経過後(Cron未実行)のyes → deadline_passed・status不変・回答行なし**(Review Focus 2)(f) retract → proposed・再yesでpartial_accept (g) **Bのyesでmatched後にAのretract → invalid_status・matched維持**(Review Focus 4)(h) 機会の排他: 同一機会Intent Xを含むLATCH L1・L2(L2はpartial_accept)・L3(candidate)で、L1成立 → L2・L3がcancelled・XのIntentがmatched(#23)(i) つながり成立後、両Intentはactiveのまま (j) 非参加者・candidateのLATCH → not_found (k) defer後のsaveDeferReason成功・2回目already_responded・yes回答者はnot_deferred
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: 回答・取り消し・離脱の状態遷移と成立後処理(機会の排他)を追加`

### Task 14: `/v1/latches` API と表示範囲

**Files:**
- Create: `apps/worker/src/latches/view.ts`・`apps/worker/src/routes/latches.ts`・`apps/worker/tests/latches-api.test.ts`
- Modify: `packages/shared/src/schema.ts`・`apps/worker/src/index.ts`(`app.route("/v1/latches", latchRoutes)`)

**Interfaces:**
- Consumes: `respond`/`retract`/`leave`/`saveDeferReason`(Task 13)
- Produces(shared schema.ts):
  ```ts
  latchResponseRequestSchema = z.object({ response: z.enum(LATCH_RESPONSE_VALUES) }).strict();
  deferReasonRequestSchema = z.object({ reason: z.enum(DEFER_REASONS) }).strict();
  // LatchDTO
  { id, form, status, response_deadline: string, participants_count: number,
    my_response: LatchResponseValue | null, score: number,
    proposal?: LatchProposal, members?: { user_id: string; display_name: string; bio: string | null; has_icon: boolean }[] }
  ```
  `toLatchDto(latch, opts: { participantsCount; myResponse; members?: UserRow[] }): LatchDTO`(view.ts)。`proposal`・`members`は status=matched、または matched経由のcancelled(latch_status_eventsに to=matched の記録がある)ときだけ含める。membersは自分を除く
- ルート(すべて`requireRegistered`): `GET /`(`type=proposals|matched`必須・不正は400・proposals=proposed/partial_accept・matched=matched・latch_members経由・id降順・cursor/limitは05 §3.1)/ `GET /:id` / `POST /:id/response` / `POST /:id/response/retract` / `POST /:id/leave` / `POST /:id/defer-reason`。成功は200 LatchDTO。`RespondFailure`の写像: not_found→404・その他→400 VALIDATION_FAILED `details.reasons=[reason]`

- [ ] **Step 1: 失敗する試験** — (a) 成立前のGET /:idに`proposal`・`members`のキーが**存在しない**(#20)(b) 双方yes後のGETに`proposal.topic`と相手の`display_name`(#18・#20)(c) 第三者ユーザーのGET → 404 (d) type未指定 → 400 (e) `{response:"maybe"}` → 400 (f) 一覧proposalsにcandidateが含まれない
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: /v1/latchesのAPIと成立前後の表示範囲を追加`

### Task 15: Intent削除時のLATCH取り消し

**Files:**
- Modify: `apps/worker/src/routes/intents.ts`(DELETE /:id)
- Test: `apps/worker/tests/intents-crud-api.test.ts`(追記)

**Interfaces:**
- Consumes: `closeLatch`・`releaseHeld`(Task 12)

- [ ] **Step 1: 失敗する試験** — proposedのLATCHに含まれるIntentを削除 → LATCHがcancelled・相手にclosed通知・history=expired。matchedのLATCHは変化しない
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装** — 候補削除の前に、当該Intentを含む candidate/proposed/partial_accept のLATCH(json_each)を`closeLatch(…, "cancelled", "expired", …)`し、相手ユーザーで`releaseHeld`
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: Intent削除で進行中の提案を取り消す`

### Task 16: Cronの追加と掃除リスト6・7

**Files:**
- Modify: `apps/worker/src/pipeline/cron.ts`・`apps/worker/src/pipeline/consumer.ts`(runEmbeddingStageのオプション)
- Test: `apps/worker/tests/pipeline-cron.test.ts`(追記)

**Interfaces:**
- Produces: `runEmbeddingStage(env, intent, clock, options?: { emitCompleted?: boolean })`(既定true)。cron.tsに`runResponseDeadlineSweep`・`runHeldSweep`(expireHeld→releaseHeld)・`runBudgetAlert`・`runPendingSweep`を追加し、`runRetentionSweep`へusage_counters削除を追加。`runScheduledPipeline`の順: 既存7走査 → 回答期限切れ → 保留 → 予算アラート → pending残留
- 規則:
  - 回答期限切れ: status IN (proposed, partial_accept) AND response_deadline <= now を最大500件、各`closeLatch(…, "expired", "expired", …)`→参加者で`releaseHeld`。有効なYESは`retracted_at=now`で無効化
  - 予算アラート: jev_global_daily(当日)・jev_global_monthly(当月)の count >= 上限×0.8 で`logger.warn("jev.budget.alert", {layer:"jev_global_daily"|"jev_global_monthly", count})`+Analytics Engine。KV `jev:alert:<scope>:<period>` が無いときだけ出し、出したら書く
  - usage_counters削除: periodの日付部分(`YYYY-MM-DD`/`YYYY-MM-DD-HH`/`YYYY-MM`の月は末日扱い)がnowのJST日付より90日超古い行
  - pending残留: status=pending AND created_at <= now−10分 を failed へ(500件上限)
  - バックフィル: Cronからは`emitCompleted:false`で呼ぶ(直後にevaluateIntentを直接呼ぶため)。`"failed"`が連続5件で当回の走査を打ち切り`logger.warn("cron.backfill.aborted", {count})`

- [ ] **Step 1: 失敗する試験** — (a) 期限を過ぎたproposed → expired・history=expired・closed通知・YESの回答にretracted_at (b) 予算80%で警告1回・2回目のCronでは出ない (c) 91日前の日次カウンタ行が消え89日前は残る (d) 11分前のpendingイベントがfailed・9分前は残る (e) バックフィルでembedding_completedイベント行が作られない (f) Embeddingが常に失敗する状態(LATCH_EMBEDDING_MODEはstubのため`vi.spyOn`で失敗させる)で対象10件 → 5件目で打ち切り
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** — `pnpm --filter worker exec vitest run tests/pipeline-cron.test.ts` → PASS
- [ ] **Step 5: コミット** — `F4a: Cronに回答期限切れ・保留・予算アラート・pending掃査を追加しバックフィルの二重評価を解消`

### Task 17: dev専用API(backdate・観測拡張)

**Files:**
- Modify: `apps/worker/src/routes/dev.ts`
- Test: `apps/worker/tests/dev-observe-api.test.ts`(追記)

**Interfaces:**
- Produces:
  - `POST /v1/dev/latches/:id/backdate` `{response_deadline?: string(ISO), history_updated_at?: string(ISO), intents_last_evaluated_at?: string(ISO)}`(`.strict()`・少なくとも1つ必須)→ 200 `{ok: true}`。latches.response_deadlineと、そのLATCHのproposal_history行のupdated_atと、参加Intent全員のlast_evaluated_at(30分再評価抑制をE2Eで外すため)を書き換える。存在しない→404
  - `GET /v1/dev/match-candidates` の items に `jev_result`・`latch_score` を追加
  - `GET /v1/dev/latches?intent_id=` → `{items: [{id, form, status, intent_ids, response_deadline, proposed_at, score}], next_cursor}`(json_eachでintent_ids照合)
  - `GET /v1/dev/proposal-history?user_id=` → `{items: [{id, user_low, user_high, latch_id, outcome, created_at, updated_at}], next_cursor}`
  - すべて`hideWhenDisabled`→`requireRegistered`の順(既存と同じ存在隠し)

- [ ] **Step 1: 失敗する試験** — LATCH_ENV=production相当のenvでbackdateが404 / backdate後にresponse_deadlineが更新 / match-candidatesにjev_resultが出る / latches観測でintent_id一致行のみ
- [ ] **Step 2: 失敗を確認** → FAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** → PASS
- [ ] **Step 5: コミット** — `F4a: dev専用のbackdateとLATCH・提案履歴の観測APIを追加`

### Task 18: ゲートE2E

**Files:**
- Create: `apps/worker/e2e/latches.spec.ts`
- Modify: `apps/worker/e2e/helpers.ts`(必要なヘルパーのみ: `createIntent`・`waitForLatch(request, token, intentId)`・`respond(request, token, latchId, response)`・`backdate`)

**Interfaces:**
- Consumes: Task 14・17のAPI、既存`registerUser`/`waitFor`/`runCron`

- [ ] **Step 1: specを書く** — 各testは独立ユーザーで配置(ファイル冒頭コメントに「10 §3のseed方針・stub Jev=0.9」)。
  - `#14 1イベントのJev実行回数が8回以下`: 同主題のつながりIntentを別ユーザー12人で作成→最後の起点イベントpayloadの`jev_calls <= 8`
  - `#15 双方向の判定値が記録される`: 候補のjev_resultに`would_a_accept_b`と`would_b_accept_a`
  - `#17/#18 yes・deferの回答と双方YESの成立`: A yes→partial_accept・B yes→matched / 別ペアでdefer→rejected / 別ペアで`no`をAPI直叩き→rejected
  - `#20 成立後のみ詳細を解放`: 成立前のGETに`proposal`・`members`が無く、成立後にある
  - `#19 回答期限切れ`: backdate(response_deadline=過去)→`runCron`→status=expired
  - `#23 機会の排他`: 機会Intent X(ユーザーA)と、一致する機会Intent Y(B)・Z(C)→ A-B・A-Cの2提案 → A-Bで双方yes → A-Cがcancelled
  - `#12(a) 成立・no後は再提案されない`: 成立ペア/no ペアの片方が新規Intentを作成→評価完了(payload出現)後もLATCHが増えない
  - `#12(b) 見送り後の機会Intentは条件変化で再提案される`: 機会でdefer → backdate(history_updated_at=十分過去・intents_last_evaluated_at=31分以上前)→ 片方の機会IntentをPATCH(topic等の意味フィールド)→ 新しいLATCHがproposed
- [ ] **Step 2: webをビルドしてE2E実行** — Run: `pnpm --filter web build && pnpm --filter worker test:e2e` → 全spec PASS(F3の既存specを含む)
- [ ] **Step 3: コミット** — `F4a: ゲート#12・#14・#15・#17〜#20・#23のworker E2Eを追加`

### Task 19: 文書の更新と完了記録

**Files:**
- Modify: `docs/04-system-architecture.md`(§6 CI段落のVectorize表記=掃除4・PIPELINE_KVの追加)・`docs/05-data-model-api.md`(新設API・列・grid_key書式・理由コード・表示範囲)・`docs/06-matching-pipeline.md`(起点側のみ計上・直列化・上限の僅少超過・F4a実装確定)・`docs/07-jev-llm-spec.md`(Jev差し替え口・stub目印・real化の移動)・`docs/10-test-env-nfr.md`(§3 dev APIの時刻ずらし)・`docs/12-development-roadmap.md`(F4の3分割・Parser/Jev realと精度ゲートをF9前の独立工程へ・F8注記)・`docs/00-document-roadmap.md`(§1版数表)・`AGENTS.md`(現在の状態: F4a完了・次はF4b)・本計画末尾(完了記録)

- [ ] **Step 1: 各文書を更新** — 00 §3の運用ルールどおり、版数を上げ冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える。レガシー実装への言及を入れない。用語(「Layer 2 Candidate Retrieval」「アプリ内通知」・数値単位の書式)を守る
- [ ] **Step 2: 版数の整合を確認** — Run: `rg -n "v0\.[0-9]+" docs/00-document-roadmap.md` と各文書の冒頭・前提文書欄を突き合わせ、食い違いが0件
- [ ] **Step 3: 全検証** — Run: `pnpm lint && pnpm typecheck && pnpm test` → 緑
- [ ] **Step 4: コミット** — `F4a: 提案〜成立の実装確定を04〜07・10・12へ反映し現在の状態を更新`

---

## F4a完了記録(2026-10-20・Task 1〜19完了)

- 実装コミット: caac879〜本計画のTask 19のコミット(事前点検の裁定反映・Task 1〜18の実装と修正・Task 19の文書反映)
- ゲートとE2Eの対応(`apps/worker/e2e/latches.spec.ts`・stub Jev=0.9・期限経過はdev専用backdateで作る・10 §3):

| ゲート(02 §4) | worker E2E |
|---|---|
| #14 | `#14 1イベントのJev実行回数が8回以下`(起点イベントpayloadのjev_calls ≤ 8) |
| #15 | `#15 双方向の判定値が記録される`(match_candidates.jev_resultのwould_a_accept_b・would_b_accept_a) |
| #17(API部分)・#18 | `#17/#18 yes・deferの回答と双方YESの成立`(yes→partial_accept→matched・defer→rejected・API直叩きのno→rejected) |
| #20 | `#20 成立後のみ詳細を解放`(成立前はproposal・membersのキー無し・成立後にあり) |
| #19 | `#19 回答期限切れ(両形式)`(backdate→Cron→expired) |
| #23 | `#23 機会の排他`(A-Bの成立でA-Cがcancelled) |
| #12 | `#12(a) 成立・no後は再提案されない`・`#12(b) 見送り後の機会Intentは条件変化で再提案される` |

- worker E2E 32件全緑(auth 9・intents 6・pipeline 9・latches 8。F3以前の既存specを含む)。#17のUI 2択はF4c・#24はF4bで証明する
- 文書反映: 04 v0.11・05〜07 v0.10・10 v0.10・12 v0.10(F4の3分割とParser/Jevのreal接続の移動の決定記録)・08 v0.10・09 v0.9・11 v0.10(前提文書欄の同期のみ)・00 v0.10(§1版数表)・AGENTS.md(現在の状態)

### staging初接続時チェック(F10前・本工程で追加した項目)

- D1バッチ内の `PRAGMA defer_foreign_keys = ON`(提案化の1バッチ先頭・06 §3)が実D1で効くこと。効かない場合はproposal_history.latch_idの外部キー検査で提案化が常に失敗するため、staging初回の提案化で提案が生成されることを確認する
- F3計画の同節の項目(Vectorize getByIdsのvalues返却・VectorFloatArrayの透過)も引き続き確認する
- Jevを複数件含む評価を1回流して failed にならないこと(実KVの同一キー書き込み上限=1秒に1回でcircuit breakerの記録が例外にならないこと・06 §5。miniflareでは再現しない)
- Cron 1回のD1照会数が上限内であること(追加4走査を含む1回の実行で、実D1の1呼び出しあたりの照会数上限を超えないこと)

### 最終レビューの修正(2026-10-20)

- ブランチ全体のレビュー指摘F1〜F7を1回の修正波で修正した: circuit breakerのKV書き込みを1波1回・状態不変時は書かない・KVとJevの例外を握る(F1)/releaseHeldから全体のexpireHeldを外し範囲内の期限処理とチャンク分割(F2)/Cronの追加4走査とreleaseHeldの1件ごとの処理の隔離(F3)/activeのPATCHでの進行中の提案の取り消し(F4)/提案履歴で提案できないペアのLayer 4前の除外(F5)/leaveでclosed通知を出さない(F6)/closeLatchのstatus IN fromStatusesの楽観照合(F7)
- 文書反映: 04 v0.12・05〜07 v0.11・08 v0.11・09 v0.10・10〜12 v0.11・00 v0.11(§1版数表)

### 次の工程

- F4b(グループLATCH・Pool最大15・集合選択・1対1最低4回保証の配分・#24)→ F4c(提案〜成立の画面・`prototype/`基準・#17のUI 2択)。Parser/Jevのreal接続と精度ゲートはF9前の独立工程(12 §2の決定記録)
- 未解決の検討事項: Intentの意味フィールド(topic・constraints等)の更新で30分再評価抑制(intents.last_evaluated_at)を解除するか。現状は解除しない(E2Eの#12(b)はdev専用backdateのintents_last_evaluated_atで回避している)。扱いは未決
