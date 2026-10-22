# F8b stagingの構築と負荷試験 設計書

- 作成日: 2026-10-22
- 対象: docs/12 §2 のF8「PWAと仕上げ」を2分割したうちの F8b(stagingの構築とデプロイ手順・k6の負荷試験(10 §5)・計測と報告(02 #33))
- 正本: docs/01 §20(性能目標)/ docs/02 §4 #33 / docs/04 §6(環境とCI/CD)/ docs/06 §7(観測)/ docs/10 §1・§5 / docs/11 §2・§3
- 前段: docs/superpowers/specs/2026-10-21-f8a-pwa-finish-design.md(F8の2分割)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提と範囲

### 0.1 ゲート

- **#33**(性能目標(p95)を満たす): stagingに対するk6の負荷試験で01 §20の目標値を計測し、`docs/reports/f8b-load-test.md`に記録する
- Parser/Jevはstubで測るため、Parserと初期判定のp95は「stubでの値」となる。#33は「stubでの計測済み・LLM real接続後の測り直し待ち」と記録し(#32の「実機確認待ち」と同じ扱い)、LLM real接続の工程(F9前の独立工程)で同じシナリオと集計を流し直して確定させる

### 0.2 オーナー合意(2026-10-22)

| # | 論点 | 合意 |
|---|---|---|
| 1 | stagingを作るCloudflareアカウント | このPCのwranglerがOAuthでログイン中のアカウントを使う。資源は`-staging`付きの新しい名前で作り、アカウント内の既存の資源には触れない |
| 2 | 負荷試験でのParser/Jev(real接続が未実装) | stubで測り、LLM real接続の工程で測り直す。Embeddingは実装済みのreal(Workers AI)で測る |
| 3 | stagingへのデプロイ | CIの自動デプロイまで作る(04 §6の「mainマージでstaging自動」)。APIトークンの発行とGitHubへの登録はオーナーが行い、手順書を用意する |
| 4 | テスト用サインインが開いたstagingの守り | URLを伏せるだけとし、stagingには試験用のデータしか入れない。社内クローズドテスト(F9・#34)の前に守りを強めるかをあらためて判断する |
| 5 | 内部の処理時間の測り方 | 案A: 応答で見える時間(Intent保存・Parser・チャット)はk6が測り、内部の時間(Candidate Retrieval・初期判定・通知)はD1に残る記録から試験後に集計する |

#2・#5の「#33をstubでの計測済みとして測り直し待ちにする」扱いは、決定内容/根拠/影響の形で12 §2と01冒頭の決定記録に残す。

### 0.3 F8bで行わないこと

- prodの構築・prodへの手動デプロイ(11 §2)・本番VAPID鍵・カスタムドメイン(F10)
- Cloudflare Accessによるstagingの保護(合意#4)
- レート制限の実装(後続フェーズで計上済み)。10 §5の「負荷試験ではレート制限を緩和する」は、未実装のため今回は該当しない旨を報告書に書く
- 縮退試験(10 §6・F9)
- 目標を外れた項目の修正。外れた項目はGitHubのissueに登録して報告書に記録し、直すのは別の工程とする

## 1. staging環境の構成

### 1.1 設定の置き方

`apps/worker/wrangler.jsonc`に`env.staging`の区画を足す(別ファイルにしない。ローカルとの違いを1か所で見比べられ、F10で`env.production`を同じ形で足せる)。wranglerの環境では、バインディング(D1・KV・R2・Vectorize・Queues・Analytics Engine・DO・AI)と`vars`は区画へ引き継がれないため、区画の中ですべて宣言し直す。書き漏れを防ぐため、トップレベルとstaging区画のバインディング名の集合が一致することを確かめる単体試験を足す(wrangler.jsoncをJSONCとして読む)。

### 1.2 資源

すべて新規に作る。

| 種類 | 名前 | 備考 |
|---|---|---|
| Worker | `latch-worker-staging` | `env.staging`の既定の命名(`<name>-staging`) |
| D1 | `latch-db-staging` | binding=DB・migrations_dirは共通 |
| KV | `latch-revocation-staging`・`latch-pipeline-staging` | binding=REVOCATION_KV・PIPELINE_KV |
| R2 | `latch-icons-staging` | binding=ICONS |
| Vectorize | `latch-intents-staging` | 1024次元・cosine・metadata-index form,status,category(07 §1) |
| Queues | `match-events-staging`・`match-events-dlq-staging` | consumerの設定(max_retries・DLQ)はトップレベルと同じ |
| Analytics Engine | `latch_metrics_staging` | binding=PIPELINE_AX |
| Durable Objects | CHAT_DO(ChatRoomDO) | Workerごとに分かれる |
| Workers AI | binding=AI | |

作成は何度実行しても同じ結果になる手順スクリプト(`apps/worker/scripts/provision-staging.mjs`)にまとめる。既にある資源は作らずにIDを読み出し、作った/読み出したIDを表示する。IDはwrangler.jsoncのstaging区画へ書いてコミットする(IDは秘密ではない)。初回はこのPCのログインで実行する。

### 1.3 動き方の設定(vars)

| 変数 | 値 | 理由 |
|---|---|---|
| LATCH_ENV | `staging` | VectorStoreはVectorizeを使う(04 §4)。prodの起動ガードは働かない |
| LATCH_EMBEDDING_MODE | `real` | 合意#2 |
| LATCH_LLM_MODE | `stub` | 合意#2 |
| LATCH_PUSH_MODE | `stub` | k6は本物の購読先を持てない。送信の記録(push_state・push_attempted_at)までは行われるため、通知の時間はそこまでで測る |

### 1.4 シークレット

`wrangler secret put --env staging`で登録する(手順書に記す)。

- JWT_SECRET: ランダムに生成した32字以上の値
- LATCH_TEST_IDP_JWKS・LATCH_TEST_IDP_PRIVATE_JWKS: コミット済みのテスト用IdP鍵(`tests/fixtures/`)。dev専用サインイン(POST /v1/dev/idp-token)を有効にするため
- VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECT: コミット済みのテスト用VAPID鍵(公開鍵APIと購読APIを動かすため)

値の作り方は、ローカルの`.dev.vars`を作る`scripts/prepare-dev-vars.mjs`と同じ元(fixtures)から取り、手で写さない。

### 1.5 画面とdev専用API

- 画面は`VITE_DEV_AUTH=1`付きでビルドして載せる(テスト用サインインの画面が出る。#34のクローズドテストでもそのまま使う)
- dev専用API(観測・backdate)はstagingでも有効のまま(LATCH_ENV≠productionかつテスト鍵あり)。負荷試験の準備と確認に使う

## 2. デプロイ

### 2.1 CIの自動デプロイ

`.github/workflows/ci.yml`に`deploy-staging`ジョブを足す。

- 条件: mainへのpushで、既存の`ci`・`web-e2e`ジョブが成功したときだけ(`needs`)。pull_requestでは動かない
- 同時実行の抑止: `concurrency`でstagingのデプロイを1本に揃える(後から来たものは待つ)
- 手順:
  1. `pnpm install --frozen-lockfile`
  2. `VITE_DEV_AUTH=1 pnpm --filter web build`
  3. `wrangler d1 migrations apply DB --env staging --remote`(10 §1の「明示実行のみ」は、CIの工程として明示的に書くことで満たす)
  4. `wrangler deploy --env staging`
  5. `GET /healthz`のスモーク確認(200でなければジョブを失敗させる)
- GitHubのシークレット: `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`・`LATCH_STAGING_URL`
- URLを伏せる(合意#4)ための扱い: リポジトリは公開で、Actionsの記録も誰でも読める。stagingのURL(`latch-worker-staging.<アカウントのサブドメイン>.workers.dev`)は文書・wrangler.jsonc・報告書に書かず、CIでは変数ではなくシークレットとして持つ(GitHubはシークレットの値を記録の中で伏せ字にするため、`wrangler deploy`が表示するURLも伏せられる)。資源のIDは単独では使えないためwrangler.jsoncにコミットしてよい

### 2.2 手元からのデプロイ

CIと同じ手順2〜5を`pnpm --filter worker deploy:staging`で実行できるようにする(トークンの登録前と、CIが使えないときの代替)。手元ではOAuthのログインを使う。

### 2.3 戻し方

`wrangler rollback --env staging`で直前の版へ戻す。D1は戻す手順(`apps/worker/migrations_rollback/`)を新しい番号から`wrangler d1 execute --env staging --remote --file`で明示実行する(11 §3)。手順書に記し、11 §3のロールバックのリハーサル(F10)の予行として使えるようにする。

### 2.4 手順書

`docs/runbooks/staging.md`を新しく作り、00の索引に載せる。内容: 前提(アカウント・wranglerのログイン)/資源の作成(provision-staging)/シークレットの登録/APIトークンの発行(必要な権限: Workers Scripts・D1・Workers KV・Workers R2・Queues・Vectorize・Workers AI・Account Settings(読み取り)の範囲に絞る)とGitHubへの登録/デプロイ(自動・手元)/戻し方/k6の入れ方と負荷試験の実行(§3・§4)。

## 3. 負荷試験(k6)

### 3.1 置き場所と実行

- k6のスクリプトはリポジトリ直下の`load/`に置く(k6はNode.jsではなく単体のプログラムで動くため、pnpmのワークスペースに入れない)。共通部(サインイン・意思の作成・後始末)は`load/lib/`に置く
- 実行はこのPCからstagingへ向けて行う。宛先は環境変数`LATCH_LOAD_BASE_URL`で渡す。k6の入れ方は手順書に記す(pnpmの依存には入れない)
- WebSocketはk6の`k6/websockets`を使う(10 §5の「WebSocket対応は実施時に再確認」はこれで解消し、D-E-01の記録に添える)

### 3.2 試験用の利用者と後始末

- テスト用サインイン(POST /v1/dev/idp-token→POST /v1/auth/token)で、subjectが`load-<実行の印>-<連番>`の利用者を作り、登録と同意を済ませる
- 実行の印は実行ごとに変える(時刻から作る)。集計はこの印で絞る
- 各シナリオの前後に後始末を行う: subjectが`load-`で始まる利用者のactiveの意思をexpiredへ倒す(`wrangler d1 execute --env staging --remote`。ローカルの`clean-e2e-data.mjs`と同じ考え方で、前の回の意思が候補探しに混ざらないようにする)

### 3.3 シナリオ(10 §5の(a)〜(d))

| | 内容 | 規模 | k6が直接測るもの |
|---|---|---|---|
| (a) 作成の集中 | 読み解き(parse)→下書き保存→有効化を繰り返す | 合計100件/分を5分間(100人×5件。1人のActive Intent上限5件に収まる) | Intent保存(下書き保存・有効化)のp95・Parserのp95 |
| (b) 作成〜提案の一連 | stubで提案が組まれる2人組の意思(worker E2Eで使っている組み立て方を流用)を有効化し、提案の通知が届くまで待つ | 2人組×30組を時間をずらして投入 | (内部の時間は§4で集計) |
| (c) チャット同時接続 | 事前に1対1を50組成立させ、100人が同時にWebSocketで接続し、一定間隔で送り合う | 100接続を5分間 | 送信から相手への到着までのp95・接続の失敗率 |
| (d) 通知の一斉送信 | (b)と同じ操作を、全組の有効化を1度に揃えて行う | 60件前後の提案の通知が同時に発生 | (内部の時間は§4で集計) |

- (d)は(b)の「同時に揃える版」とし、別の仕組みは作らない
- (c)の事前準備は通常のAPI(意思の作成→提案→2人とも参加)で行う。近道のAPIは足さない
- 閾値(k6のthresholds)は01 §20の目標値を設定し、外れたときはk6の終了コードで分かるようにする(合否の正本は§4の報告書)

### 3.4 費用の見込み

Workers AIのEmbeddingは1回の全シナリオで数百回程度、Queues・DO・D1の利用も少量で、無料枠かそれに近い範囲に収まる見込み。実施後にCloudflareの利用量を報告書に添える。

## 4. 集計と報告

### 4.1 集計スクリプト

`load/report.mjs`(Node.jsで動く)が、試験の後にstagingのD1へ読み取りの問い合わせ(`wrangler d1 execute --env staging --remote --json`)を送り、実行の印に一致する利用者の分だけを集めてp95を計算する。k6の結果(`--summary-export`のJSON)も読み、報告書の表を出力する。

| 01 §20の目標 | 測り方 |
|---|---|
| Intent保存 p95 0.5秒 | k6が測った応答時間((a)) |
| Parser p95 3秒 | k6が測った応答時間((a)・stubでの値) |
| Candidate Retrieval p95 1秒 | match_events.payloadに足す`retrieval_ms`((b)(d)) |
| 初期判定 p95 10秒 | 有効化のイベント行(match_events)の作成時刻→その意思の利用者への提案の通知のpush_attempted_at((b)(d)・Jevはstubでの値。01 §20の「active化の保存コミットから通知送信記録まで」) |
| 通知 判定後5秒以内 | 提案の通知行のcreated_at→push_attempted_at((b)(d)) |
| (参考)チャット | k6が測った送信から到着までのp95・接続の失敗率((c)) |

有効化のイベント行が有効化の保存と同じ処理で書かれていることは、実装計画の段階でコードを読んで確かめる。同じでなければ起点の取り方を計画で決め直す。

### 4.2 コードの変更(Candidate Retrievalの所要時間)

Layer 2 Candidate Retrievalの所要時間(ミリ秒)を`retrieval_ms`として`match_events.payload`とAnalytics Engineのdata pointへ記録する(06 §7の観測項目に足す)。時間はClockではなく処理時間の計測(`performance.now()`または`Date.now()`の差)で取る。D1の形は変わらないため、マイグレーションは要らない。単体試験で記録されることを確かめる。

### 4.3 報告書

`docs/reports/f8b-load-test.md`に記す: 実施日/stagingの版(デプロイのversion。URLは書かない・§2.1)/k6の版/シナリオごとの件数/p95の一覧と目標との比較/「stubでの値」の注記(Parser・初期判定)/レート制限が未実装である旨/Cloudflareの利用量/外れた項目のissue番号。

## 5. 試験

- 単体: staging区画のバインディング名がトップレベルと一致すること(§1.1)/`retrieval_ms`が記録されること(§4.2)/集計スクリプトのp95の計算(`load/report.mjs`の計算部を純関数に分けてvitestで確かめる)
- 既存の単体・統合・E2Eがすべて緑のままであること
- staging: デプロイ後の`/healthz`(CI)と、手順書どおりのテスト用サインイン→意思の作成→提案の疎通を1回行う
- 負荷試験そのもの(§3)

## 6. 文書の更新

変更した文書は版数を上げ、冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える(00 §3)。

- 04 §6: stagingの構成(env.staging・資源・vars)とCIの自動デプロイの実装
- 06 §7: `retrieval_ms`
- 10 §1: stagingの値(LATCH_ENV・各MODE)/§5: 負荷試験の実施方法(シナリオの規模・集計の方法・k6/websockets・レート制限の扱い)・D-E-01の記録
- 11 §2・§3: stagingのデプロイと戻し方の手順書への参照
- 02 §4 #33: 合格証拠の置き場と「stubでの計測済み・測り直し待ち」の注記
- 12 §2: F8bの完了と決定記録(#33の扱い)/01冒頭の決定記録
- 00: 索引に`docs/runbooks/staging.md`と`docs/reports/f8b-load-test.md`を追加
- AGENTS.md: 現在の状態
