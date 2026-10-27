# 公開当日と公開後72時間の台本

公開の当日に行うスモーク確認(11 §2 の手順3・4)と、公開後72時間の監視(11 §4・09 §6 の警報線)の段取りである(LAT-123)。スモーク確認は、主な動線が本番で動くことを短時間で確かめる点検を指す。

- prodの資源・シークレット・デプロイの手順は `docs/runbooks/prod.md`(LAT-119・LAT-120)、戻し方は `docs/runbooks/rollback-rehearsal.md` に置く
- 本書では、prodのwranglerの環境の指定を `--env <prod>`、prodのURLを `<prodのURL>` と書く(環境の名前は LAT-119 で決まる。URLは文書・コミットに残さない)
- コマンドはすべてリポジトリのいちばん上のフォルダ(`latch/`)で実行する。prodのデータベースへは**読み取り(SELECT)だけ**を送る
- **未確定(オーナーの判断待ち)**: 当日の担当・点検の時刻・連絡手段・ロールバックを決める人(9章)。下の時刻と分担は案である

## 1. 当日の流れ(案)

| 時刻(案) | 何をするか | 11 §2 | 担当(案) |
|---|---|---|---|
| 前日まで | 11 §1 の前提条件がすべて印付き。戻し方のリハーサル済み | — | オーナー |
| T−60分 | 本書の2章の準備 | — | オーナー |
| T0 | prodへのデプロイ(`docs/runbooks/prod.md`) | 手順1 | オーナー |
| T+10分 | 独自ドメインの向き先の確認(3.1の1) | 手順2 | オーナー |
| T+15分 | スモーク確認(3章) | 手順3 | オーナー(2つのアカウントを使う) |
| T+45分 | 計測の確認(4章) | 手順4 | オーナー |
| T+60分 | 合否の判断(5章)。合格なら告知 | 手順5 | オーナー |
| 告知から72時間 | 監視(6章) | 11 §4 | 9章で決める |

- スモーク確認は告知(11 §5 の発信)より**前**に行う。告知の前は本番の利用者がほぼいないため、確認用の意思が本番の利用者に提案されにくい(3.3)
- 不合格なら告知しない。直すか戻すか(`docs/runbooks/rollback-rehearsal.md` 3章)を決める

## 2. 準備

- `pnpm --filter worker exec wrangler whoami` でprodを操作できるアカウントに入っている
- 確認用のアカウントを2つ用意する(本番のIdPのGoogleとApple、またはGoogleを2つ。以下AとB)。PCのブラウザとスマートフォンなど、別の端末で開けるとよい
- Cloudflareの画面で、prodのWorkerの「Logs」(Workers Logs)と、Analytics Engineの画面を開いておく
- LLMの事業者(Anthropic・TypeSafe)の利用量の画面を開いておく(本物のAIの呼び出しが課金されることの確認)
- 6.4 の記録の書式を手元に開いておく

## 3. スモーク確認(11 §2 の手順3)

### 3.1 ログイン無しの確認(5項目・5分)

```bash
curl -s -o /dev/null -w '%{http_code}\n' <prodのURL>/healthz
```

(Workerが応答するか。`200` なら合格)

| # | 確かめること | 合格 |
|---|---|---|
| 1 | ブラウザで `<prodのURL>` を開く(独自ドメインの向き先) | ようこその画面が出る。鍵のマーク(HTTPS)が付く |
| 2 | `<prodのURL>/healthz`(上のコマンド) | `200` |
| 3 | `<prodのURL>/terms`・`<prodのURL>/privacy` | 確定版の規約が出る(「公開前の版」の印が無い・11 §1) |
| 4 | `curl -s -o /dev/null -w '%{http_code}\n' -X POST <prodのURL>/v1/dev/idp-token` | `404`(試験用のサインインが本番で閉じている・10 §2) |
| 5 | `curl -s -o /dev/null -w '%{http_code}\n' <prodのURL>/v1/users/me` | `401`(ログインしていない要求を断る) |

prodにCloudflare Access(門)をかけるかは LAT-91 で決まる。かける場合、上の確認はAccessを通った状態で行う。

### 3.2 本物のアカウントでの確認(30分)

AとBの2つのアカウントで、登録から成立後のチャットまでを一通り行う。本物のAI(Parser・Jev・Embedding)が動くことの確認を兼ねる。

| # | 操作 | 合格 |
|---|---|---|
| 1 | Aで本番のIdPからサインインし、登録と同意を済ませる | ホームが出る |
| 2 | AでつながりIntentを書く(例: 「週末に将棋を指せる仲間とつながりたい」) | 読み取った内容の確認が数秒で出る(本物のParser) |
| 3 | Aで意思を預ける | 一覧に載る |
| 4 | Bで1〜3を行う(例: 「将棋を一緒に指す友達がほしい」) | 一覧に載る |
| 5 | 待つ(最大10分) | AとBの両方に提案が出る。アプリ内通知が付く(通知を許可していればWeb Pushも届く) |
| 6 | AとBで[参加する] | 成立し、チャットが開ける |
| 7 | AとBでチャットを1往復する | 相手の発言がすぐに出る |
| 8 | 後始末: AとBで意思を消す(またはAとBを退会させる・3.3) | 一覧から消える |

- 5で10分を過ぎても提案が出ないときは、4章のログで `intents.parse.failed`・`jev`・`pipeline` を含む行と、6.2 の未処理の滞留を見る
- 意思の文は運営が作った例文にする(本番の利用者の文を使わない・01 §21)

### 3.3 確認用のアカウントで残るもの(判断材料)

確認用の意思やアカウントを消しても、次は残る(05 §2.5)。

- 成立したLATCHの行・チャットのメッセージ・回答と成立後の申告(`latch_responses`・`latch_feedback`)
- 匿名化した正解データの行(`calibration_records`)
- Analytics Engineの計測(消せない)と、09 §2 の集計(Mutual Latch Rateなど)への1件

このため、確認で作ったLATCHを、09 §2 のベースライン期間(4週)の集計と正解データから除くかを決めておく(9章の5)。除く場合に備えて、確認の開始と終了の時刻(JST)を記録に残す。

## 4. 計測の確認(11 §2 の手順4)

| 見るところ | 確かめること |
|---|---|
| Workers Logs | 3.2 の時間帯の要求の記録が出ている。`error` の段の記録と5xxの応答が続いていない |
| Analytics Engine | prodのデータセット(名前は `docs/runbooks/prod.md`)に、3.2 の評価の計測(`stage2`)が増えている |
| D1の外部送信の数え | 下のコマンドで、今日の `anthropic:parser` と `jev`(`anthropic:jev` か `typesafe:jev`)が1以上 |

```bash
pnpm --filter worker exec wrangler d1 execute DB --env <prod> --remote --command "SELECT key, count FROM usage_counters WHERE scope = 'external_send' AND period = strftime('%Y-%m-%d', 'now', '+9 hours')"
```

(今日(日本時間)に本物のAIへ送った回数を、送り先と用途ごとに出す。読み取りだけで、データは変えない)

## 5. 合否と、戻す判断

- 3.1・3.2・4章がすべて合格なら告知する(11 §2 の手順5)
- 不合格のときは告知を止め、11 §3 の判断基準で決める: (a)登録・意思の作成が全く通らない、(b)データの欠損・不正な表示、(c)プライバシーに関わる事故 → 戻す(`docs/runbooks/rollback-rehearsal.md` 3章)。それ以外は直してから載せ直す
- 戻すかを決める人は9章の2で決める

## 6. 公開後72時間の監視(11 §4)

09 §6 の警報線を、告知から72時間は「時間単位」で点検する。

### 6.1 点検の時刻(案)

- 告知から12時間: 1時間ごと
- その後72時間まで: 起きている間は3時間ごと(例: 9時・12時・15時・18時・21時・24時)、寝る前と起きた後に1回ずつ
- 1回の点検は10分以内で済むように、6.2 のコマンドをまとめて流す

### 6.2 警報線と、prodでの測り方

| 警報(09 §6) | 線 | 測り方(今できる方法) | 初動 |
|---|---|---|---|
| DLQ滞留 | dead件数>0 | 下の(1) | 手動確認・再処理(06 §5) |
| Parser失敗率 | 直近1日で5%超 | 分子: Workers Logsで `intents.parse.failed` の件数(直近24時間)。分母: 下の(2)の `anthropic:parser` | 事業者の状況確認(07 §3)・構造化フォームへの案内 |
| Jev予算 | 1か月の80%到達 | Workers Logsで `jev.budget.alert`(メールで送る仕組みはまだ無い・LAT-124)。下の(2)の `jev` の累計 | 消費源の確認(06 §6)・上限では保留へ縮退 |
| 通報率急増 | 週比2倍 | 下の(3)(72時間は前週が無いので、件数と中身を毎回見る) | 通報内容の確認・アカウント対応(08 §8) |
| open通報の滞留 | 7日超のopen | 下の(3)の未対応の件数(72時間では7日を超えないので、届いた通報はその日のうちに対応する) | 対応(08 §8) |
| MLR急落・YES率急落 | 前週比−10pt以上 | 72時間は前週が無いので線は当たらない。24時間ごとに集計を取り、ベースラインの最初の記録にする(下の注) | 提案ログの層別確認(06 §7)・表示と通知文の確認 |

あわせて、09 §6 には無いが公開直後に見るもの:

- 未処理の滞留: 下の(4)が0(毎分のCronと待ち行列が回っている)
- Workers Logsで、5xx(サーバーの失敗)の応答と `error` の段の記録が増え続けていない
- LLMの事業者の画面で、利用額が見込み(07のコスト試算)から外れていない

```bash
# (1) DLQで諦めたイベントの件数(0が正常)
pnpm --filter worker exec wrangler d1 execute DB --env <prod> --remote --command "SELECT COUNT(*) AS dead FROM match_events WHERE status = 'dead'"

# (2) 今日(日本時間)の本物のAIへの送信回数(送り先と用途ごと)
pnpm --filter worker exec wrangler d1 execute DB --env <prod> --remote --command "SELECT period, key, count FROM usage_counters WHERE scope = 'external_send' AND period >= strftime('%Y-%m-%d', 'now', '+9 hours', '-1 day') ORDER BY period, key"

# (3) 直近24時間の通報の件数と、未対応(open)の件数
pnpm --filter worker exec wrangler d1 execute DB --env <prod> --remote --command "SELECT COUNT(CASE WHEN created_at >= (strftime('%s','now') - 86400) * 1000 THEN 1 END) AS last_24h, COUNT(CASE WHEN status = 'open' THEN 1 END) AS open FROM reports"

# (4) 15分より前に作られて、まだ処理されていないイベントの件数(0が正常)
pnpm --filter worker exec wrangler d1 execute DB --env <prod> --remote --command "SELECT status, COUNT(*) AS n FROM match_events WHERE status IN ('pending', 'failed') AND created_at < (strftime('%s','now') - 900) * 1000 GROUP BY status"
```

(どれも読み取りだけで、データは変えない。1行ずつ実行し、結果の数を6.4の記録に写す)

注: MLR(Mutual Latch Rate)とYES率は `pnpm analytics:report`(09 §2 の集計)で出せるが、いまは手元とstagingにしか向けられない(prodに向ける変更は案・7.2)。変更が入るまでは、24時間ごとの集計を省き、72時間の後の日次点検(11 §4)から始める。

### 6.3 警報線に当たったとき

1. 9章で決めた連絡手段で、担当とロールバックを決める人へ知らせる(何が・いつから・何件)
2. 09 §6 の初動を行う
3. 11 §3 の判断基準(a)〜(c)に当たるなら、5章と同じく戻すかを決める
4. 不具合はLinearに登録する(LATCHチーム)。その場で直さず、記録を残す

### 6.4 点検の記録(案)

点検のたびに1行書く。72時間の後にLAT-123へまとめてコメントする。

```
時刻(JST) | 点検者 | (1)dead | (2)parser/jev | Parser失敗 | (3)通報24h/open | (4)滞留 | 5xx・error | 利用額 | 気づいたこと
```

## 7. stagingの通し試験をprodのスモークに使えるか(調べた結果)

### 7.1 そのままでは使えない

stagingの通し試験(`apps/worker/scripts/staging-e2e.mjs` と `apps/worker/staging-e2e/`)は、prodでは最初の確認で止まる(意図どおりの作り)。

- **試験用の利用者の作成**: サインインをdev専用の `POST /v1/dev/idp-token` で行う。prodでは起動ガードと404で閉じており(10 §2)、包みは「宛先がstagingではありません」で止まる。本番のIdP(Google・Apple)では、試験の中で利用者を自動で作れない
- **進み具合の観測**: 提案・成立・通知・通報の確かめ方が、dev専用の観測API(`/v1/dev/match-events`・`/v1/dev/latches`・`/v1/dev/notifications` など)に頼っている。prodでは使えない
- **本物のAIの課金**: 1回で本物のAIを30回前後呼ぶ(`docs/runbooks/staging.md` 8章)。額は小さいが、prodのJev予算の数え(06 §6)にも入る
- **本番の利用者のデータに混ざるか**: 試験の意思は本番の候補の集まりに入り、本番の利用者に提案されうる(提案はプライバシーの事故になりうる)。退会させても、成立したLATCH・メッセージ・匿名化した正解データの行・Analytics Engineの計測は残る(3.3)

### 7.2 使う場合に要る変更(案・コードは変えていない)

結論として、当日のスモークは3章の手作業を勧める。自動にしたい場合の案は次のとおり。

- **案A(勧める)**: ログイン無しの確認(3.1)だけを小さな道具にする(例: `apps/worker/scripts/prod-smoke.mjs`。`/healthz`・画面・規約・`/v1/dev/idp-token` の404・`/v1/users/me` の401を確かめ、URLを伏せて出す)。dev専用APIを使わず、利用者を作らないので、本番のデータに触れない
- **案B**: `apps/worker/scripts/analytics-report.mjs` に `--prod`(`--env <prod> --remote` への読み取り)を足し、6.2 の(1)〜(4)の問い合わせもまとめて出す。点検を1コマンドにできる
- **案C(勧めない)**: 通し試験をprodで流すには、prodにだけ試験用のサインインを開ける必要がある。10 §2 の二重防御を崩すため行わない

## 8. 72時間の後

11 §4 の日次点検(MLR・YES率・通報・DLQ・コスト)へ移る。6.2 の(1)〜(4)を1日1回にし、週次でKPI4群(09 §2)の形式別の集計を記録する。

## 9. 決めること(オーナーの判断待ち)

1. 当日の担当(1人で行うか、もう1人に3.2 のBのアカウントを頼むか)
2. ロールバックを決める人と、決めるまでの目安の時間
3. 公開の日時(T0)と、6.1 の点検の時刻(夜間をどうするか)
4. 警報に当たったときの連絡手段(メール・チャットなど)。コストアラートのメール(11 §1・LAT-86)が届く先と同じにするか
5. 確認用のアカウントで作ったLATCHを、ベースラインの集計と正解データから除くか(3.3)。除くなら除き方
6. 確認の後に、確認用のアカウントを退会させるか、意思を消すだけにするか
7. 7.2 の案A・案Bを公開前に作るか
