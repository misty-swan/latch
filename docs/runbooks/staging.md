# staging 手順書

stagingは、本番と同じCloudflareの部品(Worker・D1・KV・R2・Vectorize・Queues)で動かす試験用の環境である。本番の利用者は来ない。負荷試験(02 §4 #33)と社内クローズドテスト(#34)の場所として使う。設計はF8b設計(`docs/superpowers/specs/2026-10-22-f8b-staging-load-test-design.md` §1・§2)。

この手順書では、stagingのURLを`<stagingのURL>`と書く。実際のURLは文書・設定ファイル・コミットに残さない(設計 §2.1)。URLは手元の作業メモか、GitHubのシークレット`LATCH_STAGING_URL`にだけ置く。

コマンドはすべてリポジトリのいちばん上のフォルダ(`latch/`)で実行する。

## 1. 前提

- **Cloudflareのアカウント**: stagingの資源はこのアカウントの中に作る。既存の資源(名前が`-staging`で終わらないもの)には触れない
- **wranglerのログイン**: wranglerはCloudflareを操作するコマンドである。手元のPCで一度だけ次を実行してブラウザでログインする
  ```bash
  pnpm --filter worker exec wrangler login
  ```
  (ブラウザが開き、許可するとこのPCからアカウントを操作できるようになる)
- ログインできているかは次で確かめる
  ```bash
  pnpm --filter worker exec wrangler whoami
  ```
  (ログイン中のメールアドレスとアカウント名が表示される)
- `pnpm install --frozen-lockfile` を済ませておく(必要な部品=依存パッケージを入れる)

## 2. 資源の作成

stagingで使う資源は次のとおり。すべて名前が`-staging`で終わる。

| 種類 | 名前 | 何のためか |
|---|---|---|
| Worker | `latch-worker-staging` | アプリ本体(APIと画面) |
| D1 | `latch-db-staging` | データベース |
| KV | `latch-revocation-staging`・`latch-pipeline-staging` | 小さな値の保存場所(ログアウトの記録・予算の数え) |
| R2 | `latch-icons-staging` | アイコン画像の置き場 |
| Vectorize | `latch-intents-staging` | 意思の意味の近さで探すための索引(1024次元・cosine・メタデータ索引 form・status・category) |
| Queues | `match-events-staging`・`match-events-dlq-staging` | マッチング処理の順番待ちの列(dlqは失敗した分の置き場) |
| Analytics Engine | `latch_metrics_staging` | 計測値の記録(初回のデプロイで自動で作られる) |

作成は次の1行で行う。

```bash
pnpm --filter worker provision:staging -- --write
```

(無い資源だけを作り、既にあるものは読み出すだけにする。最後にD1とKVのIDを表示し、`apps/worker/wrangler.jsonc`のstaging区画へ書き込む)

- 何度実行しても同じ結果になる。2回目以降は「既存: …」と並び、同じIDが表示される
- 作らずに予定だけを見たいときは`-- --dry-run`を付ける
- 書き込まれたIDは秘密ではないのでコミットする(アカウントIDとURLはコミットしない)
- Cloudflare側の一時的な誤り(例: `An unknown error has occurred [code: 10013]`)で途中止まりしたら、そのまま同じコマンドをもう一度実行する。作れた分は飛ばされ、残りだけが作られる

## 3. シークレットの登録

シークレットは、設定ファイルに書かずにCloudflareへ預ける秘密の値である。stagingでは次の6件を使う。

| 名前 | 中身 |
|---|---|
| JWT_SECRET | ログインの合言葉(実行のたびに新しく作る) |
| LATCH_TEST_IDP_JWKS・LATCH_TEST_IDP_PRIVATE_JWKS | テスト用サインインの鍵(`apps/worker/tests/fixtures/`のテスト専用の値) |
| VAPID_PUBLIC_KEY・VAPID_PRIVATE_KEY・VAPID_SUBJECT | Web Pushのテスト用の鍵 |

```bash
pnpm --filter worker secrets:staging
```

(6件を順に登録し、「登録: 名前」と表示する。値は画面に出ない)

- Workerがまだ無いときは、wranglerが空のWorkerを作ってから登録する
- 登録済みの名前は`pnpm --filter worker exec wrangler secret list --env staging`で確かめられる(値は見えない)
- もう一度実行するとJWT_SECRETが新しい値に変わる。そのときは、それまでのログインが切れる

## 4. APIトークンとGitHubの登録

GitHub(コードの置き場)からの自動デプロイには、Cloudflareの**APIトークン**(操作できる範囲を絞った合鍵)が要る。手元のログインとは別に発行する。

### 4.1 APIトークンの発行

Cloudflareのダッシュボード → 右上のアカウントのメニュー → My Profile → API Tokens → Create Token → Create Custom Token で、次の権限だけを付ける。

| 区分 | 権限 | 範囲 |
|---|---|---|
| Account | Workers Scripts | 編集(Edit) |
| Account | D1 | 編集(Edit) |
| Account | Workers KV Storage | 編集(Edit) |
| Account | Workers R2 Storage | 編集(Edit) |
| Account | Queues | 編集(Edit) |
| Account | Vectorize | 編集(Edit) |
| Account | Workers AI | 読み取り(Read) |
| Account | Account Settings | 読み取り(Read) |

- Account Resources は、このアカウントだけを選ぶ
- 作成後に一度だけ表示されるトークンの値を控える(後から見直せない)

### 4.2 GitHubへの登録

GitHubのリポジトリの Settings → Secrets and variables → Actions → Secrets で、次の3件を「New repository secret」から登録する。

| 名前 | 値 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 4.1で控えたトークン |
| `CLOUDFLARE_ACCOUNT_ID` | CloudflareのアカウントID(`wrangler whoami`の表に出る32字) |
| `LATCH_STAGING_URL` | `<stagingのURL>`(`https://`から始まる。末尾の`/`は不要) |

URLもシークレットとして持つ。GitHubはシークレットの値を記録の中で伏せ字にするため、デプロイの記録にURLが残らない。

## 5. デプロイ

デプロイは、手元のプログラムをCloudflareへ載せて動かすことである。どちらの方法も同じ順で進み、途中で失敗したらそこで止まる。

1. 画面をビルドする(`VITE_DEV_AUTH=1`付き。テスト用サインインの画面が出る)
2. D1のマイグレーション(データベースの形を新しい版へ合わせる作業)を適用する
3. Workerを載せる
4. 疎通確認(`GET /healthz`と`POST /v1/dev/idp-token`が200を返すか)を行う

### 5.1 自動(GitHub Actions)

mainへの変更が入り、既存の試験(`ci`・`web-e2e`)が通ると、`deploy-staging`の工程がstagingへ載せる。4.2の登録を済ませてから、GitHubの Settings → Secrets and variables → Actions → Variables でリポジトリ変数`STAGING_DEPLOY_ENABLED`を`true`にすると動き始める(登録前に工程が失敗しないよう、変数で止めてある)。同時に2本は動かず、後から来たものは前のものの終わりを待つ。

### 5.2 手元から

```bash
LATCH_STAGING_URL=<stagingのURL> pnpm --filter worker deploy:staging
```

(1〜4を順に実行する。最後に「OK: GET /healthz」「OK: POST /v1/dev/idp-token」「stagingへのデプロイが完了しました」と出れば成功。表示の中のURLは`<url伏せ>`に置き換わる)

- トークンの登録前や、自動の工程が使えないときに使う。手元ではwranglerのログインを使う
- 新しいマイグレーションが無いときは「No migrations to apply!」と出て先へ進む

### 5.3 載ったことを確かめる

- 疎通確認だけをやり直す: `LATCH_STAGING_URL=<stagingのURL> node apps/worker/scripts/staging-smoke.mjs`(2つの確認を行い、外れたら「NG: …」と出て失敗で終わる)
- 動いている版を見る: `pnpm --filter worker exec wrangler deployments status --env staging`(今の版のIDと作られた時刻が出る)
- 動作の記録を見る: `pnpm --filter worker exec wrangler tail --env staging --format json`(stagingで起きた処理の記録が流れる。Ctrl+Cで止める)
- データベースを見る(読むだけ): `pnpm --filter worker exec wrangler d1 execute DB --env staging --remote --command "SELECT event_type, status FROM match_events ORDER BY created_at DESC LIMIT 3"`(直近のマッチング処理の状態が出る)

## 6. 戻し方

新しい版に問題があったときに、前の版へ戻す手順である。

### 6.1 Workerを前の版へ戻す

```bash
pnpm --filter worker exec wrangler deployments list --env staging
```

(これまでの版が古い順に並ぶ。各版のIDと作られた時刻が分かる)

```bash
pnpm --filter worker exec wrangler rollback --env staging --message "戻す理由"
```

(直前の版へ戻す。特定の版へ戻すときは`rollback <版のID> --env staging`と書く。確認を聞かれたら`y`)

戻した後は5.3の疎通確認を行う。直したものを載せ直すときは、5.2のデプロイをもう一度行えば最新の版になる。

- 戻すのはWorker(プログラムと画面)だけで、シークレットとデータベースの中身は戻らない
- 2026-10-22に、戻す→疎通確認→もう一度デプロイして最新へ戻す、の流れを1回試して動くことを確かめた

### 6.2 データベースの形を戻す

マイグレーションで加えた変更を取り消す必要があるときだけ行う。取り消しのSQLは`apps/worker/migrations_rollback/`に番号ごとにある(説明は同じフォルダの`README.md`)。**新しい番号から1つずつ**実行する(11 §3)。

```bash
pnpm --filter worker exec wrangler d1 execute DB --env staging --remote --file migrations_rollback/0007_rollback.sql
```

(0007番で加えた変更を取り消す。データが消える場合があるため、必要なときだけ行う)

- 取り消しのSQLは、wranglerの適用記録(D1の`d1_migrations`表の行)を消さない。記録が残ったままだと、次のデプロイでその番号は適用済みとして飛ばされる。取り消した番号をもう一度適用し直す手順は、本番前の戻し方のリハーサル(F10・11 §3)で決める
- Workerはデータベースの形に合わせて動くため、形を戻したら6.1でWorkerも対応する版へ戻す

## 7. 負荷試験の実行

(負荷試験の手順は後続の作業で書き足す)
