# LATCH アーキテクチャ設計書

- 文書バージョン: v0.7
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.7更新: 2026-10-18)
- v0.2の変更点: §3を全面改訂し、スタックを「バックエンド・フロントエンドの構成部品」(DBアクセス・マイグレーション・入力検証・プッシュ実装・フォーム等)まで確定した。D-A-06(Biome)を解消し、D-A-07(スタイリング=03で確定)を新設した
- v0.3の変更点: 07(LLM利用仕様書)の策定に伴いD-A-01(Embedding)を解消した(Workers AI bge-m3・1024次元・cosine)。R2(ユーザーアイコン)をスタックへ追加した
- v0.4の変更点: 本書が単体で完結するよう記述を整理した(変更の経緯はgit履歴を参照)
- v0.5の変更点: 多角レビュー(loop1)の指摘を反映。Web Push送信を自前実装(WebCrypto/jose+fetch)に変更、レート制限をユーザー単位に確定、イベント投入の即時/遅延を明確化、DLQ運用を追記した
- v0.6の変更点: F1実装に伴い§4の認証・セッションを確定した(起動ガード条件の拡張・テスト用IdPのiss/aud固定値・本番IdP検証の前提)
- v0.7の変更点: 03(UX仕様書)の不作成裁定(00 §1の決定記録)に伴い、D-A-07(スタイリング手法)の確定タイミングをF2'着手時(本書で技術選定として確定)に変更。値の源は`prototype/project/latch.css`。前提文書欄の版数を更新
- 前提文書: 01 要件定義書 v0.9 / 02 スコープ・受け入れ条件合意書 v0.3
- 本書の位置づけ: 01第19節の技術スタック選定を確定させる文書。UIの正本は`prototype/`(03は不作成)のため、スタイリング手法の技術選定(D-A-07)のみF2'着手時に本書で確定する

**決定記録(2026-10-17・プロダクトオーナー)**

- **インフラはCloudflareをベースとすることを確定する。** 根拠は信頼性とコストである(オーナー決定)
- **言語はTypeScriptに確定する**(オーナー選定。対抗案=Python)。**DBはD1(Cloudflare内蔵)に確定する**(オーナー選定。対抗案=外部PostgreSQL)。**チャットはリアルタイム(WebSocket)に確定する**(オーナー選定。推奨していたポーリング案から変更)
- 残りの技術選定(構成部品を含む全部)は本書§3の比較のとおり確定する。ただしLLMプロバイダ(Embedding・Jev)は07の所管、スタイリング手法はF2'着手時に本書で技術選定として確定する(D-A-07。値の源は`prototype/project/latch.css`)

## 1. 本書の目的と位置づけ

本書はv1.0完成形(01)を実装するための技術構成を確定させる。イベント駆動・段階的絞り込み・コスト保護3層・Clock抽象・ログ許可リストは、本プロジェクトの設計規律として最初から適用する。

**バージョン規律。** 本書はライブラリのバージョン番号を書かない。バージョンの正は `package.json`(pnpmの完全固定)+ lockfileであり、骨組み作成時に固定する。文書にバージョンを書くと陳腐化するためである。

## 2. 全体アーキテクチャ — Cloudflare製品へのマッピング

01第19節の論理要素(API Layer / Intent DB / Intent Parser / Event Queue / Matching Worker / Hard Filter / Vector DB / Cheap Judge / Jev / LATCH Engine / Notification・Analytics)を、すべてCloudflare製品上に置く。

```text
                    ┌────────────────────────────┐
                    │  Workers Assets(PWA・静的)  │ ← React+Vite・同一オリジン
 ユーザー(PWA) ──→  ├────────────────────────────┤
                    │  Worker: api(Hono/TypeScript)│ ← 認証・Intent CRUD・回答・
                    │   + Worker: pipeline(5層)   │    チャット・ブロック/通報
                    └───┬─────────┬──────────┬───┘
                        │         │          │
             ┌──────────▼──┐ ┌────▼─────┐ ┌──▼──────────┐
             │ D1(リレーショナル)│ │ Queues   │ │ Vectorize   │
             │ users/intents/  │ │ match_   │ │ Intent埋め込み│
             │ latches/chat/履歴│ │ events   │ │ (ANN・metadata│
             └──────────┬──┘ └────┬─────┘ │  filter=form等)│
                        │         │        └─────────────┘
             ┌──────────▼─────────▼──┐
             │ Cron Triggers(毎分)     │ ← 機会Intentの時間Bucket・期限切れ
             │  ・bucket/catch-up走査  │    バッチ・つながりcompleted判定
             │  ・Jev予算アラート      │
             └──────────┬────────────┘
                        │
        ┌───────────────┼────────────────┐
        ▼               ▼                ▼
  Embedding(07確定)  Jev(外部LLM・07確定)  Web Push(VAPID)
  確定: Workers AI(bge-m3)  TypeSafe+フォールバック   通知送信
```

※チャットのWebSocket即時配信はDurable Objectsが担う(成立LATCHごとに1DO・メッセージの正はD1。§4)。

同一Workerコードからapi(受信リクエスト処理)とpipeline(Queues consumer・Cron handler)を出口分岐して動かす。Workerは分割しない(デプロイとシークレット管理が単純になり、資産共有も直接行える)。チャットのWebSocket接続はDurable Objects(成立LATCHごとに1DO)が担い、api Workerから接続を委譲する(詳細は§4)。

## 3. 技術スタック選定(確定)

### 3.1 バックエンド(apps/worker)

| 用途 | 選定 | 理由・備考 |
|---|---|---|
| 言語・型 | TypeScript(strict)+ @cloudflare/workers-types | オーナー確定。フロントと同一言語 |
| 実行基盤 | Cloudflare Workers(単一Worker=api+pipeline出口分岐) | インフラ確定の中心。Durable Objects・Queues・Cronを1デプロイで持つ |
| Webフレームワーク | Hono | Workers標準。ルーティング・ミドルウェア・エラーハンドラ |
| リクエスト検証 | Zod + @hono/zod-validator | スキーマは `packages/shared` に置きフロントと共有 |
| DBアクセス | Drizzle ORM(D1ドライバ) | D1公式対応(2026-10-17確認)。型安全なクエリビルダ |
| マイグレーション | drizzle-kit(スキーマ差分からSQL生成)+ `wrangler d1 migrations apply`(適用) | 生成SQLをリポジトリ管理。適用は明示実行のみ |
| 認証 | jose(JWT署名/検証・createRemoteJWKSet) | §4の認証設計に対応 |
| Web Push送信 | 自前実装(VAPID署名=jose/WebCrypto・aes128gcm暗号化=WebCrypto・送信=fetch) | web-push公式ライブラリは参考実装とする(§3.4)。F7で実機検証 |
| WebSocketチャット | Durable Objects(Hibernation API)を直接使用 | 追加ライブラリなし。 WorkersネイティブのAPIで足りる |
| キュー/定時処理 | Queues(consumer)+ Cron Triggers | Workersネイティブ。DLQで失敗隔離(01 §16) |
| ベクトル検索 | Vectorize | metadata filter(form・status・category)=Layer 2の絞り込み |
| レート制限 | Workers Rate Limiting binding + D1カウンタ(Drizzle) | §5の3層保護の実装要素 |
| 設定・シークレット | wrangler vars / Workers Secrets(ローカルは .dev.vars) | 環境ごとに分離(§6) |
| 画像保存 | R2(ユーザーアイコンのみ) | v1.0で扱う画像はアイコンのみ(05 §2.3)。チャット画像はなし(02 D-06) |
| 観測 | Workers Logs + Analytics Engine + 構造化JSONログ | ログは許可リスト方式。tailはwrangler |
| LLM統合 | 確定: Parser=Claude(Haikuクラス)・Embedding=Workers AI(bge-m3)・Jev=TypeSafe+Claudeフォールバック(07) | 送信記録・同意(01 §21)の定めは08が担う |

### 3.2 フロントエンド(apps/web)

| 用途 | 選定 | 理由・備考 |
|---|---|---|
| UI | React | SPA。SSR不要(検索機能なし・認証後API描画のみ) |
| ビルド・PWA | Vite + vite-plugin-pwa | マニフェスト・Service Worker・オフラインキャッシュの生成 |
| ルーティング | React Router(library mode) | 5画面フロー+一覧(01 §10) |
| サーバー状態 | TanStack Query | 一覧・提案・履歴の取得キャッシュと再検証を標準化 |
| チャット受信 | WebSocket(DOへ直結) | 受信メッセージはTanStack Queryのキャッシュへ書き込み |
| フォーム | react-hook-form + @hookform/resolvers(zod) | 読み解き確認の修正UI・Parser失敗時の構造化フォールバック。zodスキーマはsharedから流用 |
| スタイリング | **F2'着手時に本書で技術選定として確定(D-A-07)** | 値の源は`prototype/project/latch.css`(デザイン定義唯一の源。トークンをそのまま移植)。手法の選定だけF2'着手時に確定する |
| 単体試験 | vitest + Testing Library(happy-dom) | fetchはモック |
| E2E | Playwright(chromium) | 02の対応表#34の社内クローズドテストに使用 |

### 3.3 共有・品質・CI

| 用途 | 選定 | 理由・備考 |
|---|---|---|
| 共有パッケージ | packages/shared(Zodスキーマ・TS型・定数) | APIリクエスト/レスポンス・Intent構造を前後面で一字共有 |
| モノレポ | pnpm workspaces + corepack | apps/web・apps/worker・packages/shared |
| 開発用Node | Node 22 LTS | ビルド・試験ツールのためのみ(実行はWorkers) |
| リント/整形 | Biome(確定・D-A-06解消) | 単一ツール・高速。毎コミット実行 |
| 型チェック | tsc --noEmit | Biomeと分離(型はtscが正) |
| バックエンド試験 | vitest + @cloudflare/vitest-pool-workers | D1・Queues・Vectorize・DOのローカル実行で単体・統合試験 |
| CI/CD | GitHub Actions + wrangler | §6(品質ゲート→staging自動→prod手動) |

### 3.4 対抗案と選定理由

**言語 — TypeScriptを採用(2026-10-17オーナー選定)、Python Workers・Go不採用。** Workersの機能(Durable Objects・Queues consumer・Cron・Rate Limitingバインディング・Assets)はすべてTypeScriptファーストで提供され、ドキュメント・サンプル・AIによるコード生成の品質も最も高い。フロントエンドとバックエンドが同一言語になり、Intentの型・APIスキーマを `packages/shared` で文字どおり共有できる(単一実装のため、前後面の契約は型共有で賄い、契約試験は不要になる)。Python WorkersはローカルMLライブラリを使う場合の選択肢だが、本サービスのLLM利用は外部API呼び出しのみで、この利点が生きない。

**DB — D1を採用(2026-10-17オーナー選定)、外部PostgreSQL(Hyperdrive経由)不採用。** オーナー決定の「信頼とコスト」に対し、プラットフォーム外のDB(Neon・Supabase等)は通信遅延・別課金・別障害点を追加する。**地理情報の専門機能(PostGIS相当)を持たない**ため地理判定は「SQLでバウンディングボックス事前絞り+TypeScriptでハバーサイン(距離計算)」に置き換える。対象は地域添付Intent同士の重なり判定のみで(01 §12)、全国規模でも前段のVectorizeメタデータフィルタで評価対象は小さい。geo検索の複雑さが必要になった時点で再評価する(D-A-05と同じトリガー)。

**DBアクセス — Drizzle ORM(D1ドライバ)を採用、生SQL・Kysely・Prisma不採用。** DrizzleはD1公式ドキュメントに接続方法が掲載され(2026-10-17確認)、型安全なクエリビルダとスキーマからのマイグレーション生成(drizzle-kit)を備える。生SQLは型の保証が弱く、PrismaはWorkers上で動くもののクエリエンジン分がヘビーである。注意点として、drizzle-kitの新版(RC)で `wrangler d1 migrations apply` との非互換が報告されているため、**安定版にバージョン固定**して使う(§1のバージョン規律)。

**Web Push送信 — 自前実装を採用、web-pushライブラリ直接利用は不採用(loop1裁定)。** VAPID署名はjose(WebCrypto)で、メッセージ暗号化(aes128gcm・RFC8291)はWebCryptoで行い、送信はfetchで直接行う。定番ライブラリ(web-push)は通知送信にNodeのHTTPクライアントを使いWorkers上の動作が保証されないため、参考実装(署名生成の検証用)と位置づける。実装と実機検証(iOS/Android/デスクトップ各ブラウザ)はF7(12)に明示的に計上する。

**WebSocketチャット — リアルタイム(Durable Objects+WebSocket)を採用(2026-10-17オーナー選定)、ポーリング不採用。** 成立後の対話そのものが主目的のつながりIntentでは、表示の即時性が体験の中心になる。DOのHibernation APIで接続維持のコストを抑え、メッセージの正はD1に置くことでDOの障害・再起動でも履歴を失わない構造とする(詳細は§4)。追加ライブラリは使わない(WorkersネイティブのWebSocket APIで足りる)。

**ベクトル検索 — Vectorizeを採用、D1内自前実装・外部ベクトルDB不採用。** マネージドのANN検索とmetadata filterを持ち、プラットフォーム内で完結する。filterでform(つながり/機会)・status(active)・categoryを縛れるため、「つながり×機会を候補化しない」(01 §12)と「expiredを候補化しない」を検索段階で強制できる。次元=1024・距離=cosineは07 v0.1で確定した(D-A-01解消)。

**フロントエンド — React+Vite SPAを採用、Next/Remix不採用。** 本サービスはSSRの利益(SEO・初期表示)を得られない(検索エンジンに載せるページがなく、体験は認証後のAPI描画だから)。静的Assets配信が最も安く・速い。

**フロントの状態管理 — TanStack Query+react-hook-formを採用、グローバル状態ライブラリ(Zustand等)は持たない。** 本アプリの状態のほとんどはサーバー由来(提案・Intent・履歴)とフォームであり、どちらも専用の標準ライブラリがカバーする。グローバル単一ストアは、必要性が生じた時点で導入する(最初から持たない=前提: 画面間で共有する純クライアント状態がほぼない)。

**配備 — Cloudflare単一構成を採用、複数事業者混在不採用。** オーナー決定どおり。DNS・CDN・Workers・D1・Queues・Vectorize・KV・Assets・観測を1アカウントで運用し、障害点と請求を1本化する。

## 4. 主要設計

**認証・セッション。** Google・AppleのIdPトークンを検証し(joseのリモートJWKS)、独自JWT(有効期限1時間)を発行する。リフレッシュトークンは回転式(30日)でD1に族IDごと管理し、再利用を検出したら族失効+401とする(ただし応答喪失後の同一旧トークン再提示は1回に限り現行トークンを再返す猶予を持つ)。ログアウト・ブロック・退会の反映はKVの失効リスト(JWTのjtiをTTL=残り寿命で格納。JWT残寿命以内に効力)とし、権限が関わる操作(チャット送信・回答・退会)はD1のusers.statusとblocksを再検証して補完する(05 §2.3)。起動ガードとして、prodでテスト鍵(LATCH_TEST_IDP_JWKS)が残存する場合、またはJWT_SECRETが未設定もしくは32字未満の場合は起動を拒否する。テスト用IdP(staging・ローカルの内部トークン用・10 §2)のiss・audは固定値 `urn:latch:test-idp`・`latch-test` とし、prodでは起動ガードがこの設定自体を拒否する。本番IdP検証の前提: Google=JWKS `https://www.googleapis.com/oauth2/v3/certs`(iss `accounts.google.com`・aud=GOOGLE_CLIENT_ID)/ Apple=JWKS `https://appleid.apple.com/auth/keys`(iss `https://appleid.apple.com`・aud=APPLE_CLIENT_ID)。client id未設定は認証失敗として扱う。

**イベント駆動(01 §16の実装)。** Intentの作成はapi出口で即時にQueuesへ送信(第1段=Embedding要求。draft→active化も即時とし、初回提案のレイテンシを守る)。Embedding完了時に派生イベント(embedding_completed)を再送し(第2段=Layer 1〜5)。**更新のみ**10秒の遅延配信とし、消費側で現行versionと突き合わせて古ければ破棄する(idempotency。match_eventsのUNIQUE制約が二重投入も許さない)。失敗は再試行上限(max_retries=3初期値)ののちDLQへ隔離し、DLQを見る最小のconsumerがmatch_eventsのstatusをdeadへ反映して警報する。誤った提案より提示の見送りを優先する方針である。deadの再処理は、UNIQUE衝突を避けるため新規イベントとして再発行する(手動)。

**Cron(毎分)。** (a)機会Intentの時間Bucket到来の再評価と期限前catch-up走査(01 §16)、(b)全Intentの期限切れバッチ、(c)つながりLATCHのチャット非活動90日判定(completed)、(d)Jev予算の80%到達検知とアラート。毎分1回のCron Trigger内で走査対象をインデックス(status・starts_at・expires_at)で最小化する。

**地理の実装。** 地域添付は中心座標+半径をD1に保存し、候補検索はSQLのバウンディングボックス事前絞り+TSでの距離判定。相手への表示は地域名のみ(01 §21の丸め規定)。座標・距離の数値は一切表示しない。

**地名データ(D-A-03解消)。** ソースは国土交通省の位置参照情報(ISJ・大字/町丁目級。CC BY 2.0 JP)と駅データ.jp(駅位置・CC BY 4.0)とする。取り込みは `scripts/` の前処理スクリプトがCSVからINSERT SQLを生成し、`wrangler d1 execute --file` で環境ごとに適用する(生データはリポジトリにコミットしない)。座標→地名の変換は約1kmグリッド(0.01度)のgrid_keyで一致検索し、グリッド内の代表点から最近傍を採る(05 §2.2)。両データのクレジット表記を利用規約のクレジット節に含める(08 §10)。

**Web Push。** PWAのService Workerが購読し、購読情報をD1に保存。提案通知の送信は汎用文のみ(01 §10の表示規制どおり)。VAPID鍵はWorkersシークレットで管理し、送信記録を残す。

**チャット(リアルタイム・オーナー確定)。** 成立LATCHごとに1つのDurable Objectを置き、WebSocketで接続中の参加者へ新着を即時配信する。メッセージの正はD1に保存し、履歴取得・未読管理・つながり品質の計測(01 §14)はD1に対するREST/クエリで行う。DOは配信に専念し、障害・再起動があっても履歴は失われない。接続の維持はHibernation APIを使いコストを抑える。オフラインの参加者にはアプリ内通知(お知らせ)とWeb Pushで到達する(01 §10)。

**時刻の規律。** 製品コードは実時間を直接参照しない。現在時刻は注入可能なclock経由とし、単体試験は固定時刻で行う。JST基準の集計・リセット(01 §20)もclock上で扱う。

**構造化ログ。** 出力フィールドは列挙型の許可リストで固定し、raw_text・座標・NG条件をロギングしない。Serializer段で強制する。

## 5. コスト保護機構(3層)

| 層 | 要件(01 §20) | 実装 |
|---|---|---|
| 源流レート制限 | 1ユーザーあたり60req/分・Active Intent 5件/ユーザー・作成20件/日・更新6回/時間 | Workers Rate Limitingバインディング(key=user_id・60req/60秒・ユーザー単位。グローバル制限は設けない。429のRetry-Afterは固定60秒)+D1カウンタ(ユーザー単位・日次/時間窓) |
| Jev予算 | 1Intentあたり1日40回・1ユーザーあたり1日120回・再評価30分抑制 | D1カウンタ(日次バケット keyed by intent/user)+最終評価時刻チェック |
| 実行回数上限 | 1日30,000回・1か月600,000回・80%でalert | D1のグローバルカウンタ+Cronでの検知・Analytics Engineでの傾向記録 |

上限到達・LLM API障害時はJev未判定として候補を保留し、提案しない(circuit breaker)。Embedding失敗はバックフィルで回収する。

## 6. 環境・CI/CD・テスト戦略

**環境(3つ)。** (1)開発= `wrangler dev`(ローカルD1・Queues・Vectorizeのエミュレート。外部LLMはstubモード)、(2)staging= Workersのプレビュー環境(実D1・stub/real切替。02の#34クローズドテストの対象)、(3)prod=カスタムドメイン。D1・Vectorize・KVは環境ごとに分離する。

**CI(GitHub Actions)。** プルリクエストごとに(1)Biome(リント+整形)、(2)tsc(typecheck)、(3)vitest(vitest-pool-workersでD1/Queues/Vectorize込みの単体・統合試験)、(4)Playwright E2E(wrangler devに対して実行)を回す。mainマージでstagingへ自動デプロイ、**prodへのデプロイは手動承認トリガー**とする(公開前はプロダクトオーナーの操作)。

**テストの所在。** 02の対応表(#1〜#35)のうち、#34(社内クローズドテスト)はstagingでPlaywright+実機ブラウザによって証明する。Durable Objectsはvitest-pool-workersとwrangler devがローカル実行に対応しており、WebSocketを含むチャット(#25)の試験がローカルで完結する。負荷試験(#33)はstagingに対して実施し、性能目標(01 §20)のp95を計測する。

## 7. 非機能要件(01 §20)への対応

- Intent保存 p95 0.5秒 / Candidate Retrieval p95 1秒: Workers+D1(同一ネットワーク内)で十分達成可能。D1は読み取りを `withReplication`(Sessions API)でスケールさせる余地を持つ(D-A-05)
- Parser構造化プレビュー p95 3秒: 外部LLM呼び出し(timeout 10秒・再試行なし・フォールバック)は07の仕様どおり。stubモードでは即時
- 初期LATCH判定 p95 10秒: Queues経由の非同期処理のため、この目標は「保存コミット→通知送信記録」の計測(01 §20)であり、apiの応答性能とは独立
- 通知5秒以内: 判定確定後のWeb Push送信を同一Worker内で直列実行
- バックアップ: D1のポイントインタイムリストア(7日)を利用。VectorizeはD1の構造化データから再構築できる構造を保つ(埋め込みの再計算を許容・01 §18のモデル識別子記録)
- 可用性: Cloudflareのアナウンスに従う。計画停止はcron・キューの滞留として現れ、復帰後に消化される(冪等性がこれを許容する設計)

## 8. コスト概算(Workers Paid確定)

Workers Paid(月$5基礎料金)を前提とする。小規模(登録数百人・日次Intent作成数百件)では、リクエスト・D1読み書き・Queues・Vectorizeクエリとも無料枠または従量で月**$5〜$30程度**(チャットのDurable Objects常時接続分を含む)と見込む。LLM API(Embedding・Parser・Jev)は従量(07のコスト試算に委ねる)。アラート予算(月次LLM上限の80%)到達時の通知先・手段はリリース計画で定める。

## 9. 未決事項(本書ローカル・D-A-xx)

製品レベルの未決は01(D-02/D-03/D-05)が管理する。本書の技術ローカルな未決は次のとおり。

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-A-07 | フロントのスタイリング手法(CSSの書き方・UI部品の枠組み) | F2'着手時に本書で技術選定として確定。値の源は`prototype/project/latch.css`(トークンをそのまま移植) |

(解消記録。D-A-01 Embeddingプロバイダ=07で確定: Workers AI bge-m3・1024次元・cosine。D-A-02 チャットのリアルタイム化=オーナー選定で確定。D-A-06 リント/整形ツール=Biomeに確定。D-A-03 地名データ=§4のとおり確定(ISJ+駅データ)。D-A-04 課金=Workers Paid(月$5)を確定し、アラートは月次LLM予算の80%到達と日次サマリをオーナーのメールアドレス(wrangler secretに登録)へ送信。D-A-05 D1レプリカ導入基準=(a)読み取りレイテンシ/スロットリングのアラート検知 (b)読み取り系p95が0.5秒目標を2週連続で超過 (c)読み取り1日1,000万クエリ超過、のいずれかが続いた場合にwithReplicationを導入。欠番IDは再利用しない)

## 10. 01への反映

本書の確定により、01第19節の技術スタック選定は解消した。01本文の変更は不要である(技術スタック非依存の書き方になっているため)。
