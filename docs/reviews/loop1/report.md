# レビューループ 統合レポート(loop1・2026-10-17)

- 対象: docs/00〜12(03は未作成)
- 実施: 6観点の並列レビュー(glm-5.3-flash)→ 本レポートにて統合・採否
- 指摘総数: **121件**(Critical 8 / Major 51 / Minor 62)
- 指摘票: [consistency.md](consistency.md) / [completeness.md](completeness.md) / [feasibility.md](feasibility.md) / [product-ux.md](product-ux.md) / [privacy-legal.md](privacy-legal.md) / [wording.md](wording.md)

## 採否サマリ

- **採用(修正する): 116件** — 内3件はオーナー裁定待ち(A・B theme)
- **条件付き採用: 2件** — 実装時検証を条件とする(FEAS-05の送信方式・FEAS-15のtimeout値)
- **却下: 3件** — UX-17の設問廃止案(タイミング修正で対応)/ CONS-10のうち「保存先をreviewsへ寄せる」案(reports/を00に登録する側で対応)/ WORD-24のうち決定記録7の丸ごと削除(時点情報の整理のみ行う)

## テーマ別の統合と方針

### A. 回答と再提案の規則【オーナー裁定Q1】— CONS-01 / WORD-01 / WORD-02 / UX-04 / PRIV-04

「同一ユーザーペアへの再提案恒久排除」と「機会Intentの見送り後条件付き再提案」が実装上両立しない(提案履歴は1ペア1行で存在すれば除外されるため)。**対応表(yes=参加する/defer=今回は見送る/no=API専用)の追記は確定**。排除の範囲は次の選択をオーナーに依頼:
- 案a: 排除は「成立・明示拒否(no)」のみ。見送り・期限切れは機会Intentに限り条件付き再提案可(つながりは常に1回きり)
- 案b: あらゆる提案履歴で恒久排除(見送り後の再提案規則を廃止)

### B. 成立前の開示範囲【オーナー裁定Q2/Q3】— UX-01 / UX-03 / UX-10 / PRIV-02 / COMP-02 / WORD-25

01と08の記述が矛盾(既定で条件サマリを出す vs 出さない)。**「既定(hidden_until_match)では条件サマリ非開示」を正と確定**する点是揃う。残る2点:
- Q2: summary_only(相手に主題等の概要を見せる設定)をv1.0に残すか → 残す場合の設定経路は「A/Bのサーバ側割付のみ」(UI導線なし)が現実的。単値化(廃止)も可
- Q3: 一致度(LATCH Score)を提案画面に表示するか → 非表示(内部利用のみ)/ 3段階バンド表示

### C. 下書きとactive化 — COMP-01 / COMP-16

採用。05のintentsはdraft時 topic/form/starts_at/expires_at をnull許容とし、active化時の検証リスト(必須・範囲・期限規則)を明記。PATCHの可変フィールドと再エンベディング要否も規定。

### D. パイプラインの実行順と取り出し幅 — CONS-03 / FEAS-01 / FEAS-18 / WORD-14 / WORD-17

採用。実行順は「Vectorize(topK=**100**・プラットフォーム上限)→ Layer 1(コード+D1)→ 類似度上位K_v=50」と確定し、06の図と本文・01 §12(層番号は概念順で実行順は06が定める旨)を揃える。D1照合は100件チャンク分割。層の正式名を「Layer 2 Candidate Retrieval」に統一。

### E. つながりIntentの取りこぼし回収と保留の解放 — FEAS-02 / COMP-06 / COMP-09

採用。Cron(毎分)に (a)「埋め込み済み・未評価・active」の回収 (b)「active化後10分のつながりIntentの1回きり遅延再評価」を追加。提案クローズ(matched/expired/rejected/cancelled)を起点イベントとし、保留candidateの提示昇格とグループ次集合の評価を行う後続処理を06 §2/§4に追加。pause/resume時のVectorize metadata更新と再評価イベントも規定。

### F. Vectorizeの同期 — FEAS-03 / FEAS-20 / COMP-10

採用。Intent遷移(pause/resume/matched/expired)ごとにmetadata statusを更新し、Layer 1は取り出し後にD1現行statusで再検証(二重化)。metadata index(form・status・category)の作成を07/05に明記。D1行不在のベクトルはfail-close除外+削除失敗はバックフィル。

### G. 通知・プッシュの実装 — FEAS-05 / FEAS-19 / FEAS-17 / UX-07 / UX-16

採用。Web Pushの送信は**自前実装(VAPID署名=jose/WebCrypto・暗号化aes128gcm=WebCrypto・送信=fetch)** を正とし、web-pushライブラリ+nodejs_compatは参考実装に格下げ(F7で実機検証を明記)。Web Pushは提案と成立のみ・不成立はアプリ内のみ。重複通知防止(status再確認+notifications UNIQUE)。iOSは未インストール時アプリ内通知で成立する確認ケースを追加。

### H. 認証・チケット・レート制限 — FEAS-04 / FEAS-06 / FEAS-12 / FEAS-21 / PRIV-18

採用。WSチケットは**jose署名の短期トークン(60秒)** に変更(KVの伝播遅延を回避。参加者判定はDOがD1で再検証)。API全体60req/分は「**ユーザー単位**60req/分(バインディング)」と明記し、usage_countersのapi_minuteスコープは削除。権限操作はD1再検証で失効リストを補完。リフレッシュ再送は猶予1回。他人リソースはNOT_FOUNDで存在隠蔽。

### I. カウンタとCronの実装 — FEAS-07 / FEAS-08 / FEAS-16 / COMP-07 / COMP-14

採用。カウンタ加算は原子的UPDATE(RETURNING)・consumerはバッチ加算。latchesにlast_message_at・intentsにvector_deleted_atを追加し索引を整理。usage_countersは90日で削除。グループ候補でJev予算が足りない場合は部分評価せず保留。メッセージ0件の90日completedはmatched時刻を起点。

### J. 退会・削除の網羅 — PRIV-03 / PRIV-05 / PRIV-06 / PRIV-07 / PRIV-15 / PRIV-16 / COMP-03 / UX-13

採用。`DELETE /v1/users/me` を追加。削除表に match_events(payload規定込み)・notifications・sessions・survey・usage_counters・blocks・reports・latches(退会時の進行中提案はcancelled・matchedの表示は「退会したユーザー」)・R2オブジェクト削除・KV失効を追記。calibration_recordsは匿名化時にlatch_idを切る。messagesは保持+名前置換+本人からの削除要求に応じる(保持期間は法務確認事項)。

### K. 外部送信と同意・法務 — PRIV-01 / PRIV-08 / PRIV-13 / PRIV-14

採用。01 §21を修正(Parserのみraw_textを送信、Jev/Embeddingは正規化テキストのみ・Embeddingは外部送信なし)。同意文言を系統別に具体化。外部送信テーブルにWeb Push(プッシュサービス)とIdPを追加。Analytics/Logsには識別子を書かない設計制約。法務チェックリストに個情法・電気通信事業法・商標調査(J-PlatPat)・ステマ規制・アイコン権利を追加。

### L. 通報・ブロックの運用 — PRIV-09 / PRIV-10 / PRIV-11

採用。通報の対応目標・重複統合・被通報者への非通知・対象にプロフィール/メッセージ追加・open滞留の警報。ブロック後は**被ブロック側の当該メッセージ取得を不可**(ブロックした側は自分の記録として読取可)と安全側で確定。20歳判定は作成時と候補化時の双方。

### M. UXの空白(状態・用語・画面) — UX-05 / 06 / 08 / 09 / 11 / 12 / 14 / 15 / 17 / 18 / WORD-26 / WORD-27

採用。01 §10に「状態→表示名対照表」「相手離脱時の中立的表示」「Intent期限切れの再作成導線」「回答待ち状態」「空状態のコピー方針」「Push購読の依頼タイミング」を追記。見送り理由は独立導線(スキップ既定)。画面インベントリの下限を01に列挙(全体は03)。コピー用語対照表とform確認ラベルの修正(「探す」語の回避)。アンケート設問を体験済み範囲に修正。

### N. 工程・ゲートの整合 — CONS-04 / CONS-05 / COMP-15 / WORD-21 / WORD-23 / CONS-10 / WORD-22

採用。12のゲート割当を#1〜#35が丁度1回ずつ現れるよう再配分(#6→F3・#12/#14→F4・#16→F7・#20→F4・#21→F5)。10のE2E対象を明示的に列挙。docs/reports/を00の文書一覧に登録。

### O. 試験・評価の整合 — CONS-06〜09 / COMP-11 / 12 / 13 / 17 / FEAS-13 / 14 / 15 / WORD-28

採用。Jev/Embeddingのstub出力仕様を07に定義(決定的・閾値超過を保証)。90日completedは単体/統合試験で証明(E2E対象外)。Parser p95は成功応答のp95と定義し失敗率警報を追加。Jev 8回は並列実行。Embedding timeoutは初期5秒・実測で確定(D-D-03)。A/B対象・MLR分母文言・エラーcode(422)・負荷試験のレート制限除外を整合。

### P. 表現・用語の統一 — 残り全件(WORD-03〜30 / CONS-11〜14 ほか)

採用。「〜相当」参照の全置換、誤字修正(モノレポ/ハバーサイン/外部送信/呼び出し/信頼度/悪化)、「MVP…v1.0」→「v1.0」、単位表記の統一(1日30,000回等)、「機会form/つながりform」→「機会Intent/つながりIntent」、アプリ内通知の正式呼称、埋め込み/Embedding・ANN表記、completed定義の統一(最終メッセージから90日)、§28の経緯叙述の削除、差分前提表現の除去、未決ID欠番の補記(D-01/D-04/D-A-02の来歴)、01 §26冒頭の版数修正。

## 次のステップ

1. オーナー裁定(Q1/Q2/Q3)を反映して修正を適用(Phase 3)
2. 検証エージェントによる指摘別の解消確認と差分周りの再レビュー(Phase 4)
3. Critical/Major が残らないことを確認して loop1 完了
