# LATCH マッチングパイプライン設計書

- 文書バージョン: v0.10
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.10更新: 2026-10-20)
- v0.2の変更点: 多角レビュー(loop1)の指摘を反映。実行順(候補検索→硬絞り)の確定と取り出し幅の上限100件化・つながりIntentの取りこぼし回収と保留解放のトリガー追加・提案化の直列化と再提案規則(01裁定)の反映・グループ期限切れと予算不足の挙動を確定
- v0.3の変更点: 前提文書欄の版数同期(F1実装に伴う04/05/10改版への追従)
- v0.4の変更点: 前提文書欄の版数同期(F2実装に伴う05改版への追従)
- v0.5の変更点: 前提文書欄の版数同期(03不作成裁定に伴う各前提文書の改版への追従)
- v0.6の変更点: 前提文書欄の版数同期(プロトタイプREADME §7のオーナー裁定(2026-10-19)に伴う01・02・04・05改版への追従)。内容の変更はない
- v0.7の変更点: 前提文書欄の版数同期(F2'実装に伴う04改版への追従)。内容の変更はない
- v0.8の変更点: 前提文書欄の版数同期(F2'実装に伴う05改版への追従)。内容の変更はない
- v0.9の変更点: F3実装に伴い§2へCron走査の実装形態((a)(b)(c)(e)(g)(h)+保持期間削除は評価本体の直接呼び出し・起点イベントは発行しない。イベント型intent_expired・intent_deleted・bucket_arrivedはF3では不使用(予約))を追記。§3へblocks・proposal_history照会のチャンク幅48件(D1の1文あたりバインド上限)と双方空topicの一致度1(同一扱い)を追記。§7へイベント単位の層別計測の記録先(match_events.payload+Analytics Engine+許可リストログ)を追記。前提文書欄の版数を更新
- v0.10の変更点: F4a(1対1の提案〜成立)実装に伴い§2へCronの追加走査((f)予算アラート・(i)提案クローズ後続・回答期限切れ・usage_counters 90日削除・pending残留のfailed化・バックフィルの直接評価と連続失敗の打ち切り)の実装確定を、§3のLayer 4へ実行枠と予約・予算の起点側のみ計上を、Layer 5へlatch_scoreの保存値とHの最終再検証の扱い・提案化の直列化(proposal_historyの確保を1文目に置く1バッチ)を追記。§4へ通知上限の僅少超過の許容と同時YESの1バッチ判定(機会の二重成立防止)を、§5へcircuit breakerの状態の所在(KV)を、§6へ予算の起点側のみ計上を、§7へJev・提案化の計測項目を追記。前提文書欄の版数を更新
- 前提文書: 01 要件定義書 v0.10 / 02 スコープ・受け入れ条件合意書 v0.4 / 04 アーキテクチャ設計書 v0.11 / 05 データモデル・API仕様書 v0.10
- 本書の位置づけ: 01第11〜16節(マッチングシステム)の実装仕様を確定する。5層の絞り込み・イベント駆動・提案化・失敗と縮退を、04のCloudflare構成(Queues・Vectorize・Cron)と05のテーブルの上に定める。LLM呼び出しの内容は07が担い、本書は「いつ・何回・どの層で呼ぶか」を定める

## 1. 全体像

```text
api(POST/PATCH intents)  ※作成・draft→active化は即時投入/更新は10秒遅延
  → Queues(match_events: intent_created / intent_updated)      第1段
      → Embedding計算(07) → Vectorize登録(upsert完了確認後)
      → Queues(embedding_completed)                            第2段
          → Layer 2 Candidate Retrieval(Vectorize・topK=100)  ← 実行順は検索が先
          → Layer 1 Hard Filter(コード+D1・通過分から上位K_v=50)
          → Layer 3 Cheap Judge(課金ゼロ・上位K_c=20)
          → Layer 4 Jev(07・予算管理・並列実行)
          → Layer 5 LATCH Engine → 提案化(proposed) → 通知

Cron(毎分) → 機会: bucket到来・catch-up / 全Intent: 期限切れ /
             つながり: completed判定 / Embeddingバックフィル /
             未評価回収・遅延再評価(つながり) / 提案クローズ後続(保留昇格・次集合) /
             予算アラート
削除・期限切れ → 即時処理(候補クローズ・ベクトル削除予約。層を経ない)
```

01第12節の層番号(1〜5)は絞り込みの**概念順**であり、実行順は上図のとおり候補検索が先である。

計算量の規律(01 §11): 総当たり禁止。イベント数E×評価対象Kの秩序を維持し、Kは各層の出力上限で頭打ちにする。

## 2. イベントとトリガー

**2段構成。** 作成・更新は第1段でEmbedding要求までを処理し、Embedding完了を`embedding_completed`イベントとして再投入して第2段(Layer 1〜5)を走らせる。埋め込み未完了のIntentは生成元にも対象にもならない。Vectorizeへのupsert反映は秒単位の遅延があり得るため、**upsert完了を確認してから**`embedding_completed`を投入する順序を守る。

**投入の即時/遅延。** 作成とdraft→active化は即時投入する(初回提案のレイテンシ優先)。**更新のみ**10秒の遅延配信とし、消費側で起点Intentの現行versionと突き合わせて古ければ破棄する。

**冪等性。** match_eventsのUNIQUE(event_type, source_intent_id, version)が二重投入を許さない。処理済みイベントの再消費はstatus=processedを確認してスキップする。

**Cron(毎分・04 §4)。** (a)機会Intentのbucket到来(starts_atが属する30分Bucket到達の未評価Intent)の再評価、(b)catch-up(expires_atまで2時間以内かつlast_evaluated_atから30分以上経過のactiveな機会Intent)、(c)全active Intentの期限切れバッチ(expired化+ベクトル削除予約)、(d)つながりLATCHのcompleted判定(matchedで最終メッセージ(0件ならmatched時刻)から90日経過)、(e)埋め込み未完了のIntentのバックフィル再試行、(f)usage_counters集計とJev予算アラート(80%)、(g)**埋め込み済みかつ未評価(embedded_at NOT NULL かつ last_evaluated_at NULL)のactive Intentの回収再評価**(キュー消失の安全網)、(h)**active化後10分経過のつながりIntentの1回きり遅延再評価**(upsert反映遅延による相互取りこぼしの安全網)、(i)**提案クローズ後続処理**(下記)。

**提案クローズ後続処理。** 提案がクローズ(matched / expired / rejected / cancelled)した時点で、当該ユーザー(機会Intentは当該Intent)の保留candidateを提示順(機会=対象時刻の近い順/つながり=LATCH Score降順)で通知上限までproposedへ昇格し、回答期限を再計算して通知する。グループの「次集合の評価」もこのトリガーで実行する。

**実装確定(F3)。** Cron走査のうち(a)(b)(c)(e)(g)(h)と保持期間削除(05 §2.6の30日定期削除)を毎分Cronで実装する。各走査は評価本体(evaluateIntent)と第1段(Embedding処理)の**直接呼び出し**で完結し、Cronからは新たな起点イベントを発行しない(走査結果をイベント経由にすると再びキューに滞留するため)。走査は1回あたりの処理件数を上限500で頭打ちにし、(status, starts_at)・(status, expires_at)等の索引で対象を最小化する(04 §4)。match_eventsのイベント型のうちintent_expired・intent_deleted・bucket_arrivedはF3では不使用(将来のために予約)。(f)予算アラート・(i)提案クローズ後続処理はF4aで実装済み(次段落)であり、**(d)つながりLATCHのcompleted判定はF5で計上する(12)。**

**実装確定(F4a)。** 毎分Cronに次を追加する(いずれも評価本体等の直接呼び出しで、起点イベントは発行しない)。(i)提案クローズ後続処理=回答期限切れ(proposed・partial_acceptでresponse_deadlineを過ぎたLATCHをexpiredで閉じ、有効なYESを無効化し、参加者の保留を解放する)と、保留の期限切れ(保留中に参加Intentの期限を過ぎたもの・機会で対象時刻まで75分を切ったものは提示せずexpiredで閉じる)・保留の解放(通知上限の範囲で提示順にproposedへ昇格する)。提案がクローズする回答(defer・no)・成立(機会の排他によるcancelledを含む)・Intent削除の時点でも、関係ユーザーを対象に同じ解放を実行する。(f)予算アラート=全体の1日・1か月の実行回数が上限の80%に達したら、同一period(日・月)につき1回だけ警報する(送信済みの印はKV・04 §4)。保持期間削除にusage_countersの90日削除(05 §2.2)を加える。pending残留の掃査=status=pendingのままcreated_atから10分を超えたmatch_events行をfailedへ倒す(評価失敗による残留の可視化。評価の回収は(e)(g)が担う)。(e)のバックフィルはembedding_completedを発行せずに評価本体を直接呼び出し(二重評価の解消)、Embeddingの失敗が連続5件に達したら当回の走査を打ち切る(全断時のCron時間膨張の防止)。

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
- **実装確定(F4a)。** K_j=8は実呼び出し(フォールバックを含む)の枠である。各呼び出しの前に予算を加算して予約し、予約できた件だけを並列実行する(予算到達・circuit breakerのオープン・失敗・枠超過の分は保留として数える)。予算は**起点側(イベントを生じたIntentとそのユーザー)のみ**に計上する(相手側の予算を他人の行動で消費させないため・§6)。1対1への最低4回保証の配分はグループLATCHとあわせてF4bで導入し、F4aは8回すべてを1対1に使う
- 1ペア=1リクエスト(7軸を並列評価・07 §5)
- **jev_resultの再利用**: 同一バージョン組(両Intentが未更新)のmatch_candidates既存行にjev_resultがあれば再実行しない。30分再評価抑制(intents.last_evaluated_at)は別規則として併用

### Layer 5 LATCH Engine

- H(Hard Constraint)の最終再検証(判定時点で条件が変わっていないか。**提案履歴の存在判定を含む**)を経て、`L = H × min(P(a→b), P(b→a)) × C`(C初期値1)を算出
- **L > 0.60(初期値)で提案化(proposed)**。閾値未満はcandidateのままシステム内部データ
- **実装確定(F4a)。** match_candidates.latch_scoreはJev値(H=1とした値)で保存し(閾値未満も保存する)、Hの最終再検証の不合格は「提案しない」で表す(スコアを0で上書きしない)
- **提案化はユーザーペア単位で直列に実行し、proposal_historyへの追加成功(UNIQUE)を提案化の完了条件とする。** 同一イベント処理で同一ユーザーペアの複数候補が閾値を超えた場合は、LATCH Score最大の1件のみ提案化し、残りはcandidate保持とする
- **提案化の直列化(F4a実装確定)。** proposal_historyの確保を1文目に置き、後続(latches・latch_members・latch_status_events・候補のstatus・通知)の各文を「proposal_historyにlatch_id=新LATCHの行が存在すること」(EXISTS)で条件付けた1つのD1バッチ(トランザクション)で書く。確保は、新規ペアは `INSERT … ON CONFLICT DO NOTHING`、再提案(§4)は `outcome IN (deferred, expired) AND updated_at=読み出し値` を条件とするUPDATE(楽観照合)とする。確保に失敗すれば後続はすべて0行となり何も残らない。proposal_history.latch_idの外部キーをコミット時の検査とするため、バッチ先頭で `PRAGMA defer_foreign_keys = ON` を実行する。再提案の可否(抑制期間・スコア変化・Intent更新)は読み出した値でコードが判定し、書き込み時の照合で並行更新を退ける
- グループ(3〜4人): Layer 1通過済の近傍から**Pool最大15**を構築(同一form・主題近接・participants整合)。全ペアのMutualScoreの最小値をaggregateとし、貪欲法で集合を選ぶ(aggregate降順・同点は小集合優先・さらにULID辞書順)。**通知は1集合のみ**。次集合の評価は提案クローズ後続処理(§2)で行う

## 4. 提案化と通知

**回答期限の導出。** 機会= `min( max(通知+15分, min(通知+2時間, 対象時刻−60分)), 参加Intent期限の最小値 )`。つながり= `min(通知+24時間, 参加Intent期限の最小値)`(01 §8)。対象時刻まで75分を切った機会提案は通知しない。

**通知の上限と保留。** 1ユーザー1日6件・1Intent同時進行3件。超過分は破棄せず保留(candidate保持)。提示順は**機会=対象時刻の近い順/つながり=LATCH Score降順**(01 §10)。保留の解放は提案クローズ後続処理(§2)が担う。提示時に回答期限を再計算する。**上限の判定と通知の書き込みは同一文ではないため、並行消費で上限を1件程度超え得る(許容・F4a実装確定)。** 重複通知の防止として、通知ステップの前にlatch.statusを再確認し(proposed反映済みなら送信スキップ)、notificationsはUNIQUE(latch_id, user_id, type)で保護する。

**同時通知・開示。** 必要人数全員へ同時通知。不成立時の開示は「この提案は成立しませんでした」の一文のみ。

**同時YES(F4a実装確定)。** 回答の記録・状態遷移の記録・状態の更新を1つのD1バッチで行い、YES数をDB内で数えてmatched/partial_acceptを決める(並行するYESの取りこぼし・二重遷移を防ぐ)。機会LATCHのyesには「参加Intentにmatchedが無い」条件を加え、成立時の参加Intentのmatched化も同じバッチ内で行う(同一機会Intentの二重成立を防ぐ・02 §4の#23)。

**排他(機会のみ)。** あるIntentのLATCH成立時点で、そのIntentを含む回答待ち提案はすべてcancelled。つながりは排他なし(成立後active復帰・複数成立可)。

**提案履歴と再提案(01 §8裁定)。** 提案の生成にはproposal_historyの追加を伴う。恒久排除は**outcomeがmatched(成立)またはrejected(明示の拒否no)の履歴**だけで行う。deferred(見送り)・expired(回答期限切れ)の履歴は排除対象とせず、機会Intentに限り、見送り後 min(24時間, 対象時刻までの残時間の半分) の抑制期間を経て、スコア変化またはどちらかのIntent更新を条件に再提案する(prev_latch_scoreとの比較でスコア変化を判定)。抑制期間の基準はproposal_history.updated_at(見送り・期限切れの時刻)とし、「Intent更新」はどちらかのIntentのupdated_atが前回LATCHのcreated_atより後であることで判定する(updated_atはversionと同時に進む・F4a実装確定)。つながりIntentへの再提案は行わない。**グループ提案が回答期限までに必要人数に届かなかった場合はexpiredで閉じ、既存のYESは無効(次提案に持ち越さない)。同ペア間の提案履歴は通常どおり記録される。**

## 5. 失敗と縮退(誤提案より非提示を優先)

| 障害 | 挙動 |
|---|---|
| Jev timeout/429/529 | フォールバックLLMへ切替(07)。フォールバックも失敗なら候補は保留 |
| Jevの連続失敗 | circuit breaker: 5分窓で10連続失敗で30分オープン(期間中はJev実行せず保留)。状態はKV(バインディングPIPELINE_KV・05 §2.3)に置く |
| Embedding失敗 | 再試行なし。Intentは未登録のまま、Cronのバックフィルが回収 |
| Queues消費失敗 | プラットフォームの再試行(max_retries=3)ののちDLQ(dead)へ。DLQを見る最小のconsumerがmatch_eventsへdead反映し警報する(04 §4)。再処理はUNIQUE衝突を避けるため新規イベントとして再発行する(手動) |
| Jev予算到達 | 対象外は保留(提案化しない)。アラートはCronが検知 |

## 6. コスト保護(3層)と予算計上

API源流レート制限・Jev予算(1Intentあたり1日40回・1ユーザーあたり1日120回・30分抑制)・実行回数上限(1日30,000回・1か月600,000回・80%アラート)は04 §5の表どおり、usage_countersで実装する。**実API呼び出し(フォールバック切替を含む)をすべて計上する**規則を適用する。1Intentあたり・1ユーザーあたりの予算は**起点側(イベントを生じたIntentとそのユーザー)のみ**に計上する(相手側の予算を他人の行動で消費させない・F4a実装確定)。

## 7. 観測(Analytics Engine+D1集計)

各層の通過件数(Vectorize取得→L1通過→L2確定→L3通過→Jev実行→提案化)と**Layer 1の除外理由別内訳**・Jev回数/latency/費用・LATCH Score分布・提示数・回答率・保留→expired率・**Embedding未完・未評価の滞留件数**・DLQ件数を、イベント単位で記録する。02の#35(Analytics)・#7(総当たり禁止の観察)・#11〜#13/#26(非生成の証明)の証拠はこの計測が担う。

**実装確定(F3)。** 第2段(評価)の結果は、起点イベント(embedding_completed)の行のmatch_events.payloadへ記録する。記録するのは層通過件数(retrieval_count / l1_pass / l1_exclusions(Layer 1の除外理由別内訳) / l3_pass)と処理済み判定の理由(抑制・対象外はskipped理由・旧versionはstale_version)であり、raw_text・座標は格納しない(05 §2.5)。あわせてAnalytics Engine(dataset=latch_metrics・バインディング=PIPELINE_AX)へ層通過のdata pointをイベント単位で書き、処理結果は許可リストの構造化ログ(04 §4)に出力する。バインド未設定の環境(単体試験等)では送信を省略し例外を出さない。

**実装確定(F4a)。** payloadにJev・提案化の項目を加える: jev_calls(実呼び出し回数) / jev_reused(jev_resultの再利用件数) / jev_held(保留の理由別内訳=budget・breaker・failed・cap) / jev_latency / l5_over_threshold(L>0.60の件数) / proposed(提示した件数) / held_proposals(通知上限で保留した件数)。#14・#15の証拠はこの記録とmatch_candidates.jev_resultが担う。

## 8. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-C-01 | topK=100(上限固定)に対するK_v=50の妥当性(L1通過率の実測後の調整) | 運用開始後、L1通過率が50/100を下回るようならLayer 3の配分を減らすか起点側のクエリ分割を検討する(topKの増加は不可) |
| D-C-02 | Layer 3ルール点の重み(0.7/0.3と3要素等分) | 運用データでOffline評価により調整 |
