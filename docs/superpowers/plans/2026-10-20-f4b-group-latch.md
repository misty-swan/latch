# F4b グループLATCH 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F4aの1対1の提案〜成立を2〜4人の集合へ一般化し、Pool最大15・集合選択・Jevの1対1最低4回保証の配分・ペア別の履歴記録・グループの離脱を実装して、ゲート#24(02 §4)をworker E2Eで証明する。

**Architecture:** `evaluateIntent`の中で1対1と並行してグループの集合を組み立てる(案A)。集合の列挙・配分・点数は純関数の`pipeline/group.ts`、D1・ベクトルの読み書きは`pipeline/group-eval.ts`に置き、Jevは1対1とグループの対象を1つの列にして`runJev`を1回だけ呼ぶ。提案化は`proposePair`を`proposeSet`(2〜4人・全ペアの履歴確保と巻き戻しを1バッチ)へ置き換え、1対1も人数2の集合として同じ道を通す。

**Tech Stack:** TypeScript(strict)・Hono・Zod v4(shared)・Drizzle(D1・`db.batch`)・Vectorize抽象・vitest(vitest-pool-workers)・Playwright(APIレベルE2E)。

**Spec:** `docs/superpowers/specs/2026-10-20-f4b-group-latch-design.md`(本計画の正本。以下「spec」)。前段の`docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md`と`docs/superpowers/plans/2026-10-20-f4a-proposal-to-match.md`の規約を引き継ぐ。

## Global Constraints

- コミットは `git add <パス>` で対象限定(`git add -A`・`-a`禁止)。コミットメッセージは日本語・接頭辞「F4b: 」・末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 毎コミット: `pnpm lint`・`pnpm typecheck`・`pnpm test` が緑。字下げタブ・文字列ダブルクォート。コメントは「docs/NN §x」「F4b設計 §x」で根拠参照(既存慣習)
- 時刻の規律(04 §4): 製品コードは`Clock`注入または`now`引数。`Date.now()`/`new Date()`直接呼び出し禁止
- ログ規律(08 §6): `createLogger`の許可フィールドのみ。user_id・topic・raw_text・座標はログ・Analytics Engine・payloadに出さない
- 課金ゼロ: vitest・E2E・CIはstub Jev(全7軸0.9)のみ
- 数値: 閾値 L > 0.60(ちょうどは提案しない)・K_j=8・1対1の最低保証4回・Pool最大15・集合は3〜4人・時間はペアごとの重なり15分以上(Layer 1と同じ。区間の性質上、全ペアが15分以上重なれば全員の共通部分も15分以上になるため、n人の別判定は置かない)・通知上限1ユーザー1日6件・1Intent同時進行3件・機会は対象時刻まで75分未満なら提案しない・回答期限の式はF4aのまま
- 人数条件(spec §2.1): 人数nの集合は全メンバーで `participantsMin ≤ n ≤ participantsMax`。1対1(n=2)にも適用
- D1の1文あたりバインド上限100。照会・upsertはチャンクで分割(既存の48件・50件・7行の幅に従う)
- マイグレーションは戻す手順(`apps/worker/migrations_rollback/NNNN_rollback.sql`)と対で作る(12 §4)
- **F4bスコープ外**(spec §0.3): 画面(F4c)・チャットの読み取り専用化(F6)・Web Push(F7)・real接続

## Review Focus

1. **重なる2つの集合({A,B,C}と{A,B,D})がほぼ同時に提案化される** → LATCHは1件だけで、負けた側のlatch_idを指すproposal_history行が1行も残らない → Task 6の並行試験
2. **1対1の提案が進行中のペアを含む集合** → 集合は提案されず、1対1の履歴行(outcome・latch_id・updated_at)は変わらない → Task 6
3. **Pool内の他人どうしのペアが過去にno(rejected)またはmatchedの履歴を持つ** → その2人を含む集合を作らず、Jevの枠も使わない → Task 8
4. **人数の下限ちょうどのグループから2人がほぼ同時に離脱** → 下限を割った時点でLATCH全体がcancelledになり、下限未満の人数でmatchedのまま残らない → Task 7
5. **Jev実行〜提案化の間にメンバーの1人がpause・削除** → Hの再検証で集合は提案されず、次の候補集合へ進む。削除なら進行中のグループは全ペアreleaseでcancelled → Task 9・Task 5

---

## ファイル構成

| 区分 | パス | 責務 |
|---|---|---|
| 作成 | `apps/worker/migrations/0004_*.sql`(drizzle-kit生成)/ `migrations_rollback/0004_rollback.sql` | `latch_members.left_at` |
| 作成 | `apps/worker/src/pipeline/group.ts` / `group.test.ts` | 純関数: 人数条件・Pool・集合列挙・配分・点数・順位 |
| 作成 | `apps/worker/src/pipeline/group-eval.ts` | Poolのデータ取得・ペア行のupsert・集合の点数保存と提案 |
| 作成 | `apps/worker/src/pipeline/candidates.ts` | match_candidatesのupsertと行idの読み直し(evaluate.tsから抽出) |
| 作成 | `apps/worker/src/latches/next-group.ts` | グループ提案のクローズ後に次集合を提案 |
| 作成 | `apps/worker/tests/pipeline-group.test.ts` / `latches-group.test.ts` | 統合試験 |
| 作成 | `apps/worker/e2e/group-latches.spec.ts` | #24のゲートE2E |
| 変更 | `packages/shared/src/constants.ts`(+test) | `LATCH.GROUP_*`・`LATCH.JEV_ONE_ON_ONE_MIN` |
| 変更 | `apps/worker/src/db/schema.ts` | `latchMembers.leftAt` |
| 変更 | `apps/worker/src/latches/{deadline,content,release,propose,close,respond,view}.ts` | n人化・proposeSet・ペア別履歴・離脱 |
| 変更 | `apps/worker/src/pipeline/{evaluate,layer1,layer4,layer5,metrics,consumer,cron}.ts` | 統合・配分・計測・次集合の呼び出し |
| 変更 | `apps/worker/src/routes/{latches,intents}.ts` | 離脱者の除外・次集合の呼び出し |
| 変更 | `docs/01`・`05`・`06`・`12`・`00`・`AGENTS.md` | Task 12 |

---

### Task 1: マイグレーション0004と定数

**Files:**
- Create: `apps/worker/migrations/0004_*.sql`(`pnpm --filter worker exec drizzle-kit generate`の生成物)、`apps/worker/migrations_rollback/0004_rollback.sql`
- Modify: `apps/worker/src/db/schema.ts`(`latchMembers`)、`packages/shared/src/constants.ts`、`packages/shared/src/constants.test.ts`
- Test: `apps/worker/tests/migration.test.ts`(既存の0003と同じ確認を0004へ追加)

**Interfaces:**
- Produces: `latchMembers.leftAt: integer("left_at", { mode: "timestamp_ms" })`(null可・nullは参加中)。`LATCH.GROUP_POOL_MAX = 15`・`LATCH.GROUP_SIZE_MIN = 3`・`LATCH.GROUP_SIZE_MAX = 4`・`LATCH.JEV_ONE_ON_ONE_MIN = 4`

- [ ] **Step 1: 失敗する試験を書く** — `constants.test.ts`のLATCHの期待値に上記4値を追加。`migration.test.ts`に「latch_membersにleft_at列がある」「0004_rollback適用後にleft_atが無い」を既存0003の試験と同じ書き方で追加
- [ ] **Step 2: 失敗を確認** — `pnpm --filter @latch/shared exec vitest run src/constants.test.ts` と `pnpm --filter worker exec vitest run tests/migration.test.ts` がFAIL
- [ ] **Step 3: 実装** — schemaに列を足して生成。rollbackは `ALTER TABLE latch_members DROP COLUMN left_at;`(`migrations_rollback/README.md`の書式に従う)。定数はLATCHへdocs/06 §3の参照コメント付きで追加
- [ ] **Step 4: 緑を確認** — 同じコマンドがPASS
- [ ] **Step 5: コミット** — `F4b: latch_members.left_atとグループの定数を追加する`

### Task 2: 期限・提案内容・保留の解放をn人へ一般化

**Files:**
- Modify: `apps/worker/src/latches/deadline.ts`・`content.ts`・`release.ts`・`propose.ts`(呼び出し側の引数のみ)
- Test: `apps/worker/src/latches/deadline.test.ts`・`content.test.ts`・`apps/worker/tests/latches-release.test.ts`

**Interfaces:**
- Produces(引数を2つのIntentから配列へ変更):
  - `occasionTargetAt(members: IntentRow[]): Date` — starts_atの最大値
  - `minExpiry(members: IntentRow[]): Date` — expires_atの最小値
  - `baseIntentOf(members: IntentRow[]): IntentRow` — created_at最小・同値はid昇順
  - `buildProposal(members: IntentRow[], regionName: string | null): LatchProposal` — time_window=[starts_at最大, 終端(ends_at ?? expires_at)最小]・participants=全員の区間の共通部分(空なら基準Intentの値)・budget=全員が予算を持ち共通部分が空でないときだけ
  - release.tsの`intentsOf`は`IntentRow[] | null`(intent_idsの順)を返し、`expireHeld`・`releaseOne`は全メンバーで判定する(75分判定・参加Intentの状態・`responseDeadline(…, occasionTargetAt(members), minExpiry(members))`)

- [ ] **Step 1: 失敗する試験を書く** — 既存の2引数の試験を配列呼び出しへ書き換え、3人の試験を追加:
  - `occasionTargetAt([a(12:00), b(13:00), c(12:30)])` が13:00、`minExpiry`が3人の最小
  - `baseIntentOf([late, early, mid])` が`early`
  - `buildProposal([a,b,c], null)`: starts 12:00/12:30/13:00・終端 15:00/14:00/14:30 → `time_window = {start: 13:00, end: 14:00}`、participants {2,4}/{3,4}/{3,3} → `{min:3, max:3}`、cの予算なし → `budget: null`
  - latches-release: 3人のcandidateのLATCHで、メンバーの1人だけが当日6件の通知を持つと昇格しない/0件なら3人全員にproposal通知が作られる
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run src/latches tests/latches-release.test.ts` がFAIL(型エラーを含む)
- [ ] **Step 3: 実装** — 上記シグネチャへ変更し、`propose.ts`・`release.ts`の呼び出しを`[a, b]`配列で渡す形に直す
- [ ] **Step 4: 緑を確認** — 同コマンドと`pnpm typecheck`がPASS
- [ ] **Step 5: コミット** — `F4b: 回答期限・提案内容・保留の解放を2〜4人へ一般化する`

### Task 3: 集合の純関数(人数条件・Pool・列挙・点数)

**Files:**
- Create: `apps/worker/src/pipeline/group.ts`・`group.test.ts`

**Interfaces:**
- Produces:
  - `intentPairKey(a: string, b: string): string` — 小さいid:大きいid
  - `sizeFits(members: IntentRow[], n: number): boolean`
  - `interface PoolEntry { intent: IntentRow; cheapScore: number; similarity: number }`
  - `selectPool(origin: IntentRow, entries: PoolEntry[]): PoolEntry[]` — `origin.participantsMax < LATCH.GROUP_SIZE_MIN`なら`[]`。`participantsMax ≥ 3`の候補をcheapScore降順・同点id昇順で最大`LATCH.GROUP_POOL_MAX`件
  - `cosineSimilarity(a: number[], b: number[]): number`
  - `interface GroupSet { members: IntentRow[] /* id昇順 */; key: string /* idをカンマ結合 */; cheapAggregate: number }`
  - `enumerateSets(origin: IntentRow, pool: IntentRow[], pairOk: (a: IntentRow, b: IntentRow) => boolean, pairCheap: (a: IntentRow, b: IntentRow) => number): GroupSet[]` — originを含む3人・4人の組み合わせのうち、全ペアpairOk・`sizeFits(members, n)`を満たすもの(時間・予算・地域はpairOkが担う)。cheapAggregate=全ペアのpairCheapの最小値。cheapAggregate降順→人数昇順→key昇順
  - `aggregateOf(members: IntentRow[], scoreByPair: Map<string, number>): number | null` — 全ペアのscoreの最小値。1ペアでも欠ければnull
  - `rankByAggregate<T extends { members: IntentRow[]; key: string; aggregate: number }>(sets: T[]): T[]` — aggregate > `LATCH.THRESHOLD`のみ・aggregate降順→人数昇順→key昇順
  - `dedupKeyOf(members: IntentRow[]): string` — id昇順の`${id}@${version}`をカンマ結合(schemaのdedup_keyの定義)

- [ ] **Step 1: 失敗する試験を書く**(`group.test.ts`):
  - `sizeFits`: `[{2,4},{3,4},{3,3}]`はn=3でtrue・n=4でfalse・n=2でfalse
  - `selectPool`: origin max=2 → `[]`。max=2の候補は除外・17件の候補から15件・cheapScore同点はid昇順
  - `enumerateSets`: origin+Pool4件(全員{3,4})で集合は C(4,2)+C(4,3)=10件。pairOkが(B,C)でfalseならB・Cを両方含む集合が消える。並び順: cheapAggregateが同点の3人集合と4人集合では3人が先
  - `aggregateOf`: 3ペア {0.9,0.7,0.8} → 0.7。1ペア欠落 → null
  - `rankByAggregate`: 0.60ちょうどは除外。同点は人数昇順→key昇順
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run src/pipeline/group.test.ts` がFAIL
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: コミット** — `F4b: 集合の列挙と点数の純関数を追加する`

### Task 4: Jev配分の計画(1対1最低4回保証)

**Files:**
- Modify: `apps/worker/src/pipeline/group.ts`・`group.test.ts`

**Interfaces:**
- Consumes: Task 3の`GroupSet`・`intentPairKey`
- Produces:
  ```ts
  export interface AllocationInput {
  	/** 1対1の対象(人数条件・履歴除外済み・Layer 3降順)。keyはintentPairKey */
  	oneOnOne: string[];
  	/** enumerateSetsの順の集合 */
  	sets: GroupSet[];
  	/** jev_resultが既にあるペア */
  	known: Set<string>;
  }
  export interface AllocationPlan {
  	/** runLayer4へ渡す1対1のキー(known分は全件+未判定の選ばれた分。L3順) */
  	oneOnOneKeys: string[];
  	/** 枠に収まらなかった1対1の未判定件数(jev_heldのcapへ加算) */
  	oneOnOneCapped: number;
  	/** グループ用に新たにJevへ渡すキー(oneOnOneKeysと重複しない) */
  	groupKeys: string[];
  	/** 全ペアが既知または予定済みの集合(順序はsetsのまま) */
  	plannedSets: GroupSet[];
  	/** 未判定ペアが枠に収まらず予定に入らなかった集合の数 */
  	heldSets: number;
  }
  export const planJevAllocation = (input: AllocationInput): AllocationPlan
  ```

- [ ] **Step 1: 失敗する試験を書く**:
  - 集合なし・1対1の未判定10件 → oneOnOneKeysの未判定8件・capped 2・groupKeys空
  - 1対1の未判定10件・集合1件(未判定3ペア) → 1対1 5件・groupKeys 3件・capped 5
  - 1対1の未判定2件・4人集合(未判定6ペア) → 1対1 2件・groupKeys 6件(合計8)
  - 1対1の未判定6件・4人集合(未判定6ペア) → グループの枠は4のため集合は入らない(heldSets 1)→ 1対1 6件・groupKeys空。2番目の3人集合(未判定3ペア)は入る → 1対1 5件・groupKeys 3件
  - 集合のペアが1対1の対象と重なる場合はgroupKeysに入れて1対1の未判定数から除き、1回だけ数える
  - 全ペアknownの集合は枠を使わずplannedSetsに入る。knownの1対1は件数に関係なくoneOnOneKeysへ全件入る
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装** — 次の手順(試験が決めない部分):
  ```text
  need1 = oneOnOneのうちknownでないもの
  groupCap = 8 − min(JEV_ONE_ON_ONE_MIN, |need1|)
  scheduled = 空集合
  for set in sets:
    missing = set内のペアのうち known にも scheduled にも無いもの
    if |scheduled| + |missing| ≤ groupCap: scheduled ∪= missing; plannedSetsへ追加
    else heldSets += 1
  groupKeys = scheduled(1対1の対象と重なるものも含む)
  rest1 = need1 − groupKeys
  slots1 = min(|rest1|, 8 − |groupKeys|)
  oneOnOneKeys = oneOnOneのうち (known ∪ rest1の先頭slots1件 ∪ groupKeysと重なるもの) をL3順で
  oneOnOneCapped = |rest1| − slots1
  ```
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: コミット** — `F4b: Jevの1対1最低4回保証の配分を計画する`

### Task 5: クローズのペア別履歴記録

**Files:**
- Modify: `apps/worker/src/latches/close.ts`・`respond.ts`(`respondClose`)・`release.ts`・`apps/worker/src/pipeline/cron.ts`(`runResponseDeadlineSweep`)・`apps/worker/src/routes/intents.ts`(`cancelOpenLatchesOf`)
- Test: `apps/worker/tests/latches-group.test.ts`(新規)・既存の`latches-respond.test.ts`・`pipeline-cron.test.ts`

**Interfaces:**
- Produces: `closeLatch`の第4引数を次へ置き換える(他の引数は不変):
  ```ts
  export type HistoryRule =
  	| { kind: "release" }
  	| { kind: "actor"; userId: string; outcome: "deferred" | "rejected" }
  	| { kind: "non_yes"; outcome: "expired" };
  closeLatch(db, latchId, to, history: HistoryRule | null, fromStatuses, now, options?)
  ```
  - 呼び出し側の対応: defer/no → `actor`(本人)、回答期限切れ → `non_yes`、保留の期限切れ・排他・Intent削除・条件変更 → `release`、leave → `null`
- バッチ内の文の順(`closed`条件付き): (1) 対象ペアのUPDATE(`actor`=`user_low = X OR user_high = X`・`non_yes`=`user_low`または`user_high`が「このLATCHで有効なyesを持つuser_id」の集合に無い)(2) このLATCHを指し outcome='proposed' のまま残った行のうち created_at ≥ latches.created_at を削除 (3) 残った outcome='proposed' の行を expired(updated_at=now)。`release`は(2)(3)のみ。cronのyes無効化はクローズの後で行う既存の順を保つ

- [ ] **Step 1: 失敗する試験を書く**(`latches-group.test.ts`・3人のproposedのLATCHと履歴3行を直接INSERT):
  - Xのdefer(`respond(…,"defer")`) → X含む2行がdeferred・Y-Zの行は削除。Y-Zの行が再提案で確保した既存行(created_atがLATCHより前)ならexpiredへ戻る
  - Xのno → X含む2行がrejected・Y-Zは削除
  - Y・Zがyesの状態で回答期限切れ走査 → X含む2行がexpired・Y-Zは削除。誰もyesでなければ3行ともexpired
  - 既存の1対1の試験(defer→deferred・no→rejected・期限切れ→expired・release)が変更なしで緑
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run tests/latches-group.test.ts tests/latches-respond.test.ts tests/pipeline-cron.test.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: コミット** — `F4b: 提案クローズの履歴をペアごとに記録する(オーナー裁定1・2)`

### Task 6: 提案化の一般化(proposeSet)

**Files:**
- Modify: `apps/worker/src/latches/propose.ts`・`apps/worker/src/pipeline/evaluate.ts`(呼び出しのみ)
- Test: `apps/worker/tests/latches-propose.test.ts`(`proposePair`の試験を`proposeSet`へ移す)・`latches-group.test.ts`・`latches-release.test.ts`(呼び出しの置換)

**Interfaces:**
- Consumes: Task 2のn人の関数、Task 3の`intentPairKey`
- Produces(`proposePair`は削除):
  ```ts
  export type ProposeSource =
  	| { kind: "pair"; rowId: string }              // match_candidates.id
  	| { kind: "group"; groupCandidateId: string }; // group_candidates.id
  export interface ProposeSetInput {
  	members: IntentRow[]; // 2〜4・id昇順
  	score: number;        // 1対1=L・集合=aggregate(latches.scoreへ)
  	source: ProposeSource;
  }
  export const proposeSet = (db: DrizzleD1Database, input: ProposeSetInput, now: Date): Promise<ProposeOutcome>;
  /** 履歴によりこの時点で提案できないペア(intentPairKey)。判定はblockedForProposalと同じ規則 */
  export const historyBlockedPairs = (db: DrizzleD1Database, members: IntentRow[], now: Date): Promise<Set<string>>;
  ```
  - `blockedForProposal`は残し、ペア1件の判定(既存行・再提案不可・抑制期間中)を`historyBlockedPairs`と共通の内部関数にする
- 手順(試験が決めない部分):
  1. 機会は`isTooLate(occasionTargetAt(members), now)`ならskipped
  2. 全ペアの既存履歴を読み、1行でも再提案不可・抑制期間中ならskipped。既存行があるペアは前回LATCH(行のlatch_id)を読み、全ペアについて「前回のscore ≠ score または どれかのメンバーのupdated_at > 前回のcreated_at」を満たさなければskipped。`source.kind==="pair"`はmatch_candidates.prev_latch_score、`"group"`はgroup_candidates.prev_aggregate_score(最も新しい前回LATCHのscore)を記録する
  3. `canPresent(db, 全user_id, 全intent_id, now)`で提示/保留
  4. バッチ: `PRAGMA defer_foreign_keys = ON` → 各ペアの確保(新規は事前に採番したidでINSERT ON CONFLICT DO NOTHING・既存は楽観照合のUPDATE)→ `secured = (SELECT COUNT(*) FROM proposal_history WHERE latch_id = 新id) = C(n,2)` で条件付けたlatches・latch_members(全員)・latch_status_events・source行のstatus=proposed・通知(提示時のみ全員)→ **巻き戻し**: `NOT secured`のときだけ働く、新規確保した行(事前採番のid)のDELETEと、UPDATEした行を読み出し値(outcome・latch_id・updated_at)へ戻すUPDATE
  5. 作成されたLATCHを読み直して proposed / held / skipped

- [ ] **Step 1: 失敗する試験を書く**:
  - 既存の`proposePair`の全試験を`proposeSet({members:[a,b], score, source:{kind:"pair", rowId}})`で書き換えて同じ期待値
  - 3人: proposed・履歴3行(latch_id=新id・outcome=proposed)・latch_members 3行・proposal通知3件・group_candidatesのstatus=proposed
  - 同じ3人集合の並行2回 → LATCH 1件・履歴3行
  - {A,B,C}と{A,B,D}の並行 → LATCH 1件。負けた側のlatch_idを指す履歴行が0行・勝った側の履歴行がC(3,2)=3行(Review Focus 1)
  - A-Bに進行中の1対1(outcome=proposed)がある状態で{A,B,C} → skipped。A-B行は変化なし・A-C・B-Cの行は作られない(Review Focus 2)
  - メンバー1人が当日6件の通知 → held(通知0件)
  - 機会の3人で、1ペアのみdeferred・抑制期間経過・メンバー更新あり → proposed(既存行のlatch_idが新idへ移る)
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run tests/latches-propose.test.ts tests/latches-group.test.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認** — 加えて `pnpm test` 全体
- [ ] **Step 5: コミット** — `F4b: 提案化を2〜4人の集合へ一般化する(全ペアの履歴確保と巻き戻し)`

### Task 7: 成立後の離脱と表示の離脱者除外

**Files:**
- Modify: `apps/worker/src/latches/respond.ts`(`leave`・`loadForMember`)・`apps/worker/src/routes/latches.ts`(`loadLatchDto`・一覧)
- Test: `apps/worker/tests/latches-group.test.ts`・`latches-api.test.ts`

**Interfaces:**
- Consumes: Task 1の`latchMembers.leftAt`
- Produces: `leave(db, latchId, userId, now): Promise<RespondResult>`(シグネチャ不変)。挙動: 1つのバッチで「latch.status='matched' かつ 本人以外でleft_at IS NULLの参加者数 ≥ `json_extract(proposal,'$.participants.min')`」を条件に本人のleft_atを記録する。記録されなければ(下限割れ)`closeLatch(…,"cancelled", null, ["matched"], now, {notify:false})`。参加者の判定(`loadForMember`・`loadLatchDto`・一覧のjoin)は`left_at IS NULL`の行だけを参加者とみなし、membersとparticipants_countも同じ

- [ ] **Step 1: 失敗する試験を書く**:
  - 4人のmatched(participants.min=3)で1人leave → matchedのまま・本人のleft_atあり・残り3人のGETのmembersは2人・participants_countは3・本人のGETは404・本人の一覧(type=matched)に出ない
  - 続けて2人目がleave → cancelled(closed通知なし)
  - 3人のmatched(min=3)で2人が並行してleave → 結果はcancelledで、matchedのままleft_atが2件ある状態にならない(Review Focus 4)
  - 1対1のleaveは従来どおりcancelled(既存試験が緑)
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: コミット** — `F4b: グループの離脱を残りで継続・下限割れで取り消しにする(オーナー裁定3)`

### Task 8: Poolのデータ取得とペア行の準備

**Files:**
- Create: `apps/worker/src/pipeline/candidates.ts`・`apps/worker/src/pipeline/group-eval.ts`
- Modify: `apps/worker/src/pipeline/evaluate.ts`(upsertと読み直しを`candidates.ts`へ移す)・`layer1.ts`
- Test: `apps/worker/tests/pipeline-group.test.ts`(新規)

**Interfaces:**
- Consumes: Task 3の`selectPool`・`enumerateSets`・`cosineSimilarity`・`intentPairKey`、Task 6の`historyBlockedPairs`
- Produces:
  - `candidates.ts`: `upsertCandidateRows(db, rows: (typeof matchCandidates.$inferInsert)[], now: Date): Promise<Map<string, { id: string; jevResult: JevAxes | null }>>` — 7行チャンクのupsert(衝突時はretrieval_score・cheap_judge_score・updated_atのみ更新)と、UNIQUEキーでの読み直し。戻り値のキーは`intentPairKey`
  - `layer1.ts`: `fetchMembersL1Data(db: DrizzleD1Database, members: IntentRow[]): Promise<Omit<L1Data, "intents">>` — メンバー全員のユーザー間のbirth_date・blocks・proposal_history(matched/rejected)を照会(メンバーは最大16人のため両側in句の1文で足りる)
  - `group-eval.ts`:
    ```ts
    export interface GroupPrep {
    	sets: GroupSet[];
    	/** intentPairKey → match_candidates行(集合に現れるペアのみ) */
    	rows: Map<string, { id: string; jevResult: JevAxes | null; a: IntentRow; b: IntentRow }>;
    	poolSize: number;
    }
    export const prepareGroups = (env: Env, db: DrizzleD1Database, origin: IntentRow, entries: PoolEntry[], now: Date): Promise<GroupPrep | null>;
    ```
    `selectPool`が2件未満ならnull。Pool+起点のベクトルを`getByIds`で取り、他人どうしの類似度はコサイン。pairOk=`layer1Judge`(`fetchMembersL1Data`の値)かつ`historyBlockedPairs`に無い。pairCheap=起点ペアはentriesのcheapScore・他人どうしは`cheapJudgeScore`(evaluate.tsと同じ入力)。集合に現れるペアだけをupsertする(retrieval_score=類似度)

- [ ] **Step 1: 失敗する試験を書く**(インメモリのベクトルストアへ直接upsertし、Intent行をINSERT):
  - 起点{3,3}+候補3件{3,3} → setsは3人集合3件+4人集合1件・行は6ペア分upsert
  - 候補のうち2人の間にblocks行 → その2人を含む集合が無い
  - 候補のうち2人の間にoutcome=rejected(またはmatched)の履歴行 → その2人を含む集合が無く、その組の行はupsertされない(Review Focus 3)
  - 起点{2,2} → null
  - 既存の行にjev_resultがあればrowsのjevResultに入る
  - `pipeline-evaluate.test.ts`が抽出後も緑
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run tests/pipeline-group.test.ts tests/pipeline-evaluate.test.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: コミット** — `F4b: グループのPoolとペア行を準備する`

### Task 9: 評価への統合・集合の提案・計測

**Files:**
- Modify: `apps/worker/src/pipeline/evaluate.ts`・`layer4.ts`・`layer5.ts`・`group-eval.ts`・`metrics.ts`・`consumer.ts`
- Test: `apps/worker/tests/pipeline-group.test.ts`・`pipeline-evaluate.test.ts`・`pipeline-layer4.test.ts`・`pipeline-consumer.test.ts`

**Interfaces:**
- Consumes: Task 4・6・8
- Produces:
  - `runLayer4(env, clock, budgetOrigin: { intentId: string; userId: string }, candidates: L4Candidate[], jev?)` — 予算の起点を明示引数にする(他人どうしのペアが混ざるため`candidates[0].origin`に頼らない)
  - `layer5.ts`: `recheckSet(db: DrizzleD1Database, members: IntentRow[], now: Date): Promise<IntentRow[] | null>` — 全メンバーを読み直し、全員active・全ペア`layer1Judge`合格・`sizeFits`なら最新の行を返す
  - `group-eval.ts`: `finishGroups(db, prep: GroupPrep, plannedSets: GroupSet[], axesByRow: Map<string, JevAxes>, now: Date): Promise<GroupOutcome>`、`interface GroupOutcome { sets: number; overThreshold: number; heldSets: number; proposed: number; held: number }` — aggregateが出せた集合をgroup_candidatesへupsert(dedup_key衝突はaggregate_scoreのみ更新)・出せない集合はheldSetsへ加算・`rankByAggregate`の順に`recheckSet`→`proposeSet(group)`し、proposed/heldで止める
  - `Stage2Result`・`Stage2MetricsData`・payloadに追加: `l4SkippedParticipants`/`l4_skipped_participants`・`groupPool`/`group_pool`・`groupSets`/`group_sets`・`groupJevCalls`/`group_jev_calls`(グループ用にJevへ渡した件数)・`groupHeldSets`/`group_held_sets`(配分の保留+判定欠けの合計)・`groupOverThreshold`/`group_over_threshold`・`groupProposed`/`group_proposed`・`groupHeldProposals`/`group_held_proposals`。Analytics Engineのdoublesは既存の末尾に同順で追加
- evaluate.tsの流れ: L3の候補から1対1の対象=履歴除外を通り`sizeFits([intent, c], 2)`のもの(不合格はl4SkippedParticipants)→ `prepareGroups`(l1Topのうちcheap・類似度付きのentries)→ `planJevAllocation` → 1対1とグループの行を1つの`L4Candidate`列(1対1が先)で`runLayer4` → 全行のlatch_score保存 → 1対1のL5と提案(従来どおり・`proposeSet(pair)`)→ `finishGroups`。グループ部分(prepare〜finish)は`try/catch`で囲み、失敗は`logger.warn("pipeline.group.failed", { intent_id, error_code })`として1対1の結果を返す

- [ ] **Step 1: 失敗する試験を書く**:
  - 3人のつながり{3,3}: A・Bを先に置き、Cを評価 → 3人のLATCHがproposed・payloadの`group_proposed=1`・`group_jev_calls=3`・`jev_calls ≤ 8`
  - 起点{2,4}・1対1候補10件・3人集合あり → Jev呼び出しは8回以内で、1対1は5件以上(最低4回保証)
  - 双方{3,3}の2人だけ → 1対1のLATCHを作らない(`l4_skipped_participants=1`)
  - Jevを差し替えて1ペアだけtimeout(両方失敗) → 集合は提案されず`group_held_sets ≥ 1`・次の評価(同じversion)でそのペアだけJevを呼び、集合が提案される
  - Jev実行後に集合の1人をpaused → その集合は提案されず、次の集合へ進む(Review Focus 5)
  - prepareGroupsが例外 → 1対1の提案は作られ、評価は結果を返す
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run tests/pipeline-group.test.ts tests/pipeline-evaluate.test.ts tests/pipeline-layer4.test.ts tests/pipeline-consumer.test.ts`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認** — 加えて `pnpm test`
- [ ] **Step 5: コミット** — `F4b: 評価にグループの集合選択とJev配分を組み込む`

### Task 10: 次集合の提案

**Files:**
- Create: `apps/worker/src/latches/next-group.ts`
- Modify: `apps/worker/src/latches/respond.ts`(`respondClose`・`onMatched`)・`apps/worker/src/pipeline/cron.ts`(`runResponseDeadlineSweep`)・`apps/worker/src/routes/intents.ts`(`cancelOpenLatchesOf`)
- Test: `apps/worker/tests/latches-group.test.ts`

**Interfaces:**
- Consumes: Task 6の`proposeSet`、Task 9の`recheckSet`・Task 3の`rankByAggregate`
- Produces: `proposeNextGroup(db: DrizzleD1Database, closedIntentIds: string[], now: Date): Promise<ProposeOutcome | null>` — `closedIntentIds.length < 3`なら何もしない(null)。閉じたLATCHのIntentのいずれかを含む group_candidates(status=candidate・aggregate_score > 0.60)を読み、dedup_keyのversionが全員の現行versionと一致するものだけを`rankByAggregate`の順に`recheckSet`→`proposeSet(group)`し、proposed/heldで止める。呼び出しは各クローズ処理の`releaseHeld`の直後(閉じたLATCHのintent_idsを渡す)

- [ ] **Step 1: 失敗する試験を書く**:
  - {A,B,C}のLATCHがproposed・group_candidatesに{A,B,D}(0.9・現行version)→ Cのdeferで{A,B,C}が閉じると{A,B,D}が提案される(A-Bは裁定1で消費されていない)
  - 次集合のversionが古い(Dが更新済み)→ 提案しない
  - 1対1のLATCHのクローズでは呼ばれても何もしない
  - 回答期限切れ走査で閉じた場合も次集合が提案される
- [ ] **Step 2: 失敗を確認**
- [ ] **Step 3: 実装**
- [ ] **Step 4: 緑を確認**
- [ ] **Step 5: コミット** — `F4b: グループ提案のクローズ後に次の集合を提案する`

### Task 11: ゲートE2E(#24)

**Files:**
- Create: `apps/worker/e2e/group-latches.spec.ts`

**Interfaces:**
- Consumes: `e2e/helpers.ts`の`registerUser`・`createIntent`・`waitForLatch`・`respond`・`backdate`・`runCron`、dev観測API(`/v1/dev/latches`・`/v1/dev/proposal-history`・`/v1/dev/match-events`)
- seed: `latches.spec.ts`冒頭の方針を踏襲(新規ユーザー・testごとに離れた地域・各testの前に`scripts/clean-e2e-data.mjs`・最後にDELETE)。Intentの作成は`latches.spec.ts`の`createConnection`/`createOccasion`と同じボディに`participants: { min, max, includes_owner: true }`を加える。他specの残置Intentは{2,2}のためPoolに入らない

- [ ] **Step 1: 試験を書く**:
  - **3人のつながり集合**: 3人が{3,3}で作成 → `intent_ids.length === 3`のLATCHがproposed。各人の`GET /v1/latches/{id}`は`participants_count=3`でmembers・proposalのキーなし。2人yes→partial_accept・3人目yes→matched・membersは2人・履歴3行すべてmatched・3人目のembedding_completedのpayloadで`group_proposed=1`
  - **4人の機会集合**: 4人が{4,4}・starts_at=now+4時間・同じ時間帯 → 4人のLATCH・全員yesでmatched・4件のIntentがmatched・履歴6行matched
  - **1人のdefer**: 3人集合でAがdefer → rejected・履歴はA含む2行deferred・B-Cの行なし
  - **期限切れ**: 3人集合でB・Cがyes → `backdate(response_deadline=過去)`→`runCron` → expired・履歴はA含む2行expired・B-Cの行なし
- [ ] **Step 2: 実行** — `pnpm --filter web build` の後 `pnpm --filter worker test:e2e`(ポート競合時は`LATCH_E2E_PORT=<空きポート>`)。新specと既存32本がすべてPASS
- [ ] **Step 3: コミット** — `F4b: グループLATCHのゲートE2E(#24)を追加する`

### Task 12: 文書の更新と完了記録

**Files:**
- Modify: `docs/01-requirements.md`・`docs/05-data-model-api.md`・`docs/06-matching-pipeline.md`・`docs/12-development-roadmap.md`・`docs/00-document-roadmap.md`(§1の版数表)・`AGENTS.md`、版数を上げた文書を前提文書に持つ文書の前提文書欄

- [ ] **Step 1: 記述** —
  - 01: 冒頭の決定記録へspec §0.2の裁定3件(決定内容/根拠/影響)
  - 05: latch_members.left_at・離脱の規則(残りで継続・proposal.participants.min割れで全体cancelled・離脱者は非参加扱い)・group_candidatesの保存と状態・ペア別の履歴記録(§2.2の「履歴を消費しない閉じ方」の段落に追記)
  - 06: §3 Layer 4の配分(「F4bで導入」の文言を実装確定へ)・人数条件(1対1を含む)・Pool・集合列挙・aggregate・選択順・1評価1集合、§4のグループの履歴規則(「同ペア間の提案履歴は通常どおり記録される」を裁定2へ書き換え)・次集合、§7のpayload追加項目
  - 12: §2の表でF4bを完了と記録(#24をworker E2Eで証明)
  - AGENTS.md: 「現在の状態」へF4bの完了を追記し、「次はF4c」へ更新
  - 各文書の版数・変更点行・前提文書欄・00 §1の版数表を揃える
- [ ] **Step 2: 確認** — `rg -n "通常どおり記録" docs/` が0件、`rg -n "F4bで導入" docs/` が0件。版数表と各文書冒頭の版数が一致
- [ ] **Step 3: コミット** — `F4b: グループLATCHの実装確定とオーナー裁定を01・05・06・12へ記録する`
