# F8b stagingの構築と負荷試験 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cloudflare上にstagingを作ってCIから自動で載せ、k6で01 §20の性能目標を計測して02 #33の記録を残す。

**Architecture:** `apps/worker/wrangler.jsonc`に`env.staging`の区画を足し、資源の作成とシークレットの登録をスクリプト化する。CIはmainへのpushで既存の検査が緑のときだけstagingへ載せる。k6のシナリオと集計は新しいワークスペース`tools/load`に置き、応答の時間はk6、内部の時間(Candidate Retrieval・初期判定・通知)はstagingのD1の記録から集計する。

**Tech Stack:** wrangler 4.151.1・GitHub Actions・k6(v1系の最新版・単体のプログラム)・Node.js 22・vitest 4.1.12・jsonc-parser

**Spec:** `docs/superpowers/specs/2026-10-22-f8b-staging-load-test-design.md`

## Global Constraints

- 応答・コミットメッセージ・文書・コメントは日本語。コミットは`git add <パス>`で対象を限定する(`git add -A`・`git commit -a`は禁止)
- コミットの末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- 旧リポジトリ・旧実装への言及をしない
- stagingのURL(`latch-worker-staging.<アカウントのサブドメイン>.workers.dev`)は文書・wrangler.jsonc・報告書・コミットに書かない。CIでは`LATCH_STAGING_URL`シークレット、手元では環境変数`LATCH_LOAD_BASE_URL`で渡す
- アカウント内の既存の資源(`latch-core`・`latch-jobs-probe`・`fireos-*`・`dayborad`)には触れない。作る資源名はspec §1.2の表どおり
- staging vars: `LATCH_ENV=staging`・`LATCH_EMBEDDING_MODE=real`・`LATCH_LLM_MODE=stub`・`LATCH_PUSH_MODE=stub`
- 試験用の利用者のsubjectは`load-<runId>-<連番>`。runIdはUTCの`YYYYMMDDHHmm`(例`202610221530`)。subjectは64字以内(devIdpTokenRequestSchema)
- p95は最近順位法: 昇順に並べ、`ceil(0.95 × n) − 1`番目(0始まり)。n=0は`null`
- 01 §20の目標: Intent保存 p95 0.5秒・Parser p95 3秒・Candidate Retrieval p95 1秒・初期判定 p95 10秒・通知 判定後5秒以内(数値の単位表記は「p95 0.5秒」の形式)
- 用語: 「Layer 2 Candidate Retrieval」「アプリ内通知」「機会Intent(form=occasion)」
- 目標を外れた項目はこの工程で直さない。GitHubのissueに登録し報告書に記録する
- 変更した文書は版数を上げ、冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える(00 §3)

## Review Focus

1. 誤った宛先(将来のprodなど)へk6を向ける → setupでPOST /v1/dev/idp-tokenが200でなければ即中止する(prodは404)。Task 5のcheckTargetの試験で固定する
2. 途中で止まった回の意思が残る → 次の回の前に`cleanup.mjs`が`load-`の利用者の意思をすべて削除する。Task 5の`subjectsWithIntents`の試験で、runIdを問わず`load-`の全利用者を拾うことを固定する
3. 提案が届かなかった意思・送信記録の無い通知 → p95から黙って落とさず「対象n件・計測m件・欠けk件」を報告に出す。Task 2の`summarize`の試験で固定する
4. 計測が0件 → p95はnullで、報告は「計測なし」と出す(NaNや0を出さない)。Task 2の試験で固定する
5. stagingのシークレットの登録漏れ → デプロイ後のスモークで`/healthz`に加えてPOST /v1/dev/idp-tokenの200を確かめる(テスト鍵の登録の証明)。Task 3のsmoke関数とTask 4のCIの手順で固定する

---

### Task 1: Candidate Retrievalの所要時間を記録する

**Files:**
- Modify: `apps/worker/src/pipeline/evaluate.ts`(Stage2Result・store.queryの前後)
- Modify: `apps/worker/src/pipeline/consumer.ts:229-250`(payload)
- Modify: `apps/worker/src/pipeline/metrics.ts`(Stage2MetricsData・doublesの末尾)
- Test: `apps/worker/tests/pipeline-evaluate.test.ts`・`apps/worker/tests/pipeline-consumer.test.ts`・metricsの既存試験

**Interfaces:**
- Produces: `Stage2Result.retrievalMs: number`・`Stage2MetricsData.retrievalMs: number`・payloadキー`retrieval_ms`(payloadの最後のキー)・Analytics Engineのdoublesの最後(groupFailedの後)

- [ ] **Step 1: 失敗する試験を書く**
  - `pipeline-consumer.test.ts`のキー順の試験(`Object.keys(payload)`の配列)の末尾に`"retrieval_ms"`を足す
  - `pipeline-evaluate.test.ts`でpayloadを`toEqual`で比べている箇所に`retrieval_ms: expect.any(Number)`を足し、新しい試験「payloadのretrieval_msは0以上の数」(`expect(payload.retrieval_ms).toBeGreaterThanOrEqual(0)`)を足す
  - metricsの試験でdoublesの長さを24・最後の値が`retrievalMs`であることを確かめる
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter worker exec vitest run tests/pipeline-evaluate.test.ts tests/pipeline-consumer.test.ts` / Expected: FAIL(retrieval_msが無い)
- [ ] **Step 3: 実装する** — `store.query`の直前と直後で`performance.now()`の差を取り`Math.round`したミリ秒を`retrievalMs`とする(Clockを使わない。処理時間の計測であり時刻依存のロジックではないため)。payloadの最後に`retrieval_ms`、doublesの最後に`retrievalMs`。metrics.tsの説明コメントの並び順にも追記する
- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm --filter worker test && pnpm typecheck && pnpm lint` / Expected: すべてPASS
- [ ] **Step 5: worker E2Eのpipeline.spec.tsが緑のままか確かめる** — Run: `pnpm --filter web build && pnpm --filter worker exec playwright test e2e/pipeline.spec.ts` / Expected: PASS
- [ ] **Step 6: コミット** — `F8b: Layer 2 Candidate Retrievalの所要時間をpayloadと計測へ記録する`

### Task 2: 集計のワークスペースと計算部

**Files:**
- Create: `tools/load/package.json`(name=`load`・private・type=module・scripts: `test`=`vitest run`・devDependencies: `vitest` 4.1.12)
- Create: `tools/load/vitest.config.mjs`(environment=node)
- Create: `tools/load/lib/stats.mjs`・`tools/load/lib/stats.test.mjs`
- Modify: `pnpm-workspace.yaml`(`tools/*`を足す)・`biome.json`(includesに`tools/**`)・`pnpm-lock.yaml`(`pnpm install`で更新)

**Interfaces:**
- Produces(`tools/load/lib/stats.mjs`):
  - `p95(values: number[]): number | null`
  - `summarize(name: string, targetMs: number, durations: Array<number | null>): { name, targetMs, total, measured, missing, p95Ms: number | null, pass: boolean | null }` — nullは「計測できなかった1件」(missing)。pass=p95Ms≤targetMs、p95Msがnullならnull
  - `judgeDurations(rows: Array<{ activatedAt: number, pushAttemptedAt: number | null }>): Array<number | null>` — pushAttemptedAt−activatedAt、pushAttemptedAtがnullならnull
  - `notifyDurations(rows: Array<{ createdAt: number, pushAttemptedAt: number | null }>): Array<number | null>`
  - (追記・最終レビュー: `judgeDurations`・`notifyDurations`は集計のCLIから使われず`queries.mjs`の`judgeFromRows`・`notifyFromRows`と重複したため削除した。所要時間の組み立ては`queries.mjs`に一本化。`summarize`の判定は、欠けが1件でもあれば目標以内でも`null`(表は`—(欠けあり)`)に改めた)
  - `renderTable(summaries: ReturnType<typeof summarize>[]): string` — Markdownの表。列: 項目/目標/対象/計測/欠け/p95/判定。p95Msがnullなら`計測なし`、判定は`合格`・`不合格`・`—`。ミリ秒は秒へ換算し小数2桁(`0.42秒`)

- [ ] **Step 1: 失敗する試験を書く**(`stats.test.mjs`)
  - `p95([])`は`null`/`p95([5])`は`5`/1〜100の配列は`95`/1〜20の配列は`19`
  - `summarize("初期判定", 10000, [1000, null, 3000])` → `{ total: 3, measured: 2, missing: 1, p95Ms: 3000, pass: true }`
  - `summarize("通知", 5000, [null])` → `{ measured: 0, p95Ms: null, pass: null }`
  - `judgeDurations([{activatedAt: 100, pushAttemptedAt: 2600}, {activatedAt: 100, pushAttemptedAt: null}])` → `[2500, null]`
  - `renderTable`がnullを`計測なし`・判定`—`、420msを`0.42秒`と出す
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm install && pnpm --filter load test` / Expected: FAIL(関数が無い)
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm test && pnpm lint` / Expected: PASS(ルートの`pnpm test`に`load`が含まれる)
- [ ] **Step 5: コミット** — `F8b: 負荷試験の集計の計算部をtools/loadに置く`

### Task 3: stagingの設定・資源作成・シークレット・手元デプロイのスクリプト

**Files:**
- Modify: `apps/worker/wrangler.jsonc`(`env.staging`)
- Modify: `apps/worker/package.json`(scripts: `provision:staging`・`secrets:staging`・`deploy:staging`・devDependencies: `jsonc-parser`)
- Create: `apps/worker/scripts/provision-staging.mjs`・`apps/worker/scripts/put-staging-secrets.mjs`・`apps/worker/scripts/deploy-staging.mjs`・`apps/worker/scripts/staging-smoke.mjs`
- Test: `apps/worker/tests/wrangler-envs.test.ts`

**Interfaces:**
- Produces: `env.staging`の区画(資源名はspec §1.2)。`staging-smoke.mjs`は`LATCH_STAGING_URL`(未設定なら`LATCH_LOAD_BASE_URL`)を読み、`GET /healthz`=200と`POST /v1/dev/idp-token {"subject":"load-smoke"}`=200を確かめ、どちらかが外れたら非0で終わる。URLを標準出力に出さない
- `deploy-staging.mjs`の順序: `VITE_DEV_AUTH=1 pnpm --filter web build` → `wrangler d1 migrations apply DB --env staging --remote` → `wrangler deploy --env staging` → `staging-smoke.mjs`。どれかが失敗したらそこで止まる

- [ ] **Step 1: 失敗する試験を書く**(`wrangler-envs.test.ts`。`import raw from "../wrangler.jsonc?raw"`を`jsonc-parser`の`parse`で読む)
  - トップレベルと`env.staging`で、`d1_databases`・`kv_namespaces`・`r2_buckets`・`vectorize`・`queues.producers`・`analytics_engine_datasets`・`durable_objects.bindings`のbinding名の集合が一致する。`ai.binding`が両方に在る
  - staging区画の`vars`が上のGlobal Constraintsの4値に一致する
  - staging区画の資源名がトップレベルと異なる(取り違えでローカルの名前を使わない)・queuesのconsumerが`match-events-staging`(max_retries 3・DLQ`match-events-dlq-staging`)と`match-events-dlq-staging`(max_retries 1)
  - staging区画の`triggers.crons`が`["* * * * *"]`
- [ ] **Step 2: 失敗を確かめる** — Run: `pnpm --filter worker exec vitest run tests/wrangler-envs.test.ts` / Expected: FAIL(env.stagingが無い)
- [ ] **Step 3: `env.staging`を書く** — IDはこの時点では仮の値(トップレベルと同じ000…)。Task 4で実IDに置き換える。区画の先頭に、バインディングとvarsは引き継がれないため全部書き直している旨のコメントを置く
- [ ] **Step 4: 通ることを確かめる** — Run: `pnpm --filter worker exec vitest run tests/wrangler-envs.test.ts` / Expected: PASS
- [ ] **Step 5: `provision-staging.mjs`を書く** — `wrangler d1 list --json`・`kv namespace list`・`r2 bucket list`・`vectorize list --json`・`queues list`で既存を調べ、無いものだけ作る(D1・KV×2・R2・Vectorize(`--dimensions 1024 --metric cosine`の後に`vectorize create-metadata-index`でform・status・categoryをstring型で作る)・Queues×2)。最後にD1のuuidとKVの2つのidを表示し、`--write`を付けたときはwrangler.jsoncのstaging区画の該当IDを書き換える(jsonc-parserの`modify`/`applyEdits`でコメントを保つ)。2回続けて実行しても何も作らず同じIDを表示する
- [ ] **Step 6: `put-staging-secrets.mjs`を書く** — prepare-dev-vars.mjsと同じfixturesから値を作り、`wrangler secret put <名前> --env staging`へ標準入力で渡す。JWT_SECRETは`crypto.randomBytes(32).toString("base64url")`。VAPID_SUBJECTは`mailto:dev@latch.invalid`。値を標準出力に出さない
- [ ] **Step 7: `deploy-staging.mjs`と`staging-smoke.mjs`を書き、package.jsonのscriptsへ登録する**
- [ ] **Step 8: 確認** — Run: `pnpm --filter worker test && pnpm typecheck && pnpm lint` / Expected: PASS
- [ ] **Step 9: コミット** — `F8b: stagingの設定区画と資源作成・シークレット・デプロイのスクリプトを追加する`

### Task 4: stagingを実際に作って載せる(Cloudflareの操作・手順書)

このタスクはオーナーのCloudflareアカウントへ資源を作る。実行の前に、作る資源の一覧をオーナーへ示して承認を得る。

**Files:**
- Modify: `apps/worker/wrangler.jsonc`(staging区画の実ID)
- Create: `docs/runbooks/staging.md`

**Interfaces:**
- Consumes: Task 3のスクリプト
- Produces: 動いているstaging。`docs/runbooks/staging.md`の章立て: 1.前提/2.資源の作成/3.シークレットの登録/4.APIトークンとGitHubの登録/5.デプロイ(自動・手元)/6.戻し方/7.負荷試験の実行(Task 5〜8で書き足す)

- [ ] **Step 1: 資源を作る** — Run: `pnpm --filter worker provision:staging -- --write` / Expected: 資源が作られ、wrangler.jsoncのD1・KVのIDが実IDに変わる。もう一度実行して「作成なし・同じID」を確かめる
- [ ] **Step 2: シークレットを登録する** — Run: `pnpm --filter worker secrets:staging` / Expected: 6件(JWT_SECRET・LATCH_TEST_IDP_JWKS・LATCH_TEST_IDP_PRIVATE_JWKS・VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECT)の登録成功(初回はWorkerが無いため、wranglerが空のWorkerを作るか確認を求める。求められたら作る)
- [ ] **Step 3: 手元から載せる** — Run: `LATCH_STAGING_URL=<表示されたURL> pnpm --filter worker deploy:staging` / Expected: マイグレーション0001〜0007の適用・デプロイ・スモーク成功
- [ ] **Step 4: 疎通を1回確かめる** — ブラウザでstagingを開き、テスト用サインイン→登録→意思を預ける→ホームに出る、まで進む。stagingのD1で`SELECT event_type, status FROM match_events ORDER BY created_at DESC LIMIT 3`を実行し、embedding_completedがprocessedになっている(本物のEmbeddingとVectorizeが動いた)ことを確かめる
- [ ] **Step 5: 戻し方を1回試す** — Run: `pnpm --filter worker exec wrangler deployments list --env staging` で版を確かめ、`wrangler rollback --env staging`で直前へ戻し、もう一度`deploy:staging`で最新へ戻す(初回で直前の版が無ければ、Step 3を2回目のデプロイとして行ってから試す)
- [ ] **Step 6: 手順書の1〜6章を書く** — URLは書かず`<stagingのURL>`と表記する。4章にAPIトークンの権限(Account: Workers Scripts 編集・D1 編集・Workers KV Storage 編集・Workers R2 Storage 編集・Queues 編集・Vectorize 編集・Workers AI 読み取り・Account Settings 読み取り)とGitHubの登録先(Settings→Secrets and variables→Actions に`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`LATCH_STAGING_URL`)を書く
- [ ] **Step 7: コミット** — `F8b: stagingを作成し実IDと手順書を追加する`(wrangler.jsoncと手順書のみ)

### Task 5: k6の共通部・後始末・シナリオ(a)

**Files:**
- Create: `tools/load/lib/api.js`(k6用)・`tools/load/lib/target.mjs`・`tools/load/lib/target.test.mjs`・`tools/load/cleanup.mjs`・`tools/load/scenarios/a-intent-burst.js`

**Interfaces:**
- Produces(`tools/load/lib/api.js`・k6のhttpで動く):
  - `signIn(baseUrl, subject): string` — POST /v1/dev/idp-token→POST /v1/auth/token(provider=`google`)→POST /v1/users(display_name=`負荷試験`・birth_date=`2000-01-01`・bio=``)の順で、登録後のaccess_tokenを返す
  - `parseIntent(baseUrl, token, rawText)`・`saveIntent(baseUrl, token, body)` — それぞれのリクエストにk6のタグ`name: "parse"`・`name: "intent_save"`を付ける
  - `createOccasion(baseUrl, token, { topic, startMs })` — 機会Intent(status=active・time=startMs〜+2時間・geoはworker E2E `e2e/latches.spec.ts`と同じ値)を保存しidを返す
  - `checkTarget(status: number): void`(`lib/target.mjs`・純関数) — 200以外なら`宛先がstagingではありません(dev専用サインインが使えない)`の例外
  - `runIdNow(): string`(`lib/target.mjs`) — UTCの`YYYYMMDDHHmm`
- Produces(`cleanup.mjs`・Node): `subjectsWithIntents(rows)`(純関数・`load-`で始まるsubjectだけを重複なく返す)をexportし、CLIとしては`wrangler d1 execute DB --env staging --remote --json`で`SELECT DISTINCT u.auth_subject FROM users u JOIN intents i ON i.user_id = u.id WHERE u.auth_subject LIKE 'load-%'`を取り、各subjectでサインインし直してGET /v1/intents(全頁)→DELETE /v1/intents/{id}。消した件数を出す

- [ ] **Step 1: 失敗する試験を書く**(`target.test.mjs`) — `checkTarget(404)`は例外・`checkTarget(200)`は通る/`runIdNow()`が`/^\d{12}$/`/`subjectsWithIntents([{auth_subject:"load-202610221530-1"},{auth_subject:"load-202610221530-1"},{auth_subject:"load-202610210900-3"},{auth_subject:"e2e-x"}])`が`load-`の2件だけを返す
- [ ] **Step 2: 失敗を確かめ、実装して通す** — Run: `pnpm --filter load test` / Expected: FAIL→PASS
- [ ] **Step 3: シナリオ(a)を書く** — setupで`checkTarget`→100人を`signIn`(subject=`load-<runId>-<1..100>`)。executor=`constant-arrival-rate`(rate 100・timeUnit 1m・duration 5m・preAllocatedVUs 20)。各反復は1人を順に使い、`parseIntent`→応答のフィールドで`saveIntent`(status=active)。1人の作成は5件まで(上限5件)。raw_textは`tools/load/lib/topics.js`の固定の文の一覧から反復番号で選ぶ。thresholds: `http_req_duration{name:intent_save}`の`p(95)<500`・`http_req_duration{name:parse}`の`p(95)<3000`・`http_req_failed`の`rate<0.01`。`--summary-export`で`tools/load/results/<runId>-a.json`へ出す(`tools/load/results/`はgitignore)
- [ ] **Step 4: stagingで小さく試す** — Run: `node tools/load/cleanup.mjs && k6 run -e LATCH_LOAD_BASE_URL=$LATCH_LOAD_BASE_URL -e LOAD_SCALE=0.1 tools/load/scenarios/a-intent-burst.js && node tools/load/cleanup.mjs` / Expected: 10件/分で全件201・cleanupで全件削除。`LOAD_SCALE`(既定1)はrate・人数・時間に掛ける倍率としてシナリオ共通で受け付ける
- [ ] **Step 5: 手順書の7章にk6の入れ方(公式のリリースのバイナリ・版の確認`k6 version`)・環境変数・後始末・(a)の実行を書く**
- [ ] **Step 6: コミット** — `F8b: k6の共通部と後始末とシナリオ(a)を追加する`

### Task 6: シナリオ(b)(d) 作成〜提案と通知の一斉送信

**Files:**
- Create: `tools/load/scenarios/bd-proposal.js`

**Interfaces:**
- Consumes: Task 5の`signIn`・`createOccasion`・`checkTarget`
- Produces: 環境変数`MODE=staggered`(b)/`MODE=burst`(d)。subjectは(b)`load-<runId>-b<n>`・(d)`load-<runId>-d<n>`

- [ ] **Step 1: 書く** — setupで30組=60人を`signIn`。基準時刻=実行時刻+24時間を1時間単位に切り上げ。組kの2人は同じtopic(`topics.js`から)で`createOccasion(startMs = 基準 + k × 3時間)`。(b)は組ごとに2秒間隔で投入(executor=`per-vu-iterations`・vus 30・各VUが1組)、(d)は全VUが同じ時刻(setupが返す開始時刻まで`sleep`)に一斉に投入。各VUは自分の組の2人が`GET /v1/notifications`で`type=proposal`を得るまで1秒間隔・最長60秒待つ(届いた/届かなかった件数をk6のCounterで出す)。k6は時間の計測をしない(§4.1の集計が正本)
- [ ] **Step 2: stagingで試す** — Run: `node tools/load/cleanup.mjs && k6 run -e MODE=staggered -e LOAD_SCALE=0.2 tools/load/scenarios/bd-proposal.js` / Expected: 6組すべてで2人に提案の通知が届く。stagingのD1で各組のLATCHの参加Intentが組の2人だけであることを1回確かめる(組どうしが混ざらない)
- [ ] **Step 3: 手順書の7章に(b)(d)を書き足す**
- [ ] **Step 4: コミット** — `F8b: k6のシナリオ(b)(d)を追加する`

### Task 7: シナリオ(c) チャット同時接続

**Files:**
- Create: `tools/load/scenarios/c-chat.js`

**Interfaces:**
- Consumes: Task 5・6と同じ組の作り方(`createOccasion`・組ごとに時間帯をずらす)
- Produces: k6のTrend`chat_delivery_ms`・Rate`chat_connect_failed`

- [ ] **Step 1: k6のWebSocketの対応を確かめる** — `k6/websockets`(ブラウザ互換のWebSocket API)が入れた版で使えることを`k6 version`と小さなスクリプトで確かめ、結果を手順書と報告書に書く(10 §5の再確認)
- [ ] **Step 2: 書く** — setup(setupTimeout 10m)で50組=100人を`signIn`→組ごとに機会Intentを作り→提案を待ち→2人とも`POST /v1/latches/{id}/response {response:"yes"}`→status=matchedを確かめ、`[{latchId, tokens:[a,b]}]`を返す。本体はexecutor=`per-vu-iterations`・vus 100・iterations 1。VU iは組`floor(i/2)`の`i%2`側として`POST /v1/ws-ticket {scope:"chat", latch_id}`→`wss://.../v1/latches/{id}/ws?ticket=`へ接続し、5分間、5秒ごとに`{type:"message", body:"t=<Date.now()>", client_id:"<vu>-<連番>"}`を送る。相手からの`message`フレームのbodyの時刻との差を`chat_delivery_ms`へ入れる(自分の送信の折り返しは除く)。25秒ごとにping。接続に失敗したら`chat_connect_failed`へ1
- [ ] **Step 3: stagingで試す** — Run: `node tools/load/cleanup.mjs && k6 run -e LOAD_SCALE=0.1 tools/load/scenarios/c-chat.js` / Expected: 10接続すべて成功・`chat_delivery_ms`に値が入る
- [ ] **Step 4: 手順書の7章に(c)を書き足す**
- [ ] **Step 5: コミット** — `F8b: k6のシナリオ(c)を追加する`

### Task 8: 集計のCLI

**Files:**
- Create: `tools/load/report.mjs`・`tools/load/lib/queries.mjs`

**Interfaces:**
- Consumes: Task 2の`summarize`・`judgeDurations`・`notifyDurations`・`p95`・`renderTable`
- Produces: `node tools/load/report.mjs <runId>`。`tools/load/results/<runId>-*.json`(k6のsummary)とstagingのD1を読み、Markdownの表を標準出力へ出す
- `lib/queries.mjs`のSQL(すべて`u.auth_subject LIKE 'load-<runId>-%'`で絞る):
  - 初期判定: 各Intentの`match_events`の`event_type='intent_created'`の`created_at`(activatedAt)と、`latches`の`intent_ids`(json_each)にそのIntentを含むLATCHについて、そのIntentの利用者への`notifications`の`type='proposal'`の行の最小の`push_attempted_at`。提案が無ければnull
  - 通知: 上の利用者への`type='proposal'`の`created_at`・`push_attempted_at`
  - Candidate Retrieval: そのIntentの`event_type='embedding_completed'`の`json_extract(payload,'$.retrieval_ms')`

- [ ] **Step 1: queries.mjsのSQLを関数`buildQueries(runId)`で返すようにし、runIdが`/^\d{12}$/`でなければ例外とする試験を書いて通す**(SQLへの差し込みを防ぐ) — Run: `pnpm --filter load test` / Expected: FAIL→PASS
- [ ] **Step 2: report.mjsを書く** — k6のsummaryからIntent保存・Parserのp95(`http_req_duration{name:...}`の`p(95)`)とチャットの`chat_delivery_ms`の`p(95)`・`chat_connect_failed`を読み、D1の3つの集計と合わせて`renderTable`で出す。Parser・初期判定の行には「(stub)」を付ける
- [ ] **Step 3: Task 6・7の小さな実行のrunIdで動かし、表が出ることを確かめる**
- [ ] **Step 4: コミット** — `F8b: 負荷試験の集計のCLIを追加する`

### Task 9: CIの自動デプロイ

**Files:**
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: Task 3の`deploy-staging.mjs`と同じ手順(CIでは各手順を個別のstepとして書き、どこで落ちたかを記録で分かるようにする)

- [ ] **Step 1: `deploy-staging`ジョブを書く** — `if: github.event_name == 'push' && github.ref == 'refs/heads/main' && vars.STAGING_DEPLOY_ENABLED == 'true'`(シークレットの登録前にジョブが赤くならないよう、オーナーがリポジトリ変数を`true`にしたときから動く)・`needs: [ci, web-e2e]`・`concurrency: { group: staging-deploy, cancel-in-progress: false }`・env`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`LATCH_STAGING_URL`をsecretsから。steps: checkout→pnpm→node 22.22.0→`pnpm install --frozen-lockfile`→`VITE_DEV_AUTH=1 pnpm --filter web build`→`pnpm --filter worker exec wrangler d1 migrations apply DB --env staging --remote`→`pnpm --filter worker exec wrangler deploy --env staging`→`node apps/worker/scripts/staging-smoke.mjs`。既存の「staging自動デプロイはCloudflareトークン手配時に追加」のコメントを消す
- [ ] **Step 2: 書式を確かめる** — Run: `pnpm dlx @action-validator/cli .github/workflows/ci.yml`(使えなければ`actionlint`) / Expected: エラーなし
- [ ] **Step 3: コミット** — `F8b: mainへのpushでstagingへ自動デプロイするCIを追加する`
- [ ] **Step 4: オーナーへ依頼する** — 手順書4章のトークン発行とGitHubへの登録。登録後にmainへのpushでジョブが緑になることを確かめる(この確認はF8bの完了の条件に含めない。手順書4章に、登録の最後にリポジトリ変数`STAGING_DEPLOY_ENABLED=true`を作ることを書く)

### Task 10: 負荷試験の本番の実行と報告書

**Files:**
- Create: `docs/reports/f8b-load-test.md`

- [ ] **Step 1: 実行する** — 手順書7章どおり、`cleanup`→(a)→`cleanup`→(b)→`cleanup`→(d)→`cleanup`→(c)→`cleanup`を同じrunIdで行う(`-e RUN_ID=<runId>`で固定)。各シナリオの前に直前の回のキューの消化を待つ(stagingのD1で`SELECT count(*) FROM match_events WHERE status='pending'`が0)
- [ ] **Step 2: 集計する** — Run: `node tools/load/report.mjs <runId>` / Expected: 表が出る
- [ ] **Step 3: 報告書を書く** — spec §4.3の項目(実施日・stagingの版(`wrangler deployments list --env staging`のversion id)・k6の版・シナリオごとの件数・表・stubの注記・起点と送信記録の注記(spec §4.1)・レート制限が未実装である旨・k6/websocketsの確認結果・Cloudflareのダッシュボードの利用量)。URLは書かない
- [ ] **Step 4: 外れた項目があればissueを登録する** — `gh issue create`で1項目1件(タイトル`F8b負荷試験: <項目>がp95 <値>で目標<目標>を超えた`)。番号を報告書に書く
- [ ] **Step 5: コミット** — `F8b: 負荷試験の結果を記録する`

### Task 11: 文書の更新

**Files:**
- Modify: `docs/04-*.md` §6・`docs/06-*.md` §7・`docs/10-*.md` §1・§5・§7・`docs/11-*.md` §2・§3・`docs/02-*.md` §4 #33・`docs/12-*.md` §2・`docs/01-*.md` 冒頭の決定記録・`docs/00-*.md`(§1の版数表・索引に`docs/runbooks/staging.md`と`docs/reports/f8b-load-test.md`)・`AGENTS.md`(現在の状態)

- [ ] **Step 1: 内容を反映する** — spec §6の一覧どおり。決定記録(01冒頭と12 §2)は「決定内容: #33をParser/Jevはstub・Embeddingはrealで計測し、LLM real接続の工程で同じシナリオと集計(tools/load)を流し直して確定する。#33は記録が揃うまで『stubでの計測済み・測り直し待ち』とする/根拠: real接続は未実装でF9前の独立工程(12 §2)。キュー・D1・Vectorize・DO・通知の速さはstubでも本物の環境で測れる/影響: 02 #33・12 §2のフェーズ表・11 §1」の形で書く。12 §2のフェーズ表のF8bを完了とし、LLM real接続の行に#33の測り直しを加える
- [ ] **Step 2: 版数を揃える** — 変更した文書ごとに版数を上げ変更点行を追記し、各文書の前提文書欄と00 §1の版数表を実態に合わせる。Run: `rg -n "文書バージョン: v" docs/0*.md docs/1*.md` で00 §1の表と突き合わせる
- [ ] **Step 3: 確認** — Run: `pnpm lint && pnpm typecheck && pnpm test` / Expected: PASS
- [ ] **Step 4: コミット** — `F8b: stagingの構築と負荷試験の完了を文書へ記録する`
