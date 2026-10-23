# LLM real接続 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** stagingをCloudflare Accessで閉じたうえで、Parser(Anthropic)・Jev(TypeSafe/予備Anthropic)のreal接続を作り、ゴールドセットの精度ゲートに合格させ、地域名の判断を経てstagingをrealにし、#33を測り直す。

**Architecture:** real実装は`apps/worker/src/llm/real/`に置き、`fetch`で直接呼ぶ(SDKなし)。失敗は例外にせず`ParserOutcome`/`JevOutcome`で返す。指示文・モデル名は`apps/worker/src/llm/real/prompts.ts`の1ファイルに集め、採点の指紋の対象にする。採点は`tools/eval`(Node・tsx)で手元から行い、記録`eval/records/gate.json`をCIが照合する。

**Tech Stack:** Cloudflare Workers(Hono)・D1・Vitest(workerはvitest-pool-workers・toolsはNode)・k6 v1.8.1・tsx・yaml

**Spec:** docs/superpowers/specs/2026-10-24-llm-real-connection-design.md

**設計書との違い(計画の裁量):** 設計書§3.4はCIの照合を「workerの単体試験」としたが、workerの試験はminiflare上でリポジトリのファイルを読めないため、`tools/eval`のNodeの試験(`pnpm test`で走る)に置く。照合の中身は設計書どおり。

## Global Constraints

- 応答・コミットメッセージ・文書・コード中のコメントは日本語。レガシー実装に触れない
- コミットは `git add <パス>` のみ(`-A`・`commit -a` 禁止)。末尾に `Co-Authored-By: <実行したモデル> <noreply@anthropic.com>`
- stagingのURL・CloudflareのアカウントID・Accessのチームのドメイン・AUD・APIキー・サービストークンの値を、文書・設定・コミット・ログ・標準出力に書かない
- k6は `tools/load/run.mjs` 経由で実行する
- Cloudflareの資源・設定を新しく作る/消す操作はオーナーの事前承認(stagingへのデプロイとD1のマイグレーションは承認済み)。pushは毎回オーナーの承認
- 本物のAIを呼ぶ試験はCIに置かない(`pnpm test` は課金ゼロで完結する)
- 既存のE2E・統合試験はstubのまま緑であること
- 用語: 「Layer 2 Candidate Retrieval」「アプリ内通知」「機会Intent」「つながりIntent」・数値は「p95 0.5秒」の形
- 固定値: Parser timeout 10秒・再試行0 / Jev timeout 6秒 / Anthropicモデル `claude-haiku-5-5` / TypeSafeのエンドポイント `https://api.typesafe.ai/v1/systemone` / Anthropicのエンドポイント `https://api.anthropic.com/v1/messages`
- 合格基準(07 §6・設計書§3.3): form 90%・topic 85%・category 85%・time.start 90%・participants 80%・budget 90%・場所の言及のwarnings 90%・alcohol recall 100%かつprecision 90%・Jev順序整合の中央値0.3以下(第一候補と予備のそれぞれ)
- 合格基準を下げない。届かない項目が残ったらオーナーに相談する

## Review Focus

1. モデルが7軸の一部だけ・範囲外の数値・文字列の数値を返す → `invalid_output`(予備へ切り替えず保留)。Task 6で試験する
2. Anthropicが200で`stop_reason: "max_tokens"`やJSONでない本文を返す → `invalid_output`。Task 5で試験する
3. Parserがカテゴリの一覧外・不正なISO時刻・人数5人以上を返す → 422 PARSE_FAILED(200で返さない)。Task 5で試験する
4. Accessの公開鍵の取得が失敗・`kid`が未知 → 403(500にしない)、鍵は`kid`が見つからないときだけ取り直す。Task 1で試験する
5. 外部送信の集計の書き込みが失敗 → 本処理(読み解き・評価)は止めない。Task 7で試験する

## オーナーの操作(コントローラが案内する・サブエージェントに渡さない)

| 印 | 時点 | 内容 |
|---|---|---|
| O1 | Task 2の後・push前 | Cloudflare Accessの有効化・方針・サービストークン/stagingシークレット`ACCESS_AUD`・`ACCESS_TEAM_DOMAIN`/GitHubシークレット`LATCH_ACCESS_CLIENT_ID`・`LATCH_ACCESS_CLIENT_SECRET`/手元の管理外ファイルへ通行証。完了後にpushの承認→デプロイ後に通行証なし403・ありで`/healthz` 200を確かめる |
| O2 | Task 9の後 | ゴールドセットの下書きを読んで直す→承認の日付 |
| O3 | Task 10の後 | `tools/eval/.env`へ`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`(と§7用のWorkers AIのトークン・アカウントID)を置く。AnthropicとTypeSafeの利用額の上限/通知の設定 |
| O4 | Task 12の後 | 地域名を含めるかの判断 |
| O5 | Task 13の前 | stagingのシークレットへ`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`を `!` で登録 |
| O6 | Task 14の中 | 負荷試験の回数と費用の概算の承認 |

---

### Task 1: stagingのAccessの証明をWorkerで検証する(#11)

**Files:**
- Create: `apps/worker/src/auth/access.ts`・`apps/worker/src/auth/access.test.ts`
- Modify: `apps/worker/src/env.ts`(Envに`ACCESS_AUD?`・`ACCESS_TEAM_DOMAIN?`・`assertEnvSafety`)・`apps/worker/src/index.ts`(fetchの先頭)・`apps/worker/src/logging/logger.ts`(許可リストに必要なら`access.denied`)・`apps/worker/worker-configuration.d.ts`(wrangler typesで再生成する場合)

**Interfaces:**
- Produces: `verifyAccessRequest(request: Request, env: Env, fetchFn?: typeof fetch): Promise<{ ok: true } | { ok: false; reason: "missing" | "invalid" | "jwks_unavailable" }>`

- [ ] **Step 1: 失敗する試験を書く** — `access.test.ts`(テスト内でRS256の鍵対を作り、JWKSを返す`fetchFn`を差し替える):
  - ヘッダー無し → `{ok:false, reason:"missing"}`
  - 正しい署名・`iss`=`ACCESS_TEAM_DOMAIN`・`aud`に`ACCESS_AUD`を含む・期限内 → `{ok:true}`
  - aud違い/iss違い/期限切れ/別の鍵の署名 → `"invalid"`
  - JWKSの取得が500 → `"jwks_unavailable"`
  - 2回目の検証で同じ`kid`なら`fetchFn`を呼ばない。未知の`kid`なら1回だけ取り直す
  - `assertEnvSafety`: `LATCH_ENV=staging`で`ACCESS_AUD`か`ACCESS_TEAM_DOMAIN`が無ければ`ENV_MISSING_ACCESS`で始まる例外。`local`では例外なし
- [ ] **Step 2: 試験が落ちることを確かめる** — `pnpm --filter worker exec vitest run src/auth/access.test.ts`
- [ ] **Step 3: 実装** — 署名検証は既存の`src/auth/jwt.ts`・`src/auth/idp.ts`のJWKS検証(WebCrypto)を再利用する。公開鍵はモジュール変数で保持。`index.ts`のfetchで`env.LATCH_ENV === "staging"`のときだけ`verifyAccessRequest`を呼び、`ok:false`なら`new Response("Forbidden", {status: 403})`を返す(理由はログの`error_code`へ)。`assertEnvSafety`はproductionの早期returnより前にstagingの検査を置く
- [ ] **Step 4: 通ることを確かめる** — 上のコマンドと `pnpm --filter worker exec vitest run`・`pnpm typecheck`
- [ ] **Step 5: コミット** — `git add apps/worker/src/auth/access.ts apps/worker/src/auth/access.test.ts apps/worker/src/env.ts apps/worker/src/index.ts …` / `#11: stagingのCloudflare Accessの証明をWorkerで検証する`

### Task 2: 道具とCIが通行証を送る・手順書(#11)

**Files:**
- Modify: `tools/load/lib/api.js`(`headers()`とWebSocketの接続)・`tools/load/run.mjs`(`-e LATCH_ACCESS_CLIENT_ID=…`・`-e LATCH_ACCESS_CLIENT_SECRET=…`を渡し、出力から伏せる)・`tools/load/cleanup.mjs`・`tools/load/report.mjs`(またはその照会部品`tools/load/lib/queries.mjs`)・`tools/load/lib/redact.mjs`・`apps/worker/scripts/staging-smoke.mjs`・`.github/workflows/ci.yml`(スモークのenvに`LATCH_ACCESS_CLIENT_ID`・`LATCH_ACCESS_CLIENT_SECRET`)・`docs/runbooks/staging.md`(Accessの節: §1.1の手順・通行証の置き場所・GitHubシークレット2件・確かめ方)
- Test: 既存の `tools/load/*.test.mjs`・`tools/load/lib/*.test.mjs`

**Interfaces:**
- Produces: `accessHeaders(env: Record<string,string|undefined>): Record<string,string>`(`tools/load/lib/target.mjs`に置き、Nodeの道具とsmokeが共用)。両方の値があれば`{"CF-Access-Client-Id":…, "CF-Access-Client-Secret":…}`、片方でも欠ければ`{}`。k6側は`__ENV`から同じ規則で作る

- [ ] **Step 1: 失敗する試験** — `accessHeaders`の3通り(両方・片方・無し)/`redact`が通行証の値を伏せる/`cleanup`の要求に2つのヘッダーが付く(既存の`cleanup.test.mjs`の差し替えfetchで確かめる)
- [ ] **Step 2: 落ちることを確かめる** — `pnpm --filter load test`
- [ ] **Step 3: 実装** — k6のWebSocketは`new WebSocket(url, null, { headers })`で付ける(k6 v1.8.1の`k6/websockets`の引数を確かめてから)。手元の値は`.superpowers/sdd/2026-10-22-f8b-staging-load-test/access.env`から読む旨を手順書に書く
- [ ] **Step 4: 通ることを確かめる** — `pnpm --filter load test`・`pnpm lint`
- [ ] **Step 5: コミット** — `#11: 負荷試験の道具とCIのスモークがAccessの通行証を送る・手順書`

→ **O1**(オーナーの操作とpush・デプロイ後の確認)。確認できたら#11を結果を書いて閉じる。

### Task 3: Parserの差し替え口を非同期・失敗型付きにする

**Files:**
- Modify: `apps/worker/src/llm/types.ts`・`apps/worker/src/llm/stub/parser.ts`(+test)・`apps/worker/src/llm/mode.ts`(+test)・`apps/worker/src/routes/intents.ts`(parseルート)
- Test: 既存の `tests/` のparseの統合試験

**Interfaces:**
- Produces:
  - `ParserOutput`(`ParserStubOutput`を改名。`category: Category | null`)
  - `type LlmFailureKind = "timeout" | "rate_limited" | "overloaded" | "invalid_output" | "other"`(`JevFailureKind`はこの別名にする)
  - `type ParserOutcome = { ok: true; output: ParserOutput } | { ok: false; kind: LlmFailureKind }`
  - `Llm.parser: (raw_text: string) => Promise<ParserOutcome>`

- [ ] **Step 1: 失敗する試験** — mode.test: `await llm.parser("日曜17時にカレー会")`が`{ok:true}`で`output.time.start`が従来値。intentsのparse: `parser`が`{ok:false, kind:"timeout"}`を返すよう差し替えたとき422 PARSE_FAILED(差し替えの手段が無ければ、`createLlm`に試験用の注入口を足す)
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装** — ルートは`ok:false`をすべて422 PARSE_FAILEDに倒し、ログの`error_code`に`PARSE_${kind}`の大文字を出す。応答スキーマでの再検証は残す
- [ ] **Step 4: 通ることを確かめる** — `pnpm --filter worker exec vitest run`・`pnpm typecheck`
- [ ] **Step 5: コミット** — `LLM real接続: Parserの差し替え口を非同期・失敗型付きにする`

### Task 4: 指示文とモデル名の1ファイル・Anthropicの呼び出し部品

**Files:**
- Create: `apps/worker/src/llm/real/prompts.ts`・`apps/worker/src/llm/real/anthropic.ts`・`apps/worker/src/llm/real/anthropic.test.ts`

**Interfaces:**
- Produces:
  - `prompts.ts`: `ANTHROPIC_MODEL = "claude-haiku-5-5"`・`TYPESAFE_MODEL`(文字列。Task 11で合格した版名に固定する。初期値`"jev-latest"`のままでは採点の記録を合格にしない=Task 10で検査)・`PARSER_SYSTEM_PROMPT(nowJst: string): string`・`PARSER_OUTPUT_SCHEMA`(JSONスキーマ)・`JEV_QUESTIONS`(7軸→`{instructions, criteria:{true,false}}`。timing_fitは機会=日時の一致・つながり=関係の温度と開始時機の一致・07 §5)・`JEV_ANTHROPIC_SYSTEM_PROMPT`・`JEV_OUTPUT_SCHEMA`
  - `callAnthropicJson(args: { apiKey: string; system: string; user: string; schema: object; timeoutMs: number; fetchFn?: typeof fetch }): Promise<{ ok: true; value: unknown } | { ok: false; kind: LlmFailureKind }>`

- [ ] **Step 1: 失敗する試験**(`fetchFn`差し替え): 200で`content[0].text`がJSON → `{ok:true,value}`/429 → `rate_limited`/529と`overloaded_error` → `overloaded`/時間切れ(AbortSignalで`timeoutMs`)→ `timeout`/200で`stop_reason:"max_tokens"` → `invalid_output`/200でJSONでない本文 → `invalid_output`/その他の4xx・5xx・通信失敗 → `other`。要求に`x-api-key`・`anthropic-version: 2023-06-01`・`model: ANTHROPIC_MODEL`・`output_config.format`(`{type:"json_schema", schema}`)が載る
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装** — 実装前に context7(`/anthropics/anthropic-sdk-typescript` または Anthropic APIの説明書)で`output_config.format`のREST上の形と`anthropic-version`を確かめ、違えば試験と合わせて直す。`PARSER_SYSTEM_PROMPT`には設計書§4.1の規則(丸め・form判定・`CATEGORIES`の一覧・0〜23時・JSTオフセット付きISO・人数2〜4への丸めと`{field:"participants"}`・場所の言及で`{field:"geo"}`のwarnings・お酒の暗示表現)を書く
- [ ] **Step 4: 通ることを確かめる**
- [ ] **Step 5: コミット** — `LLM real接続: 指示文の定数とAnthropicの呼び出し部品`

### Task 5: Parser real

**Files:**
- Create: `apps/worker/src/llm/real/parser.ts`・`apps/worker/src/llm/real/parser.test.ts`

**Interfaces:**
- Consumes: Task 3の`ParserOutcome`、Task 4の`callAnthropicJson`・`PARSER_*`
- Produces: `realParser(deps: { apiKey: string; clock: Clock; fetchFn?: typeof fetch }): (raw_text: string) => Promise<ParserOutcome>`

- [ ] **Step 1: 失敗する試験** — 正しい出力 → `ok:true`で`ParserOutput`/カテゴリが`CATEGORIES`の外 → `invalid_output`/`time.start`が不正なISO → `invalid_output`/participants.max 5 → `invalid_output`/送った本文に`raw_text`と現在時刻(JST)以外の利用者情報が無い(要求の本文を検査)/timeoutMsが10000
- [ ] **Step 2〜4**: 落ちる→実装(出力はzodで検証して`ParserOutput`へ写す)→通る
- [ ] **Step 5: コミット** — `LLM real接続: Parser real(Anthropic・構造化出力)`

### Task 6: Jev real(TypeSafeと予備のAnthropic)

**Files:**
- Create: `apps/worker/src/llm/real/jev-typesafe.ts`・`apps/worker/src/llm/real/jev-anthropic.ts`・各`.test.ts`

**Interfaces:**
- Consumes: `JevFn`・`JevInput`・`JEV_AXES`(types.ts)、Task 4の`JEV_QUESTIONS`・`TYPESAFE_MODEL`・`callAnthropicJson`
- Produces: `typesafeJev(deps: { apiKey: string; fetchFn?: typeof fetch; onModel?: (m: string) => void }): JevFn` / `anthropicJev(deps: { apiKey: string; fetchFn?: typeof fetch }): JevFn`

- [ ] **Step 1: 失敗する試験** — TypeSafe: 要求が`{state:{intent_a, intent_b}, model: TYPESAFE_MODEL, questions:{7軸: {type:"noul", instructions, criteria}}}`・`Authorization: Bearer`/7軸の`noul`を返す → `{ok:true, axes}`/1軸欠け・1.2・`"0.5"`(文字列) → `invalid_output`/429 → `rate_limited`/503・529 → `overloaded`/6秒の時間切れ → `timeout`/応答の`model`が`onModel`へ渡る。Anthropic予備: 7軸のJSON → ok/欠け・範囲外 → `invalid_output`/timeoutMs 6000
- [ ] **Step 2〜4**: 落ちる→実装→通る。実装前にcontext7(`/typesafe-docs/typesafeai`)で要求と応答の形を確かめる
- [ ] **Step 5: コミット** — `LLM real接続: Jev real(TypeSafe・予備Anthropic)`

### Task 7: real の束ね・外部送信の集計・起動ガード

**Files:**
- Modify: `packages/shared/src/constants.ts`(`COUNTER_SCOPES`に`"external_send"`)・`apps/worker/src/llm/mode.ts`(+test)・`apps/worker/src/env.ts`(Envに`ANTHROPIC_API_KEY?`・`TYPESAFE_API_KEY?`・`assertEnvSafety`)・`apps/worker/src/routes/dev.ts`(`GET /v1/dev/usage`)・`docs/05`に載せる形はTask 15
- Create: `apps/worker/src/llm/external-send.ts`(+test)

**Interfaces:**
- Produces:
  - `recordExternalSend(db: D1Database, clock: Clock, key: "anthropic:parser" | "anthropic:jev" | "typesafe:jev"): Promise<void>`(`INSERT … ON CONFLICT(scope,key,period) DO UPDATE SET count=count+1`・periodはJSTの`YYYY-MM-DD`・失敗はログだけで例外を外へ出さない)
  - `createLlm(env, clock)`: `LATCH_LLM_MODE=real`なら`parser=realParser`・`jev={primary: typesafeJev, fallback: anthropicJev}`。各呼び出しの直前に`recordExternalSend`(成否を問わず送った回数)
  - `GET /v1/dev/usage?date=YYYY-MM-DD` → `{ date, counts: { "anthropic:parser": n, … } }`(devの既存の隠し方に従う)

- [ ] **Step 1: 失敗する試験** — 加算が同じ日に2回で2/別の日は別行/D1の失敗で例外にならない(Review Focus 5)/`createLlm`がrealでキーがあれば例外にならず`parser`が関数/`assertEnvSafety`: どの環境でも`LATCH_LLM_MODE=real`でキーのどちらかが無ければ`ENV_MISSING_LLM_KEY`で始まる例外/`/v1/dev/usage`の形
- [ ] **Step 2〜4**: 落ちる→実装→通る(`pnpm test`・`pnpm typecheck`・`pnpm --filter web build && pnpm --filter worker test:e2e`)
- [ ] **Step 5: コミット** — `LLM real接続: realの束ね・外部送信の集計・起動ガード`

### Task 8: ゴールドセットの形式と読み込み

**Files:**
- Create: `tools/eval/package.json`(name `eval`・`test: vitest run`・devDependencies `vitest 4.1.12`・`yaml`・`tsx`・`zod`(sharedと同じ版))・`tools/eval/vitest.config.mjs`・`tools/eval/lib/goldset.ts`(+test)・`eval/goldset/README.md`(形式の説明・承認の手順)
- Modify: `.gitignore`(`tools/eval/.env`)・ルート`package.json`(`"eval:gate": "pnpm --filter eval exec tsx gate.ts"`)

**Interfaces:**
- Produces:
  - `loadParserGoldset(path: string): ParserGoldset`・`loadJevGoldset(path: string): JevGoldset`(zodで検証し、違反は件のidつきで例外)
  - 形式は設計書§2.2・§2.3。Parser: `{version, approved_by_owner: string|null, items: [{id, raw_text, now, tags, expect:{form?, topic?, topic_any?, category?, time_start?, participants?, budget?, alcohol_involved?, geo_warning?}}]}`。Jev: `{version, approved_by_owner, pairs: [{id, a: IntentFixture, b: IntentFixture, match: "yes"|"no"}]}`。`IntentFixture`は`buildNormalizedText`に渡せる最小の列(form・topic・softConstraints・negativeConstraints・participantsMin/Max/IncludesOwner・startsAt・endsAt・budgetMin/Max)と任意の`area`

- [ ] **Step 1〜4**: 試験(正しい小さなYAML・idの重複・必須欠け・`now`が不正)→実装→`pnpm --filter eval test`
- [ ] **Step 5: コミット** — `LLM real接続: ゴールドセットの形式と読み込み`

### Task 9: ゴールドセットの下書き(コミットしない)

**Files:**
- Create(未コミット): `eval/goldset/parser.yaml`・`eval/goldset/jev-pairs.yaml`

- [ ] **Step 1**: parser.yaml — つながりIntent40件以上・機会Intent40件以上・境界20件以上。境界にはお酒(「ワイン会」「バーの誕生日会」「日本酒の蔵見学」/負例「コーヒー」「ノンアル」)・form曖昧・地域だけの言及・人数だけ。`approved_by_owner: null`
- [ ] **Step 2**: jev-pairs.yaml — 40組以上(yes/no半々・両form)。各意思に`area`を付ける(同じ地域/違う地域が両方ある)
- [ ] **Step 3**: Task 8のローダーで読めることを確かめる(`pnpm --filter eval exec tsx -e …`)
- [ ] **Step 4**: コミットせず、件数の内訳をレポートに書く

→ **O2**。オーナーの直しを入れて`approved_by_owner`に日付を入れ、コミット(`LLM real接続: ゴールドセット(オーナー承認済み)`)

### Task 10: 採点と記録・CIの照合

**Files:**
- Create: `tools/eval/lib/score.ts`(+test)・`tools/eval/lib/fingerprint.ts`(+test)・`tools/eval/gate.ts`・`tools/eval/gate-check.test.ts`

**Interfaces:**
- Produces:
  - `FINGERPRINT_FILES = ["apps/worker/src/llm/real/prompts.ts", "apps/worker/src/pipeline/normalize.ts", "eval/goldset/parser.yaml", "eval/goldset/jev-pairs.yaml"]`・`fingerprint(repoRoot: string): Record<string,string>`(各ファイルのSHA-256)
  - `scoreParser(items, outcomes): ParserScores`・`scoreJevOrder(pairs, ab, ba): { median: number; n: number }`(設計書§0.4の測り方)・`precisionAt(pairs, outcomes, 0.60)`(参考値)・`judge(scores): { passed: boolean; failures: string[] }`
  - `eval/records/gate.json`: `{ ranAt, passed, failures, scores, reference, models: { anthropic, typesafe_requested, typesafe_answered }, goldset: { parserVersion, jevVersion, approvedByOwner }, fingerprint }`
- 照合(gate-check.test.ts・`pnpm test`で走る): `apps/worker/wrangler.jsonc`(コメント付きJSON)のトップレベルと全`env.*`の`vars.LATCH_LLM_MODE`に`real`があれば、`gate.json`が存在・`passed:true`・`approvedByOwner`が非null・`models.typesafe_requested !== "jev-latest"`・指紋が今のファイルと一致。realが無ければ何もしない

- [ ] **Step 1**: 試験 — scoreの各一致率・alcoholのrecall/precision・topic_any・中央値(偶数個)・judgeの境界(ちょうど90%は合格)/指紋が1文字の変更で変わる/照合: realなし→通る・realあり×記録なし→落ちる・不合格・未承認・指紋違い・`jev-latest`→落ちる(一時ディレクトリに組み立てて検査する関数`checkGate(repoRoot): string[]`を試験する)
- [ ] **Step 2〜4**: 落ちる→実装→通る。`gate.ts`はJevを第一候補(TypeSafe)と予備(Anthropic)の両方で(A,B)・(B,A)の順に流し、両方の順序整合を合否に入れる(設計書§3.3)。APIキーを`tools/eval/.env`から読み、同時4件まで・429はRetry-Afterで待つ(採点の中だけ)。標準出力にキー・URLを出さない
- [ ] **Step 5: コミット** — `LLM real接続: 精度ゲートの採点・記録とCIの照合`

→ **O3**

### Task 11: 採点と指示文の調整(コントローラが進める)

- [ ] **Step 1**: `pnpm eval:gate`を流し、要約を台帳へ
- [ ] **Step 2**: 不合格の項目は、失敗した例を見て`prompts.ts`だけを直して流し直す(ゴールドセットは直さない。期待値の誤りを見つけたらオーナーに確認して直す)。回ごとの値を台帳に記録する
- [ ] **Step 3**: 応答の`model`で`TYPESAFE_MODEL`を固定の版名に改め、もう一度流して合格を確かめる
- [ ] **Step 4**: 5回直しても届かない項目があれば止めてオーナーに相談する
- [ ] **Step 5: コミット** — `prompts.ts`と`eval/records/gate.json` / `LLM real接続: 指示文の調整と精度ゲートの合格の記録`

### Task 12: 地域名の比較

**Files:**
- Create: `tools/eval/region.ts`・`tools/eval/lib/separation.ts`(+test)

**Interfaces:**
- Produces: `separation(yesSims: number[], noSims: number[]): { medianGap: number; auc: number }`
- `region.ts`: jev-pairs.yamlの各組を地域名あり(正規化テキストの末尾に`・<area>`)/なしでWorkers AIのREST(`/accounts/{id}/ai/run/@cf/baai/bge-m3`)に通し、cosineの分かれ方を比べた表を標準出力と`eval/records/region.json`へ。アカウントIDとトークンは`tools/eval/.env`から読み出力しない

- [ ] **Step 1〜4**: `separation`の試験(完全に分かれる→auc 1・同じ→0.5)→実装→実行
- [ ] **Step 5: コミット** — `LLM real接続: 地域名の有無の比較`

→ **O4**。含めると決めたら: `normalize.ts`の`buildNormalizedText`に地域名を足す(逆引きは`apps/worker/src/latches/region.ts`の既存の規則)→試験→Task 11の採り直し→コミット。含めないなら記録だけ

### Task 13: stagingをrealにする

→ **O5**の後。

**Files:**
- Modify: `apps/worker/wrangler.jsonc`(`env.staging.vars.LATCH_LLM_MODE: "real"`)・`apps/worker/scripts/put-staging-secrets.mjs`(必要なら案内文)・`docs/runbooks/staging.md`(キーの登録)

- [ ] **Step 1**: `pnpm test`(照合が通る)・`pnpm typecheck`
- [ ] **Step 2: コミット** — `LLM real接続: stagingをLATCH_LLM_MODE=realにする`
- [ ] **Step 3**: オーナーの承認でpush→CIとデプロイ→通行証つきでparseを1回呼び、`/v1/dev/usage`で`anthropic:parser`が1増えたことを確かめる

### Task 14: #33の測り直し(コントローラが進める)

- [ ] **Step 1**: (a)(b)(d)(c)のParser・Jevの呼び出し回数を過去の報告書の件数から見積もり、費用の概算を出す→**O6**
- [ ] **Step 2**: 手順書7章どおり後始末→(a)→(b)→(d)→(c)を同じRUN_IDで流し、集計は後始末の前
- [ ] **Step 3**: 報告書`docs/reports/f8b-load-test.md`へ§8(real接続での計測)を追記。新しい不具合はissueへ
- [ ] **Step 4: コミット** — `負荷試験: real接続での#33の測り直しを記録する`

### Task 15: 文書の更新

**Files:** docs/07・08・09・05(`/v1/dev/usage`・usage_countersのscope)・01(冒頭の決定記録: オーナー合意1〜5と地域名の判断)・12 §2・02 #33・10 §5・00の版数表・AGENTS.md・docs/runbooks/staging.md

- [ ] **Step 1**: 設計書§9の各項目を反映。変更した文書は版数を上げ変更点行を書く。前提文書欄の同期のみの文書も改版(「前提文書欄の同期のみの改版」)
- [ ] **Step 2**: `rg -n "LLM_REAL_NOT_IMPLEMENTED|未実装として扱い" docs apps` で古い記述が残らないこと
- [ ] **Step 3: コミット** — `文書: LLM real接続の完了を記録する・版数同期`
