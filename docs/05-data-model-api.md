# LATCH データモデル・API仕様書

- 文書バージョン: v0.50
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.50更新: 2026-10-27)
- v0.2の変更点: 多角レビュー(loop1)の指摘を反映。draft保存のNullable化とactive化検証リスト・提案履歴のoutcome設計・退会APIと削除表の拡充・WSチケットの署名トークン化・カウンタとインデックスの実装規定を追加
- v0.3の変更点: refresh_familiesにprevious_hash・current_hash UNIQUEを追加(04 §4の回転猶予・再利用検出の実装確定・猶予窓=KV 120秒)。§2.3のKVに回転猶予キー(`rfg:`)の規定を追記
- v0.4の変更点: F1実装に伴い§3.3にauth/users系・アイコン系APIの確定レスポンス形状を追記し、§3.1にエラーコード対応のHTTPステータスを明記。§2.3のKVに回転猶予の結果整合性に関する限界注記(窓内の再提示でKVエントリが見えない場合は族を失効させない)を追加。§3.2・§3.3のアイコンGETのCache-Control表記を実装値(private, max-age=3600)に精緻化
- v0.5の変更点: F2実装に伴い§3.3にIntent系API(parse・作成・一覧・PATCH・pause/resume)の確定レスポンス形状と理由コードの一覧を追記し、§3.2のPATCH可変フィールドと§2.2のactive化検証の記載を実装確定値に精緻化。§3.3にPATCH・pause・resumeのversion楽観ロック(競合時は400 version_conflict・行消滅時は一律404)と機会Intentのexpires_in_days指定の拒否(expires_in_days_not_allowed)を追記
- v0.6の変更点: 03(UX仕様書)の不作成裁定(00 §1の決定記録)に伴い、D-B-03(proposal表示項目のUI選択)の確定タイミングをF2'着手時(prototype/基準)に変更。前提文書欄の版数を更新
- v0.7の変更点: プロトタイプREADME §7のオーナー裁定(2026-10-19)に伴い、退会後の表示名を終了の原因を問わず「つながっていた相手」に統一(01 §10の規定どおり・§2.5)。D-B-03(proposal表示項目)を解消し§4に決定記録を追加。前提文書欄の版数を更新
- v0.8の変更点: 前提文書欄の版数同期(F2'実装に伴う04改版への追従)。内容の変更はない
- v0.9の変更点: F3実装に伴い§2.2のintentsへdelayed_reeval_at列(つながりIntentの1回きり遅延再評価の実行済みマーカー)を追記し、§2.3へVectorizeのローカル代替(LATCH_ENV=localはインメモリ実装・取得系getByIdsの用途)を追記。§2.5へIntent削除時はベクトル削除を先に行い失敗時は500で中断する実行順序を追記。§3.3へdev専用観測API(GET /v1/dev/match-events・match-candidates)の応答形状を追記。前提文書欄の版数を更新
- v0.10の変更点: F4a(1対1の提案〜成立)実装に伴い§2.2へlatches.proposed_at・proposal_history.updated_at(見送り時刻の基準)の列と、match_candidatesのupsertが既存行のstatusを上書きしない規定・機会LATCH成立時の参加Intentの更新範囲・geofeaturesのgrid_key書式と逆引き規則を追記し、§2.3へKVバインディングPIPELINE_KVのキーを、§2.4へ提案化・回答期限・通知上限の索引を追記。§3.2へGET /v1/latches/{id}・POST /v1/latches/{id}/defer-reasonを追加し、§3.3へLatchDTO(成立前はproposal・membersのキー自体を出さない表示範囲)・一覧のtype別の状態・回答系の理由コード・dev専用API(backdate・LATCH・提案履歴の観測)の確定形状を追記。前提文書欄の版数を更新
- v0.11の変更点: F4aの最終レビューの修正に伴い§2.2のnotificationsへ成立後の離脱(leave)はclosedを作らない規定を、§3.2のPATCHへactive Intentの意味フィールドの変更・期限の短縮で進行中の提案を取り消す規定(01 §8の不成立経路「Hard Constraintが変化した」)を、§3.3の回答と取り消しの状態遷移へleaveの通知の扱いを追記。前提文書欄の版数を更新
- v0.12の変更点: オーナー裁定(2026-10-20・01冒頭の決定記録)に伴い§2.2のproposal_historyへ未提示・システムの都合で閉じた提案は履歴を消費しない規定(新規確保の行は削除・再提案で確保した既存行はexpiredへ戻す)を、intents.last_evaluated_atへ意味フィールドの更新で解除する旨を、§2.5の削除表へIntent削除で取り消した提案の履歴の解放を、§3.2・§3.3のPATCHへ取り消し時の履歴の解放と30分再評価抑制の解除を追記。前提文書欄の版数を更新
- v0.13の変更点: F4b(グループLATCH)実装に伴い§2.2のlatch_membersへleft_at(成立後の離脱時刻・マイグレーション0004と戻す手順)を、group_candidatesへdedup_keyと保存・状態の規則(全ペアのjev_resultが揃った集合だけを保存・衝突時はaggregate_scoreのみ更新・提案でproposed・prev_aggregate_score)を、proposal_historyの「履歴を消費しない閉じ方」へグループ提案のペア別の記録規則(オーナー裁定 2026-10-20・01冒頭の決定記録)を追記。§3.3へ成立後の離脱(本人だけを外して継続・下限割れで全体cancelled・離脱者は非参加扱い・成功応答・二重の離脱の冪等)と、members・participants_countは離脱していない参加者だけを数える旨を追記。前提文書欄の版数を更新
- v0.14の変更点: F4c(提案〜成立の画面)に伴い§3.3のLatchDTOへmy_intent_id(自分側の参加Intent・全状態で含む・削除済みならnull)とmatched_at(成立時刻・成立を経ていなければnull)を追記
- v0.15の変更点: F5(つながりの性質)実装とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴い、§2.2のlatchesのlast_message_at(成立時に成立時刻を入れる)・completed_at(機会は対象時刻から3時間)、§2.6のcompleted判定(機会LATCHを追加)、§3.3のGET /v1/latches?type=matched(completedを含む)とLatchDTOの成立後の開示範囲(completedを含む)を改めた。前提文書欄の版数を更新
- v0.16の変更点: F6a(チャットのバックエンド)実装とオーナー裁定(2026-10-21・01冒頭の決定記録: 続いているLATCHを表示から消すと本人はそのLATCHから抜けたものとして扱う)に伴い、§2.2のlatch_membersへhidden_at(表示削除の時刻)と、下限割れでLATCH全体を取り消した離脱者はleft_atを記録せず読み取り専用の参加者として残す旨(オーナー裁定 2026-10-21・01冒頭の決定記録)を、messagesへclient_id(再送の重複防止・UNIQUE(latch_id, user_id, client_id))と保存の条件を、両者のマイグレーション0005と戻す手順を追記。§3.1へUPGRADE_REQUIRED=426を、§3.2へWebSocket接続のルートを、§3.3へチャットのAPI(ws-ticket・履歴・送信・既読)とMessageDTO・LatchDTOのlast_message / unread_count・成立一覧のmatched経由のcancelled・DELETE /v1/latches/{id}の挙動・hidden_atの本人の扱い・全体を取り消した離脱者の読み取り専用の扱い(DELETEはhidden_atの確認を先に行う)を追記。§3.4をF6aの実装確定(チケットの検証はWorkerのルート・1回限りはDO・`retract`フレームを`closed`へ改める・フレームのclient_id・errorのcode・配信前の参加者確認)に改めた。前提文書欄の版数を更新
- v0.17の変更点: 前提文書欄の版数同期(F6b(チャットの画面)の完了とオーナー裁定3件(2026-10-21・01冒頭の決定記録)に伴う01・02・04改版への追従)。内容の変更はない
- v0.18の変更点: F7a(安全のAPI)実装とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴い、§2.2のreportsへ通報の対象の種別(target)・対象メッセージ(message_id)・通報者内の統合の規定と、マイグレーション0006と戻す手順(適用前にreportsが0行であることの確認を含む)を、blocksへブロックの即時効果(トークンは失効させず、提案・LATCHを閉じて送信・回答を止める)を、§2.4へreportsの索引を追記し、§2.3のKVの失効の補完からblocksの再検証を外した。§3.2のブロック・通報のAPIを確定値に改め、§3.3へブロックのAPI(対象の判定・即時効果の順序・一覧)・通報のAPI(対象の判定・理由コード)・Intentの有効化での飲酒年齢の判定(422 ALCOHOL_RESTRICTED・判定の順・年齢を確かめられないときの拒否)・dev専用API GET /v1/dev/reportsを追記。前提文書欄の版数を更新。あわせて成立後の通報の条件を「自分が成立後の参加者だった(left_at・hidden_atは問わない)」へ改めた(2026-10-21オーナー裁定・01冒頭の決定記録(安全のAPI)の4)
- v0.19の変更点: F7b(通知のAPI)実装とオーナー裁定(2026-10-21・01冒頭の決定記録: notification_level=mutedはWeb Pushだけを止め、アプリ内通知は作る)に伴い、§2.2のnotificationsへ列(intent_id・push_state・push_attempted_at)・種別intent_expired・UNIQUE(intent_id, type)・送信の状態の値とマイグレーション0007と戻す手順を、push_subscriptionsへ登録・解除・失効の扱いを、§2.4へnotificationsの索引を(§2.2の索引の表記もINDEX(user_id, read_at, id)へ揃えた)、§2.5へIntent削除でintent_expiredの行を消すことを追記した。§3.2へ購読のAPI(GET /v1/push/vapid-public-key・POST/DELETE /v1/push-subscriptions)を加え、§3.3へNotificationDTOと一覧・既読・購読の検証の確定形状とdev専用GET /v1/dev/notificationsを追記した。前提文書欄の版数を更新
- v0.20の変更点: 前提文書欄の版数同期(F7c(安全と通知の画面)の完了とオーナー裁定(2026-10-21・01冒頭の決定記録)に伴う01・02・04改版への追従)。内容の変更はない
- v0.21の変更点: 前提文書欄の版数同期(F8a(PWAと画面の仕上げ)の完了とオーナー合意(2026-10-21・01冒頭の決定記録(PWAと画面の仕上げ)・12 §2の決定記録(F8の2分割))に伴う01・02・04改版への追従)。内容の変更はない
- v0.22の変更点: 前提文書欄の版数同期(F8b(stagingの構築と負荷試験)の構築の完了とオーナー決定(2026-10-22・01冒頭の決定記録(stagingと負荷試験)・12 §2の決定記録(stagingと負荷試験))に伴う01・02・04改版への追従)。内容の変更はない
- v0.23の変更点: 不具合の修正工程(issue #7・2026-10-22オーナー合意・12 §2の決定記録(評価の流れ))に伴い、§2.2のmatch_eventsのevent_typeへ反映確認のイベント`vector_reflection`を(TEXT列でCHECK制約が無いためマイグレーションは無い)、§2.3のVectorizeのmetadataへ意思の`version`(反映確認に使う)を加え、取得系(getByIds)の用途を反映確認に改めた。前提文書欄の版数を更新
- v0.24の変更点: 前提文書欄の版数同期(F8bの負荷試験の結果の記録(2026-10-22)に伴う02・04改版への追従)。内容の変更はない
- v0.25の変更点: 前提文書欄の同期のみの改版(最終の直しに伴う版数の連鎖。内容の変更はない)
- v0.26の変更点: 不具合の修正工程(第2回・issue #15・#16・#20・2026-10-23)に伴い、§2.2のmatch_eventsへ2つの索引(source_intent_id・(status, created_at))とマイグレーション0008と戻す手順を、§2.4の索引の一覧へ同じ2つを、§2.3のVectorizeへ取得(getByIds)の1回20件の上限と実装の中での分割・metadata更新の失敗をCronのmetadata整合の修復で回収することを、§2.5のIntent削除の実行順序へD1の削除を1回のバッチ(1つの取引)で行うこと・グループ候補を本人の意思を含む行に絞ってから消すこと・削除の後のベクトルの書き戻しの防止と孤立したベクトルの自己修復(06 §2)を加えた。前提文書欄の版数を更新
- v0.27の変更点: 前提文書欄の版数同期のみの改版(02・10・12の測り直し完了の記録に伴う追従)。内容の変更はない
- v0.28の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第2回)の最終レビューの直しに伴う04・06・07の改版の連鎖)。内容の変更はない
- v0.29の変更点: LLM real接続の工程の完了(2026-10-24)に伴い、§2.2のusage_countersへ外部送信の集計のscope(`external_send`・keyは`<送信先>:<系統>`・JSTの日付ごと・08 §5)を、§3.3のPOST /v1/intents/parseへParserの失敗(種別を問わず422 PARSE_FAILED)と場所の言及の注意表示(warningsの`{field:"geo"}`)を、dev専用の観測API GET /v1/dev/usageを加えた。前提文書欄の版数を更新
- v0.30の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第3回)の完了(2026-10-24)に伴う01・04・06・07・12の改版への追従)。内容の変更はない
- v0.31の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第3回)の最終点検の直し(2026-10-24)に伴う04の改版への追従)。内容の変更はない
- v0.32の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第3回・issue #39)のオーナー決定5(2026-10-24)に伴う04・06の改版への追従)。内容の変更はない
- v0.33の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第3回)の後の測り直しと、工程を区切るオーナー決定(2026-10-25・12 §2の決定記録(不具合の修正工程(第3回)))に伴う02・04の改版への追従)。内容の変更はない
- v0.34の変更点: 不具合の修正工程(第4回・issue #47・2026-10-25オーナー決定案2b・12 §2の決定記録(不具合の修正工程(第4回)))に伴い、§2.1のテーブル一覧と§2.2へ直近のベクトルの控えの表recent_vectors(intent_id・embedded_at・vector・マイグレーション0009と戻す手順・控えの寿命15分と評価での補い・失敗の扱い)を、§2.4の索引の一覧へ(embedded_at)を、§2.5の削除時の扱いへ控えの行を加えた。D1の表は24個になった。前提文書欄の版数は変わらない。同じ工程の最終点検の指摘により、§2.2の補いの説明を実装と06 §3に揃え(新しい順に最大50件を読み類似度で並べる)、vectorを照会の結果に無いidの分だけ2回目に読むことを加えた
- v0.35の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第4回)の後の測り直しに伴う02・10・12などの改版への追従)。内容の変更はない
- v0.36の変更点: 前提文書欄の同期のみの改版(不具合の修正工程(第5回)の後の測り直しに伴う02・04の改版への追従)。内容の変更はない
- v0.37の変更点: 前提文書欄の版数同期(Intent保存の測り直しと02 §4 #33の完了(2026-10-26)に伴う02・10・12の改版への追従)。内容の変更はない
- v0.38の変更点: F9のフィードバック申告(2026-10-26・LAT-84)に伴い、§2.2のlatch_feedback(スキップのnull)・§3.2・§3.3(LatchDTOの自己申告の受付・POST /v1/latches/{id}/feedback・devのmatched_atのbackdate)を改めた。前提文書欄の版数を更新
- v0.39の変更点: F9のレート制限(LAT-93)と退会(LAT-94)に伴い、§2.2(カウンタの種類)・§2.5(削除表と退会の実行順序)・§3.1(429の理由・Retry-After・数える範囲)・§3.3(DELETE /v1/users/meの応答)を更新した。前提文書欄の版数を更新
- v0.40の変更点: F9の正解データ(LAT-108)に伴い、§2.2・§2.4・§2.5(削除表と退会・Intent削除の実行順序)・§2.6を更新した。前提文書欄の版数を更新
- v0.41の変更点: 不具合の修正工程(第6回・LAT-105)に伴い、§2.2のintentsにjev_held_at・jev_held_reason・jev_held_count(マイグレーション0011と戻す手順)を、§2.4に(status, jev_held_at)の索引を加えた
- v0.42の変更点: 前提文書欄の版数同期(02 §4 #34の完了(2026-10-26・社内クローズドテストの通し直し)に伴う02の改版への追従)。内容の変更はない
- v0.43の変更点: 前提文書欄の版数同期(02 §4 #32の完了(2026-10-26)に伴う02の改版への追従)。内容の変更はない
- v0.44の変更点: 前提文書欄の版数同期(不具合の修正工程(第7回・LAT-113・LAT-114)とPC向けの画面(LAT-14)(2026-10-26)に伴う04・07・09・10の改版への追従)。内容の変更はない
- v0.45の変更点: 前提文書欄の版数同期(はじめる流れのPCの画面(LAT-118・2026-10-27)に伴う04の改版への追従)。内容の変更はない
- v0.46の変更点: 前提文書欄の版数同期(本番の土台(LAT-119・LAT-120・LAT-122)・本番IdPの画面側(LAT-90)・公開手順の台本(LAT-88・LAT-123)(2026-10-27)に伴う04の改版への追従)。内容の変更はない
- v0.47の変更点: 前提文書欄の版数同期(F10公開準備のオーナー決定(2026-10-27)に伴う04の改版への追従)。内容の変更はない
- v0.48の変更点: 前提文書欄の版数同期(法務確認の扱いのオーナー決定(2026-10-27・LAT-78)に伴う01・02・04の改版への追従)。内容の変更はない
- v0.49の変更点: 不具合の修正工程(第8回・LAT-126・2026-10-27)とオーナー決定(12 §2の決定記録(F10公開準備)の4)に伴い、§2.5のIntent削除と退会の実行順序に、ベクトルの削除の短いやり直し(0.5秒・1秒の待ちで最大2回)と、書き込みの頻度の上限(VECTOR_DELETE_40041)が続いたときの503 TEMPORARILY_UNAVAILABLEを加えた。§3.1の対応表にTEMPORARILY_UNAVAILABLE=503を、§3.3のDELETE /v1/users/meの失敗の扱いに同じ503を加えた
- v0.50の変更点: コストアラートと日次サマリをオーナーのメールへ送る仕組みの実装(LAT-124・2026-10-27オーナー決定・04冒頭の決定記録(オーナーへのメール))に伴い、§2.2のusage_countersへオーナーへのメールの送る権利のscope(`alert_mail`・keyはメールの種類・periodは日か月・countの符号で送信済みと失敗を表す・04 §4)を加えた。前提文書欄の版数を更新
- 前提文書: 01 要件定義書 v0.27 / 02 スコープ・受け入れ条件合意書 v0.30 / 04 アーキテクチャ設計書 v0.47
- 本書の位置づけ: 01第17〜19節(データモデル・API)をD1+Drizzle・Hono・リアルタイムチャット(04)の上に確定させる。テーブル・インデックス・API契約(エンドポイント・エラー・ページネーション・WebSocketプロトコル)を定め、実装はこれに従う。Zodスキーマの実体は `packages/shared` が持ち、本書がその意味規定の正本である

本書の取り決め。IDはすべてULID(時刻順序可能・大文字26桁)とする。時刻はAPI上ISO 8601(オフセット付き・保存はUTC)で表し、表示と集計の基準はJSTとする(01 §20のClock規律)。本章のテーブル定義は論理表記であり、Drizzleスキーマへの写像は実装が担う(カラム名はsnake_case)。

## 1. データの所在(まとめ)

| ストア | 保持するもの |
|---|---|
| D1(SQLite/Drizzle) | 全リレーショナルデータ(下記§2のテーブル群) |
| Vectorize | Intentの埋め込みベクトル(id= ULID・metadataは§2.3) |
| KV | アクセストークン失効リスト(jti)。チャット接続チケットはjose署名トークン(KV不使用) |
| R2 | ユーザーアイコン画像のみ |
| Durable Objects | チャットの接続管理(永続データなし。正はD1) |
| Analytics Engine | パイプライン・提案・行動の計測イベント |

## 2. データモデル(D1)

### 2.1 テーブル一覧

| 領域 | テーブル | 役割 |
|---|---|---|
| アカウント/認証 | users / refresh_families | ユーザー・リフレッシュトークン族(回転式) |
| Intent | intents / match_events | 意思本体・イベントキュー投入記録 |
| マッチング | match_candidates / group_candidates / proposal_history / recent_vectors | 評価の途中結果・同一ペア排除(恒久)・直近に埋め込んだ意思のベクトルの控え(15分) |
| LATCH/チャット | latches / latch_members / latch_responses / latch_status_events / messages / chat_reads / latch_feedback | 提案と成立・参加者・回答・状態遷移・チャット・既読・申告 |
| 安全 | blocks / reports | ブロック・通報 |
| 通知 | notifications / push_subscriptions | アプリ内通知・Web Push購読 |
| 計測 | sessions / survey_responses / calibration_records / usage_counters | DAU・アンケート・正解データ・レート/予算カウンタ |
| 地域 | geofeatures | 地名の代表点(逆引き・丸め用。D-A-03) |

### 2.2 主要テーブル定義

**users**

```yaml
id:                ULID(PK)
auth_provider:     google | apple
auth_subject:      string  # (provider, subject) UNIQUE
actor_type:        individual   # v1.0は固定。将来business(01 §17の拡張点)
display_name:      string(1..40)
bio:               string(0..200)  # ひとこと(任意)
icon_key:          string | null   # R2オブジェクトキー。null=既定アバター
birth_date:        date            # 自己申告・非公開(18歳検証のみ)
status:            active | deleted
created_at / updated_at
```

性別のカラムは存在しない(01 §22)。退会は status=deleted ののち、§2.5の削除処理を行う。

**refresh_families**

```yaml
id:            ULID(PK)
user_id:       FK users
current_hash:  string   # 現行リフレッシュトークンのハッシュ(SHA-256)。UNIQUE(回転CASの検索引)
previous_hash: string | null   # 直前の現行トークンハッシュ。再利用検出で族を特定する
expires_at:    datetime # 30日(回転ごとに延長)
status:        active | revoked
created_at / rotated_at
```

再利用検出(旧ハッシュの提示)は族revoked+401(04 §4)。

**intents**

```yaml
id:                     ULID(PK)
user_id:                FK users
form:                   connection | occasion
topic:                  string(1..40)        # 主題の短句(必須)
category:               string | null        # 低粒度タグ(任意・D-B-01初期セット: 趣味・娯楽/スポーツ・運動/学び・語学/創作・クリエイティブ/テック・開発/食・飲み/旅行・アウトドア/音楽・芸術/読書・文化/仕事・キャリア/子育て・家庭/健康・生活/地域・コミュニティ/ボランティア・社会/その他。ゴールドセット作成時に見直す)
raw_text:               string(0..300)
# 添付(任意。機会Intentはtime.start必須)
starts_at:              datetime | null      # 機会=必須 / つながり=null
ends_at:                datetime | null
geo_center_lat/lng:     real | null          # 3つ揃うか全てnull
geo_radius_m:           integer | null
participants_min/max:   integer  # 既定 2/2
participants_includes_owner: boolean  # 既定 true
budget_min/max:         integer | null
currency:               string | null        # 既定 JPY
# 制約・設定
hard_constraints:   json   # 構造化された絶対条件
soft_constraints:   json
negative_constraints: json
visibility:         hidden_until_match   # 単値(v1.0の値はこれのみ)
notification_level: proposals_only | muted              # 既定前者
alcohol_involved:   boolean  # 機会Intentのみtrueになり得る
# 状態
status:             draft | active | paused | matched | expired | cancelled
version:            integer  # 更新ごと+1(01 §16)
expires_at:         datetime  # つながり=既定30日(7/30/90選択)/機会=既定start+3h
embedding_model:    string | null   # 埋め込み済みモデル識別子(01 §18)
embedded_at:        datetime | null
last_evaluated_at:  datetime | null  # 30分再評価抑制(§2.6)。active Intentの意味フィールドの更新でnullへ戻す(§3.3・01冒頭の決定記録 2026-10-20)
delayed_reeval_at:  datetime | null  # つながりIntentの1回きり遅延再評価(06 §2の(h))の実行済みマーカー(実行時に刻印)
jev_held_at:        datetime | null  # 評価でJevの保留(予算・circuit breaker・予備も失敗)が残った時刻。保留の無い評価でnullへ戻す(06 §2の(k)・LAT-105・マイグレーション0011)
jev_held_reason:    budget | breaker | failed | null  # 保留の理由(予算 > breaker > 失敗の順で1つ)
jev_held_count:     integer  # 既定0。失敗の保留で終わった評価の連続回数(failed以外の保留・保留の無い評価で0へ戻す)
vector_deleted_at:  datetime | null  # ベクトル削除実行記録(§2.6の2窓走査用)
created_at / updated_at
```

制約(実装で検証): **draftは topic・form・starts_at・expires_at をnull許容とし、raw_text(0..300)のみで保存できる**。active化(作成時のstatus=active・PATCHでのdraft→active)時に次を検証する(違反はVALIDATION_FAILEDに理由コードを付す・§3.3に一覧): form確定必須 / topic 1..40 / 機会Intentはstarts_at必須かつ現在以降〜now+7日以内 / expires_at設定(機会=既定start+3時間・つながり=7/30/90日選択) / alcohol_involvedは機会Intentのみtrue可。つながりIntentは starts_at=null・alcohol_involved=false。

**match_events**(Queues投入の記録・冪等性)

```yaml
id:                ULID(PK)
event_type:        intent_created | intent_updated | intent_deleted |
                   intent_expired | bucket_arrived | embedding_completed |
                   vector_reflection   # 反映確認(06 §2)。TEXT列・CHECK制約なし
source_intent_id:  FK intents
version:           integer
payload:           json
status:            pending | processed | failed | dead   # dead=DLQ隔離
created_at / processed_at
UNIQUE(event_type, source_intent_id, version)
INDEX(source_intent_id) / INDEX(status, created_at)   # マイグレーション0008
```

**match_eventsの索引(不具合の修正工程(第2回)で確定)。** INDEX(source_intent_id)は意思の削除APIの子の行の削除(§2.5)・反映確認とmetadata整合の修復の照会(06 §2)に、INDEX(status, created_at)はCronの未処理・反映待ち・pending残留の掃査に使う(多くの意思を保存した後に削除APIが全件走査で遅くなった不具合・issue #16の修正)。マイグレーション0008で追加し、戻す手順(migrations_rollback/0008)を対で持つ(12 §4・11 §3。索引の追加だけで列とデータは変わらないため、適用前の確認は要らない。戻してもデータは失われないが、削除APIとCronの掃査が全件走査に戻って遅くなる)。

**recent_vectors**(直近のベクトルの控え・不具合の修正工程(第4回)で確定・issue #47)

```yaml
intent_id:    TEXT(26)(PK・FK intents.id・ON DELETE CASCADE)
embedded_at:  integer   # 埋め込みの時刻(intents.embedded_atと同じ値)
vector:       blob      # float32の並び(リトルエンディアン。bge-m3は1,024次元で約4KB)
INDEX(embedded_at)      # マイグレーション0009
```

Layer 2 Candidate Retrievalの照会(Vectorize)が照会ごとに数十秒から数分古い状態を返し、相手の反映確認が済んだ後でも相手を見落とすことがあるため、第1段(バックフィルも同じ本体を通る)が新しいベクトルをD1にも控える(同じintent_idは上書き。06 §2・§3)。評価は控えから埋め込みの新しい順に最大50件(`PIPELINE.RECENT_VECTOR_SUPPLEMENT_MAX`)を読み、Vectorizeの照会の結果に無いものだけを、照会の結果と合わせて類似度の降順に並べてtopKで切る(06 §3)。読むのは、同じform・status=activeで、控えのembedded_atがintents.embedded_atと一致する(=現在の版の)行に限る。照会と同時に読むのはintent_idとembedded_atだけで、vectorは照会の結果に無いidがあるときだけ、そのidの分を2回目に読む(D1はBLOBを数値の配列で返し1行約15KBになるため)。控えの寿命は埋め込みから15分(`PIPELINE.RECENT_VECTOR_TTL_MS`)で、期限を過ぎた行は毎分Cronの保持期間の削除が消す。意思の削除は外部キーのCASCADEで控えも消す(§2.5)。書き込みと読み出しの失敗は第1段・評価の失敗にせず、ログ(pipeline.recent_vector.failed)だけを出して補い無しで進む。マイグレーション0009で追加し、戻す手順(migrations_rollback/0009)を対で持つ(12 §4・11 §3。新しい表の追加だけで既存の表は変わらないため、適用前の確認は要らない。戻すと控えが失われ補いが無くなるが、意思とVectorizeのベクトルは残る。表を使う版のWorkerを先に戻してから適用する)。D1の表の数は24になった。

**match_candidates**(1対1評価・30日定期削除)

```yaml
id:                ULID(PK)
intent_a_id / intent_b_id:   FK intents  # 常に a.id < b.id に正規化
intent_a_version / intent_b_version: integer
form:              connection | occasion   # 同formのみ(01 §12)
retrieval_score / cheap_judge_score: real | null
jev_result:        json | null   # 7軸の数値のみ(reasonなし・01 §13)
latch_score:       real | null
prev_latch_score:  real | null   # 再提案判定用(機会Intentのみ使用)
status:            candidate | proposed | closed
UNIQUE(intent_a_id, intent_b_id, intent_a_version, intent_b_version)
created_at / updated_at
```

評価ごとの書き込みはUNIQUE組でのupsert(ON CONFLICT)とし、衝突時はretrieval_score・cheap_judge_score・updated_atのみ更新して**statusは上書きしない**(新規行だけがcandidateになり、提案済み(proposed)・closedの既存行は状態を保つ・F4a実装確定)。

**group_candidates**(3人以上・Pool最大15・30日定期削除): `intent_ids json(3..4) / dedup_key / aggregate_score / prev_aggregate_score / status(candidate | proposed | closed) / created_at`。UNIQUE(dedup_key)。dedup_key=intent_ids正規化文字列(ID昇順の`{id}@{version}`をカンマ結合・各versionを含む)。

**group_candidatesの保存と状態(F4b実装確定)。** 1回の評価で予定に入れた集合のうち、**全ペアのJev結果(match_candidates.jev_result)が揃った集合だけ**をaggregate(全ペアのLATCH Scoreの最小値・06 §3)とともに保存する(判定が欠けた集合は保存せず保留する・部分評価しない)。書き込みはdedup_keyでのupsertとし、衝突時は**aggregate_scoreのみ**を更新してstatusは上書きしない(match_candidatesと同じ考え方)。新規行はstatus=candidateで、その集合を提案化したとき(保留のcandidate LATCHを含む)に同じD1バッチでproposedへ進める。prev_aggregate_scoreには、再提案の判定時に集合内のいずれかのペアに前回のLATCHがあれば、そのうち最も新しいLATCHのscoreを記録する(再提案の可否の判定材料・06 §4)。集合を構成する他人どうしのペアもmatch_candidatesへupsertし、jev_resultを次の評価で再利用する(06 §3)。

**proposal_history**(同一ユーザーペアへの再提案恒久排除・01 §8)

```yaml
id:          ULID(PK)
user_low / user_high:  FK users   # 常に low < high に正規化
latch_id:    FK latches | null
outcome:     proposed | matched | rejected | expired | deferred
# 恒久排除の判定は outcome が matched または rejected の行の存在のみ(01 §8裁定)。
# deferred(見送り)・expired の行は機会Intentの条件付き再提案の参照に使う
# 未提示・システムの都合で閉じた提案は履歴を消費しない(下記・01冒頭の決定記録 2026-10-20)
created_at
updated_at:  datetime   # outcome更新の時刻。見送り後の抑制期間の基準(06 §4)
UNIQUE(user_low, user_high)
```

Layer 1はoutcomeがmatchedまたはrejectedの行の存在で除外する(deferred・expiredの行は機会Intentの条件付き再提案の参照に使う・01 §8)。提案化の直列化(本表の確保を1文目に置く1バッチ)は06 §3に規定する。

**履歴を消費しない閉じ方(オーナー裁定 2026-10-20・F4a実装確定)。** 一度も提示しないまま閉じた保留(保留中の期限切れ・機会で対象時刻まで75分を切ったもの・参加Intentの終了)と、システムの都合で閉じた提案(機会の排他によるcancelled・Intent削除・active Intentの意味フィールドの変更=Hard Constraintの変化・§3.3)は、本表を消費しない。そのLATCHのために新規に確保した行(created_atがLATCHの作成以降)は削除してペアを未提案に戻し、再提案で確保した既存行はoutcome=expiredに戻す(updated_atも更新する)。提示後の回答期限切れ(expired)・defer(deferred)・no(rejected)は従来どおり記録する。同ペアの行が別のLATCHへ移っていれば触らない。

**グループ提案のペア別の記録(オーナー裁定 2026-10-20・01冒頭の決定記録・F4b実装確定)。** 2〜4人の提案は全ペア(C(n,2)行)の本表を提案化の1バッチで確保し(一部だけ確保できた場合は同じバッチ内で巻き戻す・06 §3)、クローズ時はペアごとに次の記録をする。「消費しない」は上段と同じ扱い(新規確保の行は削除・再提案で確保した既存行はexpiredへ戻す)である。

| 閉じ方 | 記録するペア | それ以外のペア |
|---|---|---|
| defer(本人X) | Xを含むペア → deferred | 消費しない |
| no(本人X) | Xを含むペア → rejected(恒久排除) | 消費しない |
| 回答期限切れ | 有効なyesを持たない参加者を含むペア → expired | 消費しない(yesどうしのペア) |
| 機会の排他・Intent削除・意味フィールドの変更・未提示の保留の終了 | — | 全ペアとも消費しない |
| 成立(matched) | 全ペア → matched | — |
| 成立後の離脱(leave) | 変更しない(matchedのまま) | — |

1対1では唯一のペアが常に本人を含み、期限切れのペアは必ず有効なyesを持たない参加者を含む(双方yesなら成立済み)ため、上段の規則と一致する。

**latches**

```yaml
id:                 ULID(PK)
form:               connection | occasion
intent_ids:         json(2..4)   # ULID配列(参加メンバーはlatch_members副表で管理)
proposal:           json          # {form, topic, time_window, region_name, participants, budget}(成立後に表示する上位集合。成立前の応答は旨・回答期限・必要人数のみ・§3.3。UI表示はform別に確定済み・§4のD-B-03解消)
score:              real          # 内部利用(順序付け・計測)。UIには表示しない(01 §10裁定)
status:             candidate | proposed | partial_accept | matched |
                    rejected | expired | cancelled | completed
                    # candidate=閾値超過済みだが未提示(通知上限での保留を含む)。
                    # §2.2のMatchCandidateとは別物
response_deadline:  datetime
proposed_at:        datetime | null  # 提示(proposed化)した時刻。保留中(candidate)はnull。不成立の通知(closed)は提示済みの提案に限る
expires_at:         datetime      # 参加Intent期限の最小値
last_message_at:    datetime      # 非正規化。成立時に成立時刻を入れ、メッセージ書き込み時に更新(90日判定の索引・F5実装確定。更新はメッセージの保存と同じバッチでmatchedに限る・F6a実装確定)
completed_at:       datetime | null  # 機会=対象時刻(proposal.time_window.start)から3時間経過 / つながり=最終メッセージ(0件ならmatched時刻)から90日経過
calibrated_at:      datetime | null  # 正解データ(calibration_records)の行を作った時刻。未提示で閉じた提案は行を作らず印だけ(F9実装確定・LAT-108)
created_at / updated_at
```

**latch_responses**: `id / latch_id / user_id / response(yes|no|defer) / defer_reason(json|null) / responded_at / retracted_at(null|時刻) — UNIQUE(latch_id, user_id)`。

**latch_members**: `latch_id / user_id / left_at(datetime | null) / hidden_at(datetime | null) — PK(latch_id, user_id)`(latchesの参加者副表。「自分の提案・成立」の一覧取得はこの表経由)。left_atは成立後の離脱(leave)の時刻で、グループLATCHが離脱者を残して続くときに記録する(F4b実装確定・マイグレーション0004と戻す手順(migrations_rollback/0004)を対で持つ・12 §4)。離脱で残りが下限を割りLATCH全体をcancelledにしたとき(1対1は常にこれ)は本人のleft_atを記録せず、本人も取り消し済みLATCHの参加者として残り、履歴を読み取り専用で読める(残った参加者のmembers・participants_countにも残る。オーナー裁定 2026-10-21・01冒頭の決定記録・01 §10「双方読み取り専用」)。hidden_atは本人がLATCHを表示から消した(DELETE /v1/latches/{id}・02 D-08)時刻で、left_atと同じく本人からは当該LATCHを非参加と同じに扱う根拠になる。他の参加者のmembers・participants_countの数え方はleft_atだけで決め、hidden_atは影響しない(§3.3・オーナー裁定 2026-10-21・01冒頭の決定記録・F6a実装確定・マイグレーション0005と戻す手順(migrations_rollback/0005)を対で持つ)。成立前の判定(回答のyes数と参加人数の比較・通知・保留の解放・提示の上限判定)は離脱がmatched後にしか起きないため従来どおり全行を数え、成立後の表示・離脱の判定ではleft_atがnullの行だけを参加者として数える(§3.3)。

**latch_status_events**: `id / latch_id / from_status(null可=生成時) / to_status / created_at — INDEX(latch_id)`(MLR集計の観測点。成立後の表示範囲の判定で「matched経由のcancelled」を見分ける根拠にも使う・§3.3)。

**messages**(チャットの正。DOは配信のみ)

```yaml
id:         ULID(PK)
latch_id:   FK latches
user_id:    FK users
body:       string(1..2000)   # 前後の空白を除いて1〜2,000字。保存も除いた形(F6a実装確定)
client_id:  string(1..64) | null  # 送信者が付ける再送の重複防止キー([A-Za-z0-9_-])。APIでは必須・既存行のため列はnull可(F6a実装確定)
created_at
INDEX(latch_id, id)
UNIQUE(latch_id, user_id, client_id)   # 同じclient_idの再送は既存行を返す(SQLiteの一意索引はnullを重複とみなさない)
```

保存はLATCHがmatchedかつ送り手のleft_at・hidden_atがnullであることを条件にしたINSERT文1つで行い(事前の読み出しだけで決めない)、挿入が起きたときだけ同じバッチでlatches.last_message_atを進める。終了・離脱と送信が並行しても条件はD1の直列化で評価されるため、終了後のメッセージは保存されない。client_idと上記の一意索引は、latch_members.hidden_atとともにマイグレーション0005で追加し、戻す手順(migrations_rollback/0005)を対で持つ(12 §4・11 §3。戻すと表示削除の印と再送の重複防止が失われ、表示から消したLATCHが一覧に再び現れる)。

**chat_reads**: `latch_id / user_id / last_read_message_id — PK(latch_id, user_id)`(未読表示・つながり品質の開始判定に使用)。既読は前にだけ進め、UPSERTで既存値との大きい方(ULIDの文字列比較)を残す(F6a実装確定)。

**latch_feedback**: `id / latch_id / user_id / kind(attendance|connection_quality) / value(json) / created_at — UNIQUE(latch_id, user_id, kind)`(01 §14の正解データ申告。集計は02 #35の対象)。valueは、attendanceが`{attended: boolean|null}`、connection_qualityが`{score: 1〜5の整数|null}`で、nullはスキップ(答えなかったことの記録・オーナー裁定 2026-10-26・01冒頭の決定記録)。行の書き込みはPOST /v1/latches/{id}/feedbackだけが行い、UNIQUEで1人1種別1回に限る(§3.3・F9実装確定)。

**blocks**: `blocker_user_id / blocked_user_id / created_at — PK(blocker, blocked)`。行の書き込みと即時効果(進行中の提案の取り消し・続いているLATCHからの本人の離脱)はPOST /v1/users/{user_id}/blockが行う(§3.3・F7a実装確定)。ブロックはトークンを失効させない(§2.3)。チャット送信・回答は、ブロックで該当する提案・LATCHがcancelled(読み取り専用・回答不可)になることで止まり、送信・回答の各処理へblocksの照会は加えない。**reports**: `id / reporter / reportee / reason(spam|harassment|inappropriate|other) / target(proposal|profile|icon|message) / latch_id|null / message_id|null / note(0..500) / status(open|resolved) / created_at — INDEX(reporter, latch_id, reportee, target, status)`。targetは通報の対象の種別(proposal=成立前の提案・profile / icon / message=成立後)、message_idはtarget=messageの対象の発言で、それ以外はnull。noteは前後の空白を除いて保存し、未指定は空文字とする。提案段階(target=proposal)は自分以外の全参加者をreporteeとして1人1行で記録する(オーナー裁定 2026-10-21・01冒頭の決定記録)。同じreporter・latch_id・reportee・target(messageはmessage_idも)でstatus=openの行があれば新しい行を作らず、reason・note・created_atを今回の値で上書きする(通報者内の統合・08 §8。resolved後の再通報は新しい行)。target・message_idと索引はマイグレーション0006で追加し、戻す手順(migrations_rollback/0006)を対で持つ(12 §4・11 §3。戻すと通報の対象の種別と対象の発言の記録が失われる。F7a実装確定)。0006はtargetをDEFAULTなしのNOT NULLで追加するため、staging・prodへ適用する前に `SELECT COUNT(*) FROM reports` が0であることを確かめる(F7a以前はreportsへの書き込みAPIが無く0のはず。行があればALTERは止まり、データは壊れない)。

**notifications**: `id / user_id / type(proposal|matched|closed|intent_expired|system) / latch_id|null / read_at / created_at / intent_id|null / push_state(none|pending|sent|muted|no_subscription|failed・既定none) / push_attempted_at|null — INDEX(user_id, read_at, id)・UNIQUE(latch_id, user_id, type)・UNIQUE(intent_id, type)・INDEX(push_state, created_at)`。closedは不成立(rejected / expired / cancelled)の総称であり、成立後の離脱(leave・matched→cancelled)ではclosedを作らない(F4a実装確定)。成立前の意思・条件サマリは格納しない(visibility単値化・01 §21)。**Web Pushの記録(F7b実装確定)。** intent_expiredはIntentの期限切れ(アプリ内通知のみ・01 §10)で、Cron(c)の第1窓がexpired化と同じバッチで1Intentにつき1行書く(intent_idに対象Intent。他の種別はnull。UNIQUE(intent_id, type)の衝突は無視し、再実行でも1回・06 §2)。systemは未使用のまま残す。push_stateはWeb Pushの送信の状態で、Web Push対象のproposal・matchedは行の作成時にpending、closed・intent_expiredはnone(Web Push対象外)を書く。送信の判断(04 §4)の結果をsent(1件以上の購読へ送れた)/ muted(本人の参加Intentのnotification_levelがmuted・オーナー裁定 2026-10-21・01冒頭の決定記録)/ no_subscription(本人のactiveな購読が無い)/ failed(全購読で恒久失敗、または作成から10分を過ぎて送れなかった)で記録し、一時失敗はpendingのまま再試行する。push_attempted_atは最後に送信の順番を取った時刻(条件付きUPDATEで取り、60秒以内の再取得をさせない)。mutedでもアプリ内通知の行は作り、通知上限(1日6件)の数え方は変えない。intent_id・push_state・push_attempted_atと2索引はマイグレーション0007で追加し、戻す手順(migrations_rollback/0007)を対で持つ(12 §4・11 §3。戻すとWeb Pushの送信の状態・試行時刻とintent_expiredの対象Intentの記録が失われる)。既存行はpush_state=noneとなり、過去の通知を送り直さない。

**push_subscriptions**: `id / user_id / endpoint(string UNIQUE) / p256dh / auth / status(active|failed) / last_success_at / created_at`。端末(ブラウザ)ごとの購読で、ユーザー単位のオン/オフ列は持たない(設定画面のプッシュ通知の切り替えは端末の購読の登録・解除で行う)。同じendpointの再登録は本人への付け替え・鍵の更新・status=activeへの復帰で、送信先が404・410を返した購読はstatus=failedにして以後送らない(F7b実装確定・§3.3)。

**sessions**: `id / user_id / started_at`(DAU・再来訪)。**survey_responses**: `id / user_id / kind(onboarding|week4) / answers(json) / created_at — UNIQUE(user_id, kind)`。

**calibration_records**(正解データ・01 §14)

```yaml
id:          ULID(PK)
latch_id:    FK latches | null   # 観測の間だけ持つ。匿名化でnull。UNIQUE(1LATCH1行・nullは重複とみなさない)
form:        connection | occasion
prediction:  json    # {latch_score: latches.score, jev: [ペアごとのJev 7軸]}(評価の行が残っていないペアは含めない)
outcome:     both_yes | one_no | expired | cancelled
                    # 成立の状態記録があればboth_yes(成立の後の離脱・ブロックでcancelledでも)。
                    # rejected(no・deferで閉じた)=one_no・expired・成立前のcancelled
action:      json    # 機会={attended: bool|null, attended_true: int, attended_false: int} /
                    # つながり={chat_started_7d: bool, exchanges_7d: int, exchanges_30d: int, blocked: bool, reported: bool}
survey:      json | null   # つながり7日時点の1問 {scores: [1〜5の昇順], skipped: int}。申告が無ければnull
context:     json | null   # 提案の条件の粗い形 {participants: 人数, time_bin: night|morning|afternoon|evening|null, municipality: 市区町村|null}
anonymized:  boolean       # 確定と匿名化を済ませたか(下記)
created_at / updated_at    # created_atは提示した時刻(proposed_at)。匿名化で丸める
INDEX(anonymized)
```

**正解データの作成と匿名化(F9実装確定・LAT-108・2026-10-26オーナー決定・01冒頭の決定記録(F9(正解データ)))。** 行は提示した(proposed_atのある)提案が閉じた後(matched・completed・rejected・expired・cancelled)に、毎分Cronの正解データの走査(06 §2の(j))が1LATCH1行を作る。予測はmatch_candidates(評価確定から30日で削除・§2.6)のJevの7軸を写すため、閉じた直後に作る(ペアごとに、提案を作った時点までの最新の評価の行・無ければその後の最初の評価の行)。作成済みの印はlatches.calibrated_at(datetime | null)に置き、行の挿入と印の書き込みを「印がまだ無い」を条件にした1つの取引で書く(再実行・並行した実行・匿名化でlatch_idが消えた後も二重に作らない)。未提示のまま閉じた提案(保留のまま閉じたもの)は人の回答が無いため行を作らず、印だけを付ける。行は観測の間だけLATCHに紐づけ、観測の終わり(成立しなかった提案は閉じた時点・つながりは成立から30日・機会は対象時刻から30日)・参加者の退会・参加Intentの削除のいずれかで、その時点までの行動でaction・surveyを確定し、同じ1文でlatch_idのnull化・時刻の丸め・anonymized=trueを書く(§2.5・08 §7)。観測の途中で確定した行は、その後の行動を含まない。各値の数え方は次のとおり。chat_started_7dは成立時の参加者全員(成立の後に離脱した人を含む)が成立から7日以内に1件以上送信したこと(09 §2のチャット開始と同じ)。exchangesは成立からの期間内のメッセージを送信順に並べ、発言者が入れ替わった回数(最初の発言は数えない)。blockedは参加者どうしのブロックが提案の作成から観測の終わりまでにあったこと、reportedはそのLATCHを対象にした通報があったこと(成立しなかった提案も数える)。attendedは参加の申告(latch_feedbackのattendance)に1件でもtrueがあればtrue、答えがfalseだけならfalse、答えが無ければnull。contextの時間帯は機会の対象時刻(proposal.time_window.start)のJSTの時を6時間ずつに分けたもの(0〜5時=night・6〜11時=morning・12〜17時=afternoon・18〜23時=evening。つながりはnull)、市区町村は基準Intent(最も先に預けた者・提案の地名と同じ)の中心から地名と同じ逆引きで引いたgeofeaturesのmunicipality(地域なし・Intentが残っていなければnull)。主題・地名・予算・IDは持たない。context列・latch_idのUNIQUE・anonymizedの索引・latches.calibrated_atとその索引はマイグレーション0010で追加し、戻す手順(migrations_rollback/0010)を対で持つ(12 §4・11 §3。戻すと匿名化した行の提案の条件と作成済みの印が失われ、作成の処理を動かすと二重に作るため、Workerを先に戻す)

**usage_counters**(レート制限・Jev予算の3層保護の実体): `scope(intent_daily|intent_hourly|jev_intent|jev_user|jev_global_daily|jev_global_monthly|external_send|alert_mail) / key(user_id|intent_id|'-'|<送信先>:<系統>|<メールの種類>) / period(日付or時間のバケット文字列) / count — PK(scope, key, period)`。加算は `UPDATE … SET count=count+1 … RETURNING` の原子的1文で行い、Queues consumerはバッチ単位でまとめて加算する(並行消費での取りこぼし防止)。periodが90日より古い行はCronで削除する(API単位のスロットルはWorkers Rate Limitingバインディング(key=user_id)が担い、本表には置かない)。**作成・更新の上限(F9実装確定・LAT-93)。** scope=`intent_daily`はIntentの作成の回数(key=user_id・periodはJSTの日付・上限20)、`intent_hourly`は預けているIntentの意味フィールドの書き直しの回数(key=user_id・periodはJSTの時`YYYY-MM-DD-HH`・上限6)で、どちらも利用者単位とする。数える範囲と確保・戻しの方法は04 §5**外部送信の集計(LLM real接続で確定)。** scope=`external_send`は外部AI事業者へ送った回数の記録(08 §5・07 §8)で、keyは`anthropic:parser`・`anthropic:jev`・`typesafe:jev`、periodはJSTの日付とし、送るたびに成否を問わず1加える(`INSERT … ON CONFLICT DO UPDATE`の1文)。送った中身は持たない。記録の失敗は呼び出しを止めない(ログに残すだけ)。予算・レート制限の判定には使わない **オーナーへのメールの送る権利(LAT-124・04 §4)。** scope=`alert_mail`は、予算アラートと日次サマリを種類(key=`jev_global_daily`・`jev_global_monthly`・`daily_summary`)と期間(periodはJSTの日付か月)ごとに1通だけ送るための行で、送る前に1件だけ入れた実行が送る。countは正なら送信中か送信済みの試行番号、負なら失敗した回数(3回で諦める)。他のscopeと同じく90日で削除する

**geofeatures**: `id / name / municipality / type(city|station) / lat / lng / grid_key(約1km=0.01度グリッドのキー・INDEX)`(ソースはISJ+駅データ。取り込みと変換の規定は04 §4)。grid_keyの書式は `${Math.floor(lat*100)}_${Math.floor(lng*100)}`(F4a実装確定)。逆引きは座標の属するセルの中心を基準点とし、そのセルと周囲を合わせた3×3セルの行からハバーシン距離の最近傍の地名を採る(同距離はid昇順・該当なしは地域名なし)。

**機会LATCH成立時の参加Intent(F4a実装確定)。** 機会LATCHが成立すると、参加Intentはstatus=matchedとupdated_atのみを更新する(versionは上げない・Vectorize metadataは更新しない)。matchedのIntentはLayer 1がD1の現行statusで除外するため、metadataの同期を要しない(§2.3の二重化)。

### 2.3 Vectorize・KV・R2

**Vectorizeインデックス**(1本): vector id = intent ULID。metadata = `{form, status, category, user_id, version}`(インデックス作成時にmetadata indexとしてform・status・categoryを宣言する。07 §1)。`version`は第1段でupsertしたときの意思のversion(整数)で、反映確認(06 §2)が新しいversionの反映を見分けるために使う(filterには使わないためmetadata indexは要らない。`version`を持たない既存のベクトルは反映確認の対象にならず、Cronのmetadata整合の修復は既存のmetadataを保ったまま書き直す・不具合の修正工程で確定)。検索時のfilterで form一致・status=active を最適化として適用し(01 §12)、取り出し後は**D1の現行status・blocks・提案履歴をコードで再検証する**(metadataの同期遅延に依存しない二重化)。Intentの遷移(pause/resume/expired)ごとにmetadataのstatusを更新し、失敗はCronのmetadata整合の修復で回収する(06 §2)(機会LATCH成立によるmatchedはmetadataを更新しない・§2.2)。照合時にD1行が存在しないベクトルはfail-closeで除外する。次元=1024・距離=cosine(07 v0.1で確定)。削除: Intent削除・期限切れ+7日でベクトル削除(§2.6)。**ローカル代替(F3実装確定)。** Vectorizeにはローカルシミュレータが存在しないため、LATCH_ENV=local(単体・統合試験・wrangler dev・E2E)では同一インタフェースのインメモリ実装(コサイン距離・metadata filter込み・04 §4のVectorStore抽象)へ置き換える。staging/prodはVectorize実装を使う。取得系(getByIds)は反映確認(metadataのversionの照合)・metadata同期・Cronの整合点検と、自分のベクトルを載せていない`embedding_completed`の第2段に使う(06 §2)。Vectorizeの取得は1回20件までで、超えると呼び出しが失敗するため、Vectorizeの実装の中で20件ずつに分けて呼ぶ(呼び出し側は上限を意識しない・不具合の修正工程(第2回)で確定)。

**KV**: `revocation:{jti}` = 1(TTL=JWT残り寿命)。失効はJWT残寿命(最大1時間)以内の効力とし、権限が関わる操作(チャット送信・回答・退会)はD1のusers.statusを必ず再検証して補完する。ブロックはトークンを失効させず、該当する提案・LATCHを閉じることで即時に効かせる(§2.2のblocks・§3.3)。WebSocket接続チケットはKVに置かず、**joseで署名した短期トークン(exp=60秒・user_id/latch_idクレーム)** を使う(結果整合の伝播遅延を回避。§3.4)。回転猶予: `rfg:{旧リフレッシュトークンハッシュ}` = 現行リフレッシュトークン(TTL 120秒・取得後に削除で使い切り。窓外の再提示は再利用検出として族をrevoked。04 §4)。猶予窓内の旧トークン再提示でKVエントリが見えない場合は結果整合の競合の可能性があるため族は失効させず401のみ(窓外のみ再利用検出として族revoked)。KVは結果整合のため猶予エントリの並行取得は理論上可能であり、猶予の「1回に限り」はベストエフォートとする。**パイプライン用KV(バインディングPIPELINE_KV・F4a実装確定)**: `jev:breaker` = Jevのcircuit breakerの状態(JSON・06 §5)。`jev:alert:{scope}:{period}` = 予算アラートの送信済み印(scope=jev_global_daily|jev_global_monthly・同一periodで1回・TTLはperiodの寿命より長く取る・06 §6)

**R2**: バケット1つ(`icons`)。キー=`{user ULID}/{ULID}`。受け付けはPNG/JPEG/WebP・1MBまで。Workersで受けて検証し保存(外部サービス送信なし)。URLは同一オリジンで配信(04 Assets経由ではなくWorkerレスポンスでストリーム)。

### 2.4 インデックス(主要・検証順序)

```text
intents:      (user_id, status) / (status, form, category) /
              (status, starts_at)  ← 機会Bucket走査 / (status, expires_at) ← 期限バッチ /
              (status, jev_held_at)  ← Jevの保留の判定し直し(06 §2の(k)・マイグレーション0011)
candidates:   UNIQUE組(前述)+ INDEX(intent_a_id), (intent_b_id)
latches:      (user_id...)は user_ids のJSONでなく参照テーブルを避け、
              latch_members(latch_id, user_id)を副表として持つ — INDEX(user_id, latch_id)
messages:     (latch_id, id)・UNIQUE(latch_id, user_id, client_id)
notifications:(user_id, read_at, id) / (user_id, type, created_at) ← 通知上限(1日6件)の判定
              UNIQUE(intent_id, type) ← 期限切れ通知を1Intent1行に限る / (push_state, created_at) ← Pushの回収走査(F7b)
proposal_history: PK(user_low, user_high)
latches:      (status, response_deadline) ← 回答期限切れ走査 / (status, proposed_at)
latch_status_events: (latch_id)
reports:      (reporter, latch_id, reportee, target, status) ← 通報者内の統合の照会(F7a)
match_events: (source_intent_id) ← 削除APIの子の削除・反映確認の照会 / (status, created_at) ← Cronの掃査(マイグレーション0008)
recent_vectors: (embedded_at) ← 期限切れの控えの削除(マイグレーション0009)
latches:      (calibrated_at, status) ← 正解データの未作成の掃査(マイグレーション0010)
calibration_records: UNIQUE(latch_id) ← 1LATCH1行 / (anonymized) ← 観測中の行の掃査(マイグレーション0010)
```

latch_membersは§2.2のlatches表からuser_ids列を置き換えた副表である(latches本体はintent_idsのみ保持)。

### 2.5 削除・退会時の扱い(01 §21の実表)

| 対象 | Intent削除時 | ユーザー退会時 |
|---|---|---|
| intents本文・構造化データ・埋め込み | 削除 + Vectorize該当ベクトル削除 | 本人の全Intentに同じ |
| match/group_candidates | 当該Intentを含む行を削除 | 同左 |
| recent_vectors | 当該Intentの控えを削除(外部キーのCASCADE) | 同左 |
| match_events | 当該Intentの行を削除(payloadにはraw_text・座標・識別子を格納しない) | 本人の全Intentに同じ |
| latches・latch_members | 進行中の提案はcancelled | 退会者が参加する進行中の提案(candidate・proposed・partial_accept)は即時cancelled(システムの都合の取り消しとして提案履歴を消費しない)。matchedからは退会者が参加取り消し(leave)と同じ処理で抜ける(1対1はLATCH全体をcancelledにしてチャットを双方読み取り専用にし、グループは退会者だけが抜け、残りが必要人数の下限を割れば全体をcancelled・2026-10-26オーナー決定(F9・LAT-94)。離脱・ブロックと区別できないようにする・01 §10)。completed・成立後のcancelledは変えない。行は残し、表示名は「つながっていた相手」(終了の原因は画面に区別して見せない・01 §10・2026-10-19オーナー裁定) |
| proposal_history | 残す(同一ペア排除のため・01 §8)。削除で取り消した進行中の提案のために確保した行は解放する(§2.2) | 本人を含む行を削除 |
| messages | 残す | 残す(表示名は「つながっていた相手」。本人からの削除要求には該当行の削除で応じる) |
| latch_responses / latch_feedback | 残す(集計値のみ利用) | 同左ののちcalibration_recordsへ匿名集約 |
| calibration_records | 当該Intentを含むLATCHの行を、その時点までの観測で確定し、latch_idをnull化+粒度低下(時刻日付丸め・地域市区町村)のうえ anonymized=true(2026-10-26オーナー決定・LAT-108) | 本人が参加したLATCHの行に同じ(観測の終わりでも同じ匿名化を行う・§2.2) |
| notifications / sessions / survey_responses | 当該Intent由来の通知を削除(intent_idが一致するintent_expiredの行を削除・F7b実装確定。LATCHの通知は当該LATCHの取り消しに従う) | 削除(surveyを集計目的で残す場合はID系を除去) |
| usage_counters | — | 本人key(user_idと本人のIntentのid)の行を削除 |
| blocks / reports | 残す | 残す(安全のための証跡。最後の活動から1年で削除) |
| push_subscriptions / refresh_families | — | 削除・失効(発行済みJWTのjtiをKV失効リストへ登録) |
| R2アイコン | — | icon_key解除+R2オブジェクト削除 |
| users行 | — | status=deleted + 表示名/プロフィール/アイコンを消去 |

**退会の実行順序(F9実装確定・LAT-94)。** DELETE /v1/users/meは、Intent削除と同じく取り消せない外部の削除を先に行う。(1)本人の全Intentのベクトル(Vectorize)と(2)R2のアイコンを消し、どちらかが失敗したらD1に触れず500 INTERNALで中断する(users行はactiveのまま残り、再試行で完結する)。ベクトルの削除はIntent削除と同じく短くやり直し、書き込みの頻度の上限が続いたときは503 TEMPORARILY_UNAVAILABLEで中断する(下のIntent削除の実行順序・LAT-126)。(3)本人が参加する進行中の提案を閉じ(他のペアの提案履歴を戻すため、提案履歴の削除より前に行う)、(4)matchedのLATCHから参加取り消しと同じ処理で抜ける。(5)子の行(1対1・グループの候補・match_events・通知)・本人の全Intent・本人を含む提案履歴・購読・sessions・survey_responses・usage_countersの削除と、refresh_familiesの失効・users行のstatus=deleted(表示名とひとことは空文字・icon_keyはnull。行とauth列は再登録で使い直すため残す)を1回のバッチ(1つの取引)で書く。(6)(3)の後に並行した評価が作った進行中の提案を拾い直して閉じる(Intent行が消えた後は作られない)。保留の解放・次の組の提案・Web Pushの送り出しは応答の後(waitUntil)に回し、退会者が抜けたLATCHのチャットの接続へはclosedを知らせる(§3.4)。要求に使ったアクセストークンのjtiはKVの失効リストへ入れる。他の端末の発行済みJWTはjtiを保存していないため列挙できず、リフレッシュ族の失効で更新できなくなる(残り寿命は最大1時間・権限が関わる操作はusers.statusの再検証で拒む・§2.3)。messages・latch_responses・latch_feedback・blocks・reports・latches・latch_membersは残す。**正解データの匿名集約(F9実装確定・LAT-108)。** (4)の後・(5)の前に、本人が参加者だった全LATCH(離脱済みを含む)のうち閉じたものについて、行の無いものは行を作り、紐づいた行はその時点までの観測で確定して匿名化する(§2.2。予測をmatch_candidatesから写すため、候補を消す(5)より前に置く)。(6)で閉じた提案の分も続けて同じ処理をする(候補は(5)で消えているため、その行の予測にJevの7軸は残らない)。匿名集約の失敗は退会を止めない(ログusers.withdraw.calibration_failed。参加者が退会したLATCHの行は、Cronの正解データの走査が観測の途中でも確定して匿名化する)

**Intent削除の実行順序(F3実装確定)。** Vectorizeの該当ベクトルの削除を先に実行し、これが失敗した場合はD1に触れず500 INTERNALで中断する(クライアントの再試行で完結する)。**ベクトルの削除のやり直し(不具合の修正工程(第8回)で確定・LAT-126)。** 削除が失敗したら、要求の中で0.5秒・1秒の待ちを置いて最大2回やり直す(`PIPELINE.VECTOR_DELETE_RETRY_DELAYS_MS`・最大の合計1.5秒)。Vectorizeの書き込みの頻度の上限(VECTOR_DELETE_40041・LAT-100の調べ)は数十秒続くこともあり、やり直しで吸収できるのは一瞬の重なりだけである。やり直しの後も40041で失敗したときは503 TEMPORARILY_UNAVAILABLE(「少し待ってからもう一度お試しください」)、それ以外の失敗は500 INTERNALとし、どちらもD1に触れない。画面はTEMPORARILY_UNAVAILABLEのときサーバーの文言をそのまま出す(500は一般の一文)。この順序により「Intent行が消えたならベクトルも消えている」ことを削除APIの側で保証する。ベクトルの削除は期限+7日の遅延ではなく**無条件の即時削除**である。**D1の削除(不具合の修正工程(第2回)で確定)。** 子の行(1対1・グループの候補・match_events・intent_expiredの通知)と本体の削除は1回のバッチ(1つの取引)で行い、途中で失敗しても子だけが消えた状態を残さない(子の行が本体を外部キーで参照するため本体を最後に置く)。グループ候補は、dedup_key(「ID@version」のカンマ結合)の文字列の一致で本人の意思を含む行のidを先に絞ってから消す(表全体のintent_idsを展開する走査をやめる。D1の束縛の上限のため1文50件ずつに分ける・issue #16)。**正解データの匿名集約(F9実装確定・LAT-108)。** 進行中の提案を閉じた後・子と本体を消すバッチの前に、本人が参加者のLATCHのうち当該Intentを含むものについて、退会と同じ匿名集約を行う(行の無い閉じた提案は行を作り、紐づいた行はその時点までの観測で確定して匿名化する・§2.2)。失敗は削除を止めない(ログintents.delete.calibration_failed。参加Intentの無いLATCHの行はCronの正解データの走査が確定して匿名化する)。各段の所要時間はログintents.delete.timing(layer=vector・open_latches・cancel・calibration・d1)に出し、ベクトルの削除の失敗のerror_codeは例外の分類名にする(06 §7)。**削除の後の書き戻し(不具合の修正工程(第2回)で確定)。** 削除の前に読み取りを済ませた第1段・Cronのバックフィルと修復・状態の同期が、削除の後にベクトルを書き戻すと孤立したベクトルが残る(issue #20)。ベクトルを書く経路はupsertの直前に意思の行を読み直して行が無ければ書かず、それでも残ったベクトルは他の評価のLayer 1で行の無いhitとして見つけて消す(06 §2の孤立したベクトルの自己修復)。

### 2.6 保持期間・定期削除(Cron・04 §4)

- match_candidates / group_candidates: 評価確定から30日で削除(01 §21)
- 期限切れIntentの埋め込み: 期限+7日でVectorizeから削除
- LATCHのcompleted判定(F5実装確定): matchedのつながりLATCHは最終メッセージ(0件ならmatched時刻)から90日経過、matchedの機会LATCHは対象時刻(proposal.time_window.start)から3時間経過でCronがcompletedへ(01 §8・06 §2の(d))。latches(status, form, last_message_at)の索引で走査し、機会の対象時刻はproposalのJSONから読む(matchedの機会LATCHは対象時刻が7日以内のものに限られ件数が小さいため列を設けない)。completedでIntentの状態とproposal_historyは変えない
- intentsの期限切れバッチ: (status, expires_at)索引で「expired化対象(now超過)」と「ベクトル削除対象(now-7日超過・vector_deleted_at IS NULL)」の2窓を走査。削除実行時にvector_deleted_atへ記録
- KVチケット: TTL 60秒で自動消滅
- calibration_records(F9実装確定・LAT-108): 提示した提案が閉じたら毎分Cronが行を作り、観測の終わり(成立しなかった提案は閉じた時点・つながりは成立から30日・機会は対象時刻から30日)で確定して匿名化する(§2.2・06 §2の(j)。観測を終えた紐づいた行の点検は毎時0分に行う)。匿名化した行(anonymized=true)は削除せず長期保持する(08 §7)。走査はlatches(calibrated_at, status)とcalibration_records(anonymized)の索引で行い、1回500件で頭打ちにする

## 3. API契約

### 3.1 共通規定

- 認証: `Authorization: Bearer <JWT>`(§3.2のauth系2つを除く全API)。権限は所有者本人または提案参加者のみ(サーバ側強制)
- 成功: 200/201/204。エラー: 次の形状のみ

```json
{ "error": { "code": "UNDER_AGE", "message": "解説文(日本語)", "details": {} } }
```

- 主要エラーcodeとHTTPステータスの対応: UNAUTHORIZED/TOKEN_EXPIRED=401・FORBIDDEN=403・NOT_FOUND=404・VALIDATION_FAILED/FORM_MISMATCH=400・RATE_LIMITED=429・ACTIVE_INTENT_LIMIT/UNDER_AGE/ALCOHOL_RESTRICTED/PARSE_FAILED=422・EMBEDDING_PENDING=409・UPGRADE_REQUIRED=426(WebSocket接続のルートへのUpgradeでない要求・F6a実装確定)・INTERNAL=500・TEMPORARILY_UNAVAILABLE=503(Intent削除と退会のベクトルの削除が書き込みの頻度の上限に当たり続けた。少し待てば通る・§2.5・LAT-126)。本人が所属しないlatch・他人のIntentへのアクセスは、存在を推測させないため一律NOT_FOUNDを返す(FORBIDDENは自己リソースへの操作権限の欠如に限る)
- ページネーション: 一覧系は `?cursor=<不透明>&limit=1..50(既定20)`。応答は `{items: [...], next_cursor: string|null}`
- レート制限: 1ユーザーあたり60req/分・Intent作成20件/日・更新6回/時間(04 §5)。超えた要求は429 RATE_LIMITEDとし、`details.reason`にどの上限かを載せる(`requests_per_minute`・`intent_creates_per_day`・`intent_updates_per_hour`・F9実装確定)。`Retry-After`は、60req/分では固定60秒、作成20件/日では次のJSTの0時まで、更新6回/時間では次のJSTの正時までの秒数(1以上の整数)とする。数えるのは、作成=`POST /v1/intents`の成功(draft保存も1件)、更新=`PATCH /v1/intents/{id}`のうちactiveの意味フィールド(§3.2の意味フィールドの変更の判定と同じ)が変わる成功だけで、表示系(notification_level)の変更・draftの編集・draftのactive化・pause/resume・失敗した要求は数えない(01冒頭の決定記録(2026-10-26・F9(レート制限)))。60req/分の対象外はauth/token・auth/refresh・auth/logout・healthz・アイコンの取得・WebSocket・dev専用API(04 §5)。画面は理由ごとの案内文を既存のエラー表示の場所に出す(文言は同じ決定記録)

### 3.2 エンドポイント一覧

```http
POST   /v1/auth/token                    # IdPトークン検証+JWT発行。User未登録なら user=null&registration_required=true
POST   /v1/auth/refresh                  # 回転式(旧トークン再利用は族失効+401)
POST   /v1/auth/logout                   # JWT失効(KV)+族失効

POST   /v1/users                         # 初回登録(display_name・birth_date。18歳検証)
GET    /v1/users/me
PATCH  /v1/users/me                      # display_name・bio
POST   /v1/users/me/icon                 # アイコン登録(PNG/JPEG/WebP・1MB)
DELETE /v1/users/me/icon

POST   /v1/intents/parse                 # 構造化プレビュー(form判定含む。保存しない)
POST   /v1/intents                       # 作成(status=draft可)
GET    /v1/intents?status=active|draft|… # 自Intent一覧
GET    /v1/intents/{id}
PATCH  /v1/intents/{id}                  # 更新(version+1)・draft→active化(検証は§2.2)
       # 可変フィールド: draft=全項目+status:"active" / active=topic・time・geo・
       # participants・budget・constraints(3種)・notification_levelのみ
       # (他のフィールド指定はfield_not_allowed=400・paused等へのPATCHは
       # invalid_status=400。詳細は§3.3)。topic・constraints等の意味フィールド変更時のみ
       # Embedding再計算イベントを発行し、表示系のみの変更は再評価しない。active宛の
       # 意味フィールド変更は進行中の提案の取り消しと30分再評価抑制の解除を伴う(§3.3)
DELETE /v1/intents/{id}
POST   /v1/intents/{id}/pause / resume

GET    /v1/latches?type=proposals|matched   # 提案一覧/成立一覧(自分が参加するもの)
GET    /v1/latches/{id}                     # 単一取得(参加しない・存在しない・保留中は一律404)
POST   /v1/latches/{id}/response            # {response: yes|no|defer, defer_reason?}
POST   /v1/latches/{id}/defer-reason        # {reason: no_capacity|schedule_mismatch|just_not_now|other}(見送った本人が1回だけ)
POST   /v1/latches/{id}/response/retract    # 回答取り消し(回答期限内・未成立に限る)
POST   /v1/latches/{id}/leave               # 参加取り消し(成立後・チャット読取専用化。01 §10)
POST   /v1/latches/{id}/feedback            # {kind: attendance, value:{attended}} / {kind: connection_quality, value:{score}}(本人が1種別1回・§3.3)
DELETE /v1/latches/{id}                     # 自分の側の表示削除(02 D-08・続いているLATCHは本人の離脱を伴う・§3.3)
DELETE /v1/users/me                          # 退会(IdP再認証のうえ§2.5の削除処理を実行)

GET    /v1/users/{user_id}/icon              # アイコン取得(未認証・推測困難キー・Cache-Control: private, max-age=3600)

GET    /v1/latches/{id}/messages?before=    # 履歴(50件/頁・昇順返却)
POST   /v1/latches/{id}/messages            # REST送信も可(WS不通時の代替)
POST   /v1/latches/{id}/read                # {last_read_message_id}
GET    /v1/latches/{id}/ws?ticket=          # WebSocket接続(Authorizationヘッダを使わずチケットで認証・§3.4)

POST   /v1/ws-ticket                       # {scope:"chat", latch_id} → {ticket, expires_in:60}(matchedのみ発行)

POST   /v1/sessions                        # セッション開始計測
POST   /v1/users/{user_id}/block      # ブロック(201新規/200既存・効果は再適用・§3.3)
DELETE /v1/users/{user_id}/block      # 解除(204・冪等)
GET    /v1/blocks                     # 自分のブロック一覧(新しい順)
POST   /v1/reports                    # 通報(201 {received:true}・§3.3)
GET    /v1/notifications?cursor=      # アプリ内通知の一覧(20件/頁・{items, next_cursor, unread_count}・§3.3)
POST   /v1/notifications/read         # {up_to_id}(id≤up_to_idの本人の未読を既読に・204)
GET    /v1/push/vapid-public-key      # {public_key}(購読のapplicationServerKey)
POST   /v1/push-subscriptions         # {endpoint, keys:{p256dh, auth}}(201新規/200既存・本文なし・§3.3)
DELETE /v1/push-subscriptions         # {endpoint}(本人の行を削除・204・冪等)
GET/POST /v1/users/me/survey               # 体感アンケート(01 §7・完成条件外)
```

### 3.3 主要レスポンス形状(抜粋)

**POST /v1/auth/token** — `{access_token, refresh_token: string|null, expires_in: 3600, user: UserDTO|null, registration_required: boolean}`。未登録は user=null・refresh_token=null・registration_required=true(登録前JWTの発行・04 §4)。IdPトークン検証の失敗は一律401 UNAUTHORIZED(固定文言)。

**POST /v1/users** — 201 `{user: UserDTO, access_token, refresh_token, expires_in}`(sub付きJWTへの付け替えと新規リフレッシュ族・04 §4)。18歳未満は422 UNDER_AGE・既に登録済み(同一(provider, subject)のactive行)は400 VALIDATION_FAILED。

**GET・PATCH /v1/users/me** — 200 UserDTO(`{id, display_name, bio, has_icon}`)。行無し・status=deleted(退会済み)は一律404 NOT_FOUND(存在を露見させない)。

**DELETE /v1/users/me(退会・F9実装確定・LAT-94)** — 本文 `{provider, idp_token}`(POST /v1/auth/tokenと同じ形)。クライアントは退会の直前にIdPで再ログインし、得たIDトークンを添える。サーバーはトークンを検証し、(provider, subject)が本人のusers行と一致し、発行(iat)から10分以内のときだけ§2.5の削除処理を行う。成功は204(本文なし)。本文の形の誤りは400 VALIDATION_FAILED、再認証の失敗(検証の失敗・別のアカウント・古いトークン・iat無し)は区別せず403 FORBIDDEN(401はクライアントがセッション切れとして再ログインへ倒すため使わない。自己リソースへの操作権限の欠如として§3.1のFORBIDDENに当たる)、行無し・退会済みは404 NOT_FOUND、外部の削除(ベクトル・アイコン)の失敗は500 INTERNAL(D1は未変更・再試行できる)。ベクトルの削除が書き込みの頻度の上限に当たり続けたときは503 TEMPORARILY_UNAVAILABLE(§2.5・LAT-126)。10分の窓は、端末に残った古いIdPトークンの使い回しを塞ぐための技術的な裁量で確定した値。成立後のLATCHの表示(LatchDTOのmembers・NotificationDTOのdisplay_names・GET /v1/blocks)では、退会した参加者を表示名「つながっていた相手」・bioは空文字・has_icon=falseとする

**POST・DELETE /v1/users/me/icon** — 201 UserDTO / 204(冪等)。**GET /v1/users/{user_id}/icon** — 200(未認証・Cache-Control: private, max-age=3600)。ユーザー不在・deleted・アイコン無しは区別せず404。

**POST /v1/auth/refresh** — 200 `{access_token, refresh_token, expires_in}`(回転式・04 §4)。期限切れは401 TOKEN_EXPIRED・未知/再利用トークンは401 UNAUTHORIZED。

**POST /v1/intents/parse** — `{form, topic, category, time:{start,end}|null, geo:{center:{lat,lng},radius_m}|null, participants:{min,max,includes_owner}, budget:{min,max,currency:"JPY"}|null, expires_at_options:[...], alcohol_involved, warnings:[{field, note}](判定不能NG条件の注意表示)}`。formはクライアント側で切替可能(確定送信は別API)。geoは常にnull(parseは地域を解決しない・ユーザーが添付で確定させる)・participants.includes_ownerはtrue・budgetの通貨はJPY固定。expires_at_optionsは期限の選択肢(ISO 8601・昇順): つながりIntent=now+7日/now+30日/now+90日の3件・機会Intent=時刻確定時はstart+3時間の1件・時刻未確定は空配列(期限の選択肢はstubとrealで同じ計算をコードで行い、モデルには作らせない・07 §3)。warningsには、人数を2〜4人へ丸めたときの`{field:"participants"}`と、入力文に場所の言及があるときの`{field:"geo"}`(地図で場所を添えるよう促す)が入る。Parserの失敗(時間切れ・混雑・応答の形の誤りなど・07 §3の失敗種別)は種別を問わず422 PARSE_FAILEDとする(LLM real接続で確定)

**IntentDTO(Intent系API共通の応答形状)** — `{id, form, topic, category, raw_text, time:{start, end}|null, geo:{center:{lat,lng}, radius_m}|null, participants:{min, max, includes_owner}, budget:{min, max, currency:"JPY"}|null, hard_constraints:[...], soft_constraints:[...], negative_constraints:[...], visibility:"hidden_until_match", notification_level, alcohol_involved, status, version, expires_at, created_at, updated_at}`。form・topic・category・time・geo・budget・expires_atは未確定欄がnullとなる(draft保存の許容・§2.2)。時刻はISO 8601。visibilityは単値のため常に"hidden_until_match"

**POST /v1/intents** — 201 IntentDTO。初回作成はversion=1で、statusの省略時はactive・draftは意味検証せず保存できる。draft保存では期限の選択(expires_in_days)を含められない(POST/PATCHとも400・理由コードexpires_choice_on_draft)。選択は預ける時(active化)に確定し、draftの明示expires_atは格納できる(機会Intentのactive化時の採用順は 明示expires_at > draft保存値 > 既定start+3時間)。active(status="active"を伴う作成)は§2.2の検証を行い、違反は400 VALIDATION_FAILEDのdetails.reasonsに理由コードの配列で返す: form_required / topic_required / starts_at_required / starts_at_out_of_range / starts_at_not_allowed / alcohol_not_allowed / expires_at_not_allowed / expires_at_before_start。機会Intentのactive作成にexpires_in_daysを指定した場合は400(理由コードexpires_in_days_not_allowed・期限は開始時刻基準で確定するため期限日数の選択肢とならない。黙って無視はしない)。**飲酒年齢の判定(F7a実装確定)。** 機会Intentでalcohol_involved=trueのactive作成とdraftからのactive化(PATCH)は、判定時点で本人が満20歳未満なら422 ALCOHOL_RESTRICTEDとする(満年齢は日本標準時の誕生日で1つ進む・Layer 1と同じ定数・08 §8)。判定の順は400 VALIDATION_FAILEDの検証の後・Active Intent上限(422 ACTIVE_INTENT_LIMIT)の前で、両方に当たるときはALCOHOL_RESTRICTEDを返す。本人のusers行が無い・activeでないときは年齢を確かめられないため、飲酒を含む機会Intentに限り同じ422で拒否する(安全側。文書の裁量で確定した技術的事項)。activeのPATCHはalcohol_involved・formを変えられないため判定の対象にならず、draftの保存は従来どおり検証しない(01 §9)

**GET /v1/intents** — 200 `{items: IntentDTO[], next_cursor: string|null}`。自Intentのみ・順序はid降順(ULID=新着順)。`?status=<単一値>`で絞り込み(不明な値は400)。limit=1..50(既定20・範囲外は400)。cursorは不透明(直前ページ最終idのbase64url化・復号できない値は400)

**GET・PATCH・DELETE /v1/intents/{id}** — 200 IntentDTO / 200 IntentDTO(version+1) / 204。他人の・存在しないは一律404(§3.1)。PATCHの可変フィールド: draft=全項目+status:"active"(active化)・active=topic・time・geo・participants・budget・constraints(3種)・notification_levelのみ(他のフィールド指定は400 field_not_allowed)。draft・active以外(paused/matched/expired/cancelled)へのPATCHは400 invalid_status。draft宛のexpires_in_daysは同一リクエストがstatus:"active"を伴う場合を除き400 expires_choice_on_draft(status:"active"を伴う場合でも結果formが機会なら400 expires_in_days_not_allowed・つながりは期限の選択として有効)。active機会Intentのtime変更は範囲を再検証し、現在のexpires_at以降へは変更できない(400 starts_at_after_expires)。PATCH・pause・resumeのUPDATEは**version楽観ロック**(01 §16)を持ち、読み出し時のversionと一致する行のみ更新する(並行更新の後勝ち上書きを防止)。競合で更新が0行だった場合は1回だけ再読込して判定し、行が残っていれば400 VALIDATION_FAILED(理由コードversion_conflict)・消えていれば一律404(§3.1)を返す。**PATCHによる進行中の提案の取り消し(F4a実装確定)。** active Intentで意味フィールド(topic・time・geo・participants・budget・constraints=intent_updatedを発行する変更・06 §2)が変わった場合、または期限(expires_at)が短くなる場合は、当該Intentを含む進行中の提案(candidate・proposed・partial_accept)をIntent削除と同じ流れでcancelledに閉じる(proposal_historyは消費せず解放する=新規確保の行は削除・再提案で確保した既存行はexpiredへ戻す・§2.2。提示済みなら参加者へclosed通知・更新者以外の参加者の保留を解放する。01 §8の不成立経路「Hard Constraintが変化した」)。notification_level等の表示系だけの変更では閉じず、matchedは変えない。再評価は既存どおりintent_updatedで走り、新しい内容で再提案され得る。**意味フィールドの更新による30分再評価抑制の解除(オーナー裁定 2026-10-20・F4a実装確定)。** active Intentで意味フィールドが変わった場合はintents.last_evaluated_atをnullへ戻す(更新後のversionと一致する行のみ・並行更新で版が進んでいれば触らない)。表示系だけの変更では解除しない(06 §3・§6)

**POST /v1/intents/{id}/pause・resume** — 200 IntentDTO(version+1)。pauseはactiveのみ実行可(他は400 invalid_status)・status=paused・期限は不変。resumeはpausedのみ実行可(他は400 invalid_status)・期限切れ(expires_at<=now)は400(理由コードexpired)・status=active・期限は据え置き(再計算しない)。参加中active数の上限5件は作成・draft→active化・resumeの3経路で検証し、超過は422 ACTIVE_INTENT_LIMIT(§3.1)

**LatchDTO(LATCH系API共通の応答形状・F4a実装確定)** — `{id, form, status, response_deadline, participants_count, my_response: yes|no|defer|null, score, my_intent_id, matched_at}`。my_intent_idはlatches.intent_idsのうちintents.user_idが呼び出し本人のIntentのID(全状態で含む。Intent削除済みで見つからなければnull)、matched_atは成立時刻(latch_status_eventsのto_status=matchedのcreated_atをISO 8601で返す。成立前など成立を経ていなければnull、matched経由のcancelled・completedは成立時刻を返す)。scoreは応答に含むがUIでは表示しない(01 §10の裁定)。**成立後(matched・completed、およびmatched経由のcancelled)に限り** `proposal:{form, topic, time_window, region_name, participants, budget}` と `members:[{user_id, display_name, bio, has_icon}]`(自分と離脱者を除く参加者)を含める。participants_countは離脱していない参加者(latch_members.left_atがnull)の数とする(成立前は全員が該当する・F4b実装確定)。成立前はproposal・membersの**キー自体を出さない**(空値でも出さない・visibility単値化・01 §21)。matched経由のcancelledはlatch_status_eventsにto_status=matchedの記録があることで判定する。保留中(candidate)のLATCHは一覧にも単一取得にも出さない(単一取得は404)。

**LatchDTOの自己申告の受付(F9実装確定)。** 成立後(matched・completed・matched経由のcancelled)に限り `feedback_due: attendance|connection_quality|null` を加える。本人の申告を受付中で、本人がまだ申告していない(スキップも申告に数える)ときにその種別を、それ以外はnullを返す。成立前はproposal・membersと同じくキー自体を出さない。受付の条件はPOST /v1/latches/{id}/feedbackと同じ。画面はつながり一覧の5段階の問いをconnection_qualityの先頭の1件だけに出し、attendanceの画面は作らない(オーナー裁定 2026-10-26・01冒頭の決定記録)。

**LatchDTOのチャットの要約(F6a実装確定)。** 成立後(matched・completed・matched経由のcancelled)に限り `last_message: {body, created_at, user_id} | null`(最新メッセージ・0件ならnull)と `unread_count`(本人以外が送り、本人のchat_reads.last_read_message_idより新しいメッセージの数。既読の記録が無ければ本人以外の全件)を加える。成立前はproposal・membersと同じくキー自体を出さない。

**GET /v1/latches** — 200 `{items: LatchDTO[], next_cursor: string|null}`。自分が参加するもののみ・id降順。type=proposalsはstatusがproposed・partial_accept、type=matchedはmatched・completedと、matched経由のcancelled(相手の離脱・表示削除で終わったもの。残された側に「このつながりは終了しました」の履歴を残すため・F6a実装確定)を返す(completed後も閲覧できる・02 D-08・F5実装確定。typeの欠落・不明な値は400)。続いているLATCHから離脱した本人(left_at)・表示削除をした本人(hidden_at)には出ない。LATCH全体を取り消した離脱者はleft_atを持たないため、matched経由のcancelledとして出る(オーナー裁定 2026-10-21)。limit・cursorはIntent一覧と同一の規則(§3.1)。**GET /v1/latches/{id}** — 200 LatchDTO。参加しない・存在しない・保留中は一律404。

**POST /v1/latches/{id}/response** — 200 状態遷移後のLatchDTO。全員YESで matched + チャット解放対象となり、双方の詳細情報(表示名・アイコン・プロフィール)が以降のGETに含まれる(01 §8)。回答系(response・response/retract・leave・defer-reason)の失敗は、参加しない・存在しないは一律404、それ以外は400 VALIDATION_FAILEDのdetails.reasonsに理由コードを返す: invalid_status(その状態では実行できない) / deadline_passed(回答期限経過) / already_responded(回答済み・見送り理由の保存済み・自己申告の申告済み) / not_deferred(defer-reasonで本人の有効な回答がdeferでない) / kind_mismatch(feedbackでkindが形式と合わない・下記)。

**POST /v1/latches/{id}/defer-reason** — 200 LatchDTO。見送った(defer)本人だけが1回だけ保存できる(latch_responses.defer_reason)。理由の値はno_capacity / schedule_mismatch / just_not_now / otherの4種(他の値・余分なキーは400)。

**POST /v1/latches/{id}/feedback(正解データの自己申告・01 §14・F9実装確定)** — 本体は `{kind: "attendance", value: {attended: boolean|null}}` か `{kind: "connection_quality", value: {score: 1〜5の整数|null}}`。nullはスキップで、答えなかったことを1回分として記録する。kindの欠落・不明な値、値の型・範囲の外れ、余分なキーは400 VALIDATION_FAILED(details.reasonsなし)。成功は200で操作後のLatchDTO(feedback_dueはnull)を返す。参加しない・存在しない・保留中のLATCHと、離脱した本人(left_at)・表示から消した本人(hidden_at)は一律404とする(回答系と同じ)。それ以外の失敗は400 VALIDATION_FAILEDのdetails.reasonsに理由コードを返す: kind_mismatch(kindがLATCHの形式と合わない。機会=attendance・つながり=connection_quality) / invalid_status(受付の前) / already_responded(本人がその種別を申告済み)。判定はこの順に行う。受付の始まりは、connection_qualityが成立から7日(latch_status_eventsのto_status=matchedの時刻から`LATCH.CONNECTION_FEEDBACK_AFTER_MS`)、attendanceが機会LATCHのcompletedへの遷移で、締め切りは設けない。つながりが終わった後(completed・matched経由のcancelled)も受け付け、機会LATCHのmatched経由のcancelledは受け付けない(completedにならないため)。1人1種別1回はlatch_feedbackのUNIQUEに任せ、挿入が起きなければalready_respondedとする(並行した2回でも1行だけが残る)。答えの変更はできない(以上のうち受付の時期・スキップ・1回だけ・attendanceの画面を作らないことはオーナー裁定 2026-10-26・01冒頭の決定記録。理由コードと判定の順は文書の裁量で確定した技術的事項)。

**回答と取り消しの状態遷移。** defer=[今回は見送る]は提案を即時にrejectedで閉じる(proposal_historyのoutcomeはdeferred)。no=API契約経由の明示の拒否(同rejected・outcome=rejectedで恒久排除)。retract(回答取り消し)は回答期限内・未成立のみ可とし、partial_accept→proposedへ復帰する(双方YES成立後は不可。離脱はleaveを使う)。leave(参加取り消し)はmatchedのLATCHに対してのみ実行できる。離脱後の残りの参加者数(本人以外でleft_atがnullの数)が提案内容の人数の下限(proposal.participants.min)以上なら本人のleft_atだけを記録してmatchedのまま続け、下限を割るならLATCH全体をcancelledとしてチャットを読み取り専用にする(1対1は常に後者・02 D-08。オーナー裁定 2026-10-20・01冒頭の決定記録・F4b実装確定)。判定と記録は1文の条件付きUPDATEで行い、並行した離脱でも下限未満の人数でmatchedのまま残らない。leaveではclosed通知を作らない(closedは不成立の総称・§2.2)。離脱者の提案履歴と機会Intentはmatchedのまま変えない(§2.2)。matchedのまま続くLATCHから離脱した本人(left_atを持つ)からは当該LATCHを非参加と同じに扱う(一覧から除外・単一取得と各操作は一律404)。ただし離脱に成功したPOST /leaveの応答は、本人を参加者として扱った操作後のLatchDTO(status=matched・participants_countは残りの人数・membersは本人と離脱者を除く)を返す。同じ本人の二重の離脱(二重送信・再試行)は冪等な成功とし、LATCHを取り消さない。下限割れでLATCH全体をcancelledにしたときは本人のleft_atを記録しない。本人は取り消し済みLATCHの参加者のまま、一覧(type=matched)・単一取得・履歴・既読を使え、送信とチケットは400 read_only(チャットは双方読み取り専用・01 §10)。残った参加者のmembers・participants_countにも本人は残る(1対1の残された側はmembers=[本人]・participants_count=2)。表示から消したいときはDELETEを使う(オーナー裁定 2026-10-21・01冒頭の決定記録)。離脱の成功後は、チャットの接続へ`closed`を知らせる(LATCHがcancelledになったときは全員・本人だけが抜けたときは本人の接続。§3.4)。

**DELETE /v1/latches/{id}(表示から消す・オーナー裁定 2026-10-21・01冒頭の決定記録・F6a実装確定)** — 成功は204(本文なし)。matchedは上記のleaveを実行し、成功したら本人のlatch_members.hidden_atを記録する(1対1は全体cancelled・グループは本人だけが抜け、下限割れで全体cancelled。全体を取り消したときは本人のleft_atを記録しないため、相手の側のmembers・participants_countには本人が残る)。leaveが並行した状態変化(completed等)で実行できなかったときは状態を読み直し、閉じた成立後のLATCHなら表示から隠すだけを行う。completed・matched経由のcancelledはhidden_atの記録だけで、left_at・人数・相手の側の表示は変えない。判定の順は、参加しない・存在しない・保留中を一律404とした後、まず本人のhidden_atを確かめ、既にあれば状態を問わず204(再試行の冪等)とする。その後に本人がleft_atを持てば404、上記以外の状態(成立前・成立せず閉じたもの)は400 invalid_statusとする。matchedの削除の成功後はleaveと同じ宛先へ`closed`を知らせ、表示から隠すだけのときは知らせない。hidden_atを持つ本人には、一覧・単一取得・回答系(response・response/retract・leave・defer-reason)・チャットの各APIで当該LATCHを非参加と同じに扱う(一律404。例外はこのDELETEの再試行の204のみ)。

**チャットのAPI(F6a実装確定)。** 失敗の写像はLATCH系と同じで、参加しない・存在しない・保留中・本人がleft_atかhidden_atを持つは一律404、それ以外は400 VALIDATION_FAILEDのdetails.reasonsに理由コードを返す: invalid_status(成立前・成立せず閉じたLATCH) / read_only(completed・matched経由のcancelledへの送信・チケット) / invalid_message(本文が前後の空白を除いて空か2,000字超) / unknown_message(既読の記録で当該LATCHのメッセージでないID)。履歴と既読はmatched・completed・matched経由のcancelledで使え(completed等は読み取り専用)、送信とチケットはmatchedに限る。要求の形はzodスキーマで定め、余分なキーは400とする。

- **MessageDTO** — `{id, user_id, body, created_at, client_id}`。client_idは本人の送信にだけ値を入れ、他の参加者の送信はnull
- **POST /v1/ws-ticket** — `{scope:"chat", latch_id}` → 200 `{ticket, expires_in:60}`(§3.4)
- **GET /v1/latches/{id}/messages?before=<message_id>** — 200 `{items: MessageDTO[], next_before: string|null}`。beforeより前(省略時は最新)の50件をID昇順で返す。さらに古い行があればnext_beforeに返した中で最古のID、無ければnull。beforeがULID形式外は400
- **POST /v1/latches/{id}/messages** — `{body, client_id}`(client_idは1〜64字の`[A-Za-z0-9_-]`)→ 201 MessageDTO。ルートは参加の確認(上記の失敗の写像)を行ってからDOへ転送し、非参加・存在しないIDでDOを作らない。保存と配信はWebSocketと同じくDOが直列に行う(§3.4・保存の可否の正はDOの条件付きINSERT)。同じclient_idの再送は保存済みの行を返す(201)
- **POST /v1/latches/{id}/read** — `{last_read_message_id}` → 204。既読は前にだけ進め、古いIDは何もせず204(§2.2)

**dev専用観測API(F3実装確定・テスト専用)** — GET /v1/dev/match-events・GET /v1/dev/match-candidates。worker E2Eがゲートの合格証拠(match_eventsの計測payload・match_candidatesの生成記録)を観測するためのdev専用API。クエリはintent_id(必須・ULID形式外は400)・limit=1..50既定20・cursor(§3.1と同一の不透明cursor)。応答は`{items, next_cursor}`(id降順)で、itemsはmatch_events行=id / event_type / source_intent_id / version / status / payload / created_at / processed_at・match_candidates行=id / intent_a_id / intent_b_id / intent_a_version / intent_b_version / form / retrieval_score / cheap_judge_score / status / created_at / updated_at(テーブル列の範囲のみ・jev_result等の内部列は含めない)。起点Intentとの一致条件はmatch_events=source_intent_id・match_candidates=intent_a_idかintent_b_idのいずれか。所有者に限定しない(候補は2ユーザーのIntentで構成されるため・観測の実行は認証済みユーザーが行う)。存在隠しはPOST /v1/dev/idp-token(04 §4)と同一条件(prod・テスト鍵2変数のいずれか未設定は認証・クエリ検証より先に一律404・理由は区別しない)。

**dev専用API(F4a実装確定・テスト専用)** — 存在隠しは上記と同一条件。(1) GET /v1/dev/match-candidatesの行にjev_result・latch_scoreを追加する(#15の証拠)。(2) GET /v1/dev/latches?intent_id= — intent_idsに指定Intentを含むLATCHをid降順で返す(`{items, next_cursor}`・itemsはid / form / status / intent_ids / response_deadline / proposed_at / score)。(3) GET /v1/dev/proposal-history?user_id= — user_lowかuser_highが指定ユーザーの履歴行をid降順で返す(itemsはid / user_low / user_high / latch_id / outcome / created_at / updated_at)。(2)(3)のlimit・cursorは観測APIと同一の規則で、参加者・所有者に限定しない。(4) POST /v1/dev/latches/{id}/backdate `{response_deadline?, history_updated_at?, intents_last_evaluated_at?, matched_at?}` — E2Eが時計を操作せずに期限経過と再提案の条件と自己申告の受付を作るための書き換え口(10 §3)。それぞれlatches.response_deadline・そのLATCHのproposal_history行(latch_id一致)のupdated_at・参加Intent全員のlast_evaluated_at・そのLATCHの成立の状態記録(latch_status_eventsのto_status=matched)のcreated_atを指定時刻へ書き換える(matched_atはF9で追加)。存在しないLATCHは404。

**ブロックのAPI(オーナー裁定 2026-10-21・01冒頭の決定記録・F7a実装確定)。**

- **POST /v1/users/{user_id}/block** — 本文なし。新規は201・既にブロック済みは200(効果は再適用する・冪等)で、応答は本文なし。対象は自分と同じLATCHに成立後の参加者として居たことがある相手(latch_membersで同じLATCHに属し、そのLATCHがmatched・completed・matched経由のcancelledのいずれか)に限る。該当しない相手・存在しない相手・退会済み(deleted)の相手は一律404 NOT_FOUND(成立前は相手のIDを開示しないため、任意IDでの存在の探索を塞ぐ・§3.1)。自分自身は400 VALIDATION_FAILED(理由コードself_block)。blocks行を先に書き込み(既にあれば何もしない)、その後で次の効果を順に適用する(1回のバッチにはまとめない。各効果は対象が既に閉じていれば何もしないため、途中で失敗した前回の効果を再送で完了できる)。(1) 2人を含む進行中の提案(candidate・proposed・partial_accept。グループの提案も全体)をIntent削除と同じ流れでcancelledに閉じる(proposal_historyは消費せず解放する・§2.2。提示済みなら参加者へclosed通知・ブロックした本人以外の参加者の保留を解放・グループの次集合の提案は取り消しの後続と同じ・06 §2)。(2) 2人がともに参加を続ける(left_atがnull)matchedのLATCHごとに、ブロックした本人について上記のleaveを行う(1対1は全体cancelledで双方読み取り専用・グループは本人だけが抜け下限割れで全体cancelled)。その後、離脱した各LATCHについてleaveと同じ宛先へ`closed`を知らせる(§3.4)。completed・cancelledのLATCHは変えない。ブロックを知らせるアプリ内通知は作らない。blocks行が先に書かれるため、適用中に別の評価が作ろうとした提案は提案直前の照合で作られない(06 §3)
- **DELETE /v1/users/{user_id}/block** — 204。対象の判定は行わず、自分のblocks行を消すだけ(行が無くても204)。候補化は再開するが、提案履歴による恒久排除とブロックで終わったLATCHは戻さない(08 §8)
- **GET /v1/blocks** — 200 `{blocks: [{user_id, display_name, has_icon, created_at}]}`(blocks.created_atの新しい順)。退会済みの相手は表示名を「つながっていた相手」・has_icon=falseとする(§2.5)
- 応答とログにブロックの相手を記録しない(ログは許可リストの項目のみ・08 §6)

**POST /v1/reports(オーナー裁定 2026-10-21・01冒頭の決定記録・F7a実装確定)** — `{latch_id, target: "proposal"|"profile"|"icon"|"message", reason: "spam"|"harassment"|"inappropriate"|"other", note?: string, reportee_user_id?: string, message_id?: string}` → 201 `{received: true}`。noteは前後の空白を除いて0〜500字。要求の形はzodスキーマで定め、形の誤り(必須欄の欠落・値の範囲外・ULID形式外・500字超・余分なキー)は400 VALIDATION_FAILEDのdetails.reasonsに該当フィールド名を返す。対象と欄の組み合わせの誤りは400 VALIDATION_FAILEDのdetails.reasonsに理由コードを返す: reportee_not_allowed(target=proposalでreportee_user_idを指定) / message_not_allowed(target=message以外でmessage_idを指定) / reportee_required(成立後の対象でreportee_user_idが無い) / message_required(target=messageでmessage_idが無い)。

- target=proposal: latch_idは自分が参加者で、状態がproposed・partial_accept(提示済み・未成立)のLATCHに限る。自分以外の全参加者をreporteeとして1人1行で記録する。提案は閉じない
- target=profile・icon・message: latch_idは自分が成立後の参加者だった(left_at・hidden_atは問わない。ブロックや参加取り消しで抜けた後も通報できる・2026-10-21オーナー裁定・01冒頭の決定記録(安全のAPI)の4)LATCHで、状態がmatched・completed・matched経由のcancelledのものに限る。reportee_user_idはそのLATCHの自分以外のメンバー、target=messageのmessage_idはそのLATCHのreportee_user_idの発言であること
- 上記に合わないLATCH(保留中・成立せず閉じたもの等)・参加していないLATCH・存在しないLATCH・対象者・発言は一律404 NOT_FOUND
- 応答は通報の件数・対象者を返さない(提案段階で対象者の人数を推測させない)。通報は提案・LATCHの状態を変えず、被通報者のどのAPI応答・通知にも現れない(08 §8)。noteと被通報者はログに出さない(08 §6)

**dev専用API(F7a実装確定・テスト専用)** — GET /v1/dev/reports。存在隠しは上記の観測APIと同一条件(prodは一律404)。認証した本人が通報者(reporter)の行だけを`{reports: [{id, reportee, latch_id, target, reason, note, message_id, status, created_at}]}`(created_atの新しい順)で返す(#27の証拠・10 §4)。

**アプリ内通知のAPI(F7b実装確定)。**

- **GET /v1/notifications?cursor=** — 200 `{items: NotificationDTO[], next_cursor: string|null, unread_count: number}`。本人の通知を新しい順(id=ULIDの降順)に20件で、cursorは§3.1と同じ不透明cursor(形式外は400 VALIDATION_FAILED)。unread_countは本人の未読(read_at null)の総数(下部タブの未読の印)。本人が抜けた(left_at)・表示から消した(hidden_at)LATCHの通知は返さず、unread_countにも数えない(本人からは非参加と同じ・§2.2のlatch_members)。system(未使用)の行は返さない
- **NotificationDTO** — 共通の`{id, type, read_at, created_at}`に種別ごとの欄を加え、他の種別の欄は持たない。proposal=`latch_id`・`response_deadline`(LATCHの回答期限)/ matched=`latch_id`・`display_names`(本人以外の全参加者の表示名。退会者は「つながっていた相手」・§2.5。成立後のため開示してよい)/ closed=`latch_id`のみ(「この提案は成立しませんでした」の一文しか出さない・01 §10)/ intent_expired=`intent: {id, raw_text}`(本人の意思の本文と「もう一度預ける」の導線)。成立前の条件・相手は一切含めず(visibility単値・01 §21)、push_stateは返さない
- **POST /v1/notifications/read** — `{up_to_id}` → 204。本人の通知のうちid≤up_to_idで未読の行のread_atを今にする(再送は同じ結果・冪等)。up_to_idが本人の通知に無くても本人の行だけを対象にするため他人の行は変わらず、存在の探索にならないよう一律204とする。形式の誤りは400 VALIDATION_FAILED

**Web Pushの購読のAPI(F7b実装確定)。**

- **GET /v1/push/vapid-public-key** — 200 `{public_key}`(base64url・非圧縮P-256公開鍵。PushManager.subscribeのapplicationServerKeyに使う・04 §4)
- **POST /v1/push-subscriptions** — `{endpoint, keys: {p256dh, auth}}`。同じendpointの行が無ければ作って201、あれば本人へ付け替え・鍵を更新・status=activeに戻して200(端末でアカウントを切り替えた場合)。応答は本文なし。検証の失敗は400 VALIDATION_FAILED(details.reasonsに理由コード): endpointはhttpsのURL(1,024字以内)で、ホストが既知のPushサービスの許可リスト(`fcm.googleapis.com`・`updates.push.services.mozilla.com`・`*.push.apple.com`・`*.notify.windows.com`)に一致すること(push_endpoint_not_allowed。サーバーが利用者の指定した任意のURLへ送信する経路を塞ぐ・08 §3)/ p256dhはbase64urlで65バイトの非圧縮点・authは16バイト(invalid_push_keys)/ 本人のactiveな購読は登録するendpointを除いて10件まで(push_subscription_limit。1通知あたりの送信回数を抑える。照会と書き込みは1文ではないため、同時の登録で一時的に10件を超えることはあり得る)
- **DELETE /v1/push-subscriptions** — `{endpoint}` → 204。本人の該当行だけを削除する(無い行・他人の行でも204・冪等)
- 応答・ログに購読のendpoint・鍵を出さない(08 §6)

**dev専用API(F7b実装確定・テスト専用)** — GET /v1/dev/notifications。存在隠しは上記の観測APIと同一条件(prodは一律404)。認証した本人の通知行だけを全件`{notifications: [{id, type, latch_id, intent_id, push_state, push_attempted_at, read_at, created_at}]}`(id降順)で返す(#16のAPI部分の証拠・10 §4)。

**dev専用API(LLM real接続で確定・テスト専用)** — GET /v1/dev/usage?date=YYYY-MM-DD。存在隠しは上記の観測APIと同一条件(prodは一律404)。登録済みの利用者で認証し、指定した日(JST)の外部送信の回数を`{date, counts: {"<送信先>:<系統>": 回数}}`で返す(usage_countersのscope=`external_send`・§2.2。行が無ければcountsは空)。dateの形式違いは400 VALIDATION_FAILED。負荷試験の費用の確認と外部送信の記録の確かめに使う(08 §5・10 §5)

### 3.4 WebSocket(リアルタイムチャット)

```text
接続: GET wss://…/v1/latches/{latch_id}/ws?ticket=<署名チケット>
      (ブラウザWSはAuthorizationヘッダを送れないため、POST /v1/ws-ticketで
       60秒・jose署名のチケットを先に取得する。Workerのルートが署名・期限・
       用途・latch_idの一致を検証し、D1で本人が参加者でありmatchedであることを
       再検証する。1回限りはDOが使用済みのjtiを記録して担う)
      チケット不正・期限切れ・使用済み・latch_id不一致・参加の再検証の失敗 → 401
      (理由を区別しない) / Upgrade: websocket でない要求 → 426 UPGRADE_REQUIRED
クライアント→サーバ: {"type":"message","body","client_id"}
サーバ→クライアント: {"type":"message","id","user_id","body","created_at","client_id"}
                      (client_idは送信者の接続にだけ値を入れ、他の接続はnull)
                      {"type":"closed"}(読み取り専用になった・直後に接続を閉じる)
                      {"type":"error","code","client_id"}
                      code = read_only | invalid_message | internal
ping → pong: DOの自動応答(DOを起こさない)
正はD1: DOは受信→D1保存→配信 の順で扱い、DO再起動でも履歴は不変(04 §4)
オフライン参加者: アプリ内通知(notifications)+Web Push(01 §10)
```

**WebSocketの規定(F6a実装確定)。**

- チケットはjoseのHS256・JWT_SECRETで署名し、クレームは`sub`(user_id)・`latch_id`・`jti`(ULID)・`exp`(発行から60秒)・`typ:"ws_ticket"`とする。アクセストークンの検証はtypを持つトークンを拒否し、チケットの検証はtypの一致を必須とする(用途の取り違えを防ぐ)。KVは使わない(§2.3)。DOは使用済みのjtiを自分のストレージに期限付きで記録し、既に記録済みなら401で接続しない。期限切れのjtiは記録のたびに掃除する
- 送信はWebSocketでもREST(§3.3)でもDOの1か所で直列に処理する。メッセージIDはDO内で単調増加のULIDを採番し、IDの順=保存の順=配信の順になる。保存の条件は§2.2のmessagesのとおり
- 配信の前に、DOはD1で現在の参加者(left_at・hidden_atがnull)を照会し、その集合に含まれる接続にだけ`message`を配信する。含まれない接続には`closed`を送って閉じる(離脱・表示削除の知らせが届かなかった場合の補い)
- 同じclient_idの再送は保存済みの行を返し、同じidで再配信することがある(画面はidで重複を除く)
- 不正なJSON・未知のtype・本文の不正は`error(invalid_message)`(client_idが読めなければnull)。completed等で保存できなければ`error(read_only)`、D1の失敗は`error(internal)`を送信者だけに返す。送信者が参加者でなくなっていた(接続中に本人が抜けた等)ときは`closed`を送って閉じる
- 離脱(POST /leave)・表示削除(DELETE)の成功後、ルートはDOへ`closed`を知らせる。LATCHがcancelledになったときは全員の接続へ、本人だけが抜けたときは本人の接続だけへ`closed`を送ってから閉じる。知らせは最善努力(失敗はログに記録して続行)で、正しい状態はD1にあり送信は必ず保存の条件で止まる。毎分Cronのcompleted判定(06 §2の(d))はDOへ知らせず、その後の送信は`read_only`で止まる
- ログは許可リスト方式(04 §4)で、本文・client_id・チケットは出さない

## 4. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-B-01 | category低粒度タグの初期セット値 | 15種の初期セットを暫定確定(§2.2 intents注記)。Parserゴールドセット作成時に見直す |

**決定記録(2026-10-19・プロトタイプREADME §7のオーナー裁定)**

1. 決定内容: D-B-03(proposal表示項目のUI選択)を解消する。成立後に見せる条件サマリは「重なったところ」として、**つながり=主題・預け方・人数・地域、機会=主題・日時・場所・人数・予算**を表示する
2. 根拠: UIの正本である`prototype/`(README §7-5)の実装基準どおり
3. 影響: 成立後画面(成立一覧・チャット)の表示項目が確定。API上位集合(§2.2 latches.proposal)の変更はない。08 §2の開示表も本確定値に揃った

(D-B-02 アンケート設問は09 §7で確定し解消。D-B-03 proposal表示項目は上記の決定記録(2026-10-19)で解消)。外部依存の既知未決はD-A-03(地名データ)であり、本書の該当箇所に影響する。
