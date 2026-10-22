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

- `LATCH_STAGING_URL`は`https://<ホスト名>`の形でそのまま登録する(末尾に`/`を付けない・後ろにパスを付けない・前後に空白や改行を入れない)。GitHubの伏せ字は登録した値と一字一句同じ文字列にだけ効くため、末尾の`/`の有無が違うだけで記録に出るURLが伏せられなくなる。なお、デプロイの工程はwranglerの出力のworkers.devのURLを`apps/worker/scripts/run-redacted.mjs`でも伏せてから記録へ出す(二重の備え)
- 3件のシークレットは、工程全体ではなく使う手順だけに渡す(トークンとアカウントIDはマイグレーションとデプロイ、URLは疎通確認)。依存の取り込み(`pnpm install`)や他者の部品(action)にはトークンを見せない

3件の登録を終えたら、最後に同じ画面の Variables(Secretsの隣)でリポジトリ変数を1件作る。名前は`STAGING_DEPLOY_ENABLED`、値は`true`である。この変数が`true`のあいだだけ、mainへの変更でstagingへの自動デプロイが動く(5.1)。

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

負荷試験は、たくさんの利用者が同時に使ったときの応答の速さを測る試験である(02 §4 #33・F8b設計 §3)。k6という負荷をかけるプログラムで、このPCからstagingへ大量のリクエスト(サーバーへの依頼)を送る。スクリプトは`tools/load/`にある。

### 7.1 k6の入れ方

k6は単体で動くプログラムで、pnpmの依存パッケージには入れない。次のどちらかで入れる。

- **公式のリリースのバイナリ**: <https://github.com/grafana/k6/releases> から、v1系の`k6-v<版>-linux-amd64.tar.gz`(Linuxの場合)を取り、展開して出てくる`k6`をPATHの通った場所(例: `~/.local/bin`)に置く。同じページの`k6-v<版>-checksums.txt`で取ったファイルの`sha256sum`の値が一致することを確かめる
- **パッケージマネージャー**: macOSは`brew install k6`、Debian/UbuntuはGrafanaの公式のaptの置き場から`sudo apt-get install k6`(手順は <https://grafana.com/docs/k6/latest/set-up/install-k6/>)

入ったことは次で確かめる。

```bash
k6 version
```

(`k6 v1.8.1 (...)`のように版が出る。F8bの試し実行はv1.8.1で行った)

### 7.2 k6は包み(run.mjs)を通して動かす

k6は通信に失敗したとき(名前が引けない・接続が切れた・時間切れ)、`WARN Request Failed error="Post \"https://…/v1/intents\": …"`のように宛先のURLをそのまま出す。stagingのURLを画面や記録に残さないため、k6は直接動かさず、必ず包みのスクリプト`tools/load/run.mjs`から動かす。

```bash
LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/run.mjs <シナリオ.js> [k6 runの引数...]
```

(k6を起動して`-e LATCH_LOAD_BASE_URL`を渡し、k6の出力の中の宛先のURL・ホスト名・workers.devのURLを`<url伏せ>`に置き換えて表示する。終わったときの終了コードはk6のものをそのまま返す)

- k6の場所は環境変数`K6_BIN`で指定する(既定は`k6`=PATHの通った場所にあるもの)
- 報告書や記録へ貼るのは、包みを通した出力だけにする。k6を直接動かしたときの生の出力は貼らない
- 中断はCtrl+Cで行う(k6が途中までの結果をまとめて終わる)

### 7.3 環境変数

k6には`-e 名前=値`で渡す(`LATCH_LOAD_BASE_URL`だけは包みが渡す)。

| 名前 | 既定 | 意味 |
|---|---|---|
| `LATCH_LOAD_BASE_URL` | (必須) | 宛先=`<stagingのURL>`。包み(`run.mjs`)と後始末(`cleanup.mjs`)にシェルの環境変数として渡す |
| `RUN_ID` | 実行時刻(UTCの`YYYYMMDDHHmm`) | 実行の印。試験用の利用者のsubjectは`load-<RUN_ID>-<連番>`になり、集計はこの印で絞る。12桁の数字のみ |
| `LOAD_SCALE` | `1` | 規模の倍率。rate(1分あたりの件数)・人数・時間に掛ける(試しは`0.1`)。(b)(d)は`1.6`(48組)まで・(c)は`1.44`(72組)まで(7.6・7.7) |
| `PROPOSAL_WAIT_SEC` | `60` | 提案の通知を待つ上限の秒数((b)〜(d)で使う) |

- 宛先を誤らないよう、各シナリオは最初にテスト用サインイン(`POST /v1/dev/idp-token`)を呼び、200でなければ「宛先がstagingではありません」で止まる(本番では404になる)
- 結果のJSON(`--summary-export`の出力)は`tools/load/results/`に置く。このフォルダはgitの管理外で、最初に`mkdir -p tools/load/results`で作る

### 7.4 後始末

試験の前と後に、試験用の利用者(subjectが`load-`で始まる)の意思をすべて消す。

```bash
LATCH_LOAD_BASE_URL=<stagingのURL> node tools/load/cleanup.mjs
```

(stagingのD1を読むだけの問い合わせで意思を持つ`load-`の利用者を探し、その利用者としてサインインし直して意思を削除APIで1件ずつ消す。「意思を持つload-の利用者 ◯人」「意思を◯件削除しました(失敗0件・うち途中で止まった利用者0人)」と出れば終わり)

- 1人の後始末(サインインし直し・意思の一覧・削除)が失敗しても、残りの利用者は続けて処理する。失敗が1件でもあれば「1人の後始末に失敗しました(…)」が出て、最後に失敗(0以外)で終わる。その場合は時間を置いてもう一度実行する(消えた意思は数え直さないため、残りだけが消える)

- 削除APIを通すのは、意思の索引(Vectorize)のベクトルも一緒に消すためである。データベースの行だけを書き換えるとベクトルが残り、次の回の候補の取り出しを汚す
- 実行の印を問わず`load-`の利用者を全員拾うため、途中で止まった回の残りも消える。利用者の行そのものは残る(次の回は別の印で作り直す)
- まれにwranglerの問い合わせが「The given account is not valid or is not authorized」(code 7403)で失敗することがある。時間を置いてもう一度実行する

### 7.5 シナリオ(a) 作成の集中

読み解き(`POST /v1/intents/parse`)→保存(`POST /v1/intents`・status=active)を、合計100件/分で5分間繰り返す(100人×5件。1人のActive Intent上限5件に収まる)。読み解き確認の画面の[預ける]と同じ呼び方である。Intent保存のp95(目標0.5秒)とParserのp95(目標3秒・stubでの値)を測る。

```bash
export LATCH_LOAD_BASE_URL=<stagingのURL>
RUN_ID=$(date -u +%Y%m%d%H%M)
node tools/load/cleanup.mjs
node tools/load/run.mjs tools/load/scenarios/a-intent-burst.js -e RUN_ID=$RUN_ID \
  --summary-export tools/load/results/$RUN_ID-a.json
node tools/load/cleanup.mjs
```

(1〜2行目で宛先と実行の印を決め、後始末→包みを通した(a)の実行→後始末の順に動く。k6は準備で100人を登録してから5分間リクエストを送り、最後に結果の表を出す)

- 結果の表の`THRESHOLDS`に、目標(`http_req_duration{name:intent_save}`の`p(95)<500`・`http_req_duration{name:parse}`の`p(95)<3000`・失敗の割合`http_req_failed`の`rate<0.01`)ごとに✓か✗が出る。1つでも✗ならk6は失敗(0以外)で終わる。合否の正本は報告書(`docs/reports/f8b-load-test.md`)の集計である
- 小さく試すときは`-e LOAD_SCALE=0.1`を足す(10人・10件/分を30秒。保存は6件前後になる)

### 7.6 シナリオ(b) 作成〜提案の一連・(d) 通知の一斉送信

2人組×30組(60人)が、組ごとに同じ話題の機会Intentをactiveで保存し、2人とも提案のアプリ内通知を受け取るまで待つ。組kの意思は基準時刻(実行時刻+24時間を1時間単位に切り上げた時刻)+k×3時間から2時間とし、組どうしは時間帯が重ならないため、相手の組とは提案されない。(b)と(d)は同じスクリプト`tools/load/scenarios/bd-proposal.js`で、`MODE`だけを変える。

- `MODE=staggered`((b)): 組ごとに2秒間隔で投入する。試験用の利用者のsubjectは`load-<RUN_ID>-b<連番>`(組kは連番2k+1と2k+2)
- `MODE=burst`((d)): 全組を同じ時刻に一斉に投入する(60件前後の提案の通知が同時に発生する)。subjectは`load-<RUN_ID>-d<連番>`

```bash
export LATCH_LOAD_BASE_URL=<stagingのURL>
RUN_ID=$(date -u +%Y%m%d%H%M)
node tools/load/cleanup.mjs
node tools/load/run.mjs tools/load/scenarios/bd-proposal.js -e MODE=staggered -e RUN_ID=$RUN_ID \
  --summary-export tools/load/results/$RUN_ID-b.json
node tools/load/report.mjs $RUN_ID
node tools/load/cleanup.mjs
```

(後始末→包みを通した(b)の実行→集計(7.8)→後始末の順に動く。k6は準備で60人を登録し、各組の2人の意思を保存してから、2人に提案の通知が届くまで1秒間隔で確かめる。(d)は`MODE=burst`にし、結果のファイル名を`$RUN_ID-d.json`にする。(b)と(d)は別の実行の印で続けて行う)

- k6は時間を測らない。初期判定(p95 10秒)と通知(判定後5秒以内)の値は、試験の後に集計(F8b設計 §4.1)がstagingのD1から出す。そのため、集計を終えるまで後始末(cleanup.mjs)をしない
- 結果の表の`proposal_delivered`が通知の届いた人数、`proposal_missing`が待ちの上限(`PROPOSAL_WAIT_SEC`・既定60秒)までに届かなかった人数である。`THRESHOLDS`の`proposal_missing`の`count<1`が✗なら、届かない人がいたことを示す
- 小さく試すときは`-e LOAD_SCALE=0.2`を足す(6組=12人)
- `LOAD_SCALE`の上限は`1.6`(48組)である。組kの開始は基準時刻+k×3時間のため、これを超えると最後の組の開始が機会の開始の上限(保存の時点から7日以内)を超えて保存できない。超えたときは準備(setup)の最初に「組数◯では最後の組の開始が機会の開始の上限(7日以内)を超えます。LOAD_SCALEを下げてください」と出て、利用者を登録する前に止まる
- 不具合#7(GitHubのissue)が直るまでは、stagingで新しい意思の索引の登録が毎回失敗し、毎分の定期処理の取りこぼし回収で5〜10分後に評価される。それまでは`-e PROPOSAL_WAIT_SEC=900`を足して待ちを延ばす(k6の1回の実行の上限は、待ちの上限から自動で決まる)

### 7.7 シナリオ(c) チャット同時接続

準備で1対1のつながりを50組(100人)成立させ、100人が同時にチャットのWebSocket(サーバーとつなぎっぱなしにして双方向にやり取りする通信)で接続し、5分間、5秒ごとに送り合う。送信から相手への到着までのp95と、接続の失敗の割合を測る(01 §20に目標値は無く、参考値として報告書に載せる)。スクリプトは`tools/load/scenarios/c-chat.js`。

- 準備は通常のAPIで行う。組の作り方は(b)と同じで、組ごとに同じ話題の機会Intentを保存し、提案のアプリ内通知が届いたら2人とも[参加する](`POST /v1/latches/{id}/response`の`yes`)で参加し、成立(matched)を確かめる。50組を機会の開始の上限(7日以内)に収めるため、組と組の間隔は(b)の3時間ではなく2時間にする(隣の組とは時間帯の端が接するだけで、重なりの下限15分を下回るため提案されない)
- 試験用の利用者のsubjectは`load-<RUN_ID>-c<連番>`(組kは連番2k+1と2k+2)
- 本体では各人がチケット(`POST /v1/ws-ticket`)を取って接続し、`{type:"message", body:"t=<送った時刻>", client_id:"<VUの番号>-<連番>"}`を送る。25秒ごとに`ping`を送る。WebSocketのURLは宛先のURLから作り(`https`→`wss`)、表示しない
- WebSocketにはk6の`k6/websockets`を使う。k6 v1.8.1で読み込めること、stagingのチャットへ接続して送受信できることを確かめた(10 §5の「WebSocket対応は実施時に再確認」)

```bash
export LATCH_LOAD_BASE_URL=<stagingのURL>
RUN_ID=$(date -u +%Y%m%d%H%M)
node tools/load/cleanup.mjs
node tools/load/run.mjs tools/load/scenarios/c-chat.js -e RUN_ID=$RUN_ID \
  --summary-export tools/load/results/$RUN_ID-c.json
node tools/load/cleanup.mjs
```

(後始末→包みを通した(c)の実行→後始末の順に動く。k6は準備で100人を登録し、50組の意思を保存して提案を待ち、2人とも参加させてから、100人を同時に接続して5分間送り合い、最後に結果の表を出す)

- 結果の表の`chat_delivery_ms`が送信から相手への到着までのミリ秒(自分の送信の折り返しは除く。`count`が相手から届いた発言の数)、`chat_connect_failed`が接続の失敗(チケットの発行の失敗を含む)の割合、`chat_messages_sent`が送った件数、`chat_pairs_unmatched`が準備で成立できなかった組数である。`THRESHOLDS`の`chat_connect_failed`の`rate<0.01`・`chat_pairs_unmatched`の`count<1`が✗なら、接続できない人か成立できない組があったことを示す
- 準備の上限(setupTimeout)は、提案待ちの上限(`PROPOSAL_WAIT_SEC`)+300秒+組数×6秒で自動で決まる
- `LOAD_SCALE`の上限は`1.44`(72組)である。組と組の間隔が2時間のため、これを超えると最後の組の開始が7日以内に収まらない。超えたときは(b)と同じく準備の最初に止まる
- 小さく試すときは`-e LOAD_SCALE=0.1`を足す(5組=10人・接続を30秒保つ。2026-10-22の試しでは10接続すべて成功し、相手への到着は50件・p95 0.63秒だった)
- 不具合#7が直るまでは、(b)と同じく`-e PROPOSAL_WAIT_SEC=900`を足して提案の待ちを延ばす
- 成立したつながりとチャットの発言は、後始末の後もstagingのD1に残る(消すAPIが無い)。後始末が消すのは意思だけで、次の回は別の実行の印の利用者で行うため、試験の妨げにはならない

### 7.8 集計

試験の後に、実行の印ごとの結果を01 §20の目標と並べた表にする(F8b設計 §4.1)。

```bash
node tools/load/report.mjs <RUN_ID>
```

(`tools/load/results/<RUN_ID>-a.json`・`-c.json`のk6の結果を読み、stagingのD1へ読み取りの問い合わせ(SELECTだけ)を送って、Intent保存・Parser・Candidate Retrieval・初期判定・通知のp95と合否、チャットの参考値をMarkdownの表で出す。宛先のURLは使わないため`LATCH_LOAD_BASE_URL`は要らない)

- 初期判定・通知・Candidate Retrievalは、その実行の印の(b)(d)の利用者の行から出す。後始末で意思を消すと、その意思の有効化や埋め込みの記録(match_events)も消えて集計できなくなるため、**集計は後始末の前に行う**(7.6の手順の順番)。提案の通知の行は後始末の後も残る
- 実行の印は1回に1つで、シナリオごとに印が違うときは印ごとに実行する。結果のファイルやD1の行が無い項目は「計測なし」と出る
- 「判定」は、欠けが0件で計測したp95が目標以内なら「合格」、計測したp95が目標を超えれば欠けの有無によらず「不合格」と出る。計測したp95が目標以内でも欠けが1件でもあれば「—(欠けあり)」と出て合格としない(欠けた分が遅かった可能性を否定できないため)。計測が0件なら「—」。「—(欠けあり)」の行は、欠けの理由(下の注記)を確かめ、直してから測り直す
- 「欠け」は計測できなかった件数(提案の通知が来なかった意思など)。表の下に、埋め込みの記録(embedding_completed)が無い意思の件数も出る。不具合#7が直るまでは埋め込みを毎分の定期処理が行うため、この件数が増え、そのぶんCandidate Retrievalの「欠け」になる
- 「(stub)」の付いた行は、LLMをstub(決まった答えを返す試験用の代わり)で動かした値である
