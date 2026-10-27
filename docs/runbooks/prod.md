# prod 手順書

prodは、公開後に利用者が使う本番の環境である。stagingと同じCloudflareの部品(Worker・D1・KV・R2・Vectorize・Queues)で動かし、資源はstagingとは別に作る。公開前のデプロイはプロダクトオーナーの操作である(04 §6)。公開の前提条件は11 §1、公開の手順は11 §2、戻す判断の基準は11 §3にある。この手順書はそのための操作をまとめる。

stagingとの違いは次のとおり。

- **テスト用の鍵を入れない。**テスト用サインインの鍵(`apps/worker/tests/fixtures/`)とテスト用VAPID鍵は、prodには登録しない。登録するスクリプト(3章)はfixturesを読まず、起動ガード(`apps/worker/src/env.ts`の`assertEnvSafety`)もテスト鍵があると起動を拒む
- **テスト用サインインの画面を出さない。**画面は`VITE_DEV_AUTH`を付けずにビルドする。dev専用API(`POST /v1/dev/idp-token`)もprodでは404になる
- **デプロイは手で起動し、承認を経る。**mainへの変更で自動では載らない(5章)
- **レート制限の緩和(`LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX`)を置かない。**起動ガードが拒む

この手順書では、prodのURLを`<prodのURL>`と書く。独自ドメイン(LAT-121)が決まるまでprodは公開のURLを持たない(7章)。

コマンドはすべてリポジトリのいちばん上のフォルダ(`latch/`)で実行する。

## 1. 前提

- **Cloudflareのアカウントとwranglerのログイン**: stagingと同じアカウントを使う。ログインの手順は`docs/runbooks/staging.md` 1章と同じ(`pnpm --filter worker exec wrangler whoami`でログイン中のアカウントを確かめる)
- **wranglerの環境名**: prodは`apps/worker/wrangler.jsonc`の`env.production`区画にあり、コマンドでは`--env production`と書く。Workerの名前は`latch-worker-production`になる。区画の名前は起動ガードが見る`LATCH_ENV=production`にそろえてある
- `pnpm install --frozen-lockfile`を済ませておく

## 2. 資源の作成

prodで使う資源は次のとおり。すべて名前が`-production`(Analytics Engineは`_production`)で終わり、stagingの資源には触れない。

| 種類 | 名前 | 何のためか |
|---|---|---|
| Worker | `latch-worker-production` | アプリ本体(APIと画面) |
| D1 | `latch-db-production` | データベース |
| KV | `latch-revocation-production`・`latch-pipeline-production` | 小さな値の保存場所(ログアウトの記録・予算の数え) |
| R2 | `latch-icons-production` | アイコン画像の置き場 |
| Vectorize | `latch-intents-production` | 意思の意味の近さで探すための索引(1024次元・cosine・メタデータ索引 form・status・category) |
| Queues | `match-events-production`・`match-events-dlq-production` | マッチング処理の順番待ちの列(dlqは失敗した分の置き場) |
| Analytics Engine | `latch_metrics_production` | 計測値の記録(初回のデプロイで自動で作られる) |
| Rate Limiting | namespace_id `1003` | 1ユーザーあたり60回/分の上限(04 §5。stagingは1002) |

作成は次の1行で行う。

```bash
pnpm --filter worker provision:prod -- --write
```

(無い資源だけを作り、既にあるものは読み出すだけにする。最後にD1とKVのIDを表示し、`apps/worker/wrangler.jsonc`のproduction区画の仮の値(0の並び)を実際のIDへ書き換える)

- 作らずに予定だけを見たいときは`-- --dry-run`を付ける
- 何度実行しても同じ結果になる。途中で止まったら同じコマンドをもう一度実行する
- 書き込まれたIDは秘密ではないのでコミットする(アカウントIDとURLはコミットしない)。IDが仮の値のままではデプロイできない

## 3. シークレットの登録

シークレットは、設定ファイルに書かずにCloudflareへ預ける秘密の値である。prodで要るものは次のとおり。

| 名前 | 中身 | 登録のしかた |
|---|---|---|
| JWT_SECRET | ログインの合言葉(32バイトの乱数) | 3.1のスクリプトが作る |
| VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY | Web Pushの本番の鍵の組(LAT-87) | 3.1のスクリプトがその場で作る |
| VAPID_SUBJECT | 通知の送り手の連絡先(`mailto:`で始まる実在の宛先) | 3.1のスクリプトへ環境変数で渡す |
| ANTHROPIC_API_KEY・TYPESAFE_API_KEY | LLMのAPIキー | 3.2(`LATCH_LLM_MODE=real`にするときだけ必須) |
| GOOGLE_CLIENT_ID・APPLE_CLIENT_ID | 本番IdPの識別子 | 3.3(本番IdPの接続・LAT-90) |

**`pnpm --filter worker secrets:staging`はprodに使わない。**stagingの登録スクリプトはテスト用の鍵を登録する。prodの登録は3.1のスクリプトか、1件ずつの`wrangler secret put … --env production`だけで行う。

### 3.1 合言葉とWeb Pushの鍵

```bash
LATCH_VAPID_SUBJECT=mailto:<連絡先> pnpm --filter worker secrets:prod
```

(未登録のものだけを新しく作って登録し、「登録: 名前」と表示する。値は画面に出ない)

- 登録済みの名前は「登録済み(変えない)」と出て、上書きしない。JWT_SECRETを変えると全員のログインが切れ、VAPID鍵を変えると全員の通知の購読が無効になるためである
- `<連絡先>`が`example.com`・`.invalid`などの仮の宛先だと、登録前に止まる(prodの起動ガードが拒むため)
- 予定だけを見たいときは`-- --dry-run`を付ける(登録済みかを調べるため、Cloudflareへ読み取りの問い合わせを1回送る)
- Workerがまだ無いときは、wranglerが空のWorkerを作ってから登録する
- どうしても鍵を作り直すとき(漏えいなど)は、`pnpm --filter worker exec wrangler secret delete <名前> --env production`で消してからもう一度実行する。VAPID鍵は2件を組で消す

### 3.2 LLMのAPIキー(LATCH_LLM_MODE=realにするとき)

prodのParser/JevとEmbeddingのモードは、LAT-91でオーナーが決めるまで暫定で`stub`にしてある(公開の前提はreal固定・11 §1)。realにするときは、先にAPIキーの2件を登録してから`wrangler.jsonc`のproduction区画のvarsを変えてデプロイする。順番を逆にすると、キーが無いためWorkerが起動を拒む。

```bash
pnpm --filter worker exec wrangler secret put ANTHROPIC_API_KEY --env production
pnpm --filter worker exec wrangler secret put TYPESAFE_API_KEY --env production
```

(名前ごとに値の入力を求められ、入力するとprodのWorkerへ保存される)

- stagingと同じキーを使うか、prod専用に発行するかはLAT-91で決める

### 3.3 本番IdP(LAT-90)

本番のGoogle/Appleのサインインの接続のしかた(Google CloudのOAuthクライアント・Apple DeveloperのServices ID・戻り先の登録)は`docs/runbooks/idp.md`に置く(LAT-90)。識別子は2か所に同じ値を入れる: Workerの`GOOGLE_CLIENT_ID`・`APPLE_CLIENT_ID`(`wrangler secret put … --env production`)と、画面のビルドの`VITE_GOOGLE_CLIENT_ID`・`VITE_APPLE_CLIENT_ID`(GitHubの環境`production`の変数(vars)。手元から`deploy:prod`で載せるときはシェルの環境変数)。画面は値の無いIdPのボタンを出さない。6章の点検は、Worker側の値が無いあいだ「注意」として表示する(起動は妨げない)。

## 4. APIトークンとGitHubの登録

GitHubからprodへ載せるには、stagingとは**別の**CloudflareのAPIトークン(操作できる範囲を絞った合鍵)と、GitHubの「環境(environment)」の承認が要る。

### 4.1 APIトークンの発行

`docs/runbooks/staging.md` 4.1と同じ画面・同じ権限で、prod用のトークンをもう1つ発行する(名前は例えば`latch-prod-deploy`)。stagingのトークンを使い回さない(片方が漏れたときに止める範囲を分けるため)。

### 4.2 GitHubの環境productionと承認者

GitHubのリポジトリの Settings → Environments → New environment で、名前`production`の環境を作り、次を設定する。

| 設定 | 値 | 意味 |
|---|---|---|
| Required reviewers | オーナー | デプロイの前に、この人の承認を待つ |
| Deployment branches and tags | Selected branches → `main` | main以外からは載せない |

続いて、同じ環境の画面の Environment secrets に次の2件を登録する(リポジトリ全体のシークレットではなく、環境productionのシークレットにする)。

| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN_PROD` | 4.1で控えたprod用のトークン |
| `LATCH_PROD_URL` | `<prodのURL>`(独自ドメインが決まってから。`https://`から始め、末尾の`/`は付けない) |

- `CLOUDFLARE_ACCOUNT_ID`はstagingと同じリポジトリのシークレットを使う
- トークンの名前をstagingの`CLOUDFLARE_API_TOKEN`と分けているのは、環境のシークレットが未登録のときにstagingのトークンで動いてしまわないようにするためである(名前が違えば、未登録のときは空になり失敗する)

## 5. デプロイ

デプロイは、手元のプログラムをCloudflareへ載せて動かすことである。どちらの方法も同じ順で進み、途中で失敗したらそこで止まる。

1. varsとシークレットの名前を点検する(6章と同じ。テスト鍵が残っている・必須のものが無いと止まる)
2. 画面をビルドする(`VITE_DEV_AUTH`を付けない。テスト用サインインの画面は出ない)
3. D1のマイグレーション(データベースの形を新しい版へ合わせる作業)を適用する
4. Workerを載せる
5. 疎通確認(`GET /healthz`が200・`POST /v1/dev/idp-token`が404)を行う。`<prodのURL>`がまだ無いときは飛ばす

### 5.1 GitHub Actionsから(手動の起動と承認)

GitHubのリポジトリの Actions → CI → Run workflow で、ブランチに`main`を選んで実行する。いつもの試験(`ci`・`web-e2e`)が通ると、`deploy-prod`の工程が承認待ちになる。承認者(4.2)が Review deployments → Approve すると載る。

- mainへの変更で自動では動かない。手で起動したときだけ動く
- 同時に2本は動かず、後から来たものは前のものの終わりを待つ
- 精度ゲートの照合は、いつもの試験(`ci`の単体試験)の中で行われる

### 5.2 手元から

```bash
pnpm --filter worker deploy:prod
```

(精度ゲートの照合と6章の点検を行ってから、上の2〜4を順に実行する。`LATCH_PROD_URL=<prodのURL>`を前に付けると5の疎通確認も行う。最後に「prodへのデプロイが完了しました」と出れば成功)

- `VITE_DEV_AUTH`が設定されたシェルで実行すると、何もせずに止まる
- 新しいマイグレーションが無いときは「No migrations to apply!」と出て先へ進む

### 5.3 載ったことを確かめる

- 疎通確認だけをやり直す: `LATCH_PROD_URL=<prodのURL> node apps/worker/scripts/prod-smoke.mjs`(2つの確認を行い、外れたら「NG: …」と出て失敗で終わる)
- 動いている版を見る: `pnpm --filter worker exec wrangler deployments status --env production`
- 動作の記録を見る: `pnpm --filter worker exec wrangler tail --env production --format json`(Ctrl+Cで止める。利用者の要求が流れるため、必要なときだけ短く使う)
- 11 §2の手順3・4(新規登録からチャットまでのスモーク確認と、Analytics Engine・Workers Logsの確認)は公開の当日に行う

## 6. テスト鍵が残っていないことの確認(11 §1・LAT-122)

11 §1の「prodシークレットにテスト鍵が残っていない(テスト用IdP鍵・テスト用VAPID鍵。起動ガード確認)」は、次の1行で確かめる。読み取りだけで、何も変えない。

```bash
LATCH_PROD_URL=<prodのURL> pnpm --filter worker check:prod-secrets
```

(登録済みのシークレットの名前を並べ、次の点を調べる。問題があれば「NG: …」と出て失敗で終わる)

- **名前の点検**: `wrangler secret list --env production`の名前と、`wrangler.jsonc`のproduction区画のvarsを照らし合わせる。テスト用IdP鍵(`LATCH_TEST_IDP_JWKS`・`LATCH_TEST_IDP_PRIVATE_JWKS`)・`TEST_QUEUES_DISABLED`・`LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX`があればNG、3章の必須のシークレットが無ければNG。判定は`apps/worker/src/ops/prod-checks.ts`にあり、workerの単体試験で起動ガードと食い違わないことを確かめている
- **起動ガードの確認**: `GET /healthz`が200であること。起動ガードはテスト用IdP鍵・テスト用VAPID鍵・仮の送信者があると起動を拒み、すべての要求に500を返す。シークレットの値はwranglerからも読めないため、テスト用VAPID鍵が入っていないことはこの200で確かめる
- **dev専用APIの確認**: `POST /v1/dev/idp-token`が404であること

`<prodのURL>`がまだ無いときは、`LATCH_PROD_URL=`を付けずに実行すると名前の点検だけを行う。確認した日と結果(OKの行)は、LAT-122に記録する。

## 7. 独自ドメイン(LAT-121)

独自ドメインが決まるまで、prodは公開のURLを持たない(`workers_dev`も`preview_urls`も`false`)。決まったら次を行う。

1. ドメインをCloudflareのアカウントに追加する(DNSをCloudflareで管理する)
2. `apps/worker/wrangler.jsonc`のproduction区画のコメントにある`routes`を有効にし、`<ドメイン>`を実際のドメインに書き換えてコミットする(`custom_domain: true`で、デプロイ時にDNSの記録と証明書が作られる)
3. 5章でデプロイし、4.2の`LATCH_PROD_URL`を登録して5.3の疎通確認を行う

- ドメインが決まると、規約の問い合わせ先(LAT-85)・本番IdPのリダイレクト先(LAT-90)・VAPID_SUBJECT(LAT-87)も決まる
- `tests/wrangler-envs.test.ts`はprodの`workers_dev`が`false`であることを確かめている。routesを足すときは試験にもroutesの確認を加える

## 8. 戻し方

新しい版に問題があったときに、前の版へ戻す手順である。戻す判断の基準は11 §3にある。

### 8.1 Workerを前の版へ戻す

```bash
pnpm --filter worker exec wrangler deployments list --env production
```

(これまでの版が古い順に並ぶ。各版のIDと作られた時刻が分かる)

```bash
pnpm --filter worker exec wrangler rollback --env production --message "戻す理由"
```

(直前の版へ戻す。特定の版へ戻すときは`rollback <版のID> --env production`と書く。確認を聞かれたら`y`)

戻した後は5.3の疎通確認を行う。直したものを載せ直すときは、5章のデプロイをもう一度行えば最新の版になる。

- 戻すのはWorker(プログラムと画面)だけで、シークレットとデータベースの中身は戻らない

### 8.2 データベースの形を戻す

マイグレーションで加えた変更を取り消す必要があるときだけ行う。取り消しのSQLは`apps/worker/migrations_rollback/`に番号ごとにある(説明は同じフォルダの`README.md`)。**新しい番号から1つずつ**実行する(11 §3)。

```bash
pnpm --filter worker exec wrangler d1 execute DB --env production --remote --file migrations_rollback/<番号>_rollback.sql
```

(その番号で加えた変更を取り消す。番号によってはデータが消えるため、必要なときだけ行う)

- 取り消しのSQLは、wranglerの適用記録(D1の`d1_migrations`表の行)を消さない。取り消した番号をもう一度適用し直す手順は、戻し方のリハーサル(11 §1・§3・LAT-88)で決めてここに書き足す
- Workerはデータベースの形に合わせて動くため、形を戻したら8.1でWorkerも対応する版へ戻す

### 8.3 データを戻す

データの欠損や不正が起きたときは、D1のポイントインタイムリストア(過去の時点への巻き戻し・7日以内)を使う(11 §3)。

```bash
pnpm --filter worker exec wrangler d1 time-travel info DB --env production --timestamp <ISO 8601の時刻>
```

(その時刻に戻すための目印(bookmark)を表示する。この段階では何も変わらない)

```bash
pnpm --filter worker exec wrangler d1 time-travel restore DB --env production --bookmark <目印>
```

(データベース全体をその時点へ戻す。それより後の書き込みはすべて失われる)

- Vectorizeの索引はD1から作り直す(04 §7)。手順は戻し方のリハーサル(LAT-88)で決める
