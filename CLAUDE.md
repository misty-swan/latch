# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

プロジェクトの規約・現在の状態・確定裁定・用語統一は AGENTS.md が正本(下で取り込む)。本ファイルはコマンドと全体構造の補足のみを持つ。

@AGENTS.md

## コマンド

ルートで実行する(pnpm 12・Node 22.22.0以上。CIは `.github/workflows/ci.yml`)。

```bash
pnpm install --frozen-lockfile
pnpm lint            # biome check .(整形込みの検査)
pnpm format          # biome check --write .(自動修正)
pnpm typecheck       # 全パッケージの tsc --noEmit
pnpm test            # 全パッケージの vitest run(単体・統合)

# 単一ファイル/単一テストの実行
pnpm --filter worker exec vitest run tests/intents-crud-api.test.ts
pnpm --filter web exec vitest run src/screens/Home.test.tsx -t "テスト名の一部"

# E2E(Playwright)。worker E2E は apps/web/dist が必要なので先に web をビルドする
pnpm --filter web build
pnpm --filter worker test:e2e                 # APIレベル・既定ポート8787・直列実行
pnpm --filter web exec playwright install chromium   # 初回のみ
pnpm --filter web test:e2e                    # ブラウザE2E・既定ポート8788・直列実行
LATCH_E2E_PORT=9001 pnpm --filter worker test:e2e    # ポート競合時の回避
pnpm --filter worker exec playwright test e2e/pipeline.spec.ts   # 単一spec

# ローカル開発
pnpm --filter worker dev     # wrangler dev --local(全バインディングをエミュレータで実行)
pnpm --filter web dev        # vite

# D1マイグレーション(src/db/schema.ts を変更したら生成してコミット)
pnpm --filter worker exec drizzle-kit generate
pnpm --filter worker exec wrangler d1 migrations apply DB --local
```

E2E の webServer は `.dev.vars` 生成(scripts/prepare-dev-vars.mjs)→ローカルD1マイグレーション→`wrangler dev --local` までを自動で行う。web E2E は `VITE_DEV_AUTH=1` 付きビルド(テスト用サインインUIを出すため)も自動で行う。
E2Eの状態は`apps/worker/.wrangler/e2e-state`(手元のD1とは別)。

## 全体構造

- **apps/worker**: 単一の Cloudflare Worker(Hono)。`src/index.ts` が `fetch`(API `/v1/*`・`/healthz`)・`queue`(マッチングパイプライン)・`scheduled`(毎分Cron)の3出口を持つ。`/v1/*` 以外は Workers Assets が `apps/web/dist` を SPA として同一オリジン配信する(`wrangler.jsonc` の `assets.run_worker_first`)
- **apps/web**: React 19 + react-router + TanStack Query の PWA。画面は `src/screens/`、API呼び出しは `src/api/client.ts` の `apiFetch` 経由。見た目は `prototype/` が正本で、`src/styles/latch.css` は prototype からの不改変コピー(編集しない)
- **packages/shared**: worker と web が共有する zod スキーマ・定数(`@latch/shared`)。ビルド不要で TS ソースを直接参照する

### マッチングパイプライン(apps/worker/src/pipeline)

Intent 作成/更新 → `MATCH_QUEUE` へイベント送信 → `consumer.ts` が Embedding 生成・ベクトル upsert 確認 → `embedding_completed` → `evaluate.ts` が Layer 2 Candidate Retrieval → Layer 1(`layer1.ts`)→ Layer 3(`cheap.ts`)。イベントの状態は D1 の `match_events` 行で管理し、消費は例外を外へ出さない(失敗は行の status に記録・DLQ consumer が dead へ倒す)。`cron.ts` は取りこぼし回収・期限切れ・バックフィル・遅延再評価・保持期間削除を担い、評価本体を直接呼ぶ。

### 差し替え可能な抽象(テスト決定性のための設計)

- **LLM/Embedding**: `src/llm/`。`LATCH_LLM_MODE`・`LATCH_EMBEDDING_MODE` が既定 `stub`(決定的・課金なし、`src/llm/stub/`)。real は Workers AI
- **VectorStore**: `src/vectorstore/`。`LATCH_ENV=local` はインメモリ実装、staging/prod は Vectorize
- **Clock**: `src/clock/`。時刻依存ロジックは `systemClock` を直接使わず Clock を受け取る
- **ログ**: `src/logging/logger.ts` の許可リスト方式(個人情報を出さない)

### テストの仕組み

- worker の vitest は `@cloudflare/vitest-pool-workers`(miniflare 上で実行)。`tests/apply-d1-migrations.ts` が毎回マイグレーションを適用する。`TEST_QUEUES_DISABLED` によりキューは自動消費されないので、消費の試験は `handleQueueBatch` を直接呼ぶ
- 認証は本番IdP未接続。テスト専用IdP鍵(`tests/fixtures/`)と dev 専用 `POST /v1/dev/idp-token` を使い、prod では `assertEnvSafety`(`src/env.ts`)と404の二重防御で拒否される
- worker E2E は 1プロセスのインメモリ・ベクトルストアを共有するため直列実行(`workers: 1`)。Cron は `wrangler dev --test-scheduled` の `GET /__scheduled` で強制発火する

## 文書

仕様の正本は `docs/00`〜`12`(索引は `docs/00-document-roadmap.md`、工程とゲートは `docs/12`、受け入れ条件は `docs/02 §4`)。フェーズごとの実装計画は `docs/superpowers/plans/`。コード中のコメントは「docs/NN §x」で根拠を参照する慣習がある。
