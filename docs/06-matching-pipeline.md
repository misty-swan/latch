# LATCH マッチングパイプライン設計書

- 文書バージョン: v0.1
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17
- 前提文書: 01 要件定義書 v0.7 / 02 スコープ・受け入れ条件合意書 v0.1 / 04 アーキテクチャ設計書 v0.4 / 05 データモデル・API仕様書 v0.1
- 本書の位置づけ: 01第11〜16節(マッチングシステム)の実装仕様を確定する。5層の絞り込み・イベント駆動・提案化・失敗と縮退を、04のCloudflare構成(Queues・Vectorize・Cron)と05のテーブルの上に定める。LLM呼び出しの内容は07が担い、本書は「いつ・何回・どの層で呼ぶか」を定める

## 1. 全体像

```text
api(POST/PATCH intents)
  → Queues(match_events: intent_created / intent_updated)      第1段
      → Embedding計算(07) → Vectorize登録
      → Queues(embedding_completed)                            第2段
          → Layer 1 Hard Filter(コード+D1)
          → Layer 2 Candidate Retrieval(Vectorize)
          → Layer 3 Cheap Judge(課金ゼロ)
          → Layer 4 Jev(07・予算管理)
          → Layer 5 LATCH Engine → 提案化(proposed) → 通知

Cron(毎分) → 機会Intent: bucket到来・catch-up / 全Intent: 期限切れ /
             つながり: completed判定 / Embeddingバックフィル / 予算アラート
削除・期限切れ → 即時処理(候補クローズ・ベクトル削除。層を経ない)
```

計算量の規律(01 §11): 総当たり禁止。イベント数E×評価対象Kの秩序を維持し、Kは各層の出力上限で頭打ちにする。

## 2. イベントとトリガー

**2段構成。** 作成・更新は第1段でEmbedding要求までを処理し、Embedding完了を`embedding_completed`イベントとして再投入して第2段(Layer 1〜5)を走らせる。埋め込み未完了のIntentは生成元にも対象にもならない。

**debounce(更新のみ)。** 更新イベントはQueuesの遅延配信(10秒)で投入し、消費側で起点Intentの現行versionと突き合わせる。古いversionへのイベントは破棄する。作成は即時(初回提案のレイテンシ優先)。

**冪等性。** match_eventsのUNIQUE(event_type, source_intent_id, version)が二重投入を許さない。処理済みイベントの再消費はstatus=processedを確認してスキップする。

**Cron(毎分・04 §4)。** (a)機会Intentのbucket到来(starts_atが属する30分Bucket到達の未評価Intent)の再評価、(b)catch-up(expires_atまで2時間以内かつlast_evaluated_atから30分以上経過のactiveな機会Intent)、(c)全active Intentの期限切れバッチ(expired化+ベクトル削除予約)、(d)つながりLATCHのcompleted判定(matchedでmessages最新から90日経過)、(e)埋め込み未完のIntentのバックフィル再試行、(f)usage_counters集計とJev予算アラート(80%)。

**つながりIntentはbucketを持たない。** 再評価は新規・更新Intentを起点とする候補検索だけで完結する(対となる既存側は同時に評価される)。catch-up・bucketは機会Intentのみ。

## 3. 5層の仕様

### Layer 1 Hard Filter(コード+D1 — AI不使用)

Vectorizeから引き当てた候補(後述の取り出し幅200件)と起点Intentの組ごとに、次を**コードで**判定する。出力はpass/failのみ。

| 判定 | 規則 | データ |
|---|---|---|
| form一致 | 双方のformが同一(つながり×機会は絶対不合格) | Vectorize filter |
| status | 双方active | Vectorize filter |
| 自己ペア | user_id一致は不合格 | コード |
| ブロック | いずれかの方向のblocks行の存在 | D1 |
| 提案履歴 | proposal_history(user_low,user_high)の存在(恒久排除・01 §8) | D1 |
| 飲酒年齢 | 機会×alcohol_involved=true は両者20歳以上必須 | D1 |
| 時間(機会のみ) | 開始・終了の重なりが15分以上 | D1(intents) |
| 地域(両方添付時のみ) | bbox事前絞り+中心間距離 ≤ 半径の和 | D1+TS計算 |
| 人数 | participants区間の共通部分あり(2〜4人内) | コード |
| 予算(機会のみ) | 区間の共通部分あり | コード |

地理を片方しか添付していない組・双方未添付の組は地理判定を行わない(全国スコープ・01 §12)。判定データを欠くNG条件はSoft Constraint側(01 §5)であり、本層では扱わない。

### Layer 2 Candidate Retrieval(Vectorize)

起点Intentの正規化テキスト(07 §4)をクエリとして、`filter={form, status:"active"}`付きでANN検索する。**取り出し幅は200件**(Layer 1で落とした分を補う余地)。Layer 1通過後、**類似度上位K_v=50**を次層へ渡す(同点はULID昇順)。

### Layer 3 Cheap Judge(LLM不使用・課金ゼロ)

1対1候補の安価な事前順位付け。合成スコア= `0.7×正規化類似度 + 0.3×ルール点` とする。ルール点は (a)topic語彙の一致度(文字一致率) (b)participants区間の重なり幅 (c)地理添付時の中心間距離の近さ(未添付は中立値)、の3要素の等分。**上位K_c=20**をLayer 4へ渡す。LLMをここに使わない理由は、コスト保護3層(04 §5)の実効性を保つため(課金発生はJev・Parser・Embeddingに限る)。

### Layer 4 Jev(07のAPIを予算内で実行)

- 実行回数上限: **1イベント処理あたりK_j=8回**(実API呼び出い毎に計上。フォールバック呼び出しも計上)
- 配分: 1対1候補に**最低4回を保証**、残りをグループ構成ペアに割当(グループ候補がなければ1対1へ繰上げ)
- 対象の順: Layer 3スコア降順。上限到達で残りは保留(candidateのまま)
- 1ペア=1リクエスト(7軸を並列評価・07 §5)
- **jev_resultの再利用**: 同一バージョン組(両Intentが未更新)のmatch_candidates既存行にjev_resultがあれば再実行しない。30分再評価抑制(intents.last_evaluated_at)は別規則として併用

### Layer 5 LATCH Engine

- H(Hard Constraint)の最終再検証(判定時点で条件が変わっていないか)を経て、`L = H × min(P(a→b), P(b→a)) × C`(C初期値1)を算出
- **L > 0.60(初期値)で提案化(proposed)**。閾値未満はcandidateのままシステム内部データ
- グループ(3〜4人): Layer 1通過済の近傍から**Pool最大15**を構築(同一form・主題近接・participants整合)。全ペアのMutualScoreの最小値をaggregateとし、貪欲法で集合を選ぶ(aggregate降順・同点は小集合優先・さらにULID辞書順)。**通知は1集合のみ**。その提案が閉じたら次の再評価で次集合を評価

## 4. 提案化と通知

**回答期限の導出。** 機会= `min( max(通知+15分, min(通知+2時間, 対象開始−60分)), 参加Intent期限の最小値 )`。つながり= `min(通知+24時間, 参加Intent期限の最小値)`(01 §8)。対象時刻まで75分を切った機会提案は通知しない。

**通知の上限と保留。** 1ユーザー日6件・1Intent同時進行3件。超過分は破棄せず保留(candidate保持)。提示順は**機会=対象時刻の近い順/つながり=LATCH Score降順**(01 §10)。提示時に回答期限を再計算する。

**同時通知・開示。** 必要人数全員へ同時通知。不成立時の開示は「この提案は成立しませんでした」の一文のみ。

**排他(機会のみ)。** あるIntentのLATCH成立時点で、そのIntentを含む回答待ち提案はすべてcancelled。つながりは排他なし(成立後active復帰・複数成立可)。**両形式とも、提案の生成にはproposal_historyの追加を伴う**(以降そのペアは恒久排除)。

## 5. 失敗と縮退(誤提案より非提示を優先)

| 障害 | 挙動 |
|---|---|
| Jev timeout/429/529 | フォールバックLLMへ切替(07)。フォールバックも失敗なら候補は保留 |
| Jevの連続失敗 | circuit breaker: 5分窓で10連続失敗で30分オープン(期間中はJev実行せず保留) |
| Embedding失敗 | 再試行なし。Intentは未登録のまま、Cronのバックフィルが回収 |
| Queues消費失敗 | プラットフォームの再試行ののちDLQ(dead)へ。deadは手動確認後にstatusを戻して再処理 |
| Jev予算到達 | 対象外は保留(提案化しない)。アラートはCronが検知 |

## 6. コスト保護(3層)と予算計上

API源流レート制限・Jev予算(1Intent日40回/1ユーザー日120回/30分抑制)・実行回数上限(日30,000・月600,000・80%アラート)は04 §5の表どおり、usage_countersで実装する。**実API呼び出い(フォールバック切替を含む)をすべて計上する**規則を適用する。

## 7. 観測(Analytics Engine+D1集計)

各層の通過件数(Vectorize取得→L1通過→L2確定→L3通過→Jev実行→提案化)・Jev回数/latency/費用・LATCH Score分布・提示数・回答率・保留→expired率・DLQ件数を、イベント単位で記録する。02の#35(Analytics)と#7(総当たり禁止の観察)の証拠はこの計測が担う。

## 8. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-C-01 | Vectorize取り出し幅200とK_v=50の妥当性(L1通過率の実測後の調整) | 運用開始後、L1通過率が50/200を下回るようなら取り出し幅を増やす |
| D-C-02 | Layer 3ルール点の重み(0.7/0.3と3要素等分) | 運用データでOffline評価により調整 |
