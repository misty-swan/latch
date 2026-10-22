# LATCH マッチングパイプライン設計書

- 文書バージョン: v0.22
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.22更新: 2026-10-22)
- v0.2の変更点: 多角レビュー(loop1)の指摘を反映。実行順(候補検索→硬絞り)の確定と取り出し幅の上限100件化・つながりIntentの取りこぼし回収と保留解放のトリガー追加・提案化の直列化と再提案規則(01裁定)の反映・グループ期限切れと予算不足の挙動を確定
- v0.3の変更点: 前提文書欄の版数同期(F1実装に伴う04/05/10改版への追従)
- v0.4の変更点: 前提文書欄の版数同期(F2実装に伴う05改版への追従)
- v0.5の変更点: 前提文書欄の版数同期(03不作成裁定に伴う各前提文書の改版への追従)
- v0.6の変更点: 前提文書欄の版数同期(プロトタイプREADME §7のオーナー裁定(2026-10-19)に伴う01・02・04・05改版への追従)。内容の変更はない
- v0.7の変更点: 前提文書欄の版数同期(F2'実装に伴う04改版への追従)。内容の変更はない
- v0.8の変更点: 前提文書欄の版数同期(F2'実装に伴う05改版への追従)。内容の変更はない
- v0.9の変更点: F3実装に伴い§2へCron走査の実装形態((a)(b)(c)(e)(g)(h)+保持期間削除は評価本体の直接呼び出し・起点イベントは発行しない。イベント型intent_expired・intent_deleted・bucket_arrivedはF3では不使用(予約))を追記。§3へblocks・proposal_history照会のチャンク幅48件(D1の1文あたりバインド上限)と双方空topicの一致度1(同一扱い)を追記。§7へイベント単位の層別計測の記録先(match_events.payload+Analytics Engine+許可リストログ)を追記。前提文書欄の版数を更新
- v0.10の変更点: F4a(1対1の提案〜成立)実装に伴い§2へCronの追加走査((f)予算アラート・(i)提案クローズ後続・回答期限切れ・usage_counters 90日削除・pending残留のfailed化・バックフィルの直接評価と連続失敗の打ち切り)の実装確定を、§3のLayer 4へ実行枠と予約・予算の起点側のみ計上を、Layer 5へlatch_scoreの保存値とHの最終再検証の扱い・提案化の直列化(proposal_historyの確保を1文目に置く1バッチ)を追記。§4へ通知上限の僅少超過の許容と同時YESの1バッチ判定(機会の二重成立防止)を、§5へcircuit breakerの状態の所在(KV)を、§6へ予算の起点側のみ計上を、§7へJev・提案化の計測項目を追記。前提文書欄の版数を更新
- v0.11の変更点: F4aの最終レビューの修正に伴い§2へ保留走査の実行順(全体の期限切れ→全体の解放)・関係ユーザー対象の解放の範囲内の期限処理とチャンク分割・追加4走査の相互隔離と1件ごとの失敗の続行を、§3のLayer 4へ提案履歴で提案できない相手の事前除外(l4_skipped_history)とJev呼び出しの例外の扱いを、§5へcircuit breakerのKV書き込み方針を、§7へl4_skipped_historyを追記。前提文書欄の版数を更新
- v0.12の変更点: オーナー裁定(2026-10-20・01冒頭の決定記録)に伴い§3のLayer 4と§6へ30分再評価抑制は意味フィールドの更新で解除する旨を、§4の提案履歴と再提案へ未提示・システムの都合で閉じた提案は履歴を消費しない規定を追記。前提文書欄の版数を更新
- v0.13の変更点: F4b(グループLATCH)実装に伴い§2へグループの次集合の評価(クローズ時の呼び出し点・機会の排他によるcancelledを含む・新たなJevを使わない・照会の順序と上限)を、§3のLayer 4へ人数の条件(1対1を含む)とJev 8回の配分(1対1への最低4回保証・重なるペアの共用・枠に収まらない集合の保留・他人どうしのペアの保存と再利用)を、Layer 5へPool・Pool内のHard判定・集合の列挙と順位・aggregateと選択順・1回の評価で1集合・提案直前の再検証(versionの照合)の実装確定を追記。§4のグループの履歴規則をオーナー裁定(2026-10-20・01冒頭の決定記録)へ書き換え、§7へグループの計測項目を追記。前提文書欄の版数を更新
- v0.14の変更点: F5(つながりの性質)実装とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴い、§2のCron (d)を機会LATCHのcompleted判定(対象時刻から3時間)まで広げ、実装確定(F5)を追記した。前提文書欄の版数を更新
- v0.15の変更点: 前提文書欄の版数同期(F6a(チャットのバックエンド)実装とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴う01・02・04・05の改版への追従)。内容の変更はない
- v0.16の変更点: 前提文書欄の版数同期(F6b(チャットの画面)の完了とオーナー裁定3件(2026-10-21・01冒頭の決定記録)に伴う01・02・04・05改版への追従)。内容の変更はない
- v0.17の変更点: F7a(安全のAPI)実装に伴い§3のLayer 5の提案化の直列化へ、提案直前のブロックの照合(後続の各文の条件に参加者の全ペアのblocks行の不在を加える)を追記。前提文書欄の版数を更新
- v0.18の変更点: F7b(通知のAPI)実装に伴い、§2へ実装確定(F7b)としてCronのWeb Pushの回収走査と(c)の期限切れのアプリ内通知(intent_expired)を、§4の通知へproposal・matchedの行に送信の状態(push_state=pending)を書くことと、キューのバッチの後のWeb Pushの送出を追記した。前提文書欄の版数を更新
- v0.19の変更点: 前提文書欄の版数同期(F7c(安全と通知の画面)の完了とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴う01・02・04・05改版への追従)。内容の変更はない
- v0.20の変更点: 前提文書欄の版数同期(F8a(PWAと画面の仕上げ)の完了とオーナー合意(2026-10-21・01冒頭の決定記録(PWAと画面の仕上げ)・12 §2の決定記録(F8の2分割))に伴う01・02・04・05改版への追従)。内容の変更はない
- v0.21の変更点: F8b(stagingの構築と負荷試験)の実装確定に伴い、§7へLayer 2 Candidate Retrievalの所要時間(retrieval_ms)の記録(match_events.payloadとAnalytics Engineのdata point・負荷試験の集計(02 #33・10 §5)に使う)を追記した。前提文書欄の版数同期(F8bの完了とオーナー決定(2026-10-22・01冒頭の決定記録(stagingと負荷試験))に伴う01・02・04・05改版への追従)
- v0.22の変更点: 不具合の修正工程(issue #7・#8・#9・#10・2026-10-22オーナー合意・12 §2の決定記録(評価の流れ))に伴い、§1の図と§2の2段構成を、第1段はVectorizeへの反映を待たずに自分のベクトルを載せた`embedding_completed`を即時に投入し、別に反映確認のイベント`vector_reflection`(2・6・14・30秒、以後30秒ごと・5分で打ち切り)で新しいversionの反映を確かめてから1回だけ評価し直す順序に改めた。第2段が古いversionの`embedding_completed`を評価しないこと・Cronの(h)と反映確認の評価し直しを30分の再評価抑制の例外とすること(§2・§3・§4・§6)を書き足した。§4のWeb Pushの送出へ、Cronが評価で作った通知をその実行の中で送ること(issue #9)を書き足した。§7へ反映確認の計測(reflect_ms)と、Analytics Engineの第2段の記録を2件のdata point(`stage2`の数値15個・`stage2_group`の数値9個。1件の数値の上限20個を超えて評価全体が失敗した不具合#8の修正)に分けたことを追記した。前提文書欄の版数を更新
- 前提文書: 01 要件定義書 v0.20 / 02 スコープ・受け入れ条件合意書 v0.14 / 04 アーキテクチャ設計書 v0.23 / 05 データモデル・API仕様書 v0.23
- 本書の位置づけ: 01第11〜16節(マッチングシステム)の実装仕様を確定する。5層の絞り込み・イベント駆動・提案化・失敗と縮退を、04のCloudflare構成(Queues・Vectorize・Cron)と05のテーブルの上に定める。LLM呼び出しの内容は07が担い、本書は「いつ・何回・どの層で呼ぶか」を定める

## 1. 全体像

```text
api(POST/PATCH intents)  ※作成・draft→active化は即時投入/更新は10秒遅延
  → Queues(match_events: intent_created / intent_updated)      第1段
      → Embedding計算(07) → Vectorize登録(upsert・反映は待たない)
      → Queues(embedding_completed・自分のベクトル付き・即時)   第2段
          → Layer 2 Candidate Retrieval(Vectorize・topK=100)  ← 実行順は検索が先
          → Layer 1 Hard Filter(コード+D1・通過分から上位K_v=50)
          → Layer 3 Cheap Judge(課金ゼロ・上位K_c=20)
          → Layer 4 Jev(07・予算管理・並列実行)
          → Layer 5 LATCH Engine → 提案化(proposed) → 通知
      → Queues(vector_reflection・遅延付き)                   反映確認
          → 反映を確かめたら第2段を1回だけ評価し直す(30分抑制の例外)

Cron(毎分) → 機会: bucket到来・catch-up / 全Intent: 期限切れ /
             つながり: completed判定 / Embeddingバックフィル /
             未評価回収・遅延再評価(つながり) / 提案クローズ後続(保留昇格・次集合) /
             予算アラート
削除・期限切れ → 即時処理(候補クローズ・ベクトル削除予約。層を経ない)
```

01第12節の層番号(1〜5)は絞り込みの**概念順**であり、実行順は上図のとおり候補検索が先である。

計算量の規律(01 §11): 総当たり禁止。イベント数E×評価対象Kの秩序を維持し、Kは各層の出力上限で頭打ちにする。

## 2. イベントとトリガー

**2段構成。** 作成・更新は第1段でEmbedding計算とVectorizeへのupsertまでを処理し、Embedding完了を`embedding_completed`イベントとして再投入して第2段(Layer 1〜5)を走らせる。埋め込み未完了のIntentは生成元にも対象にもならない。Vectorizeへのupsertの反映には秒から分の単位の遅延があり得るため、**第1段は反映を待たない**(2026-10-22オーナー合意・12 §2の決定記録(評価の流れ))。第1段の順序は、upsert(metadataに意思のversionを含める・05 §2.3)→intentsのembedding_model・embedded_atの更新→`embedding_completed`(同version)の即時の投入→反映確認のイベント`vector_reflection`(同version)の遅延付き(2秒)の投入とする。`embedding_completed`のキューのメッセージには自分のベクトルを載せ(bge-m3の1024次元で約20KB・Queuesの1メッセージの上限128KB以内。match_events行のpayloadには載せない)、第2段はLayer 2 Candidate Retrievalの照会にそれを使う。反映前でも評価でき、直した意思で古いベクトルを使うこともない。ベクトルの無いメッセージ(旧形式)はVectorizeから自分のベクトルを読む。第2段は、起点Intentの現行versionと異なる`embedding_completed`を評価せずstale_versionとして処理済みにする(古いversionで評価するとlast_evaluated_atが書かれ、新しいversionの評価が30分の再評価抑制にかかるため)。

**反映確認(vector_reflection・不具合の修正工程で確定)。** 反映前に評価すると、同時に預けた相手のベクトルがまだ見えず、互いを見落とし得る。これを反映確認の評価し直しで拾う。消費のたびに、(1)意思が無い・versionが進んでいる・active以外なら評価せずskipped(not_found・stale_version・inactive)で処理済みにする。(2)自分のベクトルをVectorizeから読み、metadataのversionがイベントのversionと一致すれば反映済みとする(直した意思の古いベクトルを反映済みと誤らない)。(3)未反映で作成から5分未満なら、同じイベントを遅延付きで送り直す。確認の時点は作成から2・6・14・30秒、以後30秒ごととし、送り直しの回数はメッセージに持たず行の作成時刻からの経過で決める(定数はPIPELINE.REFLECTION_DELAYS_S・REFLECTION_GIVE_UP_MS)。(4)未反映のまま作成から5分に達したらfailed(error_code=REFLECTION_TIMEOUT)とし、以後の回収はCron(つながりIntentは(h))に委ねる。(5)反映済みなら、評価本体を**30分の再評価抑制の例外**として1回だけ呼び(照会には読んだベクトルを使う)、第2段と同じ計測項目とreflect_ms(§7)をpayloadへ記録して処理済みにする。1回きりはmatch_eventsのUNIQUE(event_type, source_intent_id, version)と処理済みの再消費スキップで保証する。同じ組のJevは同一version組のjev_resultの再利用(§3)で再実行しないため、Jevの呼び出しが増えるのは新しく見つかった組だけで、予算は通常どおり起点側に計上する(§6)。Cronのバックフィル(e)も、第1段の後に反映確認のイベントを投入する(`embedding_completed`は投入せず、評価本体を直接呼ぶ)。反映確認の投入の失敗は第1段を失敗にしない(ログだけを出し、Cronが拾う)。

**投入の即時/遅延。** 作成とdraft→active化は即時投入する(初回提案のレイテンシ優先)。**更新のみ**10秒の遅延配信とし、消費側で起点Intentの現行versionと突き合わせて古ければ破棄する。

**冪等性。** match_eventsのUNIQUE(event_type, source_intent_id, version)が二重投入を許さない。処理済みイベントの再消費はstatus=processedを確認してスキップする。

**Cron(毎分・04 §4)。** (a)機会Intentのbucket到来(starts_atが属する30分Bucket到達の未評価Intent)の再評価、(b)catch-up(expires_atまで2時間以内かつlast_evaluated_atから30分以上経過のactiveな機会Intent)、(c)全active Intentの期限切れバッチ(expired化+ベクトル削除予約)、(d)LATCHのcompleted判定(matchedのつながりLATCHは最終メッセージ(0件ならmatched時刻)から90日経過・matchedの機会LATCHは対象時刻から3時間経過・01 §8)、(e)埋め込み未完了のIntentのバックフィル再試行、(f)usage_counters集計とJev予算アラート(80%)、(g)**埋め込み済みかつ未評価(embedded_at NOT NULL かつ last_evaluated_at NULL)のactive Intentの回収再評価**(キュー消失の安全網)、(h)**active化後10分経過のつながりIntentの1回きり遅延再評価**(upsert反映遅延による相互取りこぼしの安全網。30分の再評価抑制の例外として評価する・§3)、(i)**提案クローズ後続処理**(下記)。

**提案クローズ後続処理。** 提案がクローズ(matched / expired / rejected / cancelled)した時点で、当該ユーザー(機会Intentは当該Intent)の保留candidateを提示順(機会=対象時刻の近い順/つながり=LATCH Score降順)で通知上限までproposedへ昇格し、回答期限を再計算して通知する。グループの「次集合の評価」もこのトリガーで実行する。

**実装確定(F3)。** Cron走査のうち(a)(b)(c)(e)(g)(h)と保持期間削除(05 §2.6の30日定期削除)を毎分Cronで実装する。各走査は評価本体(evaluateIntent)と第1段(Embedding処理)の**直接呼び出し**で完結し、Cronからは新たな起点イベントを発行しない(走査結果をイベント経由にすると再びキューに滞留するため)。走査は1回あたりの処理件数を上限500で頭打ちにし、(status, starts_at)・(status, expires_at)等の索引で対象を最小化する(04 §4)。match_eventsのイベント型のうちintent_expired・intent_deleted・bucket_arrivedはF3では不使用(将来のために予約)。(f)予算アラート・(i)提案クローズ後続処理はF4aで実装済み(次段落)であり、(d)LATCHのcompleted判定はF5で実装済み(下記の実装確定(F5))。

**実装確定(F4a)。** 毎分Cronに次を追加する(いずれも評価本体等の直接呼び出しで、起点イベントは発行しない)。(i)提案クローズ後続処理=回答期限切れ(proposed・partial_acceptでresponse_deadlineを過ぎたLATCHをexpiredで閉じ、有効なYESを無効化する。参加者の保留は直後の保留走査が全体で解放する)と、保留の期限切れ(保留中に参加Intentの期限を過ぎたもの・機会で対象時刻まで75分を切ったものは提示せずexpiredで閉じる)・保留の解放(通知上限の範囲で提示順にproposedへ昇格する)。提案がクローズする回答(defer・no)・成立(機会の排他によるcancelledを含む)・Intent削除・active Intentの意味フィールドの更新(05 §3.2)の時点でも、関係ユーザーを対象に同じ解放を実行する。保留走査は全体の期限切れ→全体の解放の順に実行する。関係ユーザーを対象とする解放は全体の期限切れを走らせず、対象範囲内の保留に限って期限到達・機会で対象時刻まで75分未満のものを昇格させずexpiredで閉じる(関係ユーザーの照会は50件のチャンクに分割する・D1の1文あたりバインド上限100)。(f)予算アラート=全体の1日・1か月の実行回数が上限の80%に達したら、同一period(日・月)につき1回だけ警報する(送信済みの印はKV・04 §4)。保持期間削除にusage_countersの90日削除(05 §2.2)を加える。pending残留の掃査=status=pendingのままcreated_atから10分を超えたmatch_events行をfailedへ倒す(評価失敗による残留の可視化。評価の回収は(e)(g)が担う)。(e)のバックフィルはembedding_completedを発行せずに評価本体を直接呼び出し(二重評価の解消)、Embeddingの失敗が連続5件に達したら当回の走査を打ち切る(全断時のCron時間膨張の防止)。F4aで追加した4走査(回答期限切れ・保留・予算アラート・pending残留)は互いに隔離し、1走査の失敗はログ(cron.sweep.failed・layer=走査名・error_code)を出して次の走査へ進む。保留の解放の1件ごと(昇格・閉鎖)の失敗もログ(cron.item.failed・latch_id・error_code)を出して続行する。既存の走査((a)(b)(c)(e)(g)(h)・保持期間削除)はクエリの失敗を呼び出し元へ伝播させる方針のままとする。

**実装確定(F5)。** 毎分Cronに(d)LATCHのcompleted判定を追加する(評価本体等は呼ばず、起点イベントも発行しない)。対象はstatus=matchedで、つながりLATCHは`last_message_at + 90日 ≤ now`(last_message_atは成立時に成立時刻を入れ、F6でメッセージ書き込み時に更新する・05 §2.2)、機会LATCHは`proposal.time_window.start + 3時間 ≤ now`(対象時刻・グループは全員のstarts_atの最大値。2026-10-21オーナー裁定・01冒頭の決定記録)とする。照会はつながりをlast_message_atの古い順・機会を対象時刻の古い順に、合計500件(CRON_BATCH_LIMIT)で頭打ちにする。1件ごとに状態の記録(latch_status_events: matched→completed)と状態の更新(status=completed・completed_at=now)を1バッチで書き、どちらも「今もmatchedで境界を過ぎている」で条件付ける(並行したleave・メッセージによるlast_message_atの更新と競合しても誤って閉じない・重複実行は冪等)。Intentの状態(つながり=active・機会=matched)とproposal_history(matched)は変えず、通知も作らない。走査はF4aの4走査と同じく隔離し(cron.sweep.failed・layer=completion)、1件の失敗はcron.item.failed(latch_id・error_code)を出して続行する。完了件数はform別にcron.completion.done(layer=connection|occasion・count)へ出す

**実装確定(F7b)。** (c)の期限切れバッチの第1窓は、expired化したIntentごとに本人へアプリ内通知intent_expired(intent_id付き・Web Push対象外のためpush_state=none)を1行書く。expired化の条件付きUPDATEと同じバッチに置き、UNIQUE(intent_id, type)の衝突は無視する(再実行でも1回・05 §2.2)。毎分CronにWeb Pushの回収走査(layer=push)を追加する。作成から10分を過ぎたpush_state=pendingの通知行をfailedへ倒して送らず(遅れて鳴る提案はかえって混乱を招く)、残りのうち作成から30秒以上たち、未試行または試行から60秒以上たったpendingの行を1回あたり上限100件で送る(送信の判断と順番の取り方は04 §4)。走査はF4aの4走査と同じく隔離し、失敗はcron.sweep.failedを出して次の走査へ進む

**実装確定(F4b)。** グループの次集合の評価は、グループ提案がクローズ(matched / rejected / expired / cancelled。機会の成立に伴う排他でcancelledになったグループ提案を含む)した各呼び出し点(回答・Intent削除・意味フィールドの更新・回答期限切れの走査の1件ごと)で、保留の解放の直後に行う。そのLATCHの参加Intentを含むgroup_candidatesのうちstatus=candidate・aggregate>0.60のものを、aggregate降順・id昇順で最大500件に絞って照会し(json配列の走査を有界にする)、dedup_keyのversionが全員の現行versionと一致する集合だけを§3の選択順で見て、全メンバーのHを再検証したうえで1集合だけ提案化する(新たなJevは使わない)。毎分Cronの全体走査では次集合の評価を行わない(クローズ時の呼び出しと次のイベントの評価で回収する)。失敗はログ(latches.next_group.failed)に出し、成功済みのクローズ処理を壊さない。

**pause/resume。** pauseはVectorize metadataのstatusを即時更新して新規候補化を停止する(進行中の提案は期限どおり継続し、本人は回答可能)。resumeはintent_updatedイベントを発行して再評価する。metadata更新の失敗はCronのバックフィルで回収する。

**つながりIntentはbucketを持たない。** 再評価は新規・更新Intentを起点とする候補検索と(g)(h)の安全網で完結する。catch-up・bucketは機会Intentのみ。

## 3. 5層の仕様

### Layer 2 Candidate Retrieval(Vectorize・実行の最初)

起点Intentの正規化テキスト(07 §4)をクエリとして、`filter={form, status:"active"}`付きでANN検索する。**取り出し幅はtopK=100(プラットフォーム上限。1クエリの上限を超える取得・ページングは存在しない)**。filterは最適化であり、取り出し後の判定はLayer 1が担う。

### Layer 1 Hard Filter(コード+D1 — AI不使用)

取り出した候補(最大100件)と起点Intentの組ごとに、次を**コードで**判定する。出力はpass/failのみ。**Vectorize metadataに依存せず、status・ブロック・履歴はD1の現行値で再検証する**(二重化)。D1への照会はチャンクで分割して発行する(実装確定・F3): 候補Intentの一括取得とbirth_date取得は**100件チャンク**、blocks・proposal_historyの照会は**48件チャンク**(両方向のor+outcomeのinを含む1文のバインド数がD1の上限100内に収まる値)。

| 判定 | 規則 | データ |
|---|---|---|
| form一致 | 双方のformが同一(つながり×機会は絶対不合格) | Vectorize filter+D1 |
| status | 双方active(D1現行値) | D1 |
| 自己ペア | user_id一致は不合格 | コード |
| ブロック | いずれかの方向のblocks行の存在 | D1 |
| 提案履歴 | proposal_historyにoutcomeがmatchedまたはrejectedの行の存在(恒久排除・01 §8裁定) | D1 |
| 飲酒年齢 | 機会×alcohol_involved=true は**判定時点で**両者満20歳必須(作成時と候補化時の双方で検証・08 §8) | D1 |
| 時間(機会のみ) | 開始・終了の重なりが15分以上。ends_at=nullはexpires_at(既定start+3時間)を終端とみなす | D1(intents) |
| 地域(両方添付時のみ) | bbox事前絞り+中心間距離 ≤ 半径の和 | D1+TS計算 |
| 人数 | participants区間の共通部分あり(2〜4人内) | コード |
| 予算(機会のみ) | 区間の共通部分あり | コード |

地理を片方しか添付していない組・双方未添付の組は地理判定を行わない(全国スコープ・01 §12)。判定データを欠くNG条件はSoft Constraint側(01 §5)であり、本層では扱わない。照合時にD1行が存在しない候補はfail-closeで除外する。

Layer 1通過後、**類似度上位K_v=50**を次層へ渡す(同点はULID昇順)。

### Layer 3 Cheap Judge(LLM不使用・課金ゼロ)

1対1候補の安価な事前順位付け。合成スコア= `0.7×正規化類似度 + 0.3×ルール点` とする。ルール点は (a)topic語彙の一致度(文字一致率) (b)participants区間の重なり幅 (c)地理添付時の中心間距離の近さ(未添付は中立値)、の3要素の等分。topic語彙の一致度は、双方のtopicが空(未確定)の場合は**1(同一扱い)**・片方のみ空の場合は0とする(F3実装確定)。**上位K_c=20**をLayer 4へ渡す。LLMをここに使わない理由は、コスト保護3層(04 §5)の実効性を保つため(課金発生はJev・Parser・Embeddingに限る)。

### Layer 4 Jev(07のAPIを予算内で実行)

- 実行回数上限: **1イベント処理あたりK_j=8回**(実API呼び出しごとに計上。フォールバック呼び出しも計上)。**8回は並列実行する**(直列では初回判定の10秒目標を超える)
- 配分: 1対1候補に**最低4回を保証**、残りをグループ構成ペアに割当(グループ候補がなければ1対1へ繰上げ)。**残り予算で必要ペア数(C(n,2))を判定しきれないグループ候補は部分評価を採らず保留する**(次イベントまたはjev_result再利用で完結後に提案化)
- 対象の順: Layer 3スコア降順。上限到達で残りは保留(candidateのまま)
- **実装確定(F4a)。** K_j=8は実呼び出し(フォールバックを含む)の枠である。各呼び出しの前に予算を加算して予約し、予約できた件だけを並列実行する(予算到達・circuit breakerのオープン・失敗・枠超過の分は保留として数える)。予算は**起点側(イベントを生じたIntentとそのユーザー)のみ**に計上する(相手側の予算を他人の行動で消費させないため・§6)。1対1への最低4回保証の配分はF4bで実装した(次項)。提案履歴により現時点で提案できない相手(既存行があり再提案不可=つながり・機会でdeferred/expired以外、または機会の再提案の抑制期間中)はLayer 4へ渡さず、Jevの枠と予算を使わない(除外件数はpayloadのl4_skipped_history・§7)。この除外はLayer 1の恒久排除(matched・rejected)とは別に数え、提案化の時点の履歴判定も並行時の正として残す。照会は相手ユーザー48件のチャンクで行う。Jevの呼び出しが例外を投げた場合は失敗種別otherとして扱い(フォールバック対象外)、予約済みの実行を含む評価全体を失敗させない
- **実装確定(F4b)。** 人数の条件: 人数nの提案は、nが全メンバーのparticipants区間[min, max]に入るときだけ作る。1対1(n=2)にも適用し、双方のparticipants.minが2でない候補(どちらかがmin≥3)は1対1のLayer 4へ渡さず、Jevの枠と予算を使わない(除外件数はl4_skipped_participants・§7。Layer 1の人数判定=区間の共通部分は従来どおり)。配分: 1対1の対象(提案履歴で除外されず人数の条件を満たす候補・Layer 3降順)のうちjev_resultの無い件数をN₁とし、グループの枠を 8 − min(4, N₁) とする。集合を安価な順位(Layer 5)の上から見て、jev_resultが無くまだ予定に入っていないペアの数が残りの枠に収まる集合だけを予定に入れ、収まらない集合は部分評価せず保留する(group_held_sets)。1対1には 8 − 予定に入れたグループのペア数 の枠を、未判定の対象のLayer 3降順に割り当てる(1対1の未判定分は最低min(4, N₁)回が保証される)。起点を含むペアが1対1の対象と重なる場合は1対1側の対象として1回だけ数え、共用する(二重に呼ばない)。グループ候補が無ければ8回すべてを1対1に使い、1対1の対象が4件未満なら余りをグループへ回す。1対1とグループの予定は1つの対象列(1対1を先・グループを後)にしてJevを1回だけ実行し、予算・circuit breaker・並列・フォールバックは共通部のまま起点側のみに計上する。集合を構成する他人どうしのペアもmatch_candidatesへupsertし(a<b正規化・現在のversion組・retrieval_score=Pool全員のベクトルのコサイン類似度・cheap_judge_score=Layer 3と同じ式)、jev_resultとlatch_score(Jev値・H=1)を保存して次のイベントで再利用する(保留した集合はこれで完結できる)
- 1ペア=1リクエスト(7軸を並列評価・07 §5)
- **jev_resultの再利用**: 同一バージョン組(両Intentが未更新)のmatch_candidates既存行にjev_resultがあれば再実行しない。30分再評価抑制(intents.last_evaluated_at)は別規則として併用する。ただしactive Intentの意味フィールド(topic・time・geo・participants・budget・constraints=intent_updatedを発行する変更・§2)の更新ではlast_evaluated_atをnullへ戻して抑制を解除する(表示系だけの変更では解除しない。オーナー裁定 2026-10-20・05 §3.3)。抑制は同じ内容の繰り返し評価を防ぐためのもので、条件変更で進行中の提案が取り消された直後の再提案を最大30分遅らせないためである。**抑制の例外(不具合の修正工程で確定)。** 反映確認の評価し直し(§2)とCronの(h)の遅延再評価は、抑制にかからず評価する(どちらも1回きりで、埋め込みの直後の評価に抑制されると取りこぼしの回収が空振りになるため)

### Layer 5 LATCH Engine

- H(Hard Constraint)の最終再検証(判定時点で条件が変わっていないか。**提案履歴の存在判定を含む**)を経て、`L = H × min(P(a→b), P(b→a)) × C`(C初期値1)を算出
- **L > 0.60(初期値)で提案化(proposed)**。閾値未満はcandidateのままシステム内部データ
- **実装確定(F4a)。** match_candidates.latch_scoreはJev値(H=1とした値)で保存し(閾値未満も保存する)、Hの最終再検証の不合格は「提案しない」で表す(スコアを0で上書きしない)
- **提案化はユーザーペア単位で直列に実行し、proposal_historyへの追加成功(UNIQUE)を提案化の完了条件とする。** 同一イベント処理で同一ユーザーペアの複数候補が閾値を超えた場合は、LATCH Score最大の1件のみ提案化し、残りはcandidate保持とする
- **提案化の直列化(F4a実装確定)。** proposal_historyの確保を1文目に置き、後続(latches・latch_members・latch_status_events・候補のstatus・通知)の各文を「proposal_historyにlatch_id=新LATCHの行が存在すること」(EXISTS)で条件付けた1つのD1バッチ(トランザクション)で書く。確保は、新規ペアは `INSERT … ON CONFLICT DO NOTHING`、再提案(§4)は `outcome IN (deferred, expired) AND updated_at=読み出し値` を条件とするUPDATE(楽観照合)とする。確保に失敗すれば後続はすべて0行となり何も残らない。proposal_history.latch_idの外部キーをコミット時の検査とするため、バッチ先頭で `PRAGMA defer_foreign_keys = ON` を実行する。再提案の可否(抑制期間・スコア変化・Intent更新)は読み出した値でコードが判定し、書き込み時の照合で並行更新を退ける。**提案直前のブロックの照合(F7a実装確定)。** 後続の各文の条件(確保の存在)に「参加者のどの2人の間にもblocks行が無いこと」を加え(グループは全ペア)、満たさなければLATCHを作らず、同じバッチ末尾の補償文で確保を巻き戻す。ブロックのAPIはblocks行を先に書いてから進行中の提案を取り消すため(05 §3.3)、D1の書き込みの直列化により、評価の開始後にブロックされた組でもどちらの順でもブロック後に提示が残らない
- グループ(3〜4人): Layer 1通過済の近傍から**Pool最大15**を構築(同一form・主題近接・participants整合)。全ペアのMutualScoreの最小値をaggregateとし、貪欲法で集合を選ぶ(aggregate降順・同点は小集合優先・さらにULID辞書順)。**通知は1集合のみ**。次集合の評価は提案クローズ後続処理(§2)で行う
- **実装確定(F4b)。** Pool: 起点のparticipants.max≥3のときだけグループを組み立てる(parserの既定{min:2, max:2}のIntentは1対1のみ)。Layer 1通過後の上位K_v=50からparticipants.max≥3の候補を選び、起点との安価な順位付けの点数(Layer 3の合成スコア)の降順・同点はULID昇順で最大15件をPoolとする(ベクトルの無い候補は他人どうしの類似度を出せないため除く)。Pool内の起点以外どうしの組にも、Layer 1と同じHard判定(ブロック・恒久排除・飲酒年齢・時間の重なり・地域・人数・予算・自己ペア)と提案履歴による事前除外(Layer 4と同じ規則)をかける(D1照会はPool全員分をまとめ、blocks・proposal_historyは48件チャンク)。時間・予算の全員の共通部分は別に判定しない(区間は「全ペアが重なれば全員の共通部分も同じ幅以上ある」性質を持つ。共通部分は開始が最も遅い人と終了が最も早い人の2人の重なりと一致する)。集合: 起点を含む3人・4人の組み合わせ(最大C(15,2)+C(15,3)=560通り)のうち、全ペアがHard判定を通り、人数nが全員の区間に入るものを有効とする。安価な順位は全ペアの安価な点数の最小値の降順(同点は小集合優先・さらにメンバーのULIDを昇順に並べた文字列の辞書順)で、この順にJevの配分(Layer 4)にかける。点数: 全ペアのjev_resultが揃った集合だけaggregate=全ペアのLATCH Score(min(P(a→b), P(b→a))×C)の最小値を出してgroup_candidatesへ保存する(05 §2.2)。選択: aggregate > 0.60の集合をaggregate降順・同点は小集合優先・さらにULID辞書順に見て、提案の直前に全メンバーのHをD1の現行値で再検証し(起点の読み直しと全員のversionの照合を含む。1人でも違えば次の集合へ)、提案化する。**1回の評価で提案する集合は1つだけ**で、提案化が履歴の確保に失敗したら次の集合を試し、提示または保留になった時点で止める(1対1の提案化の後に行う)。集合のlatches.scoreはaggregateとし、保留の解放の順序(つながり=score降順)も同じ値で並べる。提案化は全ペア(C(n,2)行)のproposal_historyの確保を1バッチの先頭に並べ、確保数がC(n,2)未満のときだけ働く補償文を同じバッチの末尾に置いて半端な確保を残さない(新規INSERTした行は削除・UPDATEした行は読み出した値へ戻す)。提案内容の主題・地域の基準は最初に預けられたIntent(created_at最小・同値はid昇順)、time_window・participants・budgetは全員の区間の共通部分とし、回答期限の対象時刻は全員のstarts_atの最大値・Intent期限は全員のexpires_atの最小値とする(§4の式のまま)。提示か保留かは全メンバーについて通知上限(§4)を判定し、1人でも上限なら保留する。グループ部分(Pool構築〜集合の提案)の例外は1対1の評価と提案を止めない(ログpipeline.group.failedとpayloadのgroup_failed・§7)

## 4. 提案化と通知

**回答期限の導出。** 機会= `min( max(通知+15分, min(通知+2時間, 対象時刻−60分)), 参加Intent期限の最小値 )`。つながり= `min(通知+24時間, 参加Intent期限の最小値)`(01 §8)。対象時刻まで75分を切った機会提案は通知しない。

**通知の上限と保留。** 1ユーザー1日6件・1Intent同時進行3件。超過分は破棄せず保留(candidate保持)。提示順は**機会=対象時刻の近い順/つながり=LATCH Score降順**(01 §10)。保留の解放は提案クローズ後続処理(§2)が担う。提示時に回答期限を再計算する。**上限の判定と通知の書き込みは同一文ではないため、並行消費で上限を1件程度超え得る(許容・F4a実装確定)。** 重複通知の防止として、通知ステップの前にlatch.statusを再確認し(proposed反映済みなら送信スキップ)、notificationsはUNIQUE(latch_id, user_id, type)で保護する。**Web Pushの送出(F7b実装確定)。** 通知行のうちproposal(提示・保留の解放)とmatched(成立)は送信の状態push_state=pendingで書き、主キューのバッチの後(DLQは除く)とLATCH・Intent・安全のAPIの変更系の応答の後に、同じWorker内で送出する(waitUntil・2026-10-21オーナー裁定・04 §4)。送出の失敗はキューの消費とAPIの応答に影響させず、送れていない行はCronの回収走査(§2)が拾う。毎分Cronが評価本体を直接呼んで作った通知((a)(b)(e)(g)(h)・保留の解放・次集合の提案)は、それらの走査の後に、その回のCronの開始以後に作られたpending行をその実行の中で送る(30秒以上たった行を拾う回収走査は送り損ねの安全網として残す。他の走査と隔離する・issue #9・不具合の修正工程で確定)。notification_level=mutedの参加Intentを持つ本人にはWeb Pushを送らず、アプリ内通知の行と通知上限の数え方は変えない(01冒頭の決定記録(2026-10-21・通知のAPI))。

**反映を待つ提案(不具合の修正工程で確定)。** 同時に預けた2人の提案は、先に評価した側から相手がまだ見えないとき、反映確認の評価し直し(§2)で作られる。このとき提案はVectorizeの反映にかかった時間だけ遅れる(反映の時間はreflect_ms・§7)。評価し直しは30分の再評価抑制の例外(§3)であり、通知上限・保留・回答期限の規則は通常の評価と同じに当てる。

**同時通知・開示。** 必要人数全員へ同時通知。不成立時の開示は「この提案は成立しませんでした」の一文のみ。

**同時YES(F4a実装確定)。** 回答の記録・状態遷移の記録・状態の更新を1つのD1バッチで行い、YES数をDB内で数えてmatched/partial_acceptを決める(並行するYESの取りこぼし・二重遷移を防ぐ)。機会LATCHのyesには「参加Intentにmatchedが無い」条件を加え、成立時の参加Intentのmatched化も同じバッチ内で行う(同一機会Intentの二重成立を防ぐ・02 §4の#23)。

**排他(機会のみ)。** あるIntentのLATCH成立時点で、そのIntentを含む回答待ち提案はすべてcancelled。つながりは排他なし(成立後active復帰・複数成立可)。

**提案履歴と再提案(01 §8裁定)。** 提案の生成にはproposal_historyの追加を伴う。恒久排除は**outcomeがmatched(成立)またはrejected(明示の拒否no)の履歴**だけで行う。deferred(見送り)・expired(回答期限切れ)の履歴は排除対象とせず、機会Intentに限り、見送り後 min(24時間, 対象時刻までの残時間の半分) の抑制期間を経て、スコア変化またはどちらかのIntent更新を条件に再提案する(prev_latch_scoreとの比較でスコア変化を判定)。抑制期間の基準はproposal_history.updated_at(見送り・期限切れの時刻)とし、「Intent更新」はどちらかのIntentのupdated_atが前回LATCHのcreated_atより後であることで判定する(updated_atはversionと同時に進む・F4a実装確定)。つながりIntentへの再提案は行わない(提示された提案についての規則)。**未提示・システムの都合で閉じた提案は履歴を消費しない(オーナー裁定 2026-10-20・F4a実装確定)。** 一度も提示しないまま閉じた保留(保留中の期限切れ・機会で対象時刻まで75分を切ったもの・参加Intentの終了)と、機会の排他・Intent削除・意味フィールドの変更(Hard Constraintの変化)で閉じた提案は、そのLATCHのために新規に確保したproposal_history行を削除してペアを未提案に戻し、再提案で確保した既存行はexpiredに戻す(05 §2.2)。提示後の回答期限切れ・defer・noは従来どおりexpired / deferred / rejectedを記録する。**グループ提案が回答期限までに必要人数に届かなかった場合はexpiredで閉じ、既存のYESは無効(次提案に持ち越さない)。**提案履歴は有効なyesを持たない参加者を含むペアだけをexpiredで記録し、yesどうしのペアは消費しない(オーナー裁定 2026-10-20・01冒頭の決定記録・F4b実装確定)。グループ提案がdefer / noで閉じた場合は、閉じた本人を含むペアだけをdeferred / rejectedで記録し、本人を含まないペアは消費しない(同裁定。ペア別の記録の一覧は05 §2.2)。再提案の可否はペアごとに上記の規則を当て(1ペアでも再提案不可なら集合を提案しない)、スコア変化はペアの既存行が指す前回LATCH(1対1・集合を問わない)のscoreと今回の点数で判定する。1つのペアは同時に1つの進行中LATCHにしか属せないため、1対1の提案が進行中のペアを含む集合は、その提案が閉じるまで提案されない。恒久排除はペア単位であり、1対1で成立(またはno)したペアを含む集合は以後作られない。

## 5. 失敗と縮退(誤提案より非提示を優先)

| 障害 | 挙動 |
|---|---|
| Jev timeout/429/529 | フォールバックLLMへ切替(07)。フォールバックも失敗なら候補は保留 |
| Jevの連続失敗 | circuit breaker: 5分窓で10連続失敗で30分オープン(期間中はJev実行せず保留)。状態はKV(バインディングPIPELINE_KV・05 §2.3)に置く。状態の書き込みは1波の結果をまとめて最大1回とし、状態が変わらないときは書かない(KVの同一キーへの書き込みは1秒に1回まで・04 §4)。KVの読み書きの失敗は評価を止めない(読めなければ閉とみなし、書けなければログを出して続行) |
| Embedding失敗 | 再試行なし。Intentは未登録のまま、Cronのバックフィルが回収 |
| Queues消費失敗 | プラットフォームの再試行(max_retries=3)ののちDLQ(dead)へ。DLQを見る最小のconsumerがmatch_eventsへdead反映し警報する(04 §4)。再処理はUNIQUE衝突を避けるため新規イベントとして再発行する(手動) |
| Jev予算到達 | 対象外は保留(提案化しない)。アラートはCronが検知 |

## 6. コスト保護(3層)と予算計上

API源流レート制限・Jev予算(1Intentあたり1日40回・1ユーザーあたり1日120回・30分抑制(意味フィールドの更新で解除・反映確認の評価し直しと(h)は例外・§3))・実行回数上限(1日30,000回・1か月600,000回・80%アラート)は04 §5の表どおり、usage_countersで実装する。**実API呼び出し(フォールバック切替を含む)をすべて計上する**規則を適用する。1Intentあたり・1ユーザーあたりの予算は**起点側(イベントを生じたIntentとそのユーザー)のみ**に計上する(相手側の予算を他人の行動で消費させない・F4a実装確定)。

## 7. 観測(Analytics Engine+D1集計)

各層の通過件数(Vectorize取得→L1通過→L2確定→L3通過→Jev実行→提案化)と**Layer 1の除外理由別内訳**・Jev回数/latency/費用・LATCH Score分布・提示数・回答率・保留→expired率・**Embedding未完・未評価の滞留件数**・DLQ件数を、イベント単位で記録する。02の#35(Analytics)・#7(総当たり禁止の観察)・#11〜#13/#26(非生成の証明)の証拠はこの計測が担う。

**実装確定(F3)。** 第2段(評価)の結果は、起点イベント(embedding_completed)の行のmatch_events.payloadへ記録する。記録するのは層通過件数(retrieval_count / l1_pass / l1_exclusions(Layer 1の除外理由別内訳) / l3_pass)と処理済み判定の理由(抑制・対象外はskipped理由・旧versionはstale_version)であり、raw_text・座標は格納しない(05 §2.5)。あわせてAnalytics Engine(dataset=latch_metrics・バインディング=PIPELINE_AX)へ層通過のdata pointをイベント単位で書き、処理結果は許可リストの構造化ログ(04 §4)に出力する。バインド未設定の環境(単体試験等)では送信を省略し例外を出さない。

**実装確定(F4a)。** payloadにJev・提案化の項目を加える: l4_skipped_history(提案履歴により提案できずLayer 4へ渡さなかった件数・§3) / jev_calls(実呼び出し回数) / jev_reused(jev_resultの再利用件数) / jev_held(保留の理由別内訳=budget・breaker・failed・cap) / jev_latency / l5_over_threshold(L>0.60の件数) / proposed(提示した件数) / held_proposals(通知上限で保留した件数)。#14・#15の証拠はこの記録とmatch_candidates.jev_resultが担う。

**実装確定(F4b)。** payload(とAnalytics Engineのdata point)にグループの項目を加える: l4_skipped_participants(人数の条件で1対1のLayer 4へ渡さなかった件数・§3) / group_pool(Poolの件数。グループを組み立てない・グループ部分の失敗では0) / group_sets(列挙で得た有効な集合の数) / group_jev_calls(グループのペアとしてJevへ渡した件数。1対1の対象と重なるペアは1対1側で数える) / group_held_sets(判定しきれず保留した集合の数=配分の枠に収まらなかった集合+Jevの判定が欠けた集合) / group_over_threshold(aggregate>0.60の集合の数) / group_proposed(提示した集合の数=0または1) / group_held_proposals(通知上限で保留した集合の数=0または1) / group_failed(グループ部分で例外が起きたら1)。jev_reusedはLayer 4へ渡した行のうちjev_resultを再利用した件数だけを数える(集合の点数の計算で既存のjev_resultを読む分は数えない)。#24の証拠はこの記録とLATCH・提案履歴の観測(05 §3.3のdev専用API)が担う。

**実装確定(F8b)。** payload(とAnalytics Engineの`stage2`のdata pointの最後の数値)にLayer 2 Candidate Retrievalの所要時間を加える: retrieval_ms(Vectorizeへの問い合わせ(topK=100・§3)の所要時間・ミリ秒)。所要時間は処理時間の計測であり時刻依存のロジックではないため、Clockではなく`performance.now()`の差で測る。Cronが評価本体を直接呼ぶ経路(§2)では、payloadへは書かれずAnalytics Engineのdata pointにだけ載る。負荷試験(02 #33・10 §5)のCandidate Retrieval p95 1秒の集計はこの値を使う。D1の形は変わらない(マイグレーションは無い)

**実装確定(不具合の修正工程)。** Analytics Engineの1つのdata pointは数値(doubles)を20個までしか持てず、超えると書き込みが例外を投げて評価全体が失敗する(issue #8。F4bの項目とF8bのretrieval_msで24個になっていた)。第2段の記録はイベントごとに2件のdata pointに分ける: `stage2`(文字列=処理段の識別・Layer 1の除外理由別内訳。数値=層通過件数(Vectorize取得→L1→L3)・処理時間・Jev(呼び出し・再利用・保留の理由別4項目・処理時間)・L5閾値超過・提示・保留・retrieval_msの15個)と、`stage2_group`(数値=F4bのグループの9項目)。反映確認(§2)のmatch_events行のpayloadには、評価し直した結果の第2段と同じ項目と、reflect_ms(反映確認のイベントの作成から反映を確かめるまでのミリ秒)を記録する(評価しなかったときはskipped=not_evaluatedとreflect_ms)。reflect_msは負荷試験の集計(10 §5)で本物のVectorizeの反映時間の参考値として使い、01 §20に目標値は無いため合否は付けない。D1の形は変わらない(event_typeはCHECK制約の無いTEXT列のため、`vector_reflection`の追加にマイグレーションは要らない・05 §2.2)

## 8. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-C-01 | topK=100(上限固定)に対するK_v=50の妥当性(L1通過率の実測後の調整) | 運用開始後、L1通過率が50/100を下回るようならLayer 3の配分を減らすか起点側のクエリ分割を検討する(topKの増加は不可) |
| D-C-02 | Layer 3ルール点の重み(0.7/0.3と3要素等分) | 運用データでOffline評価により調整 |
