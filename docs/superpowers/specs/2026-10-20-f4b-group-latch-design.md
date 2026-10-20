# F4b グループLATCH 設計書

- 作成日: 2026-10-20
- 対象: docs/12 §2 のF4「Jevと提案」を3分割したうちの F4b(グループLATCH・バックエンド)
- 正本: docs/01 §8・§10・§15 / docs/05 §2.2・§3.3 / docs/06 §2〜§4・§7 / docs/02 §4(#24)
- 前段: docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md(F4a・本書はその上に載る)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提

### 0.1 目的とゲート

02 §4の#24「3〜4人の集合(つながり・機会の双方)で必要人数のYESを揃える → 必要人数のmatched成立」をworker E2Eで証明する。画面はF4cの担当であり、F4bはバックエンドのみを扱う。

### 0.2 オーナー裁定(2026-10-20・本書のブレインストーミング)

| # | 決定内容 | 根拠 |
|---|---|---|
| 1 | グループ提案がdefer / noで閉じたとき、提案履歴は **閉じた本人を含むペアだけ** を記録する(defer=deferred・no=rejected)。本人を含まないペアは履歴を消費しない(新規確保の行は削除・再提案で確保した既存行はexpiredに戻す=F4aの"release"と同じ扱い) | 本人以外の組は意思表示をしていない。つながりIntentは既存行があれば再提案しないため、全ペアを記録すると本人以外の2人が以後1対1でも出会えなくなる |
| 2 | グループ提案が回答期限までに必要人数に届かず閉じたとき(expired)、**有効なyesを持たない参加者を含むペアだけ** をexpiredで記録する。yesどうしのペアは履歴を消費しない。06 §4の「同ペア間の提案履歴は通常どおり記録される」を書き換える | 裁定1と同じ考え方(互いにyesだった組は相手を拒んでいない) |
| 3 | 成立後の参加取り消し(leave)は、抜けた本人だけをLATCHから外し、残りの参加者数が提案内容の人数の下限(proposal.participants.min)を割った場合にLATCH全体をcancelledとする(05 §3.3の記述どおり) | 05 §3.3の既定。1対1は1人抜けると下限2を割るため、F4aと同じ挙動になる |

### 0.3 F4bで行わないこと

提案〜成立の画面(F4c)・チャットの読み取り専用化(F6)・Web Push送信と`GET /v1/notifications`(F7)・Parser/Jevのreal接続(F9前の独立工程)。

## 1. 構成(案A: 評価本体の中でグループも作る)

F4aの`evaluateIntent`(L2→L1→L3→match_candidates保存→L4→L5→提案化)の中で、1対1と並行してグループの集合を組み立てる。キュー段は増やさない(1イベント処理あたりK_j=8の配分を1か所で行うため・06 §3)。

| 配置 | 責務 |
|---|---|
| `src/pipeline/group.ts`(新設) | Pool構築・Pool内ペアのHard判定・集合の列挙と安価な順位・Jev配分の計画・集合の点数と選択(純関数中心) |
| `src/pipeline/evaluate.ts` | グループ部分の呼び出し・1対1とグループのJev対象の統合・group_candidatesの保存 |
| `src/latches/propose.ts` | `proposePair`を`proposeSet`(2〜4人)へ一般化。1対1は人数2の集合として同じ道を通る |
| `src/latches/content.ts`・`deadline.ts` | 提案内容・回答期限・対象時刻・期限最小値をn人へ一般化 |
| `src/latches/close.ts` | ペアごとに記録内容を変える履歴更新(§3.2) |
| `src/latches/release.ts` | 保留の解放をn人へ一般化・次集合の提案(§2.4) |
| `src/latches/respond.ts` | defer/no/期限切れの履歴規則の呼び分け・leaveの一般化(§3.4) |
| `src/routes/latches.ts`・`src/latches/view.ts` | 離脱者の扱い(一覧・単一取得・members) |

案B(グループ専用のキュー段)・案C(既存のjev_resultだけで集合を作る)は不採用。理由: BはK_j=8の枠が段をまたいで数えにくく状態が増える。Cはグループがほぼ成立せず、06 §3の「残りをグループ構成ペアに割当」と合わない。

## 2. 集合の作り方とJevの配分

### 2.1 人数の条件(1対1にも適用)

- 人数nの集合は、**nが全メンバーのparticipants区間[min, max]に入っている** ときだけ作る
- 1対1(n=2)にも同じ規則を当てる。F4aは区間の重なりだけを見ていたため、双方min≥3でも1対1が提案され得た。F4bで「双方のparticipants.min=2」を1対1の提案条件に加える(Layer 4の対象選択の前に除外し、Jevの枠を使わない。除外件数はpayloadで数える・§5)
- 起点Intentのparticipants.max≥3のときだけグループを組み立てる。parserの既定は{min:2,max:2}のため、人数を明示しないIntentは従前どおり1対1のみ

### 2.2 Pool構築とPool内の判定

1. Layer 1通過後の上位K_v=50(evaluate.tsの`l1Top`)から、participants.max≥3の候補を選ぶ
2. 起点との安価な順位付けの点数(Layer 3と同じ`cheapJudgeScore`)の降順・同点はULID昇順で **最大15件** をPoolとする(06 §3のPool最大15・同一formはLayer 2/1で保証済み)
3. Pool内の起点以外どうしの組(最大105組)に、`layer1Judge`と同じHard判定をかける(ブロック・提案履歴の恒久排除・飲酒年齢・時間の重なり・地域・人数・予算・自己ペア)。D1照会はPool全員分をまとめて行う(blocks・proposal_historyは48件チャンク・06 §3)
4. 他人どうしの類似度は、Vectorizeから取得したPool全員のベクトル(`getByIds`)のコサイン類似度で計算し、Layer 3と同じ式で安価な点数を出す

### 2.3 集合の列挙と有効性

- 起点を含む3人・4人の組み合わせを列挙する(最大 C(15,2)+C(15,3)=560通り)
- 有効な集合: 全ペアがHard判定を通過・人数nが全員の区間内。時間・予算の全員の共通部分は別に判定しない(区間は「全ペアが重なれば全員の共通部分も同じ幅以上ある」性質を持つため、ペアごとのLayer 1判定で足りる。共通部分は、開始が最も遅い人と終了が最も早い人の2人の重なりと一致する)
- 安価な順位 = 全ペアの安価な点数の最小値。降順・同点は小集合優先・さらにメンバーのULIDを昇順に並べた文字列の辞書順

### 2.4 Jev 8回の配分(06 §3)

1. 1対1の対象(§2.1の人数条件を満たし、提案履歴で除外されない候補・Layer 3降順)を数える
2. 1対1の枠 = min(1対1の対象数, max(4, 8 − グループが求めるペア数))。グループ候補が無ければ8回すべてを1対1に使う。1対1の対象が4件未満なら余りをグループへ回す
3. グループの枠 = 8 − 1対1の枠。安価な順位の上から集合を見て、「jev_resultが無く、まだ予定に入っていないペア数」が残りの枠に収まる集合だけを予定に入れる。収まらない集合は部分評価せず保留(payloadで数える)。起点とのペアが1対1の予定と重なる場合は共用する(二重に呼ばない)
4. 1対1とグループの予定を1つの対象列(1対1を先・グループを後)にして`runJev`を1回だけ呼ぶ(予算・circuit breaker・並列・フォールバックは共通部のまま・起点側のみ計上)
5. 他人どうしのペアもmatch_candidatesへupsertし(a<b正規化・現在のversion組・retrieval_score=コサイン類似度・cheap_judge_score)、jev_resultとlatch_score(Jev値・H=1)を保存する。次のイベントで再判定せず再利用するため(保留した集合はこれで完結できる・06 §3)

### 2.5 集合の点数と選択(Layer 5)

- 全ペアのjev_resultが揃った集合だけ、aggregate = 全ペアの`latchScore`(min(P(a→b), P(b→a))×C)の最小値を計算し、group_candidatesへ保存する(UNIQUE=dedup_key。衝突時はaggregate_scoreのみ更新・statusは保持)
- aggregate > 0.60 の集合を、aggregate降順・同点は小集合優先・さらにULID辞書順で並べ、提案の直前に全メンバーのHardを再検証する(起点の読み直しを含む・F4aの`recheckHard`をn人へ拡張)
- **1回の評価で提案する集合は1つだけ**。`proposeSet`が履歴確保に失敗(skipped)したら次の集合を試し、proposed または held になった時点で止める
- 提案した集合のgroup_candidates.statusはproposedにする

## 3. 提案化・回答・クローズ

### 3.1 提案化(`proposeSet`)

- **履歴の確保**: 全ペア(C(n,2)行)の確保を1つのD1バッチの先頭に並べる(新規はINSERT ON CONFLICT DO NOTHING・再提案は楽観照合のUPDATE・F4aと同じ)。後続(latches・latch_members・latch_status_events・match_candidates/group_candidatesのstatus・notifications)は「latch_id=新idの履歴行の数=C(n,2)」で条件付ける
- **一部だけ確保できた場合の巻き戻し**: 同じバッチの末尾に、確保数がC(n,2)未満のときだけ働く補償文を置く(新規INSERTした行は削除・UPDATEした行は読み出した値(outcome・latch_id・updated_at)へ戻す)。半端な確保を残さない
- **再提案の可否**: ペアごとにF4aの規則をそのまま使う(つながりは既存行があれば不可・機会はdeferred/expiredかつ抑制期間経過)。変化の条件は「前回LATCHのscoreと今回の点数の差が0でない、またはどれかのIntentのupdated_atが前回LATCHのcreated_atより後」(前回LATCHはペアごとの既存行のlatch_id。1対1・集合を問わない)。集合の点数はgroup_candidates.prev_aggregate_scoreにも記録する
- **latches.score**: 1対1はL(F4aのまま)、集合はaggregate。保留の解放の順序(つながり=score降順)も同じ値で並べる
- **提示か保留か**: 全メンバーが当日のproposal通知6件未満、かつ全メンバーのIntentが進行中3件未満なら提示(全員へ同時通知)。誰か1人でも上限なら保留(F4a §3.3をn人へ拡張)
- **提案内容**: 主題・地域の基準=最初に預けられたIntent(created_at最小・同値はid昇順)。time_window=全員の時間の共通部分。participants・budget=全員の区間の共通部分
- **回答期限**: F4aの式のまま。対象時刻=全員のstarts_atの最大値・Intent期限=全員のexpires_atの最小値。機会で対象時刻まで75分未満なら提案しない

### 3.2 ペアごとの履歴記録(オーナー裁定1・2)

`closeLatch`の履歴指定を、ペアごとに記録内容を決められる形へ拡張する。

| 閉じ方 | 記録するペア | それ以外のペア |
|---|---|---|
| defer(本人X) | Xを含むペア → deferred | release(消費しない) |
| no(本人X) | Xを含むペア → rejected(恒久排除) | release |
| 回答期限切れ | 有効なyesを持たない参加者を含むペア → expired | release |
| 排他・Intent削除・意味フィールドの変更・未提示の保留の終了 | — | 全ペア release(F4aと同じ) |
| 成立(matched) | 全ペア → matched | — |
| leave | 変更しない(matchedのまま) | — |

1対1では唯一のペアが常に「本人を含むペア」であり、期限切れのペアは必ず非yesの参加者を含む(双方yesなら成立済み)ため、F4aの挙動と一致する。

### 3.3 回答・取り消し

- yes: F4aの「有効なyesの数=参加人数でmatched」をそのまま使う(人数に依存しない)。機会の成立時の参加Intentのmatched化と排他も同じ
- retract: 他にyesが残ればpartial_acceptのまま、残らなければproposedへ戻す(F4aの実装のまま)
- defer / no / 期限切れ: §3.2の規則で履歴を記録する

### 3.4 成立後の離脱(オーナー裁定3)

- `latch_members`に`left_at`(datetime | null)を追加する。マイグレーションは戻す手順と対で作る(12 §4)
- leaveは、離脱後の残り人数(left_atがnullの参加者数)がproposal.participants.minを割るならLATCH全体をcancelled(F4aと同じclosed通知なし)とし、割らなければ本人のleft_atを記録してmatchedのまま続ける。判定と記録は1つのD1バッチで行い、並行した離脱でも下限割れを取りこぼさない
- 離脱者の提案履歴はmatchedのまま。機会Intentはmatchedのまま(F4aと同じ)
- 離脱者から見たLATCHは非参加と同じ扱い(一覧から除外・単一取得と各操作は404)。残りの参加者に返すmembersからも除く
- 参加者を数える処理(回答のyes数との比較・通知・保留の解放・提示の上限判定)は、離脱はmatched後にしか起きないため成立前の判定に影響しない。成立後の表示・離脱判定ではleft_atがnullの参加者だけを数える

### 3.5 次集合の評価(06 §2の(i))

- グループ提案がクローズ(matched / rejected / expired / cancelled)したとき、保留の解放と同じ呼び出し点で、メンバーのIntentを含むgroup_candidatesのうち status=candidate・aggregate>0.60 のものから、§2.5の順で次の1集合を提案する(新たなJevは使わない)。提案前に全メンバーのHardを再検証する
- 毎分Cronの全体走査では次集合の評価を行わない(クローズ時の呼び出しと、次のイベントの評価で回収する)

### 3.6 既知の帰結

- 恒久排除はペア単位のため、1対1で成立(またはno)したペアを両方含む集合は以後作られない。グループで成立した場合も全ペアが恒久排除になる
- 1つのペアは同時に1つの進行中LATCHにしか属せない(proposal_historyの1ペア1行)。1対1の提案が進行中のペアを含む集合は、その提案が閉じるまで提案されない

## 4. API

新しいAPIは作らない。`/v1/latches`系がそのまま2〜4人に対応する。成立前の応答の`participants_count`が3・4になるだけで、相手の情報・proposalを出さない規則(#20)も同じ。離脱者の扱いは§3.4。

## 5. 失敗と縮退・計測

- Jevの失敗・予算到達・circuit breakerで判定が欠けた集合はaggregateを出さず保留する(部分評価をしない・06 §3)
- グループ部分(Pool構築〜集合の提案)で例外が起きても1対1の評価と提案は止めない。失敗はログ(pipeline.group.failed・error_code)とpayloadに記録する
- payload(match_events)とAnalytics Engineに追加する項目: `l4_skipped_participants`(人数条件で1対1から除外した件数)/ `group_pool` / `group_sets`(有効な集合数)/ `group_jev_calls` / `group_held_sets`(判定しきれず保留した集合数)/ `group_over_threshold` / `group_proposed`(0または1)/ `group_held_proposals`(通知上限で保留した数)
- ログは許可リストのみ(個人情報を出さない)

## 6. 試験

- **単体**: 人数条件・Pool選択・集合の列挙と有効性(人数条件・ペアのHard判定)・安価な順位・Jev配分(最低4回保証・繰り上げ・共用・枠に収まらない集合の保留)・aggregateと選択順・提案内容と回答期限のn人化・履歴記録のペア別判定
- **統合**(vitest-pool-workers): 全ペアの履歴確保と一部失敗時の巻き戻し・defer/no/期限切れのペア別記録・離脱の継続と全体取消・次集合の提案・双方min≥3のペアに1対1を出さない・group_candidatesの保存とjev_resultの再利用
- **E2E(#24)**: 3人のつながり集合と4人の機会集合で全員yes→matched。あわせて1人のdeferで閉じる・期限切れで閉じる(backdate)を確認する

## 7. 文書の更新(docs/00 §3)

- 01: §0.2のオーナー裁定3件の決定記録(決定内容/根拠/影響)
- 05: latch_members.left_at・group_candidatesの利用の実装確定・leaveの規則・ペア別の履歴記録
- 06: §3の人数条件・Pool・集合列挙・Jev配分・選択の実装確定、§4のグループの履歴規則の書き換え、§7の計測項目
- 12: F4bの完了記録
- AGENTS.md: 「現在の状態」にF4bの完了を追記
- 版数・変更点行・前提文書欄・00 §1の版数表を揃える
