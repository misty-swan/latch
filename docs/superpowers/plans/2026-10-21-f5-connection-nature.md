# F5 つながりの性質 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** matchedのLATCHを毎分Cronでcompletedへ進め(つながり=チャット非活動90日・機会=対象時刻+3時間)、つながりIntentの成立後の再候補化をE2Eで証明する(02 §4の#21・#22)。

**Architecture:** 新設の`apps/worker/src/latches/complete.ts`が完了境界の計算と条件付き更新の走査を持ち、`cron.ts`がF4aの隔離方式(`runIsolated`)で呼ぶ。成立のバッチで`last_message_at`を成立時刻へ置き直し、成立一覧・単一取得と画面の状態判定にcompletedを加える。スキーマ変更・マイグレーションは無い。

**Tech Stack:** TypeScript・Hono・drizzle-orm(D1)・vitest(@cloudflare/vitest-pool-workers)・Playwright(worker E2E)・React(web)

**Spec:** docs/superpowers/specs/2026-10-21-f5-connection-nature-design.md

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。コメントは「docs/NN §x」で根拠を参照する慣習に従う
- コミットは `git add <パス>` で対象を限定する(`git add -A`・`git commit -a` は禁止)。コミットメッセージの先頭は `F5: `、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- つながりのcompleted: `last_message_at + 90日 ≤ now`。機会のcompleted: `proposal.time_window.start + 3時間 ≤ now`
- 1回の走査は `PIPELINE.CRON_BATCH_LIMIT`(500件)で頭打ち(つながり・機会の合計)
- 時刻は`Clock`/`now`引数で受け取り、`systemClock`を直接使わない
- ログは許可リスト(`intent_id`・`latch_id`・`status`・`version`・`error_code`・`layer`・`count`・`latency`)のフィールドだけを使う
- completedでIntentの状態(つながり=active・機会=matched)・proposal_history(matched)を変えない。通知を作らない
- 用語: 「つながりIntent」「機会Intent」「アプリ内通知」「Layer 2 Candidate Retrieval」。数値は「90日」「3時間」の表記
- 毎コミットで `pnpm lint`・`pnpm typecheck`・該当パッケージの vitest が緑

## Review Focus

1. completedのLATCHをwebで開くと、現状は「成立しませんでした」(closed)が出る → 「このつながりは終了しました」(ended)を出す(Task 3で`selectLatchView`の試験を追加)
2. 走査と並行したleaveで先にcancelledになった行 → completedへ上書きせず、状態遷移の記録も作らない(Task 2の試験⑨)
3. 成立後にメッセージ相当で`last_message_at`が新しくなった行(F6の書き込みを模して直接UPDATE)→ 走査が古い境界で閉じない(Task 2の試験⑩)
4. つながりと機会の対象が合計500件を超えるとき → 1回の走査で500件だけ閉じ、次回の走査で残りを閉じる(Task 2の試験⑥)
5. 成立前に提案作成時刻から90日以上たっていたつながりLATCH(保留が長く続いた場合)→ 成立直後の走査で閉じない(Task 1で`last_message_at`が成立時刻になることを確認し、Task 2の試験①で走査が閉じないことを確認)

---

### Task 1: 成立時刻を`last_message_at`へ記録する

**Files:**
- Modify: `apps/worker/src/latches/respond.ts`(`respondYes`の`update`。140〜186行付近)
- Test: `apps/worker/tests/latches-respond.test.ts`

**Interfaces:**
- Produces: matchedへの遷移が効いた行の`latches.last_message_at`=成立時刻(Task 2の走査の起点)

- [ ] **Step 1: 失敗する試験を書く**

`latches-respond.test.ts`の既存の配置関数(insertUser・insertIntent・LATCH行の直接INSERT)を使い、`last_message_at`を作成時刻(`ago(48 * HOUR)`)にしたつながりLATCHへ双方のyesを入れる。

```ts
it("双方yesで成立した時点のlast_message_atは成立時刻になる(docs/05 §2.2)", async () => {
	// 配置: last_message_at = ago(48 * HOUR) の proposed つながりLATCH
	// 1人目のyes(NOWの1分前)→ partial_accept の間は last_message_at を変えない
	// 2人目のyes(NOW)→ matched
	expect(afterPartial.lastMessageAt.getTime()).toBe(ago(48 * HOUR).getTime());
	expect(afterMatched.status).toBe("matched");
	expect(afterMatched.lastMessageAt.getTime()).toBe(NOW.getTime());
});
```

- [ ] **Step 2: 試験が失敗することを確かめる**

Run: `pnpm --filter worker exec vitest run tests/latches-respond.test.ts -t "last_message_at"`
Expected: FAIL(`lastMessageAt`が作成時刻のまま)

- [ ] **Step 3: 実装する**

`respondYes`の`update`の`set`に `lastMessageAt: sql\`CASE WHEN ${next} = 'matched' THEN ${nowMs} ELSE last_message_at END\`` を加える(状態の更新と同じ1文で書くため、並行したyesでも成立時刻は1回だけ記録される)。

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `pnpm --filter worker exec vitest run tests/latches-respond.test.ts`
Expected: PASS(既存の試験を含む)

- [ ] **Step 5: コミット**

```bash
git add apps/worker/src/latches/respond.ts apps/worker/tests/latches-respond.test.ts
git commit -m "F5: 成立時刻をlast_message_atへ記録する"
```

### Task 2: Cron (d) completed判定の走査(#22)

**Files:**
- Modify: `packages/shared/src/constants.ts`(`LATCH`へ定数2件)・`packages/shared/src/constants.test.ts`
- Create: `apps/worker/src/latches/complete.ts`
- Create: `apps/worker/src/latches/complete.test.ts`(純関数の単体試験)
- Create: `apps/worker/tests/latches-complete.test.ts`(D1の統合試験)
- Modify: `apps/worker/src/pipeline/cron.ts`(冒頭コメントと`runScheduledPipeline`)

**Interfaces:**
- Consumes: Task 1の`last_message_at`=成立時刻
- Produces:
  - `LATCH.CONNECTION_QUIET_MS = 90 * 24 * 60 * 60_000`(docs/01 §8)・`LATCH.OCCASION_COMPLETE_AFTER_START_MS = 3 * 60 * 60_000`(F5設計 §0.3 裁定2)
  - `connectionCompletionCutoff(now: Date): Date` — `now − 90日`。`last_message_at`がこれ以下なら対象
  - `occasionCompletionCutoffIso(now: Date): string` — `(now − 3時間).toISOString()`。`time_window.start`がこれ以下なら対象
  - `completeOne(db: DrizzleD1Database, latchId: string, now: Date): Promise<boolean>` — 1件を条件付きでcompletedにする(更新が効いたらtrue)
  - `completeDueLatches(db: DrizzleD1Database, now: Date): Promise<{ connection: number; occasion: number }>` — 実際にcompletedにした件数

- [ ] **Step 1: 単体試験を書く(`complete.test.ts`)**

```ts
it("つながりの境界はnowの90日前", () => {
	expect(connectionCompletionCutoff(new Date("2026-06-01T00:00:00Z")).toISOString())
		.toBe("2026-03-03T00:00:00.000Z");
});
it("機会の境界はnowの3時間前のISO 8601(UTC)", () => {
	expect(occasionCompletionCutoffIso(new Date("2026-06-01T03:00:00Z")))
		.toBe("2026-06-01T00:00:00.000Z");
});
```

`constants.test.ts`の`LATCH`の期待値へ2件を加える。

- [ ] **Step 2: 統合試験を書く(`tests/latches-complete.test.ts`)**

配置は`latches-respond.test.ts`と同じ流儀(ユーザー・Intent・`latches`・`latch_members`・`proposal_history`(matched)の行を直接INSERT)。`NOW = 2026-06-01T03:00:00Z`。機会LATCHの`proposal.time_window.start`は`content.ts`の形(ISO 8601)で置く。

| # | 試験名 | 主な期待値 |
|---|---|---|
| ① | つながり: 90日の1ミリ秒前はmatchedのまま | `last_message_at = NOW − 90日 + 1ms` → status=matched・completed_at=null・戻り値 connection=0 |
| ② | つながり: 90日ちょうどでcompleted(#22) | `last_message_at = NOW − 90日` → status=completed・completed_at=NOW・updated_at=NOW・`latch_status_events`に from=matched/to=completed が1行 |
| ③ | 機会: 対象時刻+3時間の境界 | `time_window.start = NOW − 3時間 + 1ms` はmatched、`NOW − 3時間` はcompleted |
| ④ | 機会: グループは最大のstarts_at(time_window.start)で判定する | 3人のLATCHで`time_window.start`=全員のstarts_atの最大値(content.tsの値)を置き、最小値では閉じず最大値の境界で閉じる |
| ⑤ | matched以外は触らない | proposed・partial_accept・cancelled・expired・rejected・candidateの各行(境界を十分過ぎた値)は状態もupdated_atも変わらない |
| ⑥ | 上限500件 | つながり300件+機会300件(いずれも対象)→ 1回目で合計500件・2回目で残り100件・3回目で0件 |
| ⑦ | 冪等 | ②の直後にもう一度呼ぶと戻り値0・`latch_status_events`は1行のまま |
| ⑧ | Intentとproposal_historyは変えない・通知を作らない | つながりIntent=active・機会Intent=matchedのまま・proposal_history.outcome=matched・`notifications`の行数が変わらない |
| ⑨ | 離脱者がいてもLATCH全体を閉じる | 3人のLATCHで1人の`left_at`がある → status=completed |
| ⑩ | 照会後に先にcancelledになった行は閉じない | 走査の照会と書き込みの間の変化を模すため、`completeDueLatches`の書き込み部分を1件ずつ呼べる内部関数`completeOne(db, latchId, now): Promise<boolean>`を export し、cancelledへ更新済みの行に対して`false`・状態変化なし・状態記録なしを確かめる |
| ⑪ | 照会後に`last_message_at`が新しくなった行は閉じない | `last_message_at = NOW − 1時間` に更新済みの行へ`completeOne`→`false` |
| ⑫ | Cronの入口から走る | `runScheduledPipeline(env, fixedClock(NOW))`で②の配置がcompletedになる |

- [ ] **Step 3: 試験が失敗することを確かめる**

Run: `pnpm --filter worker exec vitest run src/latches/complete.test.ts tests/latches-complete.test.ts`
Expected: FAIL(モジュール未定義)

- [ ] **Step 4: 実装する**

- `constants.ts`: `LATCH`へ上記2定数をコメント(docs参照)付きで加える
- `complete.ts`:
  - `completeOne(db, latchId, now)`: 1バッチで (1) 状態記録の`INSERT … SELECT … FROM latches WHERE id=? AND status='matched' AND <時刻条件>` (2) `UPDATE latches SET status='completed', completed_at=now, updated_at=now WHERE` 同じ条件、の順に書く(`respondYes`と同じく記録を先に書く)。時刻条件は form ごとに `last_message_at <= cutoff` / `json_extract(proposal, '$.time_window.start') <= cutoffIso`。戻り値は(2)の更新行数>0
  - `completeDueLatches(db, now)`: つながりを`last_message_at`昇順・機会を`json_extract(proposal, '$.time_window.start')`昇順で、合計`PIPELINE.CRON_BATCH_LIMIT`件まで照会し(つながりを先に・機会は残り枠)、1件ごとに`completeOne`。1件の例外は`logger.warn("cron.item.failed", { latch_id, error_code: errorCodeOf(error) })`で握って続行する。最後に件数が1以上のformごとに`logger.info("cron.completion.done", { layer: "connection" | "occasion", count })`
- `cron.ts`: 冒頭コメントの(d)の行を実装済みの記述へ改め(つながり90日・機会は対象時刻+3時間・F5設計 §2)、`runScheduledPipeline`の`pending`の後に `await runIsolated("completion", () => completeDueLatches(drizzle(env.DB), clock.now()).then(() => undefined));` を加える

- [ ] **Step 5: 試験が通ることを確かめる**

Run: `pnpm --filter worker exec vitest run src/latches/complete.test.ts tests/latches-complete.test.ts tests/pipeline-cron.test.ts && pnpm --filter @latch/shared exec vitest run`
Expected: PASS

- [ ] **Step 6: コミット**

```bash
git add packages/shared/src/constants.ts packages/shared/src/constants.test.ts apps/worker/src/latches/complete.ts apps/worker/src/latches/complete.test.ts apps/worker/tests/latches-complete.test.ts apps/worker/src/pipeline/cron.ts
git commit -m "F5: Cron (d)でmatchedのLATCHをcompletedへ進める(#22)"
```

### Task 3: completedの開示と画面の振り分け

**Files:**
- Modify: `apps/worker/src/routes/latches.ts`(冒頭コメント・`matchedAt`の取得条件 149行付近・一覧の状態 237行付近)
- Modify: `apps/worker/src/latches/view.ts`(冒頭コメント)
- Modify: `apps/web/src/screens/latch/LatchScreen.tsx`(`selectLatchView`)
- Test: `apps/worker/tests/latches-api.test.ts`・`apps/web/src/screens/latch/LatchScreen.test.tsx`

**Interfaces:**
- Consumes: Task 2の`completed`状態(試験では行の直接UPDATEで作る)

- [ ] **Step 1: 失敗する試験を書く**

`latches-api.test.ts`(既存の`setup`・`yes`・`call`を使う。双方yesの後に`status='completed'`へ直接UPDATE):

```ts
it("completedはproposal・members・matched_atを含む(docs/02 D-08)", async () => {
	expect(body.status).toBe("completed");
	expect(body.proposal).toBeDefined();
	expect(body.members).toHaveLength(1);
	expect(body.matched_at).not.toBeNull();
});
it("type=matchedの一覧はcompletedを含み、proposed・cancelledは含まない", async () => {
	expect(ids).toContain(completedId);
	expect(ids).toContain(matchedId);
	expect(ids).not.toContain(proposedId);
});
it("completedへのleaveは400 invalid_status", async () => { /* 既存のinvalid_statusの試験と同じ期待値 */ });
```

`LatchScreen.test.tsx`の`selectLatchView`の表へ1行加える:

```ts
[{ status: "completed", my_response: "yes", proposal: matchedLatch().proposal }, "ended"],
```

- [ ] **Step 2: 試験が失敗することを確かめる**

Run: `pnpm --filter worker exec vitest run tests/latches-api.test.ts && pnpm --filter web exec vitest run src/screens/latch/LatchScreen.test.tsx`
Expected: FAIL(completedにproposalが無い・一覧に出ない・画面がclosed)

- [ ] **Step 3: 実装する**

- `routes/latches.ts`: `matchedAt`の取得条件に`"completed"`を加え、`type=matched`の状態を`["matched", "completed"]`にする。冒頭コメントと`view.ts`のコメントの「成立後」の定義に completed を加える(docs/05 §3.3)
- `LatchScreen.tsx`: `latch.status === "cancelled"`の判定を「cancelled または completed」に広げる(「このつながりは終了しました」・F5設計 §3)

- [ ] **Step 4: 試験が通ることを確かめる**

Run: `pnpm --filter worker exec vitest run tests/latches-api.test.ts && pnpm --filter web exec vitest run`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add apps/worker/src/routes/latches.ts apps/worker/src/latches/view.ts apps/worker/tests/latches-api.test.ts apps/web/src/screens/latch/LatchScreen.tsx apps/web/src/screens/latch/LatchScreen.test.tsx
git commit -m "F5: completedのLATCHを成立一覧と単一取得で開示し、画面で終了として表示する"
```

### Task 4: つながりIntentの成立後の再候補化のE2E(#21)

**Files:**
- Modify: `apps/worker/e2e/latches.spec.ts`(冒頭コメントの対象番号に#21を加え、末尾へtestを追加)

**Interfaces:**
- Consumes: 同ファイルの`proposePair`・`createConnection`・`waitForEvaluation`・`waitForLatch`・`isPairOf`・`getLatch`・`historyOf`・`deletePair`・`deleteIntent`・`site`・helpersの`respond`・`registerUser`

- [ ] **Step 1: 試験を書く**

```ts
test("#21 つながりIntentの成立後のactive復帰と再候補化", async ({ request }) => {
	const topic = "週末に一緒に将棋を指せる仲間を探しています";
	const pair = await proposePair(request, "復帰", (user) =>
		createConnection(request, user, topic, site(13)),
	);
	await respond(request, pair.a.access_token, pair.latch.id, "yes");
	expect((await respond(request, pair.b.access_token, pair.latch.id, "yes")).status).toBe("matched");
	// 合格証拠(#21): 成立後もAのつながりIntentはactive(GET /v1/intents/{id}のstatus)
	// 第三者Cが意味的に近いつながりIntentを登録し、評価の完了を待つ
	const c = await registerUser(request, "E2E復帰C");
	const z = await createConnection(request, c, topic, site(13));
	await waitForEvaluation(request, c.access_token, z.id, 1);
	// 合格証拠(#21): AのIntent(x)とCのIntent(z)の新しい提案が記録される
	const ac = await waitForLatch(request, pair.a.access_token, pair.x.id, isPairOf(pair.x, z));
	expect(ac.status).toBe("proposed");
	expect(ac.id).not.toBe(pair.latch.id);
	// A–Bは成立済みのため再提案されない(proposal_historyはmatchedのまま)
	// 後片付け: deletePair(pair)・deleteIntent(c, z.id)
});
```

成立後のAのIntentの状態は`GET /v1/intents/{x.id}`で`status === "active"`を確かめる(成立直後とCの提案記録後の2回)。A–Bの履歴は`historyOf(request, pair.a)`で`outcome === "matched"`を確かめる。

- [ ] **Step 2: E2Eを実行する**

Run: `pnpm --filter web build && pnpm --filter worker exec playwright test e2e/latches.spec.ts -g "#21"`
Expected: PASS。失敗した場合は除外理由を`GET /v1/dev/match-events?intent_id=<z>`のpayload(`l1_exclusions`等)で特定し、除外の原因をsrcで直す(F5設計 §0.2の1)

- [ ] **Step 3: worker E2E全体を実行する**

Run: `pnpm --filter worker test:e2e`
Expected: 37本すべてPASS(既存36本+#21)

- [ ] **Step 4: コミット**

```bash
git add apps/worker/e2e/latches.spec.ts
git commit -m "F5: つながりIntentの成立後の再候補化のゲートE2E(#21)を追加する"
```

### Task 5: 文書の更新とゲートの記録

**Files:**
- Modify: `docs/01-requirements.md`(冒頭の決定記録・§8)・`docs/05-data-model-api.md`(§2.2 completed_at・§2.6・§3.3 GET /v1/latches)・`docs/06-matching-pipeline.md`(§2のCron (d)・実装確定(F5))・`docs/04-system-architecture.md`(§4のCron (d))・`docs/10-test-env-nfr.md`(#21・#22の証明の所在・E2E本数)・`docs/12-development-roadmap.md`(§2のF5完了・DELETE /v1/latches/{id}=F6・feedback=F9の担当)・`docs/00-document-roadmap.md`(§1の版数表)・`AGENTS.md`(現在の状態)
- 各文書の版数を上げ、冒頭に変更点行を追記し、前提文書欄を揃える(docs/00 §3)

- [ ] **Step 1: 01へ決定記録を書く**

冒頭の決定記録に2026-10-21のオーナー裁定2件を「決定内容/根拠/影響」の形式で追加する(F5設計 §0.3の表の文言をそのまま使う)。§8の成立の定義の「機会Intent由来のLATCHは対象時刻の経過でcompleted」を「対象時刻から3時間の経過でcompleted」に改める。

- [ ] **Step 2: 04・05・06・10・12・AGENTS.mdを実装の実態へ揃える**

- 05 §2.2のcompleted_at注記を「機会=対象時刻から3時間経過」に、§2.6のcompleted判定に機会を加え、§3.3の`type=matched`を「matched・completed」に改める
- 06 §2のCron (d)を「matchedのLATCHのcompleted判定(つながり=最終メッセージ(0件ならmatched時刻)から90日・機会=対象時刻から3時間)」へ広げ、「実装確定(F5)」の段落(走査上限500・条件付き更新・隔離・ログ)を加える。(d)を「F5で計上する」とした記述を実装済みへ改める
- 04 §4のCron (d)の記述を同じ内容へ揃える
- 10: #22=`tests/latches-complete.test.ts`(注入clock)・#21=`e2e/latches.spec.ts`。worker E2Eの本数を37本へ
- 12 §2: F5の行に完了を記録し、機会の排他・再提案規則はF4aで実装済みと注記。DELETE /v1/latches/{id}をF6・POST /v1/latches/{id}/feedbackをF9の内容欄へ加える
- AGENTS.md: 現在の状態にF5の完了(#21・#22を証明・worker E2E 37本)と「次はF6(チャット)」を記す

- [ ] **Step 3: 版数の整合を確かめる**

Run: `rg -n "文書バージョン|前提文書" docs/0*.md docs/1*.md` と `docs/00-document-roadmap.md` §1の版数表を突き合わせる
Expected: 変更した文書の版数が、各文書の前提文書欄と00 §1の表で一致する

- [ ] **Step 4: 全体の検査を実行する**

Run: `pnpm lint && pnpm typecheck && pnpm test`
Expected: すべて緑

Run: `pnpm --filter web test:e2e`(worker E2Eと同時に実行しない・docs/10 §3)
Expected: 10本PASS

- [ ] **Step 5: コミット**

```bash
git add docs/00-document-roadmap.md docs/01-requirements.md docs/04-system-architecture.md docs/05-data-model-api.md docs/06-matching-pipeline.md docs/10-test-env-nfr.md docs/12-development-roadmap.md AGENTS.md
git commit -m "F5: つながりの性質の完了とオーナー裁定を文書へ記録する"
```
