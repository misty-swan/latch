# LATCH データモデル・API仕様書

- 文書バージョン: v0.17
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.17更新: 2026-10-21)
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
- 前提文書: 01 要件定義書 v0.15 / 02 スコープ・受け入れ条件合意書 v0.9 / 04 アーキテクチャ設計書 v0.17
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
| マッチング | match_candidates / group_candidates / proposal_history | 評価の途中結果・同一ペア排除(恒久) |
| LATCH/チャット | latches / latch_members / latch_responses / latch_status_events / messages / chat_reads / latch_feedback | 提案と成立・参加者・回答・状態遷移・チャット・既読・申告 |
| 安全 | blocks / reports | ブロック・通報 |
| 通知 | notifications / push_subscriptions | アプリ内お知らせ・Web Push購読 |
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
vector_deleted_at:  datetime | null  # ベクトル削除実行記録(§2.6の2窓走査用)
created_at / updated_at
```

制約(実装で検証): **draftは topic・form・starts_at・expires_at をnull許容とし、raw_text(0..300)のみで保存できる**。active化(作成時のstatus=active・PATCHでのdraft→active)時に次を検証する(違反はVALIDATION_FAILEDに理由コードを付す・§3.3に一覧): form確定必須 / topic 1..40 / 機会Intentはstarts_at必須かつ現在以降〜now+7日以内 / expires_at設定(機会=既定start+3時間・つながり=7/30/90日選択) / alcohol_involvedは機会Intentのみtrue可。つながりIntentは starts_at=null・alcohol_involved=false。

**match_events**(Queues投入の記録・冪等性)

```yaml
id:                ULID(PK)
event_type:        intent_created | intent_updated | intent_deleted |
                   intent_expired | bucket_arrived | embedding_completed
source_intent_id:  FK intents
version:           integer
payload:           json
status:            pending | processed | failed | dead   # dead=DLQ隔離
created_at / processed_at
UNIQUE(event_type, source_intent_id, version)
```

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

**latch_feedback**: `id / latch_id / user_id / kind(attendance|connection_quality) / value(json) / created_at — UNIQUE(latch_id, user_id, kind)`(01 §14の正解データ申告。集計は02 #35の対象)。

**blocks**: `blocker_user_id / blocked_user_id / created_at — PK(blocker, blocked)`。**reports**: `id / reporter / reportee / reason(spam|harassment|inappropriate|other) / latch_id|null / note(0..500) / status(open|resolved) / created_at`。

**notifications**: `id / user_id / type(proposal|matched|closed|system) / latch_id|null / read_at / created_at — INDEX(user_id, read_at)・UNIQUE(latch_id, user_id, type)`。closedは不成立(rejected / expired / cancelled)の総称であり、成立後の離脱(leave・matched→cancelled)ではclosedを作らない(F4a実装確定)。成立前の意思・条件サマリは格納しない(visibility単値化・01 §21)。

**push_subscriptions**: `id / user_id / endpoint(string UNIQUE) / p256dh / auth / status(active|failed) / last_success_at / created_at`。

**sessions**: `id / user_id / started_at`(DAU・再来訪)。**survey_responses**: `id / user_id / kind(onboarding|week4) / answers(json) / created_at — UNIQUE(user_id, kind)`。

**calibration_records**(正解データ・01 §14)

```yaml
id:          ULID(PK)
latch_id:    FK latches
form:        connection | occasion
prediction:  json    # latch_score・jev 7軸
outcome:     both_yes | one_no | expired | cancelled
action:      json    # 機会={attended: bool|null} /
                    # つながり={chat_started_7d: bool, exchanges_7d: int, exchanges_30d: int, blocked: bool}
survey:      json | null   # つながり7日時点の1問
anonymized:  boolean       # 削除・退会後の匿名化済みフラグ
created_at / updated_at
```

**usage_counters**(レート制限・Jev予算の3層保護の実体): `scope(intent_daily|intent_hourly|jev_intent|jev_user|jev_global_daily|jev_global_monthly) / key(user_id|intent_id|'-') / period(日付or時間のバケット文字列) / count — PK(scope, key, period)`。加算は `UPDATE … SET count=count+1 … RETURNING` の原子的1文で行い、Queues consumerはバッチ単位でまとめて加算する(並行消費での取りこぼし防止)。periodが90日より古い行はCronで削除する(API単位のスロットルはWorkers Rate Limitingバインディング(key=user_id)が担い、本表には置かない)。

**geofeatures**: `id / name / municipality / type(city|station) / lat / lng / grid_key(約1km=0.01度グリッドのキー・INDEX)`(ソースはISJ+駅データ。取り込みと変換の規定は04 §4)。grid_keyの書式は `${Math.floor(lat*100)}_${Math.floor(lng*100)}`(F4a実装確定)。逆引きは座標の属するセルの中心を基準点とし、そのセルと周囲を合わせた3×3セルの行からハバーシン距離の最近傍の地名を採る(同距離はid昇順・該当なしは地域名なし)。

**機会LATCH成立時の参加Intent(F4a実装確定)。** 機会LATCHが成立すると、参加Intentはstatus=matchedとupdated_atのみを更新する(versionは上げない・Vectorize metadataは更新しない)。matchedのIntentはLayer 1がD1の現行statusで除外するため、metadataの同期を要しない(§2.3の二重化)。

### 2.3 Vectorize・KV・R2

**Vectorizeインデックス**(1本): vector id = intent ULID。metadata = `{form, status, category, user_id}`(インデックス作成時にmetadata indexとしてform・status・categoryを宣言する。07 §1)。検索時のfilterで form一致・status=active を最適化として適用し(01 §12)、取り出し後は**D1の現行status・blocks・提案履歴をコードで再検証する**(metadataの同期遅延に依存しない二重化)。Intentの遷移(pause/resume/expired)ごとにmetadataのstatusを更新し、失敗はCronバックフィルで回収する(機会LATCH成立によるmatchedはmetadataを更新しない・§2.2)。照合時にD1行が存在しないベクトルはfail-closeで除外する。次元=1024・距離=cosine(07 v0.1で確定)。削除: Intent削除・期限切れ+7日でベクトル削除(§2.6)。**ローカル代替(F3実装確定)。** Vectorizeにはローカルシミュレータが存在しないため、LATCH_ENV=local(単体・統合試験・wrangler dev・E2E)では同一インタフェースのインメモリ実装(コサイン距離・metadata filter込み・04 §4のVectorStore抽象)へ置き換える。staging/prodはVectorize実装を使う。取得系(getByIds)はupsert反映確認・metadata同期・Cronの整合点検に使う(06 §2)。

**KV**: `revocation:{jti}` = 1(TTL=JWT残り寿命)。失効はJWT残寿命(最大1時間)以内の効力とし、権限が関わる操作(チャット送信・回答・退会)はD1のusers.statusとblocksを必ず再検証して補完する。WebSocket接続チケットはKVに置かず、**joseで署名した短期トークン(exp=60秒・user_id/latch_idクレーム)** を使う(結果整合の伝播遅延を回避。§3.4)。回転猶予: `rfg:{旧リフレッシュトークンハッシュ}` = 現行リフレッシュトークン(TTL 120秒・取得後に削除で使い切り。窓外の再提示は再利用検出として族をrevoked。04 §4)。猶予窓内の旧トークン再提示でKVエントリが見えない場合は結果整合の競合の可能性があるため族は失効させず401のみ(窓外のみ再利用検出として族revoked)。KVは結果整合のため猶予エントリの並行取得は理論上可能であり、猶予の「1回に限り」はベストエフォートとする。**パイプライン用KV(バインディングPIPELINE_KV・F4a実装確定)**: `jev:breaker` = Jevのcircuit breakerの状態(JSON・06 §5)。`jev:alert:{scope}:{period}` = 予算アラートの送信済み印(scope=jev_global_daily|jev_global_monthly・同一periodで1回・TTLはperiodの寿命より長く取る・06 §6)

**R2**: バケット1つ(`icons`)。キー=`{user ULID}/{ULID}`。受け付けはPNG/JPEG/WebP・1MBまで。Workersで受けて検証し保存(外部サービス送信なし)。URLは同一オリジンで配信(04 Assets経由ではなくWorkerレスポンスでストリーム)。

### 2.4 インデックス(主要・検証順序)

```text
intents:      (user_id, status) / (status, form, category) /
              (status, starts_at)  ← 機会Bucket走査 / (status, expires_at) ← 期限バッチ
candidates:   UNIQUE組(前述)+ INDEX(intent_a_id), (intent_b_id)
latches:      (user_id...)は user_ids のJSONでなく参照テーブルを避け、
              latch_members(latch_id, user_id)を副表として持つ — INDEX(user_id, latch_id)
messages:     (latch_id, id)・UNIQUE(latch_id, user_id, client_id)
notifications:(user_id, read_at, id) / (user_id, type, created_at) ← 通知上限(1日6件)の判定
proposal_history: PK(user_low, user_high)
latches:      (status, response_deadline) ← 回答期限切れ走査 / (status, proposed_at)
latch_status_events: (latch_id)
```

latch_membersは§2.2のlatches表からuser_ids列を置き換えた副表である(latches本体はintent_idsのみ保持)。

### 2.5 削除・退会時の扱い(01 §21の実表)

| 対象 | Intent削除時 | ユーザー退会時 |
|---|---|---|
| intents本文・構造化データ・埋め込み | 削除 + Vectorize該当ベクトル削除 | 本人の全Intentに同じ |
| match/group_candidates | 当該Intentを含む行を削除 | 同左 |
| match_events | 当該Intentの行を削除(payloadにはraw_text・座標・識別子を格納しない) | 本人の全Intentに同じ |
| latches・latch_members | 進行中の提案はcancelled | 退会者が参加するproposed/partial_acceptは即時cancelled。matchedは残置し表示名は「つながっていた相手」(終了の原因は画面に区別して見せない・01 §10・2026-10-19オーナー裁定)・チャットは全参加者読み取り専用 |
| proposal_history | 残す(同一ペア排除のため・01 §8)。削除で取り消した進行中の提案のために確保した行は解放する(§2.2) | 本人を含む行を削除 |
| messages | 残す | 残す(表示名は「つながっていた相手」。本人からの削除要求には該当行の削除で応じる) |
| latch_responses / latch_feedback | 残す(集計値のみ利用) | 同左ののちcalibration_recordsへ匿名集約 |
| calibration_records | — | latch_idをnull化+粒度低下(時刻日付丸め・地域市区町村)のうえ anonymized=true |
| notifications / sessions / survey_responses | 当該Intent由来の通知を削除 | 削除(surveyを集計目的で残す場合はID系を除去) |
| usage_counters | — | 本人keyの行を削除 |
| blocks / reports | 残す | 残す(安全のための証跡。最後の活動から1年で削除) |
| push_subscriptions / refresh_families | — | 削除・失効(発行済みJWTのjtiをKV失効リストへ登録) |
| R2アイコン | — | icon_key解除+R2オブジェクト削除 |
| users行 | — | status=deleted + 表示名/プロフィール/アイコンを消去 |

**Intent削除の実行順序(F3実装確定)。** Vectorizeの該当ベクトルの削除を先に実行し、これが失敗した場合はD1に触れず500 INTERNALで中断する(クライアントの再試行で完結する)。この順序により「Intent行が消えたならベクトルも消えている」ことが保証され、検索可能な孤立ベクトルが残らない。ベクトルの削除は期限+7日の遅延ではなく**無条件の即時削除**である。

### 2.6 保持期間・定期削除(Cron・04 §4)

- match_candidates / group_candidates: 評価確定から30日で削除(01 §21)
- 期限切れIntentの埋め込み: 期限+7日でVectorizeから削除
- LATCHのcompleted判定(F5実装確定): matchedのつながりLATCHは最終メッセージ(0件ならmatched時刻)から90日経過、matchedの機会LATCHは対象時刻(proposal.time_window.start)から3時間経過でCronがcompletedへ(01 §8・06 §2の(d))。latches(status, form, last_message_at)の索引で走査し、機会の対象時刻はproposalのJSONから読む(matchedの機会LATCHは対象時刻が7日以内のものに限られ件数が小さいため列を設けない)。completedでIntentの状態とproposal_historyは変えない
- intentsの期限切れバッチ: (status, expires_at)索引で「expired化対象(now超過)」と「ベクトル削除対象(now-7日超過・vector_deleted_at IS NULL)」の2窓を走査。削除実行時にvector_deleted_atへ記録
- KVチケット: TTL 60秒で自動消滅

## 3. API契約

### 3.1 共通規定

- 認証: `Authorization: Bearer <JWT>`(§3.2のauth系2つを除く全API)。権限は所有者本人または提案参加者のみ(サーバ側強制)
- 成功: 200/201/204。エラー: 次の形状のみ

```json
{ "error": { "code": "UNDER_AGE", "message": "解説文(日本語)", "details": {} } }
```

- 主要エラーcodeとHTTPステータスの対応: UNAUTHORIZED/TOKEN_EXPIRED=401・FORBIDDEN=403・NOT_FOUND=404・VALIDATION_FAILED/FORM_MISMATCH=400・RATE_LIMITED=429・ACTIVE_INTENT_LIMIT/UNDER_AGE/ALCOHOL_RESTRICTED/PARSE_FAILED=422・EMBEDDING_PENDING=409・UPGRADE_REQUIRED=426(WebSocket接続のルートへのUpgradeでない要求・F6a実装確定)・INTERNAL=500。本人が所属しないlatch・他人のIntentへのアクセスは、存在を推測させないため一律NOT_FOUNDを返す(FORBIDDENは自己リソースへの操作権限の欠如に限る)
- ページネーション: 一覧系は `?cursor=<不透明>&limit=1..50(既定20)`。応答は `{items: [...], next_cursor: string|null}`
- レート制限: 1ユーザーあたり60req/分(04 §5)。429には `Retry-After`(固定60秒)を付す

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
POST   /v1/latches/{id}/feedback            # attendance / connection_quality
DELETE /v1/latches/{id}                     # 自分の側の表示削除(02 D-08・続いているLATCHは本人の離脱を伴う・§3.3)
DELETE /v1/users/me                          # 退会(IdP再認証のうえ§2.5の削除処理を実行)

GET    /v1/users/{user_id}/icon              # アイコン取得(未認証・推測困難キー・Cache-Control: private, max-age=3600)

GET    /v1/latches/{id}/messages?before=    # 履歴(50件/頁・昇順返却)
POST   /v1/latches/{id}/messages            # REST送信も可(WS不通時の代替)
POST   /v1/latches/{id}/read                # {last_read_message_id}
GET    /v1/latches/{id}/ws?ticket=          # WebSocket接続(Authorizationヘッダを使わずチケットで認証・§3.4)

POST   /v1/ws-ticket                       # {scope:"chat", latch_id} → {ticket, expires_in:60}(matchedのみ発行)

POST   /v1/sessions                        # セッション開始計測
POST   /v1/users/{user_id}/block  / blocks(GET/DELETE)
POST   /v1/reports
GET    /v1/notifications  / POST /v1/notifications/read
GET/POST /v1/users/me/survey               # 体感アンケート(01 §7・完成条件外)
```

### 3.3 主要レスポンス形状(抜粋)

**POST /v1/auth/token** — `{access_token, refresh_token: string|null, expires_in: 3600, user: UserDTO|null, registration_required: boolean}`。未登録は user=null・refresh_token=null・registration_required=true(登録前JWTの発行・04 §4)。IdPトークン検証の失敗は一律401 UNAUTHORIZED(固定文言)。

**POST /v1/users** — 201 `{user: UserDTO, access_token, refresh_token, expires_in}`(sub付きJWTへの付け替えと新規リフレッシュ族・04 §4)。18歳未満は422 UNDER_AGE・既に登録済み(同一(provider, subject)のactive行)は400 VALIDATION_FAILED。

**GET・PATCH /v1/users/me** — 200 UserDTO(`{id, display_name, bio, has_icon}`)。行無し・status=deleted(退会済み)は一律404 NOT_FOUND(存在を露見させない)。

**POST・DELETE /v1/users/me/icon** — 201 UserDTO / 204(冪等)。**GET /v1/users/{user_id}/icon** — 200(未認証・Cache-Control: private, max-age=3600)。ユーザー不在・deleted・アイコン無しは区別せず404。

**POST /v1/auth/refresh** — 200 `{access_token, refresh_token, expires_in}`(回転式・04 §4)。期限切れは401 TOKEN_EXPIRED・未知/再利用トークンは401 UNAUTHORIZED。

**POST /v1/intents/parse** — `{form, topic, category, time:{start,end}|null, geo:{center:{lat,lng},radius_m}|null, participants:{min,max,includes_owner}, budget:{min,max,currency:"JPY"}|null, expires_at_options:[...], alcohol_involved, warnings:[{field, note}](判定不能NG条件の注意表示)}`。formはクライアント側で切替可能(確定送信は別API)。geoは常にnull(parseは地域を解決しない・ユーザーが添付で確定させる)・participants.includes_ownerはtrue・budgetの通貨はJPY固定。expires_at_optionsは期限の選択肢(ISO 8601・昇順): つながりIntent=now+7日/now+30日/now+90日の3件・機会Intent=時刻確定時はstart+3時間の1件・時刻未確定は空配列

**IntentDTO(Intent系API共通の応答形状)** — `{id, form, topic, category, raw_text, time:{start, end}|null, geo:{center:{lat,lng}, radius_m}|null, participants:{min, max, includes_owner}, budget:{min, max, currency:"JPY"}|null, hard_constraints:[...], soft_constraints:[...], negative_constraints:[...], visibility:"hidden_until_match", notification_level, alcohol_involved, status, version, expires_at, created_at, updated_at}`。form・topic・category・time・geo・budget・expires_atは未確定欄がnullとなる(draft保存の許容・§2.2)。時刻はISO 8601。visibilityは単値のため常に"hidden_until_match"

**POST /v1/intents** — 201 IntentDTO。初回作成はversion=1で、statusの省略時はactive・draftは意味検証せず保存できる。draft保存では期限の選択(expires_in_days)を含められない(POST/PATCHとも400・理由コードexpires_choice_on_draft)。選択は預ける時(active化)に確定し、draftの明示expires_atは格納できる(機会Intentのactive化時の採用順は 明示expires_at > draft保存値 > 既定start+3時間)。active(status="active"を伴う作成)は§2.2の検証を行い、違反は400 VALIDATION_FAILEDのdetails.reasonsに理由コードの配列で返す: form_required / topic_required / starts_at_required / starts_at_out_of_range / starts_at_not_allowed / alcohol_not_allowed / expires_at_not_allowed / expires_at_before_start。機会Intentのactive作成にexpires_in_daysを指定した場合は400(理由コードexpires_in_days_not_allowed・期限は開始時刻基準で確定するため期限日数の選択肢とならない。黙って無視はしない)

**GET /v1/intents** — 200 `{items: IntentDTO[], next_cursor: string|null}`。自Intentのみ・順序はid降順(ULID=新着順)。`?status=<単一値>`で絞り込み(不明な値は400)。limit=1..50(既定20・範囲外は400)。cursorは不透明(直前ページ最終idのbase64url化・復号できない値は400)

**GET・PATCH・DELETE /v1/intents/{id}** — 200 IntentDTO / 200 IntentDTO(version+1) / 204。他人の・存在しないは一律404(§3.1)。PATCHの可変フィールド: draft=全項目+status:"active"(active化)・active=topic・time・geo・participants・budget・constraints(3種)・notification_levelのみ(他のフィールド指定は400 field_not_allowed)。draft・active以外(paused/matched/expired/cancelled)へのPATCHは400 invalid_status。draft宛のexpires_in_daysは同一リクエストがstatus:"active"を伴う場合を除き400 expires_choice_on_draft(status:"active"を伴う場合でも結果formが機会なら400 expires_in_days_not_allowed・つながりは期限の選択として有効)。active機会Intentのtime変更は範囲を再検証し、現在のexpires_at以降へは変更できない(400 starts_at_after_expires)。PATCH・pause・resumeのUPDATEは**version楽観ロック**(01 §16)を持ち、読み出し時のversionと一致する行のみ更新する(並行更新の後勝ち上書きを防止)。競合で更新が0行だった場合は1回だけ再読込して判定し、行が残っていれば400 VALIDATION_FAILED(理由コードversion_conflict)・消えていれば一律404(§3.1)を返す。**PATCHによる進行中の提案の取り消し(F4a実装確定)。** active Intentで意味フィールド(topic・time・geo・participants・budget・constraints=intent_updatedを発行する変更・06 §2)が変わった場合、または期限(expires_at)が短くなる場合は、当該Intentを含む進行中の提案(candidate・proposed・partial_accept)をIntent削除と同じ流れでcancelledに閉じる(proposal_historyは消費せず解放する=新規確保の行は削除・再提案で確保した既存行はexpiredへ戻す・§2.2。提示済みなら参加者へclosed通知・更新者以外の参加者の保留を解放する。01 §8の不成立経路「Hard Constraintが変化した」)。notification_level等の表示系だけの変更では閉じず、matchedは変えない。再評価は既存どおりintent_updatedで走り、新しい内容で再提案され得る。**意味フィールドの更新による30分再評価抑制の解除(オーナー裁定 2026-10-20・F4a実装確定)。** active Intentで意味フィールドが変わった場合はintents.last_evaluated_atをnullへ戻す(更新後のversionと一致する行のみ・並行更新で版が進んでいれば触らない)。表示系だけの変更では解除しない(06 §3・§6)

**POST /v1/intents/{id}/pause・resume** — 200 IntentDTO(version+1)。pauseはactiveのみ実行可(他は400 invalid_status)・status=paused・期限は不変。resumeはpausedのみ実行可(他は400 invalid_status)・期限切れ(expires_at<=now)は400(理由コードexpired)・status=active・期限は据え置き(再計算しない)。参加中active数の上限5件は作成・draft→active化・resumeの3経路で検証し、超過は422 ACTIVE_INTENT_LIMIT(§3.1)

**LatchDTO(LATCH系API共通の応答形状・F4a実装確定)** — `{id, form, status, response_deadline, participants_count, my_response: yes|no|defer|null, score, my_intent_id, matched_at}`。my_intent_idはlatches.intent_idsのうちintents.user_idが呼び出し本人のIntentのID(全状態で含む。Intent削除済みで見つからなければnull)、matched_atは成立時刻(latch_status_eventsのto_status=matchedのcreated_atをISO 8601で返す。成立前など成立を経ていなければnull、matched経由のcancelled・completedは成立時刻を返す)。scoreは応答に含むがUIでは表示しない(01 §10の裁定)。**成立後(matched・completed、およびmatched経由のcancelled)に限り** `proposal:{form, topic, time_window, region_name, participants, budget}` と `members:[{user_id, display_name, bio, has_icon}]`(自分と離脱者を除く参加者)を含める。participants_countは離脱していない参加者(latch_members.left_atがnull)の数とする(成立前は全員が該当する・F4b実装確定)。成立前はproposal・membersの**キー自体を出さない**(空値でも出さない・visibility単値化・01 §21)。matched経由のcancelledはlatch_status_eventsにto_status=matchedの記録があることで判定する。保留中(candidate)のLATCHは一覧にも単一取得にも出さない(単一取得は404)。

**LatchDTOのチャットの要約(F6a実装確定)。** 成立後(matched・completed・matched経由のcancelled)に限り `last_message: {body, created_at, user_id} | null`(最新メッセージ・0件ならnull)と `unread_count`(本人以外が送り、本人のchat_reads.last_read_message_idより新しいメッセージの数。既読の記録が無ければ本人以外の全件)を加える。成立前はproposal・membersと同じくキー自体を出さない。

**GET /v1/latches** — 200 `{items: LatchDTO[], next_cursor: string|null}`。自分が参加するもののみ・id降順。type=proposalsはstatusがproposed・partial_accept、type=matchedはmatched・completedと、matched経由のcancelled(相手の離脱・表示削除で終わったもの。残された側に「このつながりは終了しました」の履歴を残すため・F6a実装確定)を返す(completed後も閲覧できる・02 D-08・F5実装確定。typeの欠落・不明な値は400)。続いているLATCHから離脱した本人(left_at)・表示削除をした本人(hidden_at)には出ない。LATCH全体を取り消した離脱者はleft_atを持たないため、matched経由のcancelledとして出る(オーナー裁定 2026-10-21)。limit・cursorはIntent一覧と同一の規則(§3.1)。**GET /v1/latches/{id}** — 200 LatchDTO。参加しない・存在しない・保留中は一律404。

**POST /v1/latches/{id}/response** — 200 状態遷移後のLatchDTO。全員YESで matched + チャット解放対象となり、双方の詳細情報(表示名・アイコン・プロフィール)が以降のGETに含まれる(01 §8)。回答系(response・response/retract・leave・defer-reason)の失敗は、参加しない・存在しないは一律404、それ以外は400 VALIDATION_FAILEDのdetails.reasonsに理由コードを返す: invalid_status(その状態では実行できない) / deadline_passed(回答期限経過) / already_responded(回答済み・見送り理由の保存済み) / not_deferred(defer-reasonで本人の有効な回答がdeferでない)。

**POST /v1/latches/{id}/defer-reason** — 200 LatchDTO。見送った(defer)本人だけが1回だけ保存できる(latch_responses.defer_reason)。理由の値はno_capacity / schedule_mismatch / just_not_now / otherの4種(他の値・余分なキーは400)。

**回答と取り消しの状態遷移。** defer=[今回は見送る]は提案を即時にrejectedで閉じる(proposal_historyのoutcomeはdeferred)。no=API契約経由の明示の拒否(同rejected・outcome=rejectedで恒久排除)。retract(回答取り消し)は回答期限内・未成立のみ可とし、partial_accept→proposedへ復帰する(双方YES成立後は不可。離脱はleaveを使う)。leave(参加取り消し)はmatchedのLATCHに対してのみ実行できる。離脱後の残りの参加者数(本人以外でleft_atがnullの数)が提案内容の人数の下限(proposal.participants.min)以上なら本人のleft_atだけを記録してmatchedのまま続け、下限を割るならLATCH全体をcancelledとしてチャットを読み取り専用にする(1対1は常に後者・02 D-08。オーナー裁定 2026-10-20・01冒頭の決定記録・F4b実装確定)。判定と記録は1文の条件付きUPDATEで行い、並行した離脱でも下限未満の人数でmatchedのまま残らない。leaveではclosed通知を作らない(closedは不成立の総称・§2.2)。離脱者の提案履歴と機会Intentはmatchedのまま変えない(§2.2)。matchedのまま続くLATCHから離脱した本人(left_atを持つ)からは当該LATCHを非参加と同じに扱う(一覧から除外・単一取得と各操作は一律404)。ただし離脱に成功したPOST /leaveの応答は、本人を参加者として扱った操作後のLatchDTO(status=matched・participants_countは残りの人数・membersは本人と離脱者を除く)を返す。同じ本人の二重の離脱(二重送信・再試行)は冪等な成功とし、LATCHを取り消さない。下限割れでLATCH全体をcancelledにしたときは本人のleft_atを記録しない。本人は取り消し済みLATCHの参加者のまま、一覧(type=matched)・単一取得・履歴・既読を使え、送信とチケットは400 read_only(チャットは双方読み取り専用・01 §10)。残った参加者のmembers・participants_countにも本人は残る(1対1の残された側はmembers=[本人]・participants_count=2)。表示から消したいときはDELETEを使う(オーナー裁定 2026-10-21・01冒頭の決定記録)。離脱の成功後は、チャットの接続へ`closed`を知らせる(LATCHがcancelledになったときは全員・本人だけが抜けたときは本人の接続。§3.4)。

**DELETE /v1/latches/{id}(表示から消す・オーナー裁定 2026-10-21・01冒頭の決定記録・F6a実装確定)** — 成功は204(本文なし)。matchedは上記のleaveを実行し、成功したら本人のlatch_members.hidden_atを記録する(1対1は全体cancelled・グループは本人だけが抜け、下限割れで全体cancelled。全体を取り消したときは本人のleft_atを記録しないため、相手の側のmembers・participants_countには本人が残る)。leaveが並行した状態変化(completed等)で実行できなかったときは状態を読み直し、閉じた成立後のLATCHなら表示から隠すだけを行う。completed・matched経由のcancelledはhidden_atの記録だけで、left_at・人数・相手の側の表示は変えない。判定の順は、参加しない・存在しない・保留中を一律404とした後、まず本人のhidden_atを確かめ、既にあれば状態を問わず204(再試行の冪等)とする。その後に本人がleft_atを持てば404、上記以外の状態(成立前・成立せず閉じたもの)は400 invalid_statusとする。matchedの削除の成功後はleaveと同じ宛先へ`closed`を知らせ、表示から隠すだけのときは知らせない。hidden_atを持つ本人には、一覧・単一取得・回答系(response・response/retract・leave・defer-reason)・チャットの各APIで当該LATCHを非参加と同じに扱う(一律404。例外はこのDELETEの再試行の204のみ)。

**チャットのAPI(F6a実装確定)。** 失敗の写像はLATCH系と同じで、参加しない・存在しない・保留中・本人がleft_atかhidden_atを持つは一律404、それ以外は400 VALIDATION_FAILEDのdetails.reasonsに理由コードを返す: invalid_status(成立前・成立せず閉じたLATCH) / read_only(completed・matched経由のcancelledへの送信・チケット) / invalid_message(本文が前後の空白を除いて空か2,000字超) / unknown_message(既読の記録で当該LATCHのメッセージでないID)。履歴と既読はmatched・completed・matched経由のcancelledで使え(completed等は読み取り専用)、送信とチケットはmatchedに限る。要求の形はzodスキーマで定め、余分なキーは400とする。

- **MessageDTO** — `{id, user_id, body, created_at, client_id}`。client_idは本人の送信にだけ値を入れ、他の参加者の送信はnull
- **POST /v1/ws-ticket** — `{scope:"chat", latch_id}` → 200 `{ticket, expires_in:60}`(§3.4)
- **GET /v1/latches/{id}/messages?before=<message_id>** — 200 `{items: MessageDTO[], next_before: string|null}`。beforeより前(省略時は最新)の50件をID昇順で返す。さらに古い行があればnext_beforeに返した中で最古のID、無ければnull。beforeがULID形式外は400
- **POST /v1/latches/{id}/messages** — `{body, client_id}`(client_idは1〜64字の`[A-Za-z0-9_-]`)→ 201 MessageDTO。ルートは参加の確認(上記の失敗の写像)を行ってからDOへ転送し、非参加・存在しないIDでDOを作らない。保存と配信はWebSocketと同じくDOが直列に行う(§3.4・保存の可否の正はDOの条件付きINSERT)。同じclient_idの再送は保存済みの行を返す(201)
- **POST /v1/latches/{id}/read** — `{last_read_message_id}` → 204。既読は前にだけ進め、古いIDは何もせず204(§2.2)

**dev専用観測API(F3実装確定・テスト専用)** — GET /v1/dev/match-events・GET /v1/dev/match-candidates。worker E2Eがゲートの合格証拠(match_eventsの計測payload・match_candidatesの生成記録)を観測するためのdev専用API。クエリはintent_id(必須・ULID形式外は400)・limit=1..50既定20・cursor(§3.1と同一の不透明cursor)。応答は`{items, next_cursor}`(id降順)で、itemsはmatch_events行=id / event_type / source_intent_id / version / status / payload / created_at / processed_at・match_candidates行=id / intent_a_id / intent_b_id / intent_a_version / intent_b_version / form / retrieval_score / cheap_judge_score / status / created_at / updated_at(テーブル列の範囲のみ・jev_result等の内部列は含めない)。起点Intentとの一致条件はmatch_events=source_intent_id・match_candidates=intent_a_idかintent_b_idのいずれか。所有者に限定しない(候補は2ユーザーのIntentで構成されるため・観測の実行は認証済みユーザーが行う)。存在隠しはPOST /v1/dev/idp-token(04 §4)と同一条件(prod・テスト鍵2変数のいずれか未設定は認証・クエリ検証より先に一律404・理由は区別しない)。

**dev専用API(F4a実装確定・テスト専用)** — 存在隠しは上記と同一条件。(1) GET /v1/dev/match-candidatesの行にjev_result・latch_scoreを追加する(#15の証拠)。(2) GET /v1/dev/latches?intent_id= — intent_idsに指定Intentを含むLATCHをid降順で返す(`{items, next_cursor}`・itemsはid / form / status / intent_ids / response_deadline / proposed_at / score)。(3) GET /v1/dev/proposal-history?user_id= — user_lowかuser_highが指定ユーザーの履歴行をid降順で返す(itemsはid / user_low / user_high / latch_id / outcome / created_at / updated_at)。(2)(3)のlimit・cursorは観測APIと同一の規則で、参加者・所有者に限定しない。(4) POST /v1/dev/latches/{id}/backdate `{response_deadline?, history_updated_at?, intents_last_evaluated_at?}` — E2Eが時計を操作せずに期限経過と再提案の条件を作るための書き換え口(10 §3)。それぞれlatches.response_deadline・そのLATCHのproposal_history行(latch_id一致)のupdated_at・参加Intent全員のlast_evaluated_atを指定時刻へ書き換える。存在しないLATCHは404。

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
