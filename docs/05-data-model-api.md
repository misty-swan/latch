# LATCH データモデル・API仕様書

- 文書バージョン: v0.1
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17
- 前提文書: 01 要件定義書 v0.6 / 02 スコープ・受け入れ条件合意書 v0.1 / 04 アーキテクチャ設計書 v0.2
- 本書の位置づけ: 01第17〜19節(データモデル・API)をD1+Drizzle・Hono・リアルタイムチャット(04)の上に確定させる。テーブル・インデックス・API契約(エンドポイント・エラー・ページネーション・WebSocketプロトコル)を定め、実装はこれに従う。Zodスキーマの実体は `packages/shared` が持ち、本書がその意味規定の正本である

本書の取り決め。IDはすべてULID(時刻順序可能・大文字26桁)とする。時刻はAPI上ISO 8601(オフセット付き・保存はUTC)で表し、表示と集計の基準はJSTとする(01 §20のClock規律)。本章のテーブル定義は論理表記であり、Drizzleスキーマへの写像は実装が担う(カラム名はsnake_case)。

## 1. データの所在(まとめ)

| ストア | 保持するもの |
|---|---|
| D1(SQLite/Drizzle) | 全リレーショナルデータ(下記§2のテーブル群) |
| Vectorize | Intentの埋め込みベクトル(id= ULID・metadataは§2.3) |
| KV | アクセストークン失効リスト(jti)・WebSocket接続チケット |
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
# 添付(任意。機会formはtime.start必須)
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
visibility:         hidden_until_match | summary_only   # 既定前者
notification_level: proposals_only | muted              # 既定前者
alcohol_involved:   boolean  # 機会formのみtrueになり得る
# 状態
status:             draft | active | paused | matched | expired | cancelled
version:            integer  # 更置ごと+1(旧01 §16規律)
expires_at:         datetime  # つながり=既定30日(7/30/90選択)/機会=既定start+3h
embedding_model:    string | null   # 埋め込み済みモデル識別子(01 §18)
embedded_at:        datetime | null
last_evaluated_at:  datetime | null  # 30分再評価抑制(§2.6)
created_at / updated_at
```

制約(実装で検証): つながりformは starts_at=null・alcohol_involved=false。機会formは starts_at と expires_at 必須(過去・now+7日超は拒否)。draftは必須検証をactive化まで行わない(01 §9)。

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
prev_latch_score:  real | null   # 再提案判定用(機会formのみ使用)
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
outcome:     proposed | matched | rejected | expired
created_at
UNIQUE(user_low, user_high)
```

Layer 1は当該ペアの行の存在だけで除外する(outcomeは参照・分析用)。

**latches**

```yaml
id:                 ULID(PK)
form:               connection | occasion
intent_ids:         json(2..4)   # ULID配列(参加メンバーはlatch_members副表で管理)
proposal:           json          # 表示要素のみ(01 §10。visibilityに応じ内容分岐)
score:              real
status:             candidate | proposed | partial_accept | matched |
                    rejected | expired | cancelled | completed
response_deadline:  datetime
expires_at:         datetime      # 参加Intent期限の最小値
completed_at:       datetime | null  # 機会=対象時刻経過 / つながり=非活動90日
created_at / updated_at
```

**latch_responses**: `id / latch_id / user_id / response(yes|no|defer) / defer_reason(json|null) / responded_at / retracted_at(null|時刻) — UNIQUE(latch_id, user_id)`。

**latch_members**: `latch_id / user_id — PK(latch_id, user_id)`(latchesの参加者副表。「自分の提案・成立」の一覧取得はこの表経由)。

**latch_status_events**: `id / latch_id / from_status / to_status / created_at`(MLR集計の観測点・踏襲)。

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

**latch_feedback**: `id / latch_id / user_id / kind(attendance|connection_quality) / value(json) / created_at — UNIQUE(latch_id, user_id, kind)`(01 §14・#30相当の申告)。

**blocks**: `blocker_user_id / blocked_user_id / created_at — PK(blocker, blocked)`。**reports**: `id / reporter / reportee / reason(spam|harassment|inappropriate|other) / latch_id|null / note(0..500) / status(open|resolved) / created_at`。

**notifications**: `id / user_id / type(proposal|matched|closed|system) / latch_id|null / summary(json|null)  # summary_only提案のみ条件サマリ / read_at / created_at — INDEX(user_id, read_at)`。

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

**usage_counters**(レート制限・Jev予算の3層保護の実体): `scope(api_minute|intent_daily|intent_hourly|jev_intent|jev_user|jev_global_daily|jev_global_monthly) / key(user_id|intent_id|'-') / period(日付or時間のバケット文字列) / count — PK(scope, key, period)`。

**geofeatures**: `id / name / municipality / type(city|station|landmark) / lat / lng`(D-A-03で取り込み方法確定)。

### 2.3 Vectorize・KV・R2

**Vectorizeインデックス**(1本): vector id = intent ULID。metadata = `{form, status, category, user_id}`。検索時のfilterで form一致・status=active を強制し(01 §12)、取得後のコードで自己ペア・ブロック・提案履歴を判定する。次元・距離計算はD-A-01(07)の確定後に固定する。削除: Intent削除・期限切れ+7日でベクトル削除(§2.6)。

**KV**: (a)`revocation:{jti}` = 1(TTL=JWT残り寿命)、(b)`ws-ticket:{ticket}` = `{user_id, latch_id}`(TTL 60秒・使用時に削除=一回限り)。

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
| proposal_history | 残す(操作履歴) | 本人を含む行を削除 |
| messages | 残す | 残す(表示名は「退会したユーザー」) |
| latch_responses / latch_feedback | 残す(集計値のみ利用) | 同左ののちcalibration_recordsへ匿名集約 |
| calibration_records | — | ID系除去+粒度低下(時刻日付丸め・地域市区町村)のうえ anonymized=true |
| push_subscriptions / refresh_families | — | 削除・失効 |
| users行 | — | status=deleted + 表示名/プロフィール/アイコンを消去 |

### 2.6 保持期間・定期削除(Cron・04 §4)

- match_candidates / group_candidates: 評価確定から30日で削除(01 §21)
- 期限切れIntentの埋め込み: 期限+7日でVectorizeから削除
- つながりLATCHのcompleted判定: messages最新から90日経過でCronがcompletedへ(01 §8)
- KVチケット: TTL 60秒で自動消滅

## 3. API契約

### 3.1 共通規定

- 認証: `Authorization: Bearer <JWT>`(§3.2のauth系2つを除く全API)。権限は所有者本人または提案参加者のみ(サーバ側強制)
- 成功: 200/201/204。エラー: 次の形状のみ

```json
{ "error": { "code": "UNDER_AGE", "message": "解説文(日本語)", "details": {} } }
```

- 主要エラーcode: UNAUTHORIZED / TOKEN_EXPIRED / FORBIDDEN / NOT_FOUND / VALIDATION_FAILED / RATE_LIMITED / ACTIVE_INTENT_LIMIT(422) / UNDER_AGE(422) / ALCOHOL_RESTRICTED / FORM_MISMATCH / PARSE_FAILED / EMBEDDING_PENDING / INTERNAL
- ページネーション: 一覧系は `?cursor=<不透明>&limit=1..50(既定20)`。応答は `{items: [...], next_cursor: string|null}`
- レート制限: API全体60req/分(04 §5)。429には `Retry-After` を付す

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
PATCH  /v1/intents/{id}                  # 更新(version+1)・draft→active化
DELETE /v1/intents/{id}
POST   /v1/intents/{id}/pause / resume

GET    /v1/latches?type=proposals|matched   # 提案一覧/成立一覧(自分が参加するもの)
POST   /v1/latches/{id}/response            # {response: yes|no|defer, defer_reason?}
POST   /v1/latches/{id}/response/retract    # 回答取り消し(回答期限内・未成立に限る)
POST   /v1/latches/{id}/leave               # 参加取り消し(成立後・チャット読取専用化。01 §10)
POST   /v1/latches/{id}/feedback            # attendance / connection_quality
DELETE /v1/latches/{id}                     # 自分の側の表示削除(02 D-08)

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

**GET /v1/latches(提案)** — `{id, form, proposal:{…条件サマリ(visibility準拠)・必要人数}, score, status, response_deadline, my_response|null, participants_count}`。

**POST /v1/latches/{id}/response** — 状態遷移後のlatch。全員YESで matched + チャット解放対象となり、双方の詳細情報(表示名・アイコン・プロフィール)が以降のGETに含まれる(01 §8)。

### 3.4 WebSocket(リアルタイムチャット)

```text
接続: GET wss://…/v1/latches/{latch_id}/ws?ticket=<一回限りチケット>
      (ブラウザWSはAuthorizationヘッダを送れないため、POST /v1/ws-ticketで
       60秒・一回限りのチケットを先に取得する。DOがKV照合・破棄して検証)
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
| D-B-02 | アンケート・feedbackの設問文言 | 09(検証・評価)が確定 |
| D-B-03 | proposal(条件サマリ)のJSON項目の最終形 | 03(UX仕様)の表示要素確定時に揃える |

外部依存の既知未決はD-A-01(Embedding次元)/D-A-03(地名データ)であり、本書の該当箇所に影響する。
