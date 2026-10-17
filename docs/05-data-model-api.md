# LATCH データモデル・API仕様書

- 文書バージョン: v0.2
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.2更新: 同日)
- v0.2の変更点: 多角レビュー(loop1)の指摘を反映。draft保存のNullable化とactive化検証リスト・提案履歴のoutcome設計・退会APIと削除表の拡充・WSチケットの署名トークン化・カウンタとインデックスの実装規定を追加
- 前提文書: 01 要件定義書 v0.8 / 02 スコープ・受け入れ条件合意書 v0.2 / 04 アーキテクチャ設計書 v0.5
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
current_hash:  string   # 現行リフレッシュトークンのハッシュ(SHA-256)
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
category:               string | null        # 低粒度タグ(D-03)
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
last_evaluated_at:  datetime | null  # 30分再評価抑制(§2.6)
vector_deleted_at:  datetime | null  # ベクトル削除実行記録(§2.6の2窓走査用)
created_at / updated_at
```

制約(実装で検証): **draftは topic・form・starts_at・expires_at をnull許容とし、raw_text(0..300)のみで保存できる**。active化(PATCH)時に次を検証する(違反はVALIDATION_FAILEDに理由コードを付す): form確定必須 / topic 1..40 / 機会Intentはstarts_at必須かつ現在以降〜now+7日以内 / expires_at設定(機会=既定start+3時間・つながり=7/30/90日選択) / alcohol_involvedは機会Intentのみtrue可。つながりIntentは starts_at=null・alcohol_involved=false。

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

**group_candidates**(3人以上・Pool最大15・30日定期削除): `intent_ids json(3..4) / aggregate_score / prev_aggregate_score / status / created_at`。UNIQUE(intent_ids正規化文字列, 各version)。

**proposal_history**(同一ユーザーペアへの再提案恒久排除・01 §8)

```yaml
id:          ULID(PK)
user_low / user_high:  FK users   # 常に low < high に正規化
latch_id:    FK latches | null
outcome:     proposed | matched | rejected | expired | deferred
# 恒久排除の判定は outcome が matched または rejected の行の存在のみ(01 §8裁定)。
# deferred(見送り)・expired の行は機会Intentの条件付き再提案の参照に使う
created_at
UNIQUE(user_low, user_high)
```

Layer 1はoutcomeがmatchedまたはrejectedの行の存在で除外する(deferred・expiredの行は機会Intentの条件付き再提案の参照に使う・01 §8)。

**latches**

```yaml
id:                 ULID(PK)
form:               connection | occasion
intent_ids:         json(2..4)   # ULID配列(参加メンバーはlatch_members副表で管理)
proposal:           json          # 表示要素のみ(01 §10。成立前の条件サマリは含まない)
score:              real          # 内部利用(順序付け・計測)。UIには表示しない(01 §10裁定)
status:             candidate | proposed | partial_accept | matched |
                    rejected | expired | cancelled | completed
                    # candidate=閾値超過済みだが未提示(通知上限での保留を含む)。
                    # §2.2のMatchCandidateとは別物
response_deadline:  datetime
expires_at:         datetime      # 参加Intent期限の最小値
last_message_at:    datetime      # 非正規化。メッセージ書き込み時に更新(90日判定の索引)
completed_at:       datetime | null  # 機会=対象時刻経過 / つながり=最終メッセージ(0件ならmatched時刻)から90日経過
created_at / updated_at
```

**latch_responses**: `id / latch_id / user_id / response(yes|no|defer) / defer_reason(json|null) / responded_at / retracted_at(null|時刻) — UNIQUE(latch_id, user_id)`。

**latch_members**: `latch_id / user_id — PK(latch_id, user_id)`(latchesの参加者副表。「自分の提案・成立」の一覧取得はこの表経由)。

**latch_status_events**: `id / latch_id / from_status / to_status / created_at`(MLR集計の観測点)。

**messages**(チャットの正。DOは配信のみ)

```yaml
id:         ULID(PK)
latch_id:   FK latches
user_id:    FK users
body:       string(1..2000)
created_at
INDEX(latch_id, id)
```

**chat_reads**: `latch_id / user_id / last_read_message_id — PK(latch_id, user_id)`(未読表示・つながり品質の開始判定に使用)。

**latch_feedback**: `id / latch_id / user_id / kind(attendance|connection_quality) / value(json) / created_at — UNIQUE(latch_id, user_id, kind)`(01 §14の正解データ申告。集計は02 #35の対象)。

**blocks**: `blocker_user_id / blocked_user_id / created_at — PK(blocker, blocked)`。**reports**: `id / reporter / reportee / reason(spam|harassment|inappropriate|other) / latch_id|null / note(0..500) / status(open|resolved) / created_at`。

**notifications**: `id / user_id / type(proposal|matched|closed|system) / latch_id|null / read_at / created_at — INDEX(user_id, read_at)・UNIQUE(latch_id, user_id, type)`。closedは不成立(rejected / expired / cancelled)の総称。成立前の意思・条件サマリは格納しない(visibility単値化・01 §21)。

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

**geofeatures**: `id / name / municipality / type(city|station|landmark) / lat / lng`(D-A-03で取り込み方法確定)。

### 2.3 Vectorize・KV・R2

**Vectorizeインデックス**(1本): vector id = intent ULID。metadata = `{form, status, category, user_id}`(インデックス作成時にmetadata indexとしてform・status・categoryを宣言する。07 §1)。検索時のfilterで form一致・status=active を最適化として適用し(01 §12)、取り出し後は**D1の現行status・blocks・提案履歴をコードで再検証する**(metadataの同期遅延に依存しない二重化)。Intentの遷移(pause/resume/matched/expired)ごとにmetadataのstatusを更新し、失敗はCronバックフィルで回収する。照合時にD1行が存在しないベクトルはfail-closeで除外する。次元=1024・距離=cosine(07 v0.1で確定)。削除: Intent削除・期限切れ+7日でベクトル削除(§2.6)。

**KV**: `revocation:{jti}` = 1(TTL=JWT残り寿命)。失効はJWT残寿命(最大1時間)以内の効力とし、権限が関わる操作(チャット送信・回答・退会)はD1のusers.statusとblocksを必ず再検証して補完する。WebSocket接続チケットはKVに置かず、**joseで署名した短期トークン(exp=60秒・user_id/latch_idクレーム)** を使う(結果整合の伝播遅延を回避。§3.4)。

**R2**: バケット1つ(`icons`)。キー=`{user ULID}/{ULID}`。受け付けはPNG/JPEG/WebP・1MBまで。Workersで受けて検証し保存(外部サービス送信なし)。URLは同一オリジンで配信(04 Assets経由ではなくWorkerレスポンスでストリーム)。

### 2.4 インデックス(主要・検証順序)

```text
intents:      (user_id, status) / (status, form, category) /
              (status, starts_at)  ← 機会Bucket走査 / (status, expires_at) ← 期限バッチ
candidates:   UNIQUE組(前述)+ INDEX(intent_a_id), (intent_b_id)
latches:      (user_id...)は user_ids のJSONでなく参照テーブルを避け、
              latch_members(latch_id, user_id)を副表として持つ — INDEX(user_id, latch_id)
messages:     (latch_id, id)
notifications:(user_id, read_at, id)
proposal_history: PK(user_low, user_high)
```

latch_membersは§2.2のlatches表からuser_ids列を置き換えた副表である(latches本体はintent_idsのみ保持)。

### 2.5 削除・退会時の扱い(01 §21の実表)

| 対象 | Intent削除時 | ユーザー退会時 |
|---|---|---|
| intents本文・構造化データ・埋め込み | 削除 + Vectorize該当ベクトル削除 | 本人の全Intentに同じ |
| match/group_candidates | 当該Intentを含む行を削除 | 同左 |
| match_events | 当該Intentの行を削除(payloadにはraw_text・座標・識別子を格納しない) | 本人の全Intentに同じ |
| latches・latch_members | 進行中の提案はcancelled | 退会者が参加するproposed/partial_acceptは即時cancelled。matchedは残置し表示名は「退会したユーザー」・チャットは全参加者読み取り専用 |
| proposal_history | 残す(同一ペア排除のため・01 §8) | 本人を含む行を削除 |
| messages | 残す | 残す(表示名は「退会したユーザー」。本人からの削除要求には該当行の削除で応じる) |
| latch_responses / latch_feedback | 残す(集計値のみ利用) | 同左ののちcalibration_recordsへ匿名集約 |
| calibration_records | — | latch_idをnull化+粒度低下(時刻日付丸め・地域市区町村)のうえ anonymized=true |
| notifications / sessions / survey_responses | 当該Intent由来の通知を削除 | 削除(surveyを集計目的で残す場合はID系を除去) |
| usage_counters | — | 本人keyの行を削除 |
| blocks / reports | 残す | 残す(安全のための証跡。最後の活動から1年で削除) |
| push_subscriptions / refresh_families | — | 削除・失効(発行済みJWTのjtiをKV失効リストへ登録) |
| R2アイコン | — | icon_key解除+R2オブジェクト削除 |
| users行 | — | status=deleted + 表示名/プロフィール/アイコンを消去 |

### 2.6 保持期間・定期削除(Cron・04 §4)

- match_candidates / group_candidates: 評価確定から30日で削除(01 §21)
- 期限切れIntentの埋め込み: 期限+7日でVectorizeから削除
- つながりLATCHのcompleted判定: 最終メッセージ(0件ならmatched時刻)から90日経過でCronがcompletedへ(01 §8)。latches(status, form, last_message_at)の索引で走査
- intentsの期限切れバッチ: (status, expires_at)索引で「expired化対象(now超過)」と「ベクトル削除対象(now-7日超過・vector_deleted_at IS NULL)」の2窓を走査。削除実行時にvector_deleted_atへ記録
- KVチケット: TTL 60秒で自動消滅

## 3. API契約

### 3.1 共通規定

- 認証: `Authorization: Bearer <JWT>`(§3.2のauth系2つを除く全API)。権限は所有者本人または提案参加者のみ(サーバ側強制)
- 成功: 200/201/204。エラー: 次の形状のみ

```json
{ "error": { "code": "UNDER_AGE", "message": "解説文(日本語)", "details": {} } }
```

- 主要エラーcode: UNAUTHORIZED / TOKEN_EXPIRED / FORBIDDEN / NOT_FOUND / VALIDATION_FAILED / RATE_LIMITED / ACTIVE_INTENT_LIMIT(422) / UNDER_AGE(422) / ALCOHOL_RESTRICTED(422) / FORM_MISMATCH / PARSE_FAILED / EMBEDDING_PENDING / INTERNAL。本人が所属しないlatch・他人のIntentへのアクセスは、存在を推測させないため一律NOT_FOUNDを返す(FORBIDDENは自己リソースへの操作権限の欠如に限る)
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
       # 可変フィールド: draft=全項目 / active=topic・添付・constraints・notification_level
       # (visibilityは不可)。topic・constraints等の意味フィールド変更時のみ
       # Embedding再計算イベントを発行し、表示系のみの変更は再評価しない
DELETE /v1/intents/{id}
POST   /v1/intents/{id}/pause / resume

GET    /v1/latches?type=proposals|matched   # 提案一覧/成立一覧(自分が参加するもの)
POST   /v1/latches/{id}/response            # {response: yes|no|defer, defer_reason?}
POST   /v1/latches/{id}/response/retract    # 回答取り消し(回答期限内・未成立に限る)
POST   /v1/latches/{id}/leave               # 参加取り消し(成立後・チャット読取専用化。01 §10)
POST   /v1/latches/{id}/feedback            # attendance / connection_quality
DELETE /v1/latches/{id}                     # 自分の側の表示削除(02 D-08)
DELETE /v1/users/me                          # 退会(IdP再認証のうえ§2.5の削除処理を実行)

GET    /v1/users/{user_id}/icon              # アイコン取得(未認証・推測困難キー・Cache-Control: private)

GET    /v1/latches/{id}/messages?before=    # 履歴(50件/頁・昇順返却)
POST   /v1/latches/{id}/messages            # REST送信も可(WS不通時の代替)
POST   /v1/latches/{id}/read                # {last_read_message_id}

POST   /v1/ws-ticket                       # {scope:"chat", latch_id} → {ticket, expires_in:60}

POST   /v1/sessions                        # セッション開始計測
POST   /v1/users/{user_id}/block  / blocks(GET/DELETE)
POST   /v1/reports
GET    /v1/notifications  / POST /v1/notifications/read
GET/POST /v1/users/me/survey               # 体感アンケート(01 §7・完成条件外)
```

### 3.3 主要レスポンス形状(抜粋)

**POST /v1/intents/parse** — `{form, topic, category, time:{start,end}|null, geo:{center:{lat,lng},radius_m}|null, participants:{min,max,includes_owner}, budget|null, expires_at_options:[...], alcohol_involved, warnings:[{field, note}](判定不能NG条件の注意表示)}`。formはクライアント側で切替可能(確定送信は別API)。

**GET /v1/latches(提案)** — `{id, form, proposal:{…表示要素(成立前の条件サマリは含まない)・必要人数}, score, status, response_deadline, my_response|null, participants_count}`。scoreは応答に含むがUIでは表示しない(01 §10の裁定)。

**POST /v1/latches/{id}/response** — 状態遷移後のlatch。全員YESで matched + チャット解放対象となり、双方の詳細情報(表示名・アイコン・プロフィール)が以降のGETに含まれる(01 §8)。

**回答と取り消しの状態遷移。** defer=[今回は見送る]は提案を即時にrejectedで閉じる(proposal_historyのoutcomeはdeferred)。no=API契約経由の明示の拒否(同rejected・outcome=rejectedで恒久排除)。retract(回答取り消し)は回答期限内・未成立のみ可とし、partial_accept→proposedへ復帰する(双方YES成立後は不可。離脱はleaveを使う)。leave(参加取り消し)はmatchedのLATCHをcancelledとし、チャットを双方読み取り専用にする(02 D-08)。グループで必要人数の下限を割った場合もLATCH全体をcancelledとする。

### 3.4 WebSocket(リアルタイムチャット)

```text
接続: GET wss://…/v1/latches/{latch_id}/ws?ticket=<署名チケット>
      (ブラウザWSはAuthorizationヘッダを送れないため、POST /v1/ws-ticketで
       60秒・jose署名のチケットを先に取得する。DOが署名検証のうえD1で
       参加者であることを再検証する。厳密な一回限り性が必要な場合はDO内の
       使用済みセットで管理する)
サーバ→クライアント: {"type":"message","id","user_id","body","created_at"}
                      {"type":"retract","message_id}(参加取り消し時の読取専用化)
                      {"type":"error","code"}
クライアント→サーバ: {"type":"message","body"}
正はD1: DOは受信→D1保存→両者へ配信 の順で扱い、DO再起動でも履歴は不変(04 §4)
オフライン参加者: アプリ内通知(notifications)+Web Push(01 §10)
```

## 4. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-B-01 | category低粒度タグの初期セット値 | Parserゴールドセット作成時に01 D-03と同時確定 |
| D-B-03 | proposal(条件サマリ)のJSON項目の最終形 | 03(UX仕様)の表示要素確定時に揃える |

(D-B-02 アンケート設問は09 §7で確定し解消)。外部依存の既知未決はD-A-03(地名データ)であり、本書の該当箇所に影響する。
