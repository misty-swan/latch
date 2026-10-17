# LATCH マッチングパイプライン設計書

- 文書バージョン: v0.2
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.2更新: 同日)
- v0.2の変更点: 多角レビュー(loop1)の指摘を反映。実行順(候補検索→硬絞り)の確定と取り出し幅の上限100件化・つながりIntentの取りこぼし回収と保留解放のトリガー追加・提案化の直列化と再提案規則(01裁定)の反映・グループ期限切れと予算不足の挙動を確定
- 前提文書: 01 要件定義書 v0.8 / 02 スコープ・受け入れ条件合意書 v0.2 / 04 アーキテクチャ設計書 v0.5 / 05 データモデル・API仕様書 v0.2
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

**pause/resume。** pauseはVectorize metadataのstatusを即時更新して新規候補化を停止する(進行中の提案は期限どおり継続し、本人は回答可能)。resumeはintent_updatedイベントを発行して再評価する。metadata更新の失敗はCronのバックフィルで回収する。

**つながりIntentはbucketを持たない。** 再評価は新規・更新Intentを起点とする候補検索と(g)(h)の安全網で完結する。catch-up・bucketは機会Intentのみ。

## 3. 5層の仕様

### Layer 2 Candidate Retrieval(Vectorize・実行の最初)

起点Intentの正規化テキスト(07 §4)をクエリとして、`filter={form, status:"active"}`付きでANN検索する。**取り出し幅はtopK=100(プラットフォーム上限。1クエリの上限を超える取得・ページングは存在しない)**。filterは最適化であり、取り出し後の判定はLayer 1が担う。

### Layer 1 Hard Filter(コード+D1 — AI不使用)

取り出した候補(最大100件)と起点Intentの組ごとに、次を**コードで**判定する。出力はpass/failのみ。**Vectorize metadataに依存せず、status・ブロック・履歴はD1の現行値で再検証する**(二重化)。D1への照会(候補Intentの一括取得・blocks・proposal_history)は**100件チャンクで分割**して発行する。

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

1対1候補の安価な事前順位付け。合成スコア= `0.7×正規化類似度 + 0.3×ルール点` とする。ルール点は (a)topic語彙の一致度(文字一致率) (b)participants区間の重なり幅 (c)地理添付時の中心間距離の近さ(未添付は中立値)、の3要素の等分。**上位K_c=20**をLayer 4へ渡す。LLMをここに使わない理由は、コスト保護3層(04 §5)の実効性を保つため(課金発生はJev・Parser・Embeddingに限る)。

### Layer 4 Jev(07のAPIを予算内で実行)

- 実行回数上限: **1イベント処理あたりK_j=8回**(実API呼び出しごとに計上。フォールバック呼び出しも計上)。**8回は並列実行する**(直列では初回判定の10秒目標を超える)
- 配分: 1対1候補に**最低4回を保証**、残りをグループ構成ペアに割当(グループ候補がなければ1対1へ繰上げ)。**残り予算で必要ペア数(C(n,2))を判定しきれないグループ候補は部分評価を採らず保留する**(次イベントまたはjev_result再利用で完結後に提案化)
- 対象の順: Layer 3スコア降順。上限到達で残りは保留(candidateのまま)
- 1ペア=1リクエスト(7軸を並列評価・07 §5)
- **jev_resultの再利用**: 同一バージョン組(両Intentが未更新)のmatch_candidates既存行にjev_resultがあれば再実行しない。30分再評価抑制(intents.last_evaluated_at)は別規則として併用

### Layer 5 LATCH Engine

- H(Hard Constraint)の最終再検証(判定時点で条件が変わっていないか。**提案履歴の存在判定を含む**)を経て、`L = H × min(P(a→b), P(b→a)) × C`(C初期値1)を算出
- **L > 0.60(初期値)で提案化(proposed)**。閾値未満はcandidateのままシステム内部データ
- **提案化はユーザーペア単位で直列に実行し、proposal_historyへの追加成功(UNIQUE)を提案化の完了条件とする。** 同一イベント処理で同一ユーザーペアの複数候補が閾値を超えた場合は、LATCH Score最大の1件のみ提案化し、残りはcandidate保持とする
- グループ(3〜4人): Layer 1通過済の近傍から**Pool最大15**を構築(同一form・主題近接・participants整合)。全ペアのMutualScoreの最小値をaggregateとし、貪欲法で集合を選ぶ(aggregate降順・同点は小集合優先・さらにULID辞書順)。**通知は1集合のみ**。次集合の評価は提案クローズ後続処理(§2)で行う

## 4. 提案化と通知

**回答期限の導出。** 機会= `min( max(通知+15分, min(通知+2時間, 対象時刻−60分)), 参加Intent期限の最小値 )`。つながり= `min(通知+24時間, 参加Intent期限の最小値)`(01 §8)。対象時刻まで75分を切った機会提案は通知しない。

**通知の上限と保留。** 1ユーザー1日6件・1Intent同時進行3件。超過分は破棄せず保留(candidate保持)。提示順は**機会=対象時刻の近い順/つながり=LATCH Score降順**(01 §10)。保留の解放は提案クローズ後続処理(§2)が担う。提示時に回答期限を再計算する。重複通知の防止として、通知ステップの前にlatch.statusを再確認し(proposed反映済みなら送信スキップ)、notificationsはUNIQUE(latch_id, user_id, type)で保護する。

**同時通知・開示。** 必要人数全員へ同時通知。不成立時の開示は「この提案は成立しませんでした」の一文のみ。

**排他(機会のみ)。** あるIntentのLATCH成立時点で、そのIntentを含む回答待ち提案はすべてcancelled。つながりは排他なし(成立後active復帰・複数成立可)。

**提案履歴と再提案(01 §8裁定)。** 提案の生成にはproposal_historyの追加を伴う。恒久排除は**outcomeがmatched(成立)またはrejected(明示の拒否no)の履歴**だけで行う。deferred(見送り)・expired(回答期限切れ)の履歴は排除対象とせず、機会Intentに限り、見送り後 min(24時間, 対象時刻までの残時間の半分) の抑制期間を経て、スコア変化またはどちらかのIntent更新を条件に再提案する(prev_latch_scoreとの比較でスコア変化を判定)。つながりIntentへの再提案は行わない。**グループ提案が回答期限までに必要人数に届かなかった場合はexpiredで閉じ、既存のYESは無効(次提案に持ち越さない)。同ペア間の提案履歴は通常どおり記録される。**

## 5. 失敗と縮退(誤提案より非提示を優先)

| 障害 | 挙動 |
|---|---|
| Jev timeout/429/529 | フォールバックLLMへ切替(07)。フォールバックも失敗なら候補は保留 |
| Jevの連続失敗 | circuit breaker: 5分窓で10連続失敗で30分オープン(期間中はJev実行せず保留) |
| Embedding失敗 | 再試行なし。Intentは未登録のまま、Cronのバックフィルが回収 |
| Queues消費失敗 | プラットフォームの再試行(max_retries=3)ののちDLQ(dead)へ。DLQを見る最小のconsumerがmatch_eventsへdead反映し警報する(04 §4)。再処理はUNIQUE衝突を避けるため新規イベントとして再発行する(手動) |
| Jev予算到達 | 対象外は保留(提案化しない)。アラートはCronが検知 |

## 6. コスト保護(3層)と予算計上

API源流レート制限・Jev予算(1Intentあたり1日40回・1ユーザーあたり1日120回・30分抑制)・実行回数上限(1日30,000回・1か月600,000回・80%アラート)は04 §5の表どおり、usage_countersで実装する。**実API呼び出し(フォールバック切替を含む)をすべて計上する**規則を適用する。

## 7. 観測(Analytics Engine+D1集計)

各層の通過件数(Vectorize取得→L1通過→L2確定→L3通過→Jev実行→提案化)と**Layer 1の除外理由別内訳**・Jev回数/latency/費用・LATCH Score分布・提示数・回答率・保留→expired率・**Embedding未完・未評価の滞留件数**・DLQ件数を、イベント単位で記録する。02の#35(Analytics)・#7(総当たり禁止の観察)・#11〜#13/#26(非生成の証明)の証拠はこの計測が担う。

## 8. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-C-01 | topK=100(上限固定)に対するK_v=50の妥当性(L1通過率の実測後の調整) | 運用開始後、L1通過率が50/100を下回るようならLayer 3の配分を減らすか起点側のクエリ分割を検討する(topKの増加は不可) |
| D-C-02 | Layer 3ルール点の重み(0.7/0.3と3要素等分) | 運用データでOffline評価により調整 |
