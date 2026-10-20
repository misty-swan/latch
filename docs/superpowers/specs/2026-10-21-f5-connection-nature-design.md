# F5 つながりの性質 設計書

- 作成日: 2026-10-21
- 対象: docs/12 §2 のF5「つながりの性質」(バックエンド)
- 正本: docs/01 §8 / docs/02 D-08・§4(#21・#22) / docs/05 §2.2・§2.6・§3.3 / docs/06 §2
- 前段: docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md・2026-10-20-f4b-group-latch-design.md(本書はその上に載る)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提

### 0.1 目的とゲート

- #21「つながりLATCH成立後、第三者が意味的に近いIntentを登録する → Intentがactiveに復帰し、新たな候補の生成・提案が記録される」をworker E2Eで証明する
- #22「チャット非活動90日を注入clockで経過させる → completed遷移」を注入clockの統合試験で証明する(E2Eの対象外・10 §3)。「チャットは読み取り専用となる」はチャット自体を持つF6が担う(F5はcompletedの状態遷移までを作る)

### 0.2 現状の確認(着手時点のコード)

1. つながりIntentは成立してもmatchedにならずactiveのまま残る(`src/latches/respond.ts`のmatched化は機会のみ)。Layer 1の恒久排除はペア単位のproposal_history(matched・rejected)であり、成立済みペア以外の相手とは再び候補になり得る。したがって#21の仕組みは既存であり、F5ではE2Eで証明し、途中で除外される穴があれば塞ぐ
2. Cron (d)(つながりLATCHのcompleted判定)は未実装(`src/pipeline/cron.ts`の注記どおりF5で計上)
3. `latches.last_message_at`には提案作成時刻が入っている(`src/latches/propose.ts`)。05 §2.2の「最終メッセージ(0件ならmatched時刻)」と食い違う
4. 機会の排他・再提案規則はF4aで実装・証明済み(12 §2のF5の内容欄に残っているが、F5での追加作業はない)
5. 機会LATCHの「対象時刻の経過でcompleted」(01 §8・05 §2.2)はCronの走査一覧(06 §2の(a)〜(i))に無く、どの工程にも割り当てられていない
6. `GET /v1/latches?type=matched`はstatus=matchedのみを返すため、completedになったLATCHが成立一覧から消える(D-08の「completed後も閲覧できる」と矛盾する)

### 0.3 オーナー裁定(2026-10-21・本書のブレインストーミング)

| # | 決定内容 | 根拠 |
|---|---|---|
| 1 | F5の範囲に機会LATCHのcompleted判定を含める。`DELETE /v1/latches/{id}`(D-08の自分の側の削除)はF6、`POST /v1/latches/{id}/feedback`(01 §14の自己申告)はF9へ担当を記録して送る | completedへの遷移を1か所(Cron (d))にそろえ、F6のチャット読み取り専用化の前提を整える |
| 2 | 機会LATCHは **対象時刻から3時間の経過** でcompletedとする(01 §8の「対象時刻の経過」を明確化)。対象時刻は提案内容の`time_window.start`(グループは全員のstarts_atの最大値・F4b) | 対象時刻ちょうどで閉じると、F6で当日の連絡が最も必要な時刻にチャットが読み取り専用になる。3時間は機会Intentの既定の期限(start+3時間・05 §2.2)と同じ幅 |

### 0.4 F5で行わないこと

チャットの読み取り専用化(F6)・completedの画面表示(F6のつながり一覧・チャット・`prototype/`基準)・`DELETE /v1/latches/{id}`(F6)・`POST /v1/latches/{id}/feedback`(F9)・completed時の通知(作らない・つながりの「静穏」の性質による)。

## 1. 構成(案A: 毎分Cronに走査を1本追加する)

| 配置 | 責務 |
|---|---|
| `src/latches/complete.ts`(新設) | 完了予定時刻の計算(純関数)と、completed化の走査(対象の照会・条件付き更新のバッチ) |
| `src/pipeline/cron.ts` | (d)として上記の走査を呼ぶ。F4aの4走査と同じく隔離する |
| `src/latches/respond.ts` | 成立のバッチ(onMatched)で`last_message_at`を成立時刻へ置き直す |
| `src/routes/latches.ts`・`src/latches/view.ts` | 成立一覧と単一取得でcompletedをmatchedと同じ開示範囲で扱う |
| `@latch/shared` | 定数(つながり90日・機会3時間・走査上限500) |

採らなかった案: 対象時刻の専用列と索引を追加する案(マイグレーションと戻す手順が要るが、matchedの機会LATCHは対象時刻が7日以内のものに限られ件数が小さいため利益がない)/ 読み出し時に完了を判定する案(状態が書き換わらず、F6の読み取り専用判定と計測が複雑になる。06 §2のCron (d)とも食い違う)。

## 2. completed判定

### 2.1 対象と境界

- つながり: status=matched かつ form=connection かつ `last_message_at + 90日 ≤ now`
- 機会: status=matched かつ form=occasion かつ `time_window.start + 3時間 ≤ now`
- 照会は既存の索引(status, form, last_message_at)で対象を絞る。機会の時刻条件は`json_extract(proposal, '$.time_window.start')`と、JS側で計算した境界時刻のISO 8601文字列(いずれも`toISOString()`のUTC表記で辞書順=時刻順)の比較で行う
- 1回の走査は上限500件(つながり・機会の合計・06 §2の頭打ち規律)。古いものから処理する
- 離脱者(left_at)の有無は判定に関係しない(LATCH全体の状態)

### 2.2 書き込み

1件ごとに次を1バッチで行う。

1. `UPDATE latches SET status='completed', completed_at=now, updated_at=now WHERE id=? AND status='matched' AND <2.1の時刻条件>`(条件の再確認により、並行したleaveや、F6でのメッセージ到着による`last_message_at`の更新と競合しても誤って閉じない)
2. `latch_status_events`へ matched→completed を、1の更新が効いたときだけ記録する(`INSERT … SELECT … WHERE EXISTS(completed_at=now)`の形・既存の書き方に合わせる)

既にcompletedの行は条件に合わないため、走査の重複実行は冪等である。Intentの状態(つながり=active・機会=matched)とproposal_history(matched)は変えない。通知は作らない。

### 2.3 last_message_atの起点

成立のバッチ(onMatched)の中で`last_message_at`を成立時刻へ更新する(matchedへの遷移が効いたときだけ・冪等)。メッセージ書き込み時の更新はF6が担う。

## 3. API

- `GET /v1/latches?type=matched`はstatusがmatched・completedのものを返す(id降順・既存の規則)
- `GET /v1/latches/{id}`・LatchDTOは、completedでもmatchedと同じく提案内容・members・matched_atを返す(成立後の開示範囲・05 §3.3)
- 各操作(response・retract・leave・defer-reason)はcompletedに対して従来どおりinvalid_statusとなる(matched・提案中のみが対象のため、変更なし)
- web: `/latches/:id`の状態判定(`selectLatchView`)でcompletedを「このつながりは終了しました」(ended)へ振り分ける。現状はcompletedを知らず「成立しませんでした」(closed)を出すため、誤った文言を防ぐ最小の修正として本工程に含める(completedの専用の表示はF6)

## 4. 失敗と計測

- 走査の失敗はログ`cron.sweep.failed`(layer=completion・error_code)を出して次の走査へ進む。1件ごとの失敗は`cron.item.failed`(latch_id・error_code)を出して続行する(F4aの方式・06 §2)
- 完了件数をform別に許可リストの構造化ログへ出す(`cron.completion.done`・layer=connection|occasion・count。許可リストの既存フィールドだけを使い、個人情報は含めない)

## 5. 試験

| 種類 | 確かめること |
|---|---|
| 単体 | 完了予定時刻の計算(つながり=last_message_at+90日・機会=time_window.start+3時間) |
| 統合(注入clock・D1)= #22 | ①成立時に`last_message_at`が成立時刻になる ②つながりは90日の1ミリ秒前はmatchedのまま・ちょうどでcompleted(completed_at・状態遷移の記録) ③機会は対象時刻+3時間の境界で同様(グループは最大のstarts_at) ④proposed・partial_accept・cancelled・expiredは触らない ⑤2回実行しても結果が同じ ⑥上限500件 ⑦Intentの状態とproposal_historyは変わらない ⑧離脱者がいてもLATCH全体がcompletedになる |
| API | 成立一覧にcompletedが含まれる・単一取得でcompletedでも提案内容とmembersが見える・completedへのleaveはinvalid_status |
| worker E2E = #21 | AとBのつながりIntentが成立 → 第三者Cが意味的に近いつながりIntentを登録 → AのIntentはactiveのまま、A–Cの新しい提案が記録される(stub Jev=0.9・10 §3) |

完了条件: Biome・tsc・vitest・worker E2E(既存36本+本書の追加)・web E2E(既存10本)がすべて緑。

## 6. 文書の更新(docs/00 §3)

- 01 §8: completedの境界(つながり=最終メッセージ(0件ならmatched時刻)から90日・機会=対象時刻から3時間)と、冒頭へ本書のオーナー裁定2件の決定記録
- 05 §2.2(completed_atの注記)・§3.3(成立一覧の対象status)
- 06 §2: Cron (d)の内容を機会のcompletedまで広げ、実装確定(F5)を追記
- 04 §4: Cron (d)の記述と実装工程の追記
- 10: #22の統合試験・#21のE2Eの所在
- 12 §2: F5の完了と、DELETE /v1/latches/{id}=F6・feedback=F9の担当の記録
- AGENTS.md: 現在の状態へF5の完了を追記
- 各文書の版数・変更点行・前提文書欄と00 §1の版数表を揃える
