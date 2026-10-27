# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

エージェント向けの指示(規約・現在の状態・確定裁定・用語統一・コマンド・全体構造)の正本は本ファイル。AGENTS.md は本ファイルへの案内だけを持つ。

## 現在の状態

- 文書駆動開発。`docs/`(00〜12)が製品仕様の正本。工程とゲートは docs/12 §2、受け入れ条件は 02 §4 の #1〜#35
- 完了した工程: F0〜F8b(F4・F6・F7・F8は分割して実施)・不具合の修正工程(第1〜7回)・LLM real接続(精度ゲート合格・stagingは `LATCH_LLM_MODE=real`)。各工程の内容と決定は docs/12 §2 と 01 冒頭の決定記録、計画と設計は `docs/superpowers/plans`・`specs`
- 負荷試験(02 #33)は完了(2026-10-26・報告書§12・§12.8)。測り直すときの道具・k6・stagingのURLと通行証は `.superpowers/sdd/2026-10-22-f8b-staging-load-test/`(gitの管理外・手順は docs/runbooks/staging.md 7章)
- 進行中: F9 品質確立。フィードバック申告(LAT-84)・#35の集計(LAT-82)・縮退試験(LAT-83)・退会(LAT-94)・レート制限(LAT-93)・正解データ(LAT-108)・stagingの通し試験の作成(LAT-106)・#34(LAT-81・1回目の通し→不具合の修正工程(第6回)→通し直し・2026-10-26完了・記録は `docs/reports/f9-closed-test.md`)・#32の実機確認(LAT-79・2026-10-26完了)は完了。正規化テキストの否定の条件(LAT-113)とJevのゴールドセット(LAT-114)は不具合の修正工程(第7回)で直した(2026-10-26)。F10の前の工程として、PC向けの画面(LAT-14・04 §3.2)を実装し、オーナーの見た目の確認を終えた(2026-10-27)
- 進行中: F10 公開準備(2026-10-27〜)。prodの区画(`env.production`)・資源の作成とシークレット登録のスクリプト・手動の起動と承認によるデプロイ・本番IdPの画面側・戻し方と公開当日の台本は作成済み(手順は `docs/runbooks/prod.md`・`idp.md`・`rollback-rehearsal.md`・`launch-day.md`)。オーナー決定は12 §2の決定記録(F10公開準備)。残りは法務確認(LAT-78)・独自ドメイン・オーナーの登録作業・公開前の修正工程(LAT-124など)
- 02 §4 の未了: #31(規約の草案は配置済み。2026-10-27オーナー決定で、弁護士等の確認は受けず、08 §10を自分たちで確認し、電気通信事業法と出会い系サイト規制法は公的な窓口に問い合わせて記録する・01冒頭の決定記録(法務確認の扱い))
- F3は未決D-C-01/D-C-02を暫定案(K_v=50・0.7/0.3)で着手済み(調整は運用データ後・06 §8)
- 細かい進み具合・残りの作業・不具合・オーナーの判断待ちは Linear が正本(下の「作業管理」)。この節には書き足さず、工程の区切りで要約だけを直す
- 03(UX仕様)は不作成(2026-10-18オーナー裁定・docs/00の決定記録)。`prototype/` がUIの正本(README・project/latch.css)で、実装側のスタイリング正本は`apps/web/src/styles/latch.css`(prototypeから不改変コピー・docs/04 §3.2)
- READMEは現在無い。リポジトリの案内はこのファイルとdocs/00が担う
- ローカルでE2Eを実行するときの注意: 既定ポートはworker E2E=8787・web E2E=8788で分離している。他プロセスがポートを占有している場合は `LATCH_E2E_PORT=<空きポート>` で回避する(占有側のプロセスは停止しない・webとworkerには別ポートを割り当てる)

## 作業管理(Linear)

- 作業・不具合・オーナーの判断待ちは Linear の LATCH チーム(issueの番号は `LAT-nn`)で管理する。GitHub の issue は新しく作らない(既存の issue は閉じたものも含めて同じ番号で Linear へ取り込み済み=GitHub の #nn は LAT-nn・2026-10-25 オーナー決定・12 §2 の決定記録(作業の管理))
- 工程は Project(F9・F10・不具合の修正工程(第N回)・時期未定の作業など)。02 §4 の受け入れ条件は Project「v1.0 受け入れ条件(02 §4)」に1条件1 issue
- ラベル: `オーナー作業`(オーナーが手を動かす)・`オーナー判断`(オーナーが決める・未決のD-IDを含む)・`オーナー確認待ち`(直した後にオーナーの確認で閉じる)・`受け入れ条件`
- 見つけた不具合はその場で直さず LAT に登録し、出し切ってから修正工程でまとめて直す
- 文書・コミットの「issue #nn」は GitHub の旧番号で、LAT-nn と同じ番号。新しいものは「LAT-nn」と書く
- 02 §4 の未了は「受け入れ条件」ラベルで絞る。オーナーへの依頼は担当者をオーナーにし、`オーナー作業`/`オーナー判断` を付ける
- 工程を終えたら docs(12 §2・02 §4 など)の記録に加えて、Linear の Project と issue の状態を更新する
- 仕様・計画・設計の本文は Linear に写さず、docs へのリンクを張る
- 操作は Orca CLI(`orca linear …`・Linux では `~/.config/orca/linux-orca-cli-shim/orca`)か Linear の MCP。チームの作成と GitHub からの取り込みは Linear の画面でしかできない

## 絶対に守ること

1. **コミットは `git add <パス>` で対象を限定する。**`git add -A`・`git commit -a` は禁止
2. **レガシー実装への言及をしない。**旧リポジトリ・旧実装を参照・引用する表現は文書にもコードにも入れない(docs は自己完結が確定方針)。既存文書を編集する際もこの方針を壊さない
3. **応答とコミットメッセージは日本語。**文書も日本語で書く

## docs の扱い(必要に応じて変更してよい)

- docs は固定物ではなく、必要に応じてエージェントが変更してよい。ただし `docs/00` §3 の運用ルールに従う:
  - 変更した文書は版数を上げ、冒頭に変更点行を追記する
  - 「前提文書」欄と 00 §1 の版数表を実態に揃える(版数の食い違いは過去にレビューで大量指摘された)
  - 数値・用語は文書横断で一致させる(閾値・期限・K上限等の主要値は01・04〜06・02を行き来する)
- 未決事項はD-IDで管理(製品レベル=01のD-xx、技術は各文書ローカルのD-A〜F)。解消済みIDは再利用しない。台帳は00 §4
- プロダクトオーナーの判断を要する事項は、決定を「決定内容/根拠/影響」の形式で該当文書に記録する(独断で決めない。ただし軽微な技術的事項は文書の裁量で確定してよい)

## 用語の統一(ぶれると実装バグになる)

- 「機会Intent(form=occasion)」「つながりIntent(form=connection)」。「機会form」等の表記は使わない
- 検索層は「Layer 2 Candidate Retrieval」(「Vector Search」と呼ばない)。通知は「アプリ内通知」(「お知らせ」は使わない)
- 数値の単位は「1日30,000回」「1か月600,000回」「p95 0.5秒」の形式(「日次/月次」「500ms」の混在は禁止)
- 文書間参照は「文書番号 §節番号」(例: 01 §8)。「〜相当」表記は使わない

## 確定済みの重要裁定(再議しない)

- 段階リリース(MVP・クローズドベータ)は行わない。v1.0完成形を作り切って一発公開(品質保証としての社内クローズドテストのみ)
- visibilityはhidden_until_match単値(成立前の条件サマリは一切開示しない)。一致度(LATCH Score)はUIに表示しない
- 同一ユーザーペアの恒久排除は「成立・明示の拒否(no)」のみ。見送り(defer)後の条件付き再提案は機会Intentのみ可
- 回答UIは2択: yes=[参加する] / defer=[今回は見送る]。noはUIに置かずAPI専用
- チャットはリアルタイム(Durable Objects + WebSocket・メッセージの正はD1)

## 実装開始後の環境メモ(F0〜)

- TypeScript単一言語・pnpmモノレポ(apps/web・apps/worker・packages/shared)・Cloudflare(Workers/D1/Vectorize/Queues/DO/R2/KV)
- ローカル開発は `wrangler dev` のエミュレータで完結(Cloudflareアカウント不要。デプロイ時のみトークンが必要・prodは手動承認トリガー)
- LLMは既定stub(決定的・課金なし)。real適用は精度ゲート(07 §6)合格が条件
- 工程とゲートは `docs/12` のF0〜F10に従い、完了は02 §4の#1〜#35で証明する

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

# stagingの通し試験(02 #34・10 §4・手順は docs/runbooks/staging.md 8章)。必ず包みから起動する(出力の宛先と通行証を伏せ、前後に試験用の利用者を退会させる)
LATCH_E2E_PORT=9001 node apps/worker/scripts/staging-e2e.mjs --local   # 手元のwrangler dev(stub)への試運転(apps/web/distが必要)
node apps/worker/scripts/staging-e2e.mjs        # stagingへ。LATCH_LOAD_BASE_URL と LATCH_ACCESS_CLIENT_ID/SECRET を環境変数で渡す(本物のAIを30回前後呼ぶ)
node apps/worker/scripts/staging-e2e.mjs --cleanup-only   # 途中で止まった回の試験用の利用者の後始末だけ

# ローカル開発
pnpm --filter worker dev     # wrangler dev --local(全バインディングをエミュレータで実行)
pnpm --filter web dev        # vite

# 精度ゲート(本物のAIを呼ぶので課金が発生する。キーは環境変数か管理外の tools/eval/.env)
pnpm eval:gate       # ゴールドセットでParser/Jevのrealを採点し eval/records/gate.json を書く(指示文・real実装・モデル名を変えたら採り直してコミット。CIは記録を照合する)
pnpm eval:region     # 地域名をEmbedding入力に含める/含めないの比較(eval/records/region.json・Workers AIを呼ぶ)

# Analytics諸量の集計(02 #35・定義は09 §2)。D1へ読み取りの問い合わせだけを送り、Markdownの表を出す
pnpm analytics:report --persist-to apps/worker/.wrangler/e2e-state   # 手元のE2Eの状態に向ける(既定は手元のD1・--stagingでstaging)

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

- **LLM/Embedding**: `src/llm/`。`LATCH_LLM_MODE`・`LATCH_EMBEDDING_MODE` が既定 `stub`(決定的・課金なし、`src/llm/stub/`)。real は Parser=Anthropic・Jev=TypeSafe(予備Anthropic)・Embedding=Workers AI(Parser/Jev は `src/llm/real/`・指示文とモデル名は `prompts.ts`)。staging は両方 real
- **VectorStore**: `src/vectorstore/`。`LATCH_ENV=local` はインメモリ実装、staging/prod は Vectorize
- **Clock**: `src/clock/`。時刻依存ロジックは `systemClock` を直接使わず Clock を受け取る
- **ログ**: `src/logging/logger.ts` の許可リスト方式(個人情報を出さない)

### テストの仕組み

- worker の vitest は `@cloudflare/vitest-pool-workers`(miniflare 上で実行)。`tests/apply-d1-migrations.ts` が毎回マイグレーションを適用する。`TEST_QUEUES_DISABLED` によりキューは自動消費されないので、消費の試験は `handleQueueBatch` を直接呼ぶ
- 認証は本番IdP未接続。テスト専用IdP鍵(`tests/fixtures/`)と dev 専用 `POST /v1/dev/idp-token` を使い、prod では `assertEnvSafety`(`src/env.ts`)と404の二重防御で拒否される
- worker E2E は 1プロセスのインメモリ・ベクトルストアを共有するため直列実行(`workers: 1`)。Cron は `wrangler dev --test-scheduled` の `GET /__scheduled` で強制発火する

## 文書

仕様の正本は `docs/00`〜`12`(索引は `docs/00-document-roadmap.md`、工程とゲートは `docs/12`、受け入れ条件は `docs/02 §4`)。フェーズごとの実装計画は `docs/superpowers/plans/`。コード中のコメントは「docs/NN §x」で根拠を参照する慣習がある。
