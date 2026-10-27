# prod 戻し方のリハーサル台本

公開の前に、prodで「新しい版を前の版へ戻す」手順を一度通して試すための台本である(11 §1 のチェックリスト「ロールバック手順(§3)を一度リハーサル済み」・11 §3・LAT-88)。stagingの戻し方(`docs/runbooks/staging.md` 6章・2026-10-22に1回予行済み)を土台にし、prodでの違いと、11 §3 で未決だった「戻す手順を実行した後に同じ番号のマイグレーションを適用し直す手順」を加える。

- prodの資源の作成・シークレット・デプロイの手順は `docs/runbooks/prod.md`(LAT-119・LAT-120)に置く。本書はそこで作ったprodを前提にする
- prodのwranglerの環境は `--env production`(wrangler.jsoncの`env.production`区画・LAT-119・`docs/runbooks/prod.md`)。prodのURLは `<prodのURL>` と書き、文書・コミットに残さない
- コマンドはすべてリポジトリのいちばん上のフォルダ(`latch/`)で実行する
- **未確定(オーナーの判断待ち)**: 実施日・担当・戻すかどうかを決める人(本書の最後の「決めること」)

## 1. いつ・どこで行うか(案)

- **時期**: prodの資源を作り、少なくとも2回デプロイした後(戻す先の「前の版」が要る)、公開の告知(11 §2 の手順5)より前。利用者がまだいないので、データベースの形を戻しても消える記録が無い
- **場所**: prodそのもの。11 §1 は「本番を想定した一通り」を求めており、stagingの予行(Workerだけ)では満たさない
- **所要時間の目安**: 1時間(Workerの戻し15分・データベースの形の戻しと適用し直し30分・記録15分)

## 2. 前提

- `pnpm --filter worker exec wrangler whoami` でprodを操作できるアカウントに入っている(wranglerはCloudflareを操作するコマンド。ログインは `docs/runbooks/staging.md` 1章と同じ)
- prodに2つ以上の版があり、データベースへのマイグレーション(データベースの形を変える手順のファイル。`apps/worker/migrations/`)が全部適用済み
- 公開前で、本番の利用者がいない(試しに作ったアカウントがあっても消えてよいもの)
- 記録用のメモ(6章の書式)を手元に開いておく

## 3. 手順A: Workerを前の版へ戻す

Worker(プログラムと画面)だけを前の版へ戻し、もう一度最新を載せ直す。stagingの6.1と同じ流れである。

```bash
pnpm --filter worker exec wrangler deployments list --env production
```

(これまでの版が古い順に並ぶ。いちばん下が今の版。今の版と1つ前の版のIDを記録用のメモに写す)

```bash
pnpm --filter worker exec wrangler rollback --env production --message "リハーサル: 前の版へ戻す"
```

(直前の版へ戻す。確認を聞かれたら `y`。特定の版へ戻すときは `rollback <版のID> --env production`)

戻した後に、`docs/runbooks/launch-day.md` 3.1 のログイン無しの確認(5項目)を行う。続けて最新の版を載せ直す(`docs/runbooks/prod.md` のデプロイの手順)。載せ直した後も同じ確認を行う。

- 戻るのはWorkerだけで、シークレットとデータベースの中身は戻らない
- Durable Objects(チャットの部屋)の移行の設定(wrangler.jsoncの`migrations`)が今と違う版へは、wranglerが戻すのを断ることがある。いまは`v1`の1つだけなので当たらないが、増やした後は戻せる範囲が狭まる

## 4. 手順B: データベースの形を戻し、同じ番号を適用し直す

11 §3 で未決だった部分である。結論から書く。

### 4.1 何が問題か(wranglerの振る舞い)

wranglerの `d1 migrations apply`(未適用のマイグレーションを適用するコマンド)は、データベースの中の `d1_migrations` 表に**ファイル名の行があるかどうかだけ**で適用済みかを判断する。適用するときは、マイグレーションのSQLの後ろに「この名前を `d1_migrations` へ書く」1文を足して一緒に実行する(wrangler 4.151.1 の実装で確かめた)。

一方、戻す手順のSQL(`apps/worker/migrations_rollback/NNNN_rollback.sql`)は形を戻すだけで、`d1_migrations` の行を消さない。このため、戻した後にそのまま `migrations apply` をしても「`No migrations to apply!`(適用するものは無い)」となり、**形は戻ったまま適用済みの扱いになる**。新しい版のWorkerを載せると、無い列を読み書きして失敗する。

### 4.2 案: 戻した番号の適用記録の行を消してから適用し直す

戻す手順を実行したら、続けて同じ番号の適用記録の行を消す。消した番号はwranglerから「未適用」に見え、次の `migrations apply` で古い順に適用し直される。

- 適用し直すのは**同じ中身のファイル**のときに限る(問題がWorkerの側にあり、マイグレーション自体は正しかった場合)。適用済みのファイルの中身は書き換えない
- マイグレーションの中身に誤りがあった場合は、戻した番号を適用し直さず、直したものを**新しい番号**で作る(前進の修正)。この場合も、戻した番号の記録の扱いは別途決める(本書の最後の「決めること」の4)
- ファイル名と記録の名前の対応は次のとおり(記録の名前は`migrations/`のファイル名そのもの)

| 戻す手順 | 消す記録の名前 |
|---|---|
| `migrations_rollback/0011_rollback.sql` | `0011_jev_held.sql` |
| `migrations_rollback/0010_rollback.sql` | `0010_calibration_records.sql` |
| `migrations_rollback/0009_rollback.sql` | `0009_recent_vectors.sql` |
| `migrations_rollback/0008_rollback.sql` | `0008_match_events_indexes.sql` |
| `migrations_rollback/0007_rollback.sql` | `0007_notification_push.sql` |
| `migrations_rollback/0006_rollback.sql` | `0006_report_target.sql` |
| `migrations_rollback/0005_rollback.sql` | `0005_chat_hidden_client_id.sql` |
| (0004以前) | 同じ規則(`ls apps/worker/migrations` で名前を確かめる) |

### 4.3 リハーサルの手順(いちばん新しい番号を1つ戻して適用し直す)

1. 今の状態を確かめる

   ```bash
   pnpm --filter worker exec wrangler d1 migrations list DB --env production --remote
   ```

   (未適用のマイグレーションを並べる。`No migrations to apply!` と出れば全部適用済み)

2. 戻す前の時点の印を控える(万一のときにデータベース全体をこの時点へ戻すため。戻しはしない)

   ```bash
   pnpm --filter worker exec wrangler d1 time-travel info DB --env production
   ```

   (今の時点を指す印=bookmarkが表示される。記録用のメモに写す)

3. Workerを、そのマイグレーションを使わない版へ先に戻す(手順A。`migrations_rollback/README.md` の番号ごとの注意に従う。0011なら「保留の判定し直しを行う版」より前)

4. 戻す手順を実行する

   ```bash
   pnpm --filter worker exec wrangler d1 execute DB --env production --remote --file migrations_rollback/0011_rollback.sql
   ```

   (0011で足した列と索引を取り除く。複数戻すときは新しい番号から1つずつ)

5. 戻した番号の適用記録の行を消す

   ```bash
   pnpm --filter worker exec wrangler d1 execute DB --env production --remote --command "DELETE FROM d1_migrations WHERE name = '0011_jev_held.sql'"
   ```

   (wranglerに「0011は未適用」と見せる。複数戻したときは `name IN ('0011_jev_held.sql', '0010_calibration_records.sql')` のように全部並べる)

6. 未適用に見えることを確かめる(1と同じコマンド。`0011_jev_held.sql` が並べば正しい)

7. 適用し直す

   ```bash
   pnpm --filter worker exec wrangler d1 migrations apply DB --env production --remote
   ```

   (未適用の番号を古い順に適用し、記録の行を書き直す。確認を聞かれたら `y`)

8. もう一度1のコマンドで `No migrations to apply!` を確かめ、最新の版のWorkerを載せ直す(手順A)。ログイン無しの確認(`docs/runbooks/launch-day.md` 3.1)を行う

### 4.4 順序を誤ったとき

- **形を戻さずに記録だけ消した**: 7の適用が `duplicate column name`(同じ名前の列が既にある)で止まる。データは壊れず、記録の行も書かれない。次で記録を戻せば元どおりになる

  ```bash
  pnpm --filter worker exec wrangler d1 execute DB --env production --remote --command "INSERT INTO d1_migrations (name) VALUES ('0011_jev_held.sql')"
  ```

- **形を戻したが記録を消し忘れた**: 7が `No migrations to apply!` になる。5から行う
- **Workerを戻す前に形を戻した**: 戻すまでの間、新しい版のWorkerが無い列を読み書きして要求が失敗する。すぐに手順Aで戻す

### 4.5 手元での確認(2026-10-27・wrangler 4.151.1)

手元の使い捨てのデータベース(`wrangler d1 ... --local --persist-to <作業用の置き場>`。Cloudflareには送らない)で次を確かめた。

1. 0000〜0011を全部適用 → 0011の戻す手順を実行 → `d1_migrations` に `0011_jev_held.sql` が残り、`migrations apply` は `No migrations to apply!`(4.1の問題の再現)
2. 続けて0010も戻し、2つの記録の行を消す → `migrations apply` が0010・0011の順に適用し直し、列(intentsのjev_held_*の3列・latchesのcalibrated_at)が戻った
3. 形を戻さずに0011の記録だけ消す → `duplicate column name: jev_held_at` で止まり、記録は書かれなかった → 4.4の `INSERT` で記録を戻すと `migrations list` は `No migrations to apply!` に戻った

## 5. 手順C: データの戻し(D1の時点復元)は印の確認だけにする(案)

11 §3 の「データ: D1のポイントインタイムリストア(7日)」は、`wrangler d1 time-travel restore DB --env production --bookmark <印>` でデータベース全体をある時点へ戻す操作である。リハーサルでは4.3の2で印が取れることの確認だけにし、復元そのものは行わない案とする(公開前のprodで行っても失うデータは無いので、試すかはオーナーが決める)。

本番で使うときの注意(公開後の判断のため):

- 戻せる期間は、11 §3・04 §7 では7日としているが、wrangler 4.151.1 の説明は「30日以内」(Workers Paidの場合)である。どちらに合わせるかは確認中(LAT-125)

- 戻した時点より後の**意思の削除・退会も取り消される**(消したはずの本文が戻る)。復元の後に、その間の削除と退会をやり直す必要がある(01 §21・05 §2.5)
- Vectorize(意味の近さで探す索引)は戻らない。D1と食い違い、その間に作られた意思のベクトルが残り、消した意思のベクトルは戻らない。D1から作り直す道具はまだ無い(04 §7 は「再構築できる構造を保つ」までを定める)
- このため時点復元は、データの欠損や不正(11 §3 の判断基準(b))で他に手が無いときに限る

## 6. 記録

リハーサルの後に、次をLAT-88へコメントとして残し、11 §1 の「ロールバック手順(§3)を一度リハーサル済み」に印を付ける。

```
実施日時:            (JST)
実施者:
wranglerの版:        (pnpm --filter worker exec wrangler --version)
手順A: 今の版のID / 戻した先の版のID / 戻した後の確認 / 載せ直した後の確認
手順B: 戻した番号 / time-travelの印を控えたか / 適用し直した結果 / 載せ直した後の確認
手順C: (行った場合のみ)
かかった時間:
気づいたこと:
```

印(time-travelのbookmark)とprodのURLは、記録に書かない。

## 7. 決めること(オーナーの判断待ち)

1. 実施日と担当(公開の何日前か)
2. 本番で戻すかどうかを決める人と、決めるまでの目安の時間(11 §3 の判断基準(a)〜(c)に当たったとき)
3. 手順C(時点復元)を公開前のprodで実際に試すか
4. 中身に誤りのあったマイグレーションを戻したとき、戻した番号のファイルと記録をどう扱うか(案: ファイルは残し、戻した番号の記録の行は消さずに残して「適用済み・中身は空振り」とし、直したものを新しい番号で作る。drizzle-kitの記録(`migrations/meta`)とそろえるため)
5. 4.2の手順(記録の行を消す)を、戻す手順のSQLの末尾に1文足して1回の実行で済ませる形に改めるか(案は最終報告に記す。コードは変えていない)
