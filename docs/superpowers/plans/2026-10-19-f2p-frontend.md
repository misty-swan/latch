# F2' フロント基盤実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** F2'「フロント基盤」— React+Vite+PWA設定・TanStack Query・認証画面・預ける〜読み解き確認を `prototype/` 基準で実装し、ゲート「画面フローがprototype/基準であること」をブラウザE2E(Playwright/chromium)で証明する(12 §2のF2'行)。

**Architecture:** apps/webをSPAとして組み立てる(React Router・TanStack Query・`prototype/project/latch.css`の移植・fetchラッパのAPIクライアント)。配信は同一オリジン=Workers Assets(本番: `/v1/*`のみWorkerを優先・他は静的+SPAフォールバック)/開発は `vite dev`(8787のwrangler devへ `/v1` プロキシ)。サインインは開発・ステージング用のテスト鍵サインイン(10 §2の内部トークンをWorkerのdev専用エンドポイントで発行)で本フローを通し、本番IdP(Google/Apple SDK)の接続は公開準備(F10前)までのスコープ外とする。UIの正本は `prototype/`(画面ボードHTML+`latch.css`)で、文言・クラス名・構造はボードどおりに移植する(独自の改善判断をしない)。

**Tech Stack:** TypeScript(strict)・React 19・Vite・vite-plugin-pwa・React Router(library mode)・@tanstack/react-query・react-hook-form+zod resolver(sharedスキーマ流用)・vitest+Testing Library(happy-dom)・Playwright(chromium)・Hono(worker側devエンドポイント)。

**Spec:** `docs/12-development-roadmap.md` §2(F2'行)・`docs/04-system-architecture.md` §3.2/§3.3(フロントスタック)・`docs/05-data-model-api.md` §3(API契約・F2で確定済みのIntent系形状)・`docs/01-requirements.md` §9/§10(入力と画面の規則・表示語対照)・`docs/07-jev-llm-spec.md` §8(同意文言)・`docs/10-test-env-nfr.md` §2/§4(テストユーザー・E2E)・**`prototype/`(UI正本・README §4〜§6と画面ボード)**。

## Global Constraints

- **UI正本は `prototype/`**: 各画面の文言・構造・クラス名・動きは対応ボード(`prototype/project/<画面名>.dc.html`)と`latch.css`に従う。デザインの判断はボードに聞き、ボードに無い細部だけ実装の裁量とする
- **スタイリング(D-A-07解消)**: バニラCSS(グローバル)。`prototype/project/latch.css` を `apps/web/src/styles/latch.css` へそのまま移植し、画面個別の追加分のみ `apps/web/src/styles/` に別ファイルで置く
- コミットは `git add <パス>` で対象限定(`git add -A`・`-a`禁止)。コミットメッセージは日本語・接頭辞「F2': 」
- 毎コミット: `pnpm lint`・`pnpm typecheck`・`pnpm test` が緑。字下げタブ・文字列ダブルクォート(Biome)
- APIとの入出力の型・検証は `@latch/shared` のスキーマを使う(勝手に再定義しない)。エラー表示は05 §3.1の `{error:{code,message,details}}` を前提にする
- 表示語対照(01 §5): Intent→「預けた意思」/ connection→「つながり」/ occasion→「機会」/ 提案→「提案」。画面に「探す」を使わない。状態の表示名は01 §10の対照
- 時刻の表示はJST。製品コード(UI除く)の時刻規律は04 §4
- **F2'スコープ外**: 提案・回答・チャット・成立画面(F4/F6)・お知らせ・設定・通報・ブロック・退会画面(F7)・オフライン表示とホーム画面追加の実機検証(F8)・本番IdP SDK接続(F10前)・地名検索による地域添付UI(geofeaturesはF3で取り込み。F2'の地域は「指定なし(全国)」固定)・IntentDetail画面(次フェーズ)
- devサインインエンドポイントはprod絶対拒否(起動ガード+二重防御)。テスト鍵はコミット済みfixturesのみ

## Review Focus

1. **401→リフレッシュ→再試行の導線** — access期限切れ時に自動更新され、リフレッシュ失敗時は/welcomeへ遷移し無限ループしない → Task 1・8のテスト
2. **draft「下書きに残す」と再開の分岐** — raw_textのみPOST(draft)→Home→再開でComposeに復元→預けるはPATCH(既存id・version+1)で新規作成と混同しない → Task 4・6のテスト
3. **Confirmの状態の寿命** — parse結果をどう運ぶか(直アクセス・リロードで壊れない・戻るで文章を保持) → Task 4・5
4. **クライアント検証とサーバーエラーの両対応** — 300字・topic 40字・人数2..4・日時(now〜+7日)の入力時検証と、サーバー400のreasons別表示(topic_required/starts_at_out_of_range等) → Task 5
5. **E2Eの安定性** — 実時間依存を排し(日時は動生成)、タイムアウト・待ち合わせは明示的セレクタで行う → Task 8

---

### Task 1: web基盤(ルータ・Query・APIクライアント・latch.css移植)

**Files:**
- Modify: `apps/web/package.json`(react-router・@tanstack/react-query等を `--save-exact` で追加)
- Create: `apps/web/src/api/client.ts`・`apps/web/src/api/client.test.ts`
- Create: `apps/web/src/auth/session.ts`・`apps/web/src/auth/session.test.ts`
- Create: `apps/web/src/styles/latch.css`(prototypeから丸ごとコピー)・`apps/web/src/styles/app.css`(追加分の置き場)
- Modify: `apps/web/src/main.tsx`・`apps/web/src/App.tsx`(Router+QueryClient+テーマの組立て)
- Modify: `apps/web/src/App.test.tsx`(既存テストの更新)

**Interfaces:**
- Produces(以降のタスクが使う):
  - `class ApiError extends Error { code: ErrorCode; details: Record<string, unknown> }`・`apiFetch<T>(path: string, init?: RequestInit & {json?: unknown}): Promise<T>`(同一名オリジン `/v1`・Bearer自動付与・401(TOKEN_EXPIRED/UNAUTHORIZED)時にリフレッシュ1回→再試行・リフレッシュ失敗でセッション破棄して `/welcome` へ)
  - `authSession`: アクセストークンはメモリ・リフレッシュトークンはlocalStorage(`latch.refresh`)。`restore(): Promise<boolean>`(起動時リフレッシュ試行)・`setTokens`/`clear`
  - `ThemeProvider`(`data-theme` light/dark・既定は端末設定 `prefers-color-scheme`)・`useTheme()`
  - ルーティング: `createBrowserRouter`・ルート定数 `PATHS`(welcome/intro/signin/register/consent/compose/reading/confirm/parse-failed/placed/home)
- Consumes: `@latch/shared`(ErrorCode等)

- [ ] **Step 1: 失敗テスト(client.test.ts・session.test.ts・fetchをモック)**

```ts
// client: 200 JSONを返す / 401 TOKEN_EXPIRED→refresh成功→再試行で200 / refreshも失敗→セッションclear+/welcome遷移(mock history)
// 401以外のエラー形状 {error:{code,message,details}} → ApiError
// session: localStorageのrefreshで復元 / clearでlocalStorage除去
```

- [ ] **Step 2: 失敗確認** — `pnpm --filter web exec vitest run` → FAIL
- [ ] **Step 3: 実装**(fetchラッパはグローバルfetchをそのまま使う・依存追加は `pnpm --filter web add --save-exact react-router @tanstack/react-query`)
- [ ] **Step 4: 成功確認** — 同コマンド+`pnpm typecheck` → PASS
- [ ] **Step 5: コミット** — `git add apps/web/package.json pnpm-lock.yaml apps/web/src` / 「F2': ルータ・Query・APIクライアントとlatch.css移植の基盤を追加」

---

### Task 2: worker — devサインインとWorkers Assets配信

**Files:**
- Create: `apps/worker/src/routes/dev.ts`
- Create: `apps/worker/tests/dev-api.test.ts`
- Modify: `apps/worker/src/index.ts`(マウント)
- Modify: `apps/worker/wrangler.jsonc`(assets設定)
- Modify: `apps/worker/scripts/prepare-dev-vars.mjs`(必要なら)

**Interfaces:**
- Consumes: `LATCH_TEST_IDP_JWKS`・tests/fixtures秘密鍵・`TEST_IDP_ISSUER/AUDIENCE`
- Produces:
  - `POST /v1/dev/idp-token` body `{subject: string(1..64)}` → 200 `{idp_token}`。**LATCH_TEST_IDP_JWKS未設定またはLATCH_ENV==="production"では404**(存在を隠す)。署名鍵は `env.LATCH_TEST_IDP_PRIVATE_JWKS`(fixturesの秘密JWKのJSON文字列。`scripts/prepare-dev-vars.mjs` が `.dev.vars` へ生成し、ローカル/CI/E2Eのみに存在。prod起動ガード(assertEnvSafety)に同変数の残存検査を追加して二重防御)
  - wrangler.jsonc: `"assets": { "directory": "../web/dist", "not_found_handling": "single-page-application" }` + `"run_worker_first": ["/v1/*"]`
- ログ: `dev.signin.issued`(subject等は出さない)

- [ ] **Step 1: 失敗テスト(tests/dev-api.test.ts)**

```ts
// - LATCH_TEST_IDP_PRIVATE_JWK+LATCH_TEST_IDP_JWKS設定時: subject→idp_tokenが取得でき、それでPOST /v1/auth/tokenが200(registration_required=true)
// - 未設定時 → 404 / LATCH_ENV=production相当(env上書き)→404
// - assertEnvSafety: production+LATCH_TEST_IDP_PRIVATE_JWK残存 → throw(起動ガード追加)
```

- [ ] **Step 2: 失敗確認** → FAIL
- [ ] **Step 3: 実装**(vitest.config.tsのbindingsにも秘密鍵を追加・prepare-dev-vars.mjsへ同変数の生成を追加)
- [ ] **Step 4: 成功確認** → PASS
- [ ] **Step 5: コミット** — 「F2': dev専用サインイン(テスト鍵)とWorkers Assets配信設定を追加」

---

### Task 3: はじめる画面群(Welcome・Intro・SignIn・Register・Consent)

**Files:**
- Create: `apps/web/src/screens/Welcome.tsx`・`Intro.tsx`・`SignIn.tsx`・`Register.tsx`・`Consent.tsx`(各 `.test.tsx` 付き)
- Create: 画面個別CSS(`apps/web/src/styles/screens.css` にまとめてよい)

**Interfaces:**
- Consumes: Task 1の `apiFetch`/`authSession`/PATHS・`@latch/shared`のusers系スキーマ
- Produces: 未認証→ `/welcome`。`POST /v1/auth/token`→登録済なら `/home`・未登録(registration_required)なら `/register`。Register(表示名1..40・生年月日・18歳未満422 UNDER_AGEの表示)→`POST /v1/users`→ `/consent`(07 §8のParser/Jev/Embeddingの3系統文言をボードどおり)→同意でlocalStorage(`latch.consent`=true)→ `/home`。SignInの「Google/Appleではじめる」ボタンは `import.meta.env.DEV`(またはVITE_DEV_AUTH)でテストサインイン(名前入力→dev/idp-token→auth/token)に繋げる。本番ボタンの実接続はスコープ外(表示のみ)
- 文言・構造はボード(`Welcome/Intro1-3/SignIn/Register/Consent.dc.html`)どおり

- [ ] **Step 1: 失敗テスト(Testing Library・apiFetchをモック)** — welcome→signin→(テストサインイン「ゆき」)→token呼び出し→registration_requiredでregisterへ / 登録(18歳)→users呼び出し→consent→home / 17歳で422 UNDER_AGE表示 / 登録済なら直接home
- [ ] **Step 2: 失敗確認** → FAIL
- [ ] **Step 3: 実装**(react-hook-form+zodはregisterで使用)
- [ ] **Step 4: 成功確認** → PASS
- [ ] **Step 5: コミット** — 「F2': ようこそ〜サインイン・登録・同意の画面群を追加」

---

### Task 4: 預ける(Compose)・読み解き中(Reading)・下書き

**Files:**
- Create: `apps/web/src/screens/Compose.tsx`(+test)・`Reading.tsx`(+test)
- Create: `apps/web/src/intents/composeState.ts`(parse結果の受け渡し・+test)

**Interfaces:**
- Consumes: `apiFetch`・`parseIntentRequestSchema`・parse API
- Produces:
  - `/compose`: textarea(maxlength 300・カウンタ aria-live)・「読み解く」→ `/reading`。右上「下書きに残す」= raw_textのみ `POST /v1/intents {status:"draft"}` → `/home`。`?draft=<id>` 付きで開いた場合はそのIntentのraw_textを復元し、保存時はPATCH(下書き更新)
  - `/reading`: 読み解き中の表示(ボードどおり)で `POST /v1/intents/parse` を呼ぶ。成功→結果を `composeState`(sessionStorage経由等・Review Focus #3)へ置き `/confirm` へ。422 PARSE_FAILED→ `/parse-failed`
  - 空欄・300字超の入力検証(送信不可)
- 文言・構造は `Compose/ComposeFull/Reading.dc.html` どおり

- [ ] **Step 1: 失敗テスト** — 300字カウンタ・「読み解く」でparse呼び出し・成功でconfirm遷移(stateに結果)・PARSE_FAILEDでparse-failed遷移 / 下書き保存でdraft POST→home / draft=idで復元
- [ ] **Step 2〜4: 失敗確認→実装→成功確認**
- [ ] **Step 5: コミット** — 「F2': 預ける(文章入力)と読み解き中・下書き保存を追加」

---

### Task 5: 読み解き確認(Confirm)・預けた(Placed)・読み解けない(ParseFailed)

**Files:**
- Create: `apps/web/src/screens/Confirm.tsx`(+test)・`Placed.tsx`・`ParseFailed.tsx`
- Create: `apps/web/src/intents/submit.ts`(Confirm値→createIntentRequestSchema/patchIntentRequestSchema組立・+test)

**Interfaces:**
- Consumes: composeState・`@latch/shared`(create/patchスキーマ・LIMITS)・F2 API
- Produces:
  - `/confirm`: ボード(`ConfirmConnection/ConfirmOccasion.dc.html`)どおり — 引用文と「文章を直す」(composeへ戻る)・預け方の選択(radio・connection⇔occasion切替で必須項目が変わる)・主題(40字まで編集)・条件chips(soft_constraintsの追加/削除)・人数(2..4)・地域(「指定なし(全国)」固定表示・編集不可の注記)・機会のみ日時(datetime-local・now〜+7日)と予算・期限(つながり=7/30/90 pills 既定30・機会=既定start+3時間の表示)。「預ける」→active保存(新規POSTまたはdraftのPATCH status=active)→`/placed`。422 ACTIVE_INTENT_LIMITと400 reasonsはボードの該当文言(`LimitReached`等)またはエラー領域にcode/message表示
  - `/parse-failed`: 「もう一度読み解く」(composeへ戻り再parse)・「自分で入力する」(composeStateを空値で `/confirm` へ・手入力モード)
  - `/placed`: 演出(縦書き「預けました。」等・ボードどおり)→数秒後 or 「見る」で `/home`
- クライアント検証(Review Focus #4)+サーバー400/422の表示

- [ ] **Step 1: 失敗テスト** — form切替(つながり選択で日時欄が消える)・主題41字入力不可・期限選択(既定30)・預けるでPOST bodyが仕様どおり(status=active・expires_in_days)・400 VALIDATION_FAILED(reasons)の表示・ACTIVE_INTENT_LIMIT表示・手入力モードで空欄から保存・draft再開ではPATCH(既存id)
- [ ] **Step 2〜4: 失敗確認→実装→成功確認**
- [ ] **Step 5: コミット** — 「F2': 読み解き確認(form切替・編集・期限)と預けた演出・失敗時導線を追加」

---

### Task 6: Home(預けている一覧・空状態)

**Files:**
- Create: `apps/web/src/screens/Home.tsx`(+test)
- Create: `apps/web/src/intents/queries.ts`(TanStack Queryのhooks)

**Interfaces:**
- Consumes: `GET /v1/intents`(limit=50)・IntentDTO
- Produces: `/home` — 見出し「預けている」・件数caption・カード一覧( `.intent` クラス・words2行clamp・formラベル(つながり/機会)・状態表示名01 §10対照)・下書きカード→タップで `/compose?draft=id`・空状態は `HomeEmpty.dc.html` のコピー(「探す」不使用)・通知/自分のアイコンは表示のみ(遷移先はF7)。一覧はTanStack Query(useQuery)で取得
- 期限切れ(expired)・一時停止等の状態名表示に対応(データはF3以降に発生)

- [ ] **Step 1: 失敗テスト** — 一覧描画(2件: words/form/status)・下書きカードのリンク・空状態のコピー・取得失敗時の再試行導線
- [ ] **Step 2〜4: 失敗確認→実装→成功確認**
- [ ] **Step 5: コミット** — 「F2': 預けている一覧(カード・空状態・下書き再開導線)を追加」

---

### Task 7: PWA設定(vite-plugin-pwa)

**Files:**
- Modify: `apps/web/package.json`(vite-plugin-pwaを `--save-exact`)
- Modify: `apps/web/vite.config.ts`(VitePWA plugin・manifest)
- Create: `apps/web/public/icon.svg`等(prototype/app/icon.svg・manifest.webmanifestの値を移植)

**Interfaces:**
- Produces: manifest(name=LATCH・colors・icons=prototypeの値)・SWの自動登録(registerType autoUpdate)。オフラインキャッシュの設計はF8(既定のprecacheのみ・調整しない)

- [ ] **Step 1: 実装 + 確認** — `pnpm --filter web build` で `dist/manifest.webmanifest` とSWが生成されること・manifestの値がprototypeと一致することを確認(単体テスト不要・ビルド成果物の確認)
- [ ] **Step 2: コミット** — 「F2': PWA設定(manifest・Service Worker登録)を追加」

---

### Task 8: ブラウザE2E(Playwright/chromium)+ CI

**Files:**
- Create: `apps/web/playwright.config.ts`
- Create: `apps/web/e2e/flow.spec.ts`・`e2e/helpers.ts`
- Modify: `apps/web/package.json`(devDepsに@playwright/test・scripts `test:e2e`)
- Modify: `.github/workflows/ci.yml`(webのE2Eジョブ)

**Interfaces:**
- Consumes: 全画面(Task 3〜7)・wrangler dev(Assets+API同一ポート)
- Produces: `pnpm --filter web test:e2e` — `vite build` → `wrangler dev`(ポートはLATCH_E2E_PORT既定8788)→ chromiumでフロー:
  1. welcome→サインイン(テストユーザー)→登録→同意→home(空状態)
  2. つながりを預ける: compose入力→読み解く→confirm(form=connection確認・主題編集・期限30日)→預ける→placed→home(一覧に追加・words一致)
  3. 機会を預ける: 日時・予算入力→保存(機会ラベル・status)
  4. form切替: 曖昧な文章(「今度飲みに行く仲間が欲しい」)→connection判定を機会へ切替→starts_at入力→保存
  5. 下書き: 下書きに残す→home→再開→預ける(draft→active)
  6. 修正: confirmでtopic・人数を変更して保存→homeのwords/状態が反映
  7. エラー: 300字超の入力不可・17歳登録の422表示(Review Focus #5: 日時は動生成・待ちは明示セレクタ)
- CI: lint/typecheck/test/build に続いて web E2E(worker E2Eと別ジョブ・port分離)

- [ ] **Step 1: 失敗テスト(flow.spec.ts)** — `pnpm --filter web exec playwright test` → FAIL
- [ ] **Step 2: 実装**(helpers: devサインイン・登録済ユーザー作成)
- [ ] **Step 3: 成功確認** — 全シナリオ緑・`pnpm --filter worker test:e2e` も引き続き緑
- [ ] **Step 4: CI追加・ローカル全体確認** — `pnpm lint && pnpm typecheck && pnpm test` 緑
- [ ] **Step 5: コミット** — 「F2': 画面フローE2E(ブラウザ)とCIジョブを追加」

---

### Task 9: docs整合とF2'ゲート確認

**Files:**
- Modify: `docs/04-system-architecture.md`(§4へdevサインインとAssets配信の実装確定・§3.2にF2'で確定した事項)
- Modify: `docs/10-test-env-nfr.md`(§2へブラウザE2Eのテストユーザー方式(dev/idp-token)追記)
- Modify: `docs/00-document-roadmap.md`(§1版数表)
- Modify: `AGENTS.md`(現在の状態)

**Interfaces:** なし(文書と最終確認)

- [ ] **Step 1: docs反映(各文書は版数上げ+変更点行・前提文書欄同期)**
- [ ] **Step 2: AGENTS.mdの「現在の状態」を更新(F2'完了・次はF3・本番IdP接続と地名検択UI・残画面はF4〜F8で計上の旨)**
- [ ] **Step 3: F2'ゲート確認** — Run: `pnpm lint && pnpm typecheck && pnpm test && pnpm --filter worker test:e2e && pnpm --filter web test:e2e` Expected: 全緑(ゲート=画面フローがprototype基準であることのE2E証明)
- [ ] **Step 4: コミット** — 「F2': devサインインとAssets構成を04/10へ反映し現在の状態を更新」

---

## 完了後記録(2026-10-19・F2'全タスク+最終レビュー+修正波まで完了・ゲート全緑)

### F4着手前の掃除リスト(最終レビューで繰り延べたMinor・F4の提案UIがこの基盤に載る前に一括掃除を推奨)

1. apiFetchの成功応答JSONパース素通し(200+非JSONをINTERNALへ倒す)
2. readJsonBodyのworker内4ファイル重複を `src/http/` へ共通化
3. dev秘密鍵env不正値(JSON破損)の早期fail
4. restore()/sessionまわり: なし(I-3で解消済み)・ただし未認証ガード試験を全ルート分へ拡張
5. devサインインのprovider=google固定(apple再現)とstaging簡易ガード(なりすまし余地・10 §2へ注意記録も可)
6. Compose: 「読み解く」ボタンのbusy中考慮・301字超の無反応停止・カウンタid="c-count"
7. Confirm: 機会→つながり切替時の期限caption流用(切替後はnow+日数で提示)・行内エディタ同時オープン防止・日時の入力時検証(min/max属性)・予算の未設定復帰
8. Home: 件数caption計数基準(F4でproposed出たら再訪)・cancelledの非表示化(DSLatch規定)・本番QueryClient retry見直し
9. routerにcatch-all(`/foo`→welcomeへリダイレクト)
10. worker playwright.configのwebServerへ `pnpm --filter web build` 前置(ローカル実行の前提解消)
11. apps/webのtsconfig includeへe2e/とplaywright.config.tsを追加(typecheck対象化)
12. Placed自動遷移(4秒)とE2Eの競合リスクの解消
13. partial_acceptの専用グリフgd+gm分離(F4・DSLatchボード:41)

### 成立数・表示の申し送り(F4/F5)
- Homeカードの「これまでの成立数」(01 §10・ボード「つながり 2」)はAPI項目が無いため未表示。F4/F5でlatches側の項目追加時に計上
