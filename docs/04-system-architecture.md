# LATCH アーキテクチャ設計書

- 文書バージョン: v0.31
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.31更新: 2026-10-24)
- v0.2の変更点: §3を全面改訂し、スタックを「バックエンド・フロントエンドの構成部品」(DBアクセス・マイグレーション・入力検証・プッシュ実装・フォーム等)まで確定した。D-A-06(Biome)を解消し、D-A-07(スタイリング=03で確定)を新設した
- v0.3の変更点: 07(LLM利用仕様書)の策定に伴いD-A-01(Embedding)を解消した(Workers AI bge-m3・1024次元・cosine)。R2(ユーザーアイコン)をスタックへ追加した
- v0.4の変更点: 本書が単体で完結するよう記述を整理した(変更の経緯はgit履歴を参照)
- v0.5の変更点: 多角レビュー(loop1)の指摘を反映。Web Push送信を自前実装(WebCrypto/jose+fetch)に変更、レート制限をユーザー単位に確定、イベント投入の即時/遅延を明確化、DLQ運用を追記した
- v0.6の変更点: F1実装に伴い§4の認証・セッションを確定した(起動ガード条件の拡張・テスト用IdPのiss/aud固定値・本番IdP検証の前提)
- v0.7の変更点: 03(UX仕様書)の不作成裁定(00 §1の決定記録)に伴い、D-A-07(スタイリング手法)の確定タイミングをF2'着手時(本書で技術選定として確定)に変更。値の源は`prototype/project/latch.css`。前提文書欄の版数を更新
- v0.8の変更点: プロトタイプREADME §7のオーナー裁定(2026-10-19)に伴いD-A-07(スタイリング手法)を解消した(バニラCSS(グローバル)採用・決定記録)。§3.2・§9を更新。前提文書欄の版数を更新
- v0.9の変更点: F2'(フロント基盤)実装に伴い§4へdev専用サインイン(POST /v1/dev/idp-token)とWorkers Assets同一オリジン配信の実装確定を追記し、§3.2に稼働状況と移植運用を追記した。前提文書欄の変更はない
- v0.10の変更点: F3実装に伴い§4へVectorStore抽象(upsert/query/getByIds/deleteByIds・LATCH_ENV=localはインメモリ実装・staging/prodはVectorizeラップ)・Analytics Engine束縛(PIPELINE_AX・dataset=latch_metrics)・DLQのdead反映consumerの実装確定を追記し、§4のCron列挙を06 §2の(a)〜(i)に揃えた(実装済み/F4・F5計上の区別を含む)。§3.3・§6の開発環境の表記をVectorizeはインメモリ代替となる実態に整合。前提文書欄の変更はない
- v0.11の変更点: F4a(1対1の提案〜成立)実装に伴い§4へKVバインディングPIPELINE_KV(Jevのcircuit breakerの状態・予算アラートの送信済み印)の実装確定を追記し、§4のCron列挙の実装状況を更新した((f)(i)と回答期限切れ・pending残留の掃査はF4aで実装済み・(d)はF5)。§4の地名データの逆引きを実装確定(周囲3×3セルのハバーシン最近傍・05 §2.2)に精緻化し、§6のCI段落の試験対象の表記をVectorizeはインメモリ代替となる実態(§3.3)に整合。前提文書欄の変更はない
- v0.12の変更点: §4のパイプラインKVへcircuit breakerの書き込み方針(1波につき最大1回・状態が変わらないときは書かない・KVの読み書きの失敗は評価を止めない)の実装確定を追記した(F4aの最終レビューの修正)。前提文書欄の変更はない
- v0.13の変更点: 前提文書欄の版数同期(オーナー裁定3件(2026-10-20・01冒頭の決定記録)に伴う01・02改版への追従)。内容の変更はない
- v0.14の変更点: 前提文書欄の版数同期(F4b(グループLATCH)実装とオーナー裁定3件(2026-10-20・01冒頭の決定記録)に伴う01・02改版への追従)。内容の変更はない
- v0.15の変更点: F5(つながりの性質)実装とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴い、§4のCron (d)を機会LATCHのcompleted判定(対象時刻から3時間)まで広げ、実装済みと記録した。前提文書欄の版数を更新
- v0.16の変更点: F6a(チャットのバックエンド)実装に伴い、§4のチャットへWebSocket接続チケットの検証位置(Workerのルートで署名・期限・用途・LATCHの一致と参加の再検証・DOで1回限りの使用済み記録)と、送信をDOの1か所で直列に処理する構成・配信前の参加者確認・`closed`の知らせの実装確定を追記した。同段落の通知の表記を用語の統一(アプリ内通知)に揃えた。前提文書欄の版数を更新
- v0.17の変更点: 前提文書欄の版数同期(F6b(チャットの画面)の完了とオーナー裁定3件(2026-10-21・01冒頭の決定記録)に伴う01・02改版への追従)。内容の変更はない
- v0.18の変更点: F7a(安全のAPI)の実装確定に伴い、§4の認証・セッションのKV失効リストの反映対象からブロックを外し、ブロックはトークンを失効させず進行中の提案の取り消しと続いているLATCHからの本人の離脱で即時に効かせる旨(05 §2.2・§3.3)に改めた。前提文書欄の版数を更新(F7aの完了とオーナー裁定(2026-10-21・01冒頭の決定記録・12 §2の決定記録)に伴う01・02改版への追従)
- v0.19の変更点: F7b(通知のAPI)の実装確定に伴い、§4のWeb Pushへ送信の構成(書き込みの直後に同じWorker内でwaitUntilにより送り、送れていない行を毎分Cronで回収する・2026-10-21オーナー裁定)・送信の判断(mutedはWeb Pushだけを止める・01冒頭の決定記録)・順番取りの時刻と1回の送出の45秒の予算・順番取りの時刻を条件にした結果の記録・送信1件の10秒の時間制限とリダイレクトを追わないこと・送り手の差し替え口(LATCH_PUSH_MODE=stub/real)・VAPID鍵の設定と起動ガードを追記し、§4のCronへPushの回収走査と(c)の期限切れのアプリ内通知を、§3.1の表と§3.4へ実装状況を、§7の通知5秒以内へ構成の確定を加えた。前提文書欄の版数を更新
- v0.20の変更点: F7c(安全と通知の画面)の実装確定に伴い、§4のWeb Pushへ画面側の構成(Service Workerはvite-plugin-pwaの自動生成(generateSW)にworkbox.importScriptsでプッシュ処理のpush-sw.jsを読み込ませる・タップでアプリ内通知の一覧(`/notices`)を開く・購読の解除はサーバーの行の削除(DELETE /v1/push-subscriptions)を先に行ってから端末の購読を外す)を追記し、§3.1の表と§3.4の実機ブラウザでの受信確認の工程をF8(02 #32)に改めた。前提文書欄の版数を更新
- v0.21の変更点: F8a(PWAと画面の仕上げ)の実装確定とオーナー合意(2026-10-21・01冒頭の決定記録(PWAと画面の仕上げ))に伴い、§3.2の表へオフライン保存の部品を加え、§3.2へオフライン表示の構成(`PersistQueryClientProvider`とIndexedDBの保存部品・4つのキー・7日・利用者IDの紐づけ・消去の契機・帯と案内の文)を、§4へService Workerの`navigateFallbackDenylist`(`/v1/`・`/healthz`)・APIの応答をService Workerで保存しないこと・ホーム画面追加のPNGアイコン・オフライン中のセッション(`authSession.offline`・接続の回復で復元)を追記した。§3.1の表と§3.4の実機検証の工程をF8a(02 #32・実機確認はオーナーの記録待ち)に改めた。前提文書欄の版数を更新
- v0.22の変更点: F8b(stagingの構築と負荷試験)の実装確定とオーナー合意(2026-10-22・12 §2の決定記録(stagingと負荷試験))に伴い、§6の環境のstagingを`wrangler.jsonc`の`env.staging`で別名のWorkerとして載せる形に改め、§6へstagingの構成(資源の名前・vars・シークレット・URLを伏せる扱い)とCIの自動デプロイ(`deploy-staging`ジョブ)・手元からのデプロイ・手順書(`docs/runbooks/staging.md`)を追記した。前提文書欄の版数を更新
- v0.23の変更点: 不具合の修正工程(issue #3・#4・#7・#9・#10・2026-10-22)に伴い、§4のイベント駆動へ第1段が反映を待たずに第2段へ自分のベクトルを渡し、別に反映確認のイベントで1回評価し直すこと(06 §2・12 §2の決定記録(評価の流れ))を、Cronの(h)へ30分の再評価抑制の例外を、Web PushへCronが評価で作った通知をその実行の中で送ることを、オフライン中のセッションへリフレッシュの失敗の判定(セッションを捨てるのは401とLATCH形式の400(VALIDATION_FAILED)だけ)を、Web Pushの起動ガードへ仮の送信者(VAPID_SUBJECTの宛先のドメインが`.invalid`で終わるか`example.com`・`example.org`・`example.net`)の拒否を追記した
- v0.24の変更点: 前提文書欄の版数同期(F8bの負荷試験の結果の記録(2026-10-22)に伴う02改版への追従)。内容の変更はない
- v0.25の変更点: 前提文書欄の同期のみの改版(最終の直しに伴う版数の連鎖。内容の変更はない)
- v0.26の変更点: 不具合の修正工程(第2回・issue #6・#15・#17・#19・#26・2026-10-23)に伴い、§4のイベント駆動へ主キューの消費のバッチの待ち(max_batch_timeout)を1秒にしたことと、メッセージ単位のやり直し(第1段の失敗は10秒・30秒・60秒・反映確認の送り直しの送信の失敗)を、Cronへ全走査の隔離を、Web Pushへメッセージごとの送出と、起動ガードの仮の送信者の判定(前後の空白・`?`以降・末尾のドットを除いて判定する)を、Service Workerの段落へマニフェストのアイコンをPNGだけにしたこと(SVGはファビコンとPNGの元絵としてだけ使う)を、§7の初期LATCH判定と通知の行へ目標の対象(相手が先に反映済みの場合・01 §20)とメッセージごとの送出を加えた。前提文書欄の版数を更新
- v0.27の変更点: 前提文書欄の版数同期のみの改版(02・10・12の測り直し完了の記録に伴う追従)。内容の変更はない
- v0.28の変更点: 不具合の修正工程(第2回)の最終レビューの直しに伴い、§5の「Embedding失敗はバックフィルで回収する」を、キューのやり直し(10秒・30秒・60秒)の後にバックフィルで回収する記述に改めた(07 §4・06 §5と揃える)。内容の変更はこの1文のみ
- v0.29の変更点: LLM real接続の工程の完了(2026-10-24・01冒頭の決定記録(LLM real接続))に伴い、§4の認証・セッションへ起動ガードの2件(全環境で`LATCH_LLM_MODE=real`なのにAPIキーが無い=ENV_MISSING_LLM_KEY・stagingでAccessの値が無い=ENV_MISSING_ACCESS)と、stagingのCloudflare Accessの証明をWorkerでも検証すること(issue #11)を、§6のstagingの実装確定の段落へ`LATCH_LLM_MODE=real`・シークレットの追加(LLMのAPIキー2件・Accessの値2件)・守りをURLを伏せるだけ(F8bの時点の形として残す)からAccessの背後に置く形へ改めたことを、CIの段落へ精度ゲートの記録の照合(09 §4)と疎通確認の通行証を加えた。前提文書欄の版数を更新
- v0.30の変更点: 不具合の修正工程(第3回・2026-10-24・12 §2の決定記録(不具合の修正工程(第3回))・issue #30・#32)に伴い、§4のイベント駆動へ主キューの消費者のmax_batch_size=1(オーナー決定3a)と、意思を有効にした要求の応答の後の第1段・第2段の処理およびキューのintent_createdの60秒遅らせたやり直し(オーナー決定3b・06 §2)を、Accessの検証へ公開鍵の集合をPIPELINE_KVに600秒置くこと(Cache APIはworkers.devで効かないため)を加えた。前提文書欄の版数を更新
- v0.31の変更点: 不具合の修正工程(第3回)の最終点検の直し(2026-10-24)に伴い、§4のイベント駆動の段落の前半(作成はapi出口で即時にQueuesへ送信・embedding_completedを自分のベクトル付きで即時に投入)を、同じ段落の後半(応答の後の第1段・第2段・オーナー決定3b)とキューの第1段の続きの第2段(06 §2)に矛盾しない形へ直した。前提文書欄の版数は変わらない
- 前提文書: 01 要件定義書 v0.23 / 02 スコープ・受け入れ条件合意書 v0.20
- 本書の位置づけ: 01第19節の技術スタック選定を確定させる文書。UIの正本は`prototype/`(03は不作成)。スタイリング手法(D-A-07)はバニラCSS(グローバル)に確定済み(§3.2・決定記録(2026-10-19))

**決定記録(2026-10-17・プロダクトオーナー)**

- **インフラはCloudflareをベースとすることを確定する。** 根拠は信頼性とコストである(オーナー決定)
- **言語はTypeScriptに確定する**(オーナー選定。対抗案=Python)。**DBはD1(Cloudflare内蔵)に確定する**(オーナー選定。対抗案=外部PostgreSQL)。**チャットはリアルタイム(WebSocket)に確定する**(オーナー選定。推奨していたポーリング案から変更)
- 残りの技術選定(構成部品を含む全部)は本書§3の比較のとおり確定する。ただしLLMプロバイダ(Embedding・Jev)は07の所管とする(スタイリング手法=D-A-07は2026-10-19に確定済み・下記の決定記録)

**決定記録(2026-10-19・プロトタイプREADME §7のオーナー裁定)**

1. 決定内容: D-A-07(フロントのスタイリング手法)を解消する。**バニラCSS(グローバル)を採用する。** `prototype/project/latch.css` を `apps/web/src/styles/latch.css` へ移植して正本とし、追加スタイルはapps/web側のCSSに記述する。デザインシステム側の変更はprototypeで行い、apps/webへ再移植する
2. 根拠: UIの正本である`prototype/`(プロトタイプREADME §7)の実装基準どおり。ビルド時の変換を介さないため、デザイン定義(色・書体・部品・動き)の単一源が保たれる
3. 影響: §3.2のスタイリング行を確定値へ更新した。移植作業はF2'(フロント基盤)で行う

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
| Web Push送信 | 自前実装(VAPID署名=jose/WebCrypto・aes128gcm暗号化=WebCrypto・送信=fetch) | web-push公式ライブラリは参考実装とする(§3.4)。F7bで実装済み(§4)。実機検証はF8a(02 #32・実機確認はオーナーの記録待ち) |
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
| オフライン保存 | @tanstack/react-query-persist-client + idb-keyval | 一部の取得結果を端末(IndexedDB)に保存し、オフライン表示に使う(F8a・下記) |
| チャット受信 | WebSocket(DOへ直結) | 受信メッセージはTanStack Queryのキャッシュへ書き込み |
| フォーム | react-hook-form + @hookform/resolvers(zod) | 読み解き確認の修正UI・Parser失敗時の構造化フォールバック。zodスキーマはsharedから流用 |
| スタイリング | **バニラCSS(グローバル)(確定・D-A-07解消)** | 正本は `apps/web/src/styles/latch.css`(`prototype/project/latch.css` を移植)。追加スタイルはapps/web側のCSSに記述し、デザインシステム側の変更はprototypeで行い再移植する(2026-10-19オーナー裁定) |
| 単体試験 | vitest + Testing Library(happy-dom) | fetchはモック |
| E2E | Playwright(chromium) | 02の対応表#34の社内クローズドテストに使用 |

上記のフロント構成(React Router・TanStack Query・react-hook-form+zod resolver・vite-plugin-pwa)はF2'(フロント基盤)で実装済みで稼働している。バージョン番号は§1の規律どおり `package.json` が正である。スタイリングの移植運用(D-A-07): `prototype/project/latch.css` から `apps/web/src/styles/latch.css` への移植は**不改変コピー**とし、整形・リントの対象外とする(Biomeの除外設定に加える。§3.3の生成物除外と同型の運用で、デザイン定義の単一源を保つ)

**オフライン表示の構成(F8a実装確定・01冒頭の決定記録(2026-10-21・PWAと画面の仕上げ)の3)。** 画面の取得結果のうち、意思の一覧(`["intents"]`)・提案の一覧(`["latches","proposals"]`)・つながり一覧(`["latches","connections"]`)・自分(`["me"]`)の4つのキーに完全一致し、取得に成功したものだけを端末に保存する。保存はTanStack Queryの`PersistQueryClientProvider`と、IndexedDB(idb-keyval)へ書く自前の保存部品で行い、保存期間(`maxAge`)は7日とする。保存値には利用者ID(アクセストークンのsub)を添え、現在の利用者と異なる保存は読まずに消す。利用者IDが無いときは保存しない。IndexedDBが使えない端末では保存せず、表示は通常の取得に任せる。保存はログアウト・サーバーによるログインの拒否・別の利用者でのサインイン(`authSession.onUserChange`)で消す。ホームとつながり一覧は、再取得に失敗しても保存済みの内容を出し続け、オフラインの間は帯「オフラインです。最後に確かめた内容を表示しています。」(`prototype/`の文言)を出す。保存済みの内容が無いときは帯と「一覧を読み込めませんでした。」を出す。オフラインでできない操作は固定の案内(読み解きは入力欄へ戻ってトーストで「オフラインのため、いまは読み解けません。」・チャットの送信は「オフラインのため、送れませんでした。」・その他は「オフラインのため、いまは操作できません。」)を出す。チャットの本文・アプリ内通知の一覧・LATCHや意思の単一取得は保存しない(01 §20・§21・08 §7)

### 3.3 共有・品質・CI

| 用途 | 選定 | 理由・備考 |
|---|---|---|
| 共有パッケージ | packages/shared(Zodスキーマ・TS型・定数) | APIリクエスト/レスポンス・Intent構造を前後面で一字共有 |
| モノレポ | pnpm workspaces + corepack | apps/web・apps/worker・packages/shared |
| 開発用Node | Node 22 LTS | ビルド・試験ツールのためのみ(実行はWorkers) |
| リント/整形 | Biome(確定・D-A-06解消) | 単一ツール・高速。毎コミット実行 |
| 型チェック | tsc --noEmit | Biomeと分離(型はtscが正) |
| バックエンド試験 | vitest + @cloudflare/vitest-pool-workers | D1・Queues・DOのローカル実行(Vectorizeはインメモリ代替・§4)で単体・統合試験 |
| CI/CD | GitHub Actions + wrangler | §6(品質ゲート→staging自動→prod手動) |

### 3.4 対抗案と選定理由

**言語 — TypeScriptを採用(2026-10-17オーナー選定)、Python Workers・Go不採用。** Workersの機能(Durable Objects・Queues consumer・Cron・Rate Limitingバインディング・Assets)はすべてTypeScriptファーストで提供され、ドキュメント・サンプル・AIによるコード生成の品質も最も高い。フロントエンドとバックエンドが同一言語になり、Intentの型・APIスキーマを `packages/shared` で文字どおり共有できる(単一実装のため、前後面の契約は型共有で賄い、契約試験は不要になる)。Python WorkersはローカルMLライブラリを使う場合の選択肢だが、本サービスのLLM利用は外部API呼び出しのみで、この利点が生きない。

**DB — D1を採用(2026-10-17オーナー選定)、外部PostgreSQL(Hyperdrive経由)不採用。** オーナー決定の「信頼とコスト」に対し、プラットフォーム外のDB(Neon・Supabase等)は通信遅延・別課金・別障害点を追加する。**地理情報の専門機能(PostGIS相当)を持たない**ため地理判定は「SQLでバウンディングボックス事前絞り+TypeScriptでハバーサイン(距離計算)」に置き換える。対象は地域添付Intent同士の重なり判定のみで(01 §12)、全国規模でも前段のVectorizeメタデータフィルタで評価対象は小さい。geo検索の複雑さが必要になった時点で再評価する(D-A-05と同じトリガー)。

**DBアクセス — Drizzle ORM(D1ドライバ)を採用、生SQL・Kysely・Prisma不採用。** DrizzleはD1公式ドキュメントに接続方法が掲載され(2026-10-17確認)、型安全なクエリビルダとスキーマからのマイグレーション生成(drizzle-kit)を備える。生SQLは型の保証が弱く、PrismaはWorkers上で動くもののクエリエンジン分がヘビーである。注意点として、drizzle-kitの新版(RC)で `wrangler d1 migrations apply` との非互換が報告されているため、**安定版にバージョン固定**して使う(§1のバージョン規律)。

**Web Push送信 — 自前実装を採用、web-pushライブラリ直接利用は不採用(loop1裁定)。** VAPID署名はjose(WebCrypto)で、メッセージ暗号化(aes128gcm・RFC8291)はWebCryptoで行い、送信はfetchで直接行う。定番ライブラリ(web-push)は通知送信にNodeのHTTPクライアントを使いWorkers上の動作が保証されないため、参考実装(署名生成の検証用)と位置づける。実装と実機検証(iOS/Android/デスクトップ各ブラウザ)はF7(12)に明示的に計上する。実装はF7b(通知のAPI)で済み(暗号化はRFC 8291の試験ベクトル・VAPID署名はjoseでの検証で単体試験)、実機ブラウザでの受信確認はF8a(02 #32)で行う(手順と記録は`docs/reports/f8a-pwa-device-check.md`・オーナーの記録待ち)。

**WebSocketチャット — リアルタイム(Durable Objects+WebSocket)を採用(2026-10-17オーナー選定)、ポーリング不採用。** 成立後の対話そのものが主目的のつながりIntentでは、表示の即時性が体験の中心になる。DOのHibernation APIで接続維持のコストを抑え、メッセージの正はD1に置くことでDOの障害・再起動でも履歴を失わない構造とする(詳細は§4)。追加ライブラリは使わない(WorkersネイティブのWebSocket APIで足りる)。

**ベクトル検索 — Vectorizeを採用、D1内自前実装・外部ベクトルDB不採用。** マネージドのANN検索とmetadata filterを持ち、プラットフォーム内で完結する。filterでform(つながり/機会)・status(active)・categoryを縛れるため、「つながり×機会を候補化しない」(01 §12)と「expiredを候補化しない」を検索段階で強制できる。次元=1024・距離=cosineは07 v0.1で確定した(D-A-01解消)。

**フロントエンド — React+Vite SPAを採用、Next/Remix不採用。** 本サービスはSSRの利益(SEO・初期表示)を得られない(検索エンジンに載せるページがなく、体験は認証後のAPI描画だから)。静的Assets配信が最も安く・速い。

**フロントの状態管理 — TanStack Query+react-hook-formを採用、グローバル状態ライブラリ(Zustand等)は持たない。** 本アプリの状態のほとんどはサーバー由来(提案・Intent・履歴)とフォームであり、どちらも専用の標準ライブラリがカバーする。グローバル単一ストアは、必要性が生じた時点で導入する(最初から持たない=前提: 画面間で共有する純クライアント状態がほぼない)。

**配備 — Cloudflare単一構成を採用、複数事業者混在不採用。** オーナー決定どおり。DNS・CDN・Workers・D1・Queues・Vectorize・KV・Assets・観測を1アカウントで運用し、障害点と請求を1本化する。

## 4. 主要設計

**認証・セッション。** Google・AppleのIdPトークンを検証し(joseのリモートJWKS)、独自JWT(有効期限1時間)を発行する。リフレッシュトークンは回転式(30日)でD1に族IDごと管理し、再利用を検出したら族失効+401とする(ただし応答喪失後の同一旧トークン再提示は1回に限り現行トークンを再返す猶予を持つ)。ログアウト・退会の反映はKVの失効リスト(JWTのjtiをTTL=残り寿命で格納。JWT残寿命以内に効力)とし、権限が関わる操作(チャット送信・回答・退会)はD1のusers.statusを再検証して補完する(05 §2.3)。ブロックはトークンを失効させず、2人を含む進行中の提案の取り消しと続いているLATCHからの本人の離脱をその場で行うことで即時に効かせる(閉じたLATCHでは送信・回答ができない・05 §2.2・§3.3)。起動ガードとして、prodでテスト鍵(LATCH_TEST_IDP_JWKS)が残存する場合、またはJWT_SECRETが未設定もしくは32字未満の場合は起動を拒否する。テスト用IdP(staging・ローカルの内部トークン用・10 §2)のiss・audは固定値 `urn:latch:test-idp`・`latch-test` とし、prodでは起動ガードがこの設定自体を拒否する。**dev専用サインイン(F2'実装確定)。** ブラウザE2E・ローカル開発のサインイン入口としてPOST /v1/dev/idp-tokenを提供する。コミット済みテスト鍵の秘密鍵(LATCH_TEST_IDP_PRIVATE_JWKS)でRS256署名したIdPトークン(有効期限600秒)を返し、受け取ったトークンは通常どおりPOST /v1/auth/tokenで検証するため、認証フローに特別経路は設けない。存在を隠すため、LATCH_ENVがproductionの場合・またはテスト鍵2変数(LATCH_TEST_IDP_PRIVATE_JWKS・LATCH_TEST_IDP_JWKS)が未設定の場合は一律404を返す(理由は区別しない)。prodでは加えて起動ガードが秘密鍵の設定自体を拒否する二重防御とする(10 §2)。成否は構造化ログのイベント(dev.signin.issued・dev.signin.rejected)でのみ判別でき、subject等は出力しない。本番IdP検証の前提: Google=JWKS `https://www.googleapis.com/oauth2/v3/certs`(iss `accounts.google.com`・aud=GOOGLE_CLIENT_ID)/ Apple=JWKS `https://appleid.apple.com/auth/keys`(iss `https://appleid.apple.com`・aud=APPLE_CLIENT_ID)。client id未設定は認証失敗として扱う。**起動ガードの追加(LLM real接続で確定)。** 全環境で、`LATCH_LLM_MODE=real`なのにシークレット`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`のどちらかが無ければ起動を拒否する(ENV_MISSING_LLM_KEY・07 §2)。`LATCH_ENV=staging`で`ACCESS_AUD`・`ACCESS_TEAM_DOMAIN`のどちらかが無ければ起動を拒否する(ENV_MISSING_ACCESS)。**stagingのCloudflare Accessの検証(issue #11・LLM real接続で確定)。** stagingはCloudflare Accessの背後に置き(§6)、Worker側でも全リクエスト(`/healthz`・`/v1/*`・静的配信)の先頭でAccessが付ける証明(ヘッダー`Cf-Access-Jwt-Assertion`)を検証する。チームのドメイン(末尾のスラッシュ等を除いて正規化する)の`/cdn-cgi/access/certs`の公開鍵でRS256の署名を確かめ、iss=チームのドメイン・audに`ACCESS_AUD`を含むこと・期限内を確かめる(jose)。公開鍵はisolateの中で保持し、未知のkidのときだけ取り直す(取り直しが空の鍵集合でも保持中の鍵は捨てない)。新しいisolateが立つたびに公開鍵を取りに行くと保存のp95を押し上げたため(issue #32)、公開鍵の集合をPIPELINE_KVに600秒(10分)置いてisolateをまたいで使い回す(Cache APIはworkers.devのドメインでは効かないため使わない)。入れ替え・失効した鍵は、KVに最大600秒残り得る。通らない要求は403(本文は固定文・理由はログの許可リストのerror_codeだけ)とする。Cron・キューの消費はfetchを通らないため対象外。localとtestでは検証しない。prodの扱いはF10で決める。

**フロント配信(Workers Assets・F2'実装確定)。** SPAの静的資産はWorkers Assetsが同一オリジンで配信する(assets directory= `pnpm --filter web build` の生成物apps/web/dist)。未一致のパスはindex.htmlへ倒すSPAフォールバック(not_found_handling=single-page-application)とする。/v1/*と/healthzはrun_worker_firstで必ずWorkerが先に処理する。AssetsはGET/HEAD以外のメソッドをWorkerへ迂回させないため、APIのPOST/PUT/DELETEを届かせるにはこの指定が必須であり、/healthzも含めてヘルスチェックがSPAフォールバックのindex.htmlで代替応答されないようにする。

**イベント駆動(01 §16の実装)。** Intentの作成とdraft→active化は、応答の後(waitUntil)に同じ要求の続きで第1段(Embedding・Vectorizeへのupsert)と第2段(Layer 1〜5)を行い、Queuesへは60秒遅らせてやり直しの役として送る(初回提案のレイテンシを守る・この段落の後半のオーナー決定3b)。キューで第1段を処理したときも、同じ実行の中で第2段を続ける(embedding_completedはmatch_eventsの行として記録し、キューへ送るのは続きの第2段が失敗したときだけとし、そのメッセージには自分のベクトルを載せる・06 §2)。第1段はVectorizeへの反映を待たず、別に反映確認のイベント(vector_reflection)を遅延付きで投入して、反映を確かめたら1回だけ評価し直す(同時に預けた相手の取りこぼしを拾う・06 §2・不具合の修正工程で確定)。**更新のみ**10秒の遅延配信とし、消費側で現行versionと突き合わせて古ければ破棄する(idempotency。match_eventsのUNIQUE制約が二重投入も許さない)。失敗は再試行上限(max_retries=3初期値)ののちDLQへ隔離し、DLQを見る最小のconsumerがmatch_eventsのstatusをdeadへ反映して警報する。消費は例外を外へ出さず、メッセージ単位のやり直し(遅延付きのretry)は第1段の失敗(10秒・30秒・60秒)と反映確認の送り直しの送信の失敗だけで行う(06 §2・§5・不具合の修正工程(第2回)で確定)。主キューの消費のバッチの待ち(max_batch_timeout・1件目が来てから待つ秒数)は1秒とする(既定の5秒では小さなバッチでも5秒待つため。`wrangler.jsonc`の既定とstagingの両方・issue #19・不具合の修正工程(第2回)で確定)。主キューの消費者のmax_batch_sizeは1とし(トップレベルとstagingの両方)、メッセージごとに別の実行で並行に処理する(第1段の成功の後に同じ実行で第2段を続けると1件の処理が約5秒に延び、既定の10件のバッチでは直列に処理されて後ろの件が待ったため・オーナー決定3a・2026-10-24・06 §2)。意思を有効にした要求(作成・下書きの有効化)は、応答の後(waitUntil)に同じ要求の続きで第1段・第2段を行い、キューのintent_createdは60秒遅らせてやり直しの役にする(オーナー決定3b・06 §2。環境変数`LATCH_INLINE_PIPELINE`)。誤った提案より提示の見送りを優先する方針である。deadの再処理は、UNIQUE衝突を避けるため新規イベントとして再発行する(手動)。

**VectorStore抽象と観測束縛(F3実装確定)。** Vectorizeにはローカルシミュレータが存在しないため、VectorStoreインタフェース(upsert/query/getByIds/deleteByIds)の背後に2実装を置く。LATCH_ENV=local(単体・統合試験・wrangler dev・E2E)はコサイン距離・metadata filter込みのインメモリ実装、staging/prodはenv.VECTORS(Vectorize)のラップ実装であり、選択はLATCH_ENVで行う(05 §2.3)。パイプラインの計測はAnalytics EngineバインディングPIPELINE_AX(dataset=latch_metrics)へ層通過のdata pointをイベント単位で書く(06 §7・バインド未設定の環境では送信を省略)。DLQを見る最小のconsumer(match_eventsへのdead反映・警報)は第1段の消費と同一Workerに実装済みである。**パイプラインKV(F4a実装確定)。** 失効リスト用のKV(REVOCATION_KV)とは別にKVバインディングPIPELINE_KVを置き、Jevのcircuit breakerの状態(06 §5)と予算アラートの送信済み印(同一periodで1回・06 §6)を保持する(キーは05 §2.3)。Workers KVは同一キーへの書き込みが1秒に1回までのため、circuit breakerの状態の書き込みは1波(並列呼び出しの1回分)の結果をまとめて最大1回とし、状態が変わらないとき(成功のみで失敗数が既に0等)は書かない。KVの読み書きの失敗は評価を止めない(読めなければ閉とみなし、書けなければログjev.breaker.kv_failedを出して続行する。安全装置としての近似・06 §5)。

**Cron(毎分)。** 記号と内容は06 §2に揃える。(a)機会Intentのbucket到来の再評価、(b)期限前catch-up走査(expires_atまで2時間以内かつlast_evaluated_atから30分以上経過・01 §16)、(c)全active Intentの期限切れバッチ、(d)LATCHのcompleted判定(つながり=チャット非活動90日・機会=対象時刻から3時間・01 §8)、(e)埋め込み未完了のIntentのバックフィル再試行、(f)usage_counters集計とJev予算の80%到達検知とアラート、(g)埋め込み済みかつ未評価のactive Intentの回収再評価(キュー消失の安全網)、(h)active化後10分経過のつながりIntentの1回きり遅延再評価(30分の再評価抑制の例外・06 §3)、(i)提案クローズ後続処理。F3で(a)(b)(c)(e)(g)(h)と保持期間削除(05 §2.6)を、F4aで(f)(i)と回答期限切れ・pending残留の掃査を、F5で(d)を、F7bでWeb Pushの回収走査と(c)の期限切れのアプリ内通知を実装済みである(06 §2)。走査は互いに隔離し、1つの走査の失敗はログ(cron.sweep.failed)を出して次の走査へ進む(全走査に広げたのは不具合の修正工程(第2回)・issue #15。ベクトルのmetadata整合の修復はバックフィル(e)の後の独立した走査とする・06 §2)。毎分1回のCron Trigger内で走査対象をインデックス(status・starts_at・expires_at)で最小化する。

**地理の実装。** 地域添付は中心座標+半径をD1に保存し、候補検索はSQLのバウンディングボックス事前絞り+TSでの距離判定。相手への表示は地域名のみ(01 §21の丸め規定)。座標・距離の数値は一切表示しない。

**地名データ(D-A-03解消)。** ソースは国土交通省の位置参照情報(ISJ・大字/町丁目級。CC BY 2.0 JP)と駅データ.jp(駅位置・CC BY 4.0)とする。取り込みは `scripts/` の前処理スクリプトがCSVからINSERT SQLを生成し、`wrangler d1 execute --file` で環境ごとに適用する(生データはリポジトリにコミットしない)。座標→地名の変換は約1kmグリッド(0.01度)のgrid_keyで行い、座標の属するセルの中心を基準点として、そのセルと周囲を合わせた3×3セルの地名からハバーシン距離の最近傍を採る(基準点を丸めるため元の座標は距離計算にも使わない・05 §2.2)。両データのクレジット表記を利用規約のクレジット節に含める(08 §10)。

**Web Push。** PWAのService Workerが購読し、購読情報をD1に保存。提案通知の送信は汎用文のみ(01 §10の表示規制どおり)。VAPID鍵はWorkersシークレットで管理し、送信記録を残す。**送信の構成(F7b実装確定・2026-10-21オーナー裁定)。** Web Pushは通知行を書いた処理の直後に同じWorker内で送り(waitUntil)、送れていない行を毎分Cronで回収する。通知専用のキュー・Cronだけの送信は採らない(前者はキューの追加を、後者は最大1分の遅れを伴う)。通知行(05 §2.2)はWeb Push対象の種別(proposal・matched)を送信の状態push_state=pendingで書き、書き込みを行い得る入口(LATCH・Intent・安全のAPIの変更系(POST・PATCH・DELETE)の2xx応答の後と、主キューのバッチの後。DLQは除く)で送出処理(flushPush)を呼ぶ。毎分Cronが評価本体を直接呼んで作った通知は、評価を行う走査の後に、その回のCronの開始以後に作られたpending行をその実行の中で送る(30秒の回収を待たない。後述の回収は送り損ねの安全網として残す・不具合の修正工程で確定)。主キューの消費では、1件のメッセージの処理で通知が作られたら、バッチの終わりを待たずにその場で送出を始め(waitUntil・対象はそのメッセージの処理の開始以後に作られた行)、バッチの後の送出は取りこぼしの回収として残す(issue #19・不具合の修正工程(第2回)で確定)。送出は作成から10分以内で未試行(または試行から60秒以上)のpending行(1回あたり上限100件)を照会して送り、その失敗はAPIの応答・キューの消費に影響させない。行ごとに条件付きUPDATE(push_attempted_atの記録)で順番を取り、直後の送出とCronの回収が同時に拾っても片方だけが送る。順番取りの時刻は行ごとにその時点のClockで読み、1回の送出は開始から45秒を過ぎたら新しい行の順番を取らない(残りは後の送出・Cronの回収が拾う。60秒の再取得の間隔を1回の送出が越えないため)。結果の記録(sent・muted・no_subscription・failed)はpendingかつpush_attempted_atがその試行の順番取りの時刻である行だけに書き、遅れて戻った先行の試行が後続の試行の結果を上書きしない。送信の判断は、本人の当該LATCHでの参加Intentのnotification_levelがmuted→送らない(muted・01冒頭の決定記録(2026-10-21・通知のAPI))、本人のactiveな購読が無い→no_subscription、activeな各購読へ送り1件でも成功→sent・全部が恒久失敗→failed・一時失敗を含み成功が無い→pendingのまま(Cronで再試行)とする。送信先の応答は2xxで購読のlast_success_atを更新し、404・410は購読をfailedにして以後送らず、400・403・413はその送信の恒久失敗、429・5xx・ネットワーク例外は一時失敗とする。送信1件には10秒の時間制限を設けて時間切れを一時失敗とし、リダイレクトは追わず3xxをその送信の恒久失敗とする(許可ホスト以外へ送らない)。本文の暗号化はRFC 8291(aes128gcm・WebCrypto)、VAPID(RFC 8292)はES256のJWT(aud=送信先のorigin・exp=12時間後・sub=VAPID_SUBJECT)をjoseで署名する。**送り手の差し替え口と鍵(F7b実装確定)。** LATCH_PUSH_MODEは既定stub(外部へ送らず各購読への送信を成功として扱う。試験・E2Eを外部のPushサービスに依存させない)、realで実送信する。シークレットはVAPID_PUBLIC_KEY(base64url・非圧縮P-256点)・VAPID_PRIVATE_KEY(JWKのJSON)・VAPID_SUBJECT(mailto:)で、stubでも公開鍵APIのためにVAPID_PUBLIC_KEYを使う(ローカル・E2Eはコミット済みのテスト専用鍵)。起動ガードとして、prodでLATCH_PUSH_MODEがreal以外の場合・VAPID_*のいずれかが無い場合・VAPID公開鍵がコミット済みのテスト鍵の場合・VAPID_SUBJECTが仮の送信者(`mailto:`の宛先のドメインが`.invalid`で終わるか`example.com`・`example.org`・`example.net`。大文字小文字を区別せず、前後の空白・`?`以降・ドメインの末尾のドットを除いて判定する(不具合の修正工程(第2回)で確定))の場合は起動を拒否する(F10で実在の連絡先の設定を忘れないため。ローカル・E2Eの試験用の送信者は`mailto:dev@example.com`で、`.invalid`の予約ドメインはAppleのPushサービスが拒否する・不具合の修正工程で確定)。本番のVAPID鍵の発行と登録はF10(公開準備)で行う。**画面側の構成(F7c実装確定)。** Service Workerはvite-plugin-pwaの自動生成(generateSW)を変えず、`workbox.importScripts`でプッシュ処理だけの小さなファイル(`apps/web/public/push-sw.js`)を読み込ませる(injectManifestへ切り替えてキャッシュ処理を自前で持つことはしない)。受信したペイロードの汎用文をそのまま本文に出し(題名は「LATCH」・読めなければ既定の汎用文)、タップでアプリ内通知の一覧(`/notices`)を開く(開いているタブがあればそこで開き、無ければ新しく開く)。購読は、許可を求める→公開鍵の取得(GET /v1/push/vapid-public-key)→`pushManager.subscribe`→登録(POST /v1/push-subscriptions)の順で行い、登録に失敗したら作った端末の購読を外す。解除は、サーバーの行の削除(DELETE /v1/push-subscriptions)を先に行ってから端末の購読を外す(`unsubscribe()`)。ログアウトはこの解除(失敗は無視し、時間を区切る)の後にトークンを捨てるため、アクセストークンが有効なうちにサーバーの行を消せる(文書の裁量で定めた技術的事項)。購読の手順は単体試験でpushManagerを差し替えて確かめ、実機ブラウザでの購読と受信はF8a(02 #32・実機確認はオーナーの記録待ち)で確かめる。

**Service Workerとオフライン中のセッション(F8a実装確定)。** Service Workerはvite-plugin-pwaの自動生成(generateSW)と`workbox.importScripts`によるpush-sw.jsの読み込み(F7c)を保ち、画面遷移の代替応答(navigateFallback)から`/v1/`と`/healthz`を除く(`navigateFallbackDenylist`)。APIの応答はService Workerで保存しない(利用者を区別しない保存を避けるため・端末への保存は上記§3.2のオフライン表示の構成だけが担う)。ホーム画面追加のアイコンはPNG(apple-touch-icon 180・192・512・maskable 512(背景色#EEF0F2の中央に図柄を80%で置く))を`apps/web/scripts/make-icons.mjs`(@resvg/resvg-js)で生成してコミットし、マニフェストは`any`と`maskable`を別の項目で持つ。マニフェストのアイコンはPNGだけとし、SVG(`icon.svg`)はファビコンとPNGの元絵としてだけ使う(SVGを載せるとブラウザが固有サイズの警告を出すため・issue #6・不具合の修正工程(第2回)で確定)。apple-touch-iconはPNGを指す。オフライン中のセッション: 起動時のセッションの復元(リフレッシュ)が通信の失敗で終わり、リフレッシュトークンが端末に残っているときは`authSession.offline`を真とし、保護された画面の描画を許す(`RequireAuth`)。`online`のイベントで復元をやり直し、成功したら取得をやり直す。apiFetchのリフレッシュが通信の失敗(`network_error`)のときはTypeErrorを投げてセッションを捨てず、サーバーが拒んだ(`rejected`)ときは従来どおり捨てる。**リフレッシュの失敗の判定(不具合の修正工程で確定)。** `rejected`(端末の保存値とセッションを捨てる)とするのは、401と、400で本文がLATCHのAPIのエラー形式(`error.code`が`VALIDATION_FAILED`)の応答だけとする。それ以外の応答(中継の404・408・429・5xx・LATCH形式でない400・本文が読めないもの)は`network_error`として扱い、保存値を残す(回線の途中の装置が返した応答で有効なセッションを捨てない)。利用者IDとして、最後に確立したアクセストークンのsub(識別子のみ)を`localStorage`の`latch.uid`に置く(文書の裁量で定めた技術的事項)

**チャット(リアルタイム・オーナー確定)。** 成立LATCHごとに1つのDurable Objectを置き、WebSocketで接続中の参加者へ新着を即時配信する。メッセージの正はD1に保存し、履歴取得・未読管理・つながり品質の計測(01 §14)はD1に対するREST/クエリで行う。DOは配信に専念し、障害・再起動があっても履歴は失われない。接続の維持はHibernation APIを使いコストを抑える。オフラインの参加者にはアプリ内通知とWeb Pushで到達する(01 §10)。**チャットの構成(F6a実装確定)。** DOはLATCHごとに1つ(LATCH IDから名前で引く)で、外部から直接到達できず、Workerのルートだけが内部要求(接続・送信・`closed`の知らせ)で呼ぶ。送信はWebSocketでもREST(05 §3.2)でもDOへ集め、DOが1か所で直列に保存→配信する(メッセージIDはDO内で単調増加のULIDを採番し、IDの順=保存の順=配信の順)。保存は「LATCHがmatchedかつ送り手が離脱・表示削除をしていない」を条件にしたD1の1文で行うため、終了・離脱と送信が並行しても終了後のメッセージは保存されない(05 §3.4)。配信の前にDOはD1で現在の参加者を照会し、参加者でない接続には`closed`を送って閉じる。離脱・表示削除(05 §3.3)の成功後はルートがDOへ`closed`を知らせる(最善努力。正しい状態はD1にある)。**接続チケットの検証位置(F6a実装確定)。** WebSocket接続(GET /v1/latches/{id}/ws)はAuthorizationヘッダを使わず、URLのクエリのチケット(05 §3.4)で認証する。署名・期限(60秒)・用途(typ)・LATCH IDの一致の検証と、D1での参加者かつmatchedであることの再検証はWorkerのルートで行い、1回限りの使用済み記録(jti)はDOのストレージ(SQLite)で行う(KVは使わない・05 §2.3)。いずれの失敗も401で理由を区別しない(08 §11)。

**時刻の規律。** 製品コードは実時間を直接参照しない。現在時刻は注入可能なclock経由とし、単体試験は固定時刻で行う。JST基準の集計・リセット(01 §20)もclock上で扱う。

**構造化ログ。** 出力フィールドは列挙型の許可リストで固定し、raw_text・座標・NG条件をロギングしない。Serializer段で強制する。

## 5. コスト保護機構(3層)

| 層 | 要件(01 §20) | 実装 |
|---|---|---|
| 源流レート制限 | 1ユーザーあたり60req/分・Active Intent 5件/ユーザー・作成20件/日・更新6回/時間 | Workers Rate Limitingバインディング(key=user_id・60req/60秒・ユーザー単位。グローバル制限は設けない。429のRetry-Afterは固定60秒)+D1カウンタ(ユーザー単位・日次/時間窓) |
| Jev予算 | 1Intentあたり1日40回・1ユーザーあたり1日120回・再評価30分抑制 | D1カウンタ(日次バケット keyed by intent/user)+最終評価時刻チェック |
| 実行回数上限 | 1日30,000回・1か月600,000回・80%でalert | D1のグローバルカウンタ+Cronでの検知・Analytics Engineでの傾向記録 |

上限到達・LLM API障害時はJev未判定として候補を保留し、提案しない(circuit breaker)。Embedding失敗はキューのやり直し(10秒・30秒・60秒)の後にバックフィルで回収する。

## 6. 環境・CI/CD・テスト戦略

**環境(3つ)。** (1)開発= `wrangler dev`(ローカルD1・Queues・DOのエミュレート。Vectorizeは§4のインメモリ代替を使用。外部LLMはstubモード)、(2)staging= wranglerの環境(`env.staging`)で別名のWorkerとして載せる(実D1・stub/real切替。02の#34クローズドテストと#33負荷試験の対象)、(3)prod=カスタムドメイン。D1・Vectorize・KVは環境ごとに分離する。

**CI(GitHub Actions)。** プルリクエストごとに(1)Biome(リント+整形)、(2)tsc(typecheck)、(3)vitest(vitest-pool-workersでD1・Queues込みの単体・統合試験。Vectorizeは§4のインメモリ代替)、(4)Playwright E2E(wrangler devに対して実行)を回す。(3)には、どれかの環境で`LATCH_LLM_MODE=real`のときに精度ゲートの合格記録(`eval/records/gate.json`)と今のファイルの指紋を照合する試験(`tools/eval`・本物のAIは呼ばない)を含む(09 §4)。mainマージでstagingへ自動デプロイ、**prodへのデプロイは手動承認トリガー**とする(公開前はプロダクトオーナーの操作)。

**テストの所在。** 02の対応表(#1〜#35)のうち、#34(社内クローズドテスト)はstagingでPlaywright+実機ブラウザによって証明する。Durable Objectsはvitest-pool-workersとwrangler devがローカル実行に対応しており、WebSocketを含むチャット(#25)の試験がローカルで完結する。負荷試験(#33)はstagingに対して実施し、性能目標(01 §20)のp95を計測する。

**実装確定(F8b・staging)。** stagingは`apps/worker/wrangler.jsonc`の`env.staging`区画に置く(別ファイルにしない)。wranglerの環境はバインディングとvarsを区画へ引き継がないため、区画の中ですべて宣言し直し、トップレベルとstaging区画のバインディング名の集合・varsの値・資源名が設計どおりであることを単体試験(tests/wrangler-envs.test.ts)で確かめる。資源はCloudflareのアカウントの中に`-staging`付きの新しい名前で作り、アカウント内の既存の資源には触れない: Worker=`latch-worker-staging`・D1=`latch-db-staging`・KV=`latch-revocation-staging`/`latch-pipeline-staging`・R2=`latch-icons-staging`・Vectorize=`latch-intents-staging`(1024次元・cosine・metadata index form/status/category・07 §1)・Queues=`match-events-staging`/`match-events-dlq-staging`(consumerの再試行とDLQはトップレベルと同じ)・Analytics Engine=`latch_metrics_staging`・毎分Cron。作成は何度実行しても同じ結果になるスクリプト(`pnpm --filter worker provision:staging`)で行い、資源のIDはwrangler.jsoncにコミットする(IDは単独では使えないため秘密ではない)。varsはLATCH_ENV=staging(VectorStoreはVectorize・prodの起動ガードは働かない)・LATCH_EMBEDDING_MODE=real・LATCH_LLM_MODE=stub・LATCH_PUSH_MODE=stub(負荷試験の利用者は本物の購読先を持たないため)とした。LLM real接続の工程で`LATCH_LLM_MODE=real`に改めた(2026-10-24・精度ゲートの合格記録が前提・07 §2・09 §4)。シークレット(JWT_SECRET・テスト用IdP鍵・テスト用VAPID鍵)は、ローカルの`.dev.vars`と同じコミット済みのfixturesから登録スクリプト(`pnpm --filter worker secrets:staging`)で入れる。LLMのAPIキー(`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`)とAccessの値(`ACCESS_AUD`・`ACCESS_TEAM_DOMAIN`)はオーナーが1件ずつ登録する(値は文書・記録に出さない・`docs/runbooks/staging.md` §3・§4)。画面は`VITE_DEV_AUTH=1`付きでビルドしてテスト用サインインを出し、dev専用API(§4)もstagingで有効のまま負荷試験の準備と確認に使う。workers.devのURLを使い、プレビューURLは無効(preview_urls=false)とする。stagingには試験用のデータだけを入れ、stagingのURLは文書・設定・報告書に書かず、CIでもシークレットとして持つ。F8bの時点の守りはURLを伏せるだけだった(オーナー合意 2026-10-22・社内クローズドテスト(F9・#34)の前に守りを強めるかを改めて判断するとした・12 §2の決定記録(stagingと負荷試験))。LLM real接続の工程で守りを強めた(オーナー合意 2026-10-24・issue #11・01冒頭の決定記録(LLM real接続)の4): workers.devのURLの前にCloudflare Accessを置き(方針はオーナーのメールアドレスだけ)、道具(負荷試験・後始末・CIの疎通確認)は「Service Auth」のサービストークン(ヘッダー`CF-Access-Client-Id`・`CF-Access-Client-Secret`)で通る。Worker側でもAccessの証明を検証する(§4)。Accessのチームのドメイン・AUDタグ・サービストークンの値も文書・設定・コミットに書かない。

**実装確定(F8b・CIの自動デプロイ)。** `.github/workflows/ci.yml`の`deploy-staging`ジョブが、mainへのpushで`ci`・`web-e2e`の両ジョブの成功後に動く(pull_requestでは動かない・`concurrency`で同時に1本とし後から来たものは待つ)。手順は`pnpm install --frozen-lockfile`→`VITE_DEV_AUTH=1`でのweb build→`wrangler d1 migrations apply DB --env staging --remote`(10 §1の「明示実行のみ」はCIの工程として明示的に書くことで満たす)→`wrangler deploy --env staging`→`/healthz`のスモーク確認(200でなければ失敗)である。GitHubのシークレットは`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`LATCH_STAGING_URL`(LLM real接続の工程でAccessを通る`LATCH_ACCESS_CLIENT_ID`・`LATCH_ACCESS_CLIENT_SECRET`を加えた)で、APIトークンの発行(権限はWorkers・D1・KV・R2・Queues・Vectorize・Workers AI・アカウント設定の読み取りに絞る)とGitHubへの登録はオーナーが行う。登録が済むまで動かないよう、ジョブはリポジトリ変数`STAGING_DEPLOY_ENABLED`が`true`のときだけ動く(2026-10-22時点で未登録のため未実行)。手元からは同じ手順を`pnpm --filter worker deploy:staging`(OAuthのログインを使う)で行う。資源の作成・シークレット・トークン・デプロイ・戻し方・負荷試験の実行の手順は`docs/runbooks/staging.md`に置く(11 §2・§3・10 §5)

## 7. 非機能要件(01 §20)への対応

- Intent保存 p95 0.5秒 / Candidate Retrieval p95 1秒: Workers+D1(同一ネットワーク内)で十分達成可能。D1は読み取りを `withReplication`(Sessions API)でスケールさせる余地を持つ(D-A-05)
- Parser構造化プレビュー p95 3秒: 外部LLM呼び出し(timeout 10秒・再試行なし・フォールバック)は07の仕様どおり。stubモードでは即時
- 初期LATCH判定 p95 10秒: Queues経由の非同期処理のため、この目標は「保存コミット→通知送信記録」の計測(01 §20)であり、apiの応答性能とは独立。目標の対象は保存の時点で組の相手の意思がVectorizeに反映済みの場合に限る(ほぼ同時に預けた組は合否を付けない参考値・01 §20・01冒頭の決定記録(2026-10-23・初期判定の目標))
- 通知5秒以内: 判定確定後のWeb Push送信を同一Worker内で直列実行(F7b実装確定: 通知行を書いた要求・キューのバッチの直後にwaitUntilで送り、取りこぼしは毎分Cronで回収する・§4。主キューでは通知を作ったメッセージの処理の直後に送り、バッチの待ちを1秒にした・不具合の修正工程(第2回))
- バックアップ: D1のポイントインタイムリストア(7日)を利用。VectorizeはD1の構造化データから再構築できる構造を保つ(埋め込みの再計算を許容・01 §18のモデル識別子記録)
- 可用性: Cloudflareのアナウンスに従う。計画停止はcron・キューの滞留として現れ、復帰後に消化される(冪等性がこれを許容する設計)

## 8. コスト概算(Workers Paid確定)

Workers Paid(月$5基礎料金)を前提とする。小規模(登録数百人・日次Intent作成数百件)では、リクエスト・D1読み書き・Queues・Vectorizeクエリとも無料枠または従量で月**$5〜$30程度**(チャットのDurable Objects常時接続分を含む)と見込む。LLM API(Embedding・Parser・Jev)は従量(07のコスト試算に委ねる)。アラート予算(月次LLM上限の80%)到達時の通知先・手段はリリース計画で定める。

## 9. 未決事項(本書ローカル・D-A-xx)

製品レベルの未決は01(D-02/D-03/D-05)が管理する。本書ローカルの未決は存在しない(2026-10-19にD-A-07を解消した・下記の解消記録を参照)。

(解消記録。D-A-01 Embeddingプロバイダ=07で確定: Workers AI bge-m3・1024次元・cosine。D-A-02 チャットのリアルタイム化=オーナー選定で確定。D-A-06 リント/整形ツール=Biomeに確定。D-A-03 地名データ=§4のとおり確定(ISJ+駅データ)。D-A-04 課金=Workers Paid(月$5)を確定し、アラートは月次LLM予算の80%到達と日次サマリをオーナーのメールアドレス(wrangler secretに登録)へ送信。D-A-05 D1レプリカ導入基準=(a)読み取りレイテンシ/スロットリングのアラート検知 (b)読み取り系p95が0.5秒目標を2週連続で超過 (c)読み取り1日1,000万クエリ超過、のいずれかが続いた場合にwithReplicationを導入。D-A-07 スタイリング手法=バニラCSS(グローバル)に確定(2026-10-19オーナー裁定)。正本は `apps/web/src/styles/latch.css`(`prototype/project/latch.css` を移植)とし、追加スタイルはapps/web側のCSSに記述する(§3.2・冒頭の決定記録)。欠番IDは再利用しない)

## 10. 01への反映

本書の確定により、01第19節の技術スタック選定は解消した。01本文の変更は不要である(技術スタック非依存の書き方になっているため)。
