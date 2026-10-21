# F7b 通知のAPI 設計書

- 作成日: 2026-10-21
- 対象: docs/12 §2 のF7「安全と通知」のうちF7b(通知のAPI: アプリ内通知の一覧と既読・Web Pushの購読と送信・#16のAPI部分)。画面と規約ページはF7cで別に設計する
- 正本: docs/01 §10・§20 / docs/02 §4(#16) / docs/04 §3.4・§4・§7 / docs/05 §2.2・§2.5・§3.2・§3.3 / docs/06 §2 / docs/08 §3 / docs/10 §4 / `prototype/`(Notices・Settings・Push・PushOff)
- 前段: docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md・2026-10-21-f6a-chat-backend-design.md・2026-10-21-f7a-safety-api-design.md(本書はその上に載る)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提

### 0.1 目的とゲート

- #16「提案を通知できる(Web Push+アプリ内)」のAPI部分を、worker E2E(`e2e/notifications.spec.ts`)で証明する(§6.1)。proposals_onlyとmutedの双方で、通知の到達記録・mutedでWeb Pushが出ないこと・proposed遷移と回答ができることを確かめる
- #16の画面部分(お知らせ・プッシュの許可・設定)と実機ブラウザでのWeb Push受信はF7c・F8(#32)が扱う

### 0.2 現状の確認(着手時点のコード)

1. notifications(id / user_id / type(proposal|matched|closed|system) / latch_id / read_at / created_at・UNIQUE(latch_id, user_id, type))とpush_subscriptions(id / user_id / endpoint UNIQUE / p256dh / auth / status(active|failed) / last_success_at / created_at)はF0の初回マイグレーションで作成済み
2. 通知行は提案の提示(`src/latches/propose.ts`・保留の解放 `src/latches/release.ts`)でproposal、成立(`src/latches/respond.ts`)でmatched、提示済み提案の不成立(`src/latches/close.ts`)でclosedが、いずれも条件付きの1文(INSERT … SELECT … WHERE)で書かれている。1日6件の通知上限(`src/latches/caps.ts`)はproposal行を数える
3. 通知の一覧・既読のAPI、購読のAPI、Web Pushの送信は無い。05 §3.2には`GET /v1/notifications / POST /v1/notifications/read`の名前だけがあり、購読のAPIは定義が無い
4. intents.notification_level(proposals_only|muted)は保存・PATCHできるが、何にも効いていない
5. Intentの期限切れ(Cron(c))はアプリ内通知を作らない(01 §10「期限切れ時はアプリ内通知(1回)」が未実装)
6. joseは依存に入っている(F1)。VAPID鍵の設定は無い

### 0.3 オーナー裁定(2026-10-21・本書のブレインストーミング)

| # | 決定内容 | 根拠 |
|---|---|---|
| 1 | notification_level=mutedはWeb Pushだけを止め、アプリ内通知(お知らせ)は作る。mutedのIntentに関わる提案(proposal)と成立(matched)のWeb Pushをどちらも送らない | 「この意思ではスマホを鳴らさない」という意味に揃える。お知らせに残るため提案と回答期限を見落としにくく、通知上限(1日6件)の数え方も変わらない |
| 2 | Web Pushは通知行を書いた処理の直後に同じWorker内で送り(waitUntil)、送れていない行を毎分Cronで回収する(案1)。通知専用のキュー(案2)・Cronだけの送信(案3)は採らない | 04 §7の「通知5秒以内・判定確定後のWeb Push送信を同一Worker内で直列実行」に構成を変えずに合う。案3は最大1分遅れ、案2はキューの追加と04の改訂を要する |

### 0.4 F7bで行わないこと

画面(お知らせ・設定・プッシュの許可・待機中画面の「通知がオフです」・F7c)・Service Workerのpush受信処理と通知タップの遷移(F7c)・実機ブラウザでの受信確認(F7c・F8 #32)・本番VAPID鍵の発行と登録(F10)・通知の保持期間の定期削除(05 §2.6に規定が無い。定めるときは別に扱う)・退会時の購読の削除(退会の工程)・レート制限(後続の工程)。

## 1. 構成

| 配置 | 責務 |
|---|---|
| `src/db/schema.ts`・`migrations/0007_*`・`migrations_rollback/0007_rollback.sql` | notificationsへの3列・種別intent_expired・intent_idの一意索引(§2) |
| `src/routes/notifications.ts` | GET /v1/notifications・POST /v1/notifications/read(§3) |
| `src/routes/push.ts` | GET /v1/push/vapid-public-key・POST/DELETE /v1/push-subscriptions(§4) |
| `src/push/` | 送信の判断と実行(`dispatch.ts`)・送り手の差し替え口(`sender.ts`: stub/real)・RFC 8291暗号化(`encrypt.ts`)・VAPID署名(`vapid.ts`)・本文(`payload.ts`)・送信先ホストの許可リスト(§5) |
| `src/latches/propose.ts`・`release.ts`・`respond.ts`・`close.ts` | 通知行にpush_stateを書く(§5.1)。これらの関数はDBだけを受け取るため、送出は入口側で行う |
| `src/push/flush-middleware.ts`・`src/routes/latches.ts`・`intents.ts`・`safety.ts`・`src/pipeline/consumer.ts` | 変更系の要求とキューのバッチの後に`flushPush`をwaitUntilで呼ぶ(§5.1) |
| `src/pipeline/cron.ts` | (c)の期限切れでintent_expiredを作る・Pushの回収走査を追加(§5.6・§5.7) |
| `src/routes/intents.ts` | Intent削除でintent_idの通知行を削除(05 §2.5) |
| `src/routes/dev.ts` | dev専用GET /v1/dev/notifications(§6.1) |
| `src/env.ts` | LATCH_PUSH_MODE・VAPID_*・prodの起動ガード(§5.5) |
| `packages/shared` | NotificationDTO・購読の入力スキーマ |

## 2. データ(マイグレーション0007)

notificationsへ次の3列を追加する(戻すマイグレーションと対で作る・12 §4)。

| 列 | 型 | 内容 |
|---|---|---|
| `intent_id` | text(26) null | intent_expiredの対象Intent。他の種別はnull |
| `push_state` | text not null default 'none' | `none`(Web Push対象外の種別)/ `pending`(未送信)/ `sent` / `muted` / `no_subscription` / `failed` |
| `push_attempted_at` | integer(ms) null | 最後に送信を試みた(順番を取った)時刻 |

- 種別に`intent_expired`(Intentの期限切れ・アプリ内のみ)を加える。`system`は未使用のまま残す
- `UNIQUE(intent_id, type)`(intent_idがnullの行は重複扱いにならない)で、同じIntentの期限切れ通知を1行に限る
- 回収走査用に`INDEX(push_state, created_at)`を張る
- 既存行は`push_state='none'`になる(過去の通知を送り直さない)
- Web Push対象はproposal・matchedだけで、行の作成時に`pending`を書く。closed・intent_expiredは`none`(01 §10・08 §3)

## 3. アプリ内通知のAPI

### 3.1 GET /v1/notifications?cursor=

- 本人の通知を新しい順(id=ULIDの降順)に20件。応答は`{items: NotificationDTO[], next_cursor: string|null, unread_count: number}`。`unread_count`は本人の未読(read_at null)の総数で、下部タブの未読の印に使う
- 本人が抜けた(left_at)・表示から消した(hidden_at)LATCHの通知は返さず、unread_countにも数えない(本人からは非参加と同じに扱う・05 §3.3)
- NotificationDTO: `{id, type, read_at, created_at}`に種別ごとの欄を加える。他の種別の欄は持たない
  - proposal: `latch_id`・`response_deadline`(LATCHの回答期限。「回答期限 明日 18:12 まで」)
  - matched: `latch_id`・`display_names`(本人以外の参加者の表示名。退会者は「つながっていた相手」・05 §2.5。成立後なので開示してよい)
  - closed: `latch_id`のみ(「この提案は成立しませんでした」の一文しか出さない・01 §10)
  - intent_expired: `intent: {id, raw_text}`(本人の意思の本文と「もう一度預ける」の導線)
- 成立前の条件・相手は一切含めない(visibility単値・01 §21)。push_stateは返さない

### 3.2 POST /v1/notifications/read

- 本文`{up_to_id}`。本人の通知のうちid≤up_to_idで未読の行のread_atを今にする。204。同じ要求の再送は同じ結果(冪等)
- up_to_idが本人の通知に無くても、本人の行だけを対象にするため他人の行は変わらない(存在の探索にならないよう一律204)。形式の誤りは400 VALIDATION_FAILED

## 4. Web Pushの購読のAPI(05 §3.2へ新設)

- **GET /v1/push/vapid-public-key** — 200 `{public_key}`(base64url・非圧縮P-256公開鍵)。購読(PushManager.subscribe)のapplicationServerKeyに使う
- **POST /v1/push-subscriptions** `{endpoint, keys: {p256dh, auth}}` — 同じendpointの行が無ければ作って201、あれば本人へ付け替え・鍵を更新・status=activeに戻して200(端末でアカウントを切り替えた場合)。応答は本文なし
- **DELETE /v1/push-subscriptions** `{endpoint}` — 本人の該当行を削除。204(無くても204・冪等)
- 検証(400 VALIDATION_FAILED・理由コード):
  - endpointはhttpsのURL(1,024字以内)で、ホストが既知のPushサービスの許可リスト(`fcm.googleapis.com`・`updates.push.services.mozilla.com`・`*.push.apple.com`・`*.notify.windows.com`)に一致すること(`push_endpoint_not_allowed`)。サーバーが利用者の指定した任意のURLへ送信する経路を塞ぐ
  - p256dhはbase64urlで65バイトの非圧縮点、authは16バイト
  - 本人のactiveな購読は10件まで(11件目は`push_subscription_limit`)。1通知あたりの送信回数を抑える
- 設定画面(`prototype/` Settings)の「プッシュ通知」の切り替えは端末ごとの購読の登録・解除で実現する。ユーザー単位のオン/オフ列は作らない

## 5. Web Pushの送信

### 5.1 流れ(オーナー裁定2)

1. 通知行を書く処理(提案化・保留の解放・成立)はproposal・matchedを`push_state='pending'`で書く
2. 通知行を書き得る入口(LATCH・Intent・安全のAPIの変更系(POST・PATCH・DELETE)の成功応答の後と、キューのバッチの後)で`flushPush`を`waitUntil`で呼ぶ(APIの応答・キューの消費を待たせない)。flushPushは作成から10分以内で未試行または試行から60秒以上たった`pending`行(上限100件)を照会して`dispatchPush`へ渡す。通知行は条件付きの1文で書かれ、書いた関数はDBだけを受け取るため、書けた行を入口で照会する形にする(実装計画の調査で確定)。Cron(§5.6)はawaitする
3. dispatchPushは行ごとに順番を取る: `UPDATE … SET push_attempted_at=now WHERE id=? AND push_state='pending' AND (push_attempted_at IS NULL OR push_attempted_at≤now−60秒)`が1行を更新したときだけ送る。直後の送信とCronの回収が同時に拾っても片方だけが送る
4. 判断の順:
   - 本人の当該LATCHでの参加Intent(latches.intent_idsのうち本人が所有するもの)のnotification_levelがmuted → `muted`(送らない・オーナー裁定1)
   - 本人のactiveな購読が無い → `no_subscription`
   - activeな各購読へ送る。1件でも成功 → `sent`。全部が恒久失敗 → `failed`。一時失敗を含み成功が無い → `pending`のまま(§5.6で再試行)

### 5.2 送信先の応答

- 2xx → 購読のlast_success_atを更新
- 404・410(購読の失効) → 購読をstatus=failedにし、以後送らない(恒久失敗)
- 400・403・413(要求の誤り・鍵の不一致) → その送信は恒久失敗(購読は変えない)
- 429・5xx・ネットワーク例外 → 一時失敗

### 5.3 本文(08 §3)

- proposal: 「提案が届いています。詳細はアプリでご確認ください。」 / matched: 「つながりが成立しました。詳細はアプリでご確認ください。」
- ペイロードはJSON `{type, body}`だけで、LATCH・Intent・通知のIDも意思の内容も載せない(OS経路に識別子も残さない)。タップでお知らせ画面を開く(F7cのService Worker)
- TTL: proposalは回答期限までの秒数(上限86,400秒・下限60秒)、matchedは86,400秒。Urgency: high

### 5.4 暗号化と署名(04 §3.4の自前実装)

- 本文の暗号化: RFC 8291(Content-Encoding: aes128gcm)をWebCryptoで実装する。ECDH(P-256)・HKDF・AES-128-GCM、レコードサイズ4,096、1レコード
- VAPID(RFC 8292): ES256のJWT(aud=endpointのorigin・exp=12時間後・sub=VAPID_SUBJECT)をjoseで署名し、`Authorization: vapid t=<JWT>, k=<公開鍵>`で送る
- 試験のため、暗号化は塩(salt)と一時鍵を外から注入できる形にする(本番は毎回乱数)

### 5.5 送り手の差し替え口と設定

- `LATCH_PUSH_MODE`: 既定`stub`。stubは外部へ送らず、各購読への送信を成功として扱う(テスト・E2Eを外部のPushサービスに依存させない)。`real`は§5.4で実送信する
- シークレット: `VAPID_PUBLIC_KEY`・`VAPID_PRIVATE_KEY`(JWK)・`VAPID_SUBJECT`(mailto:)。stubでも公開鍵APIのためにVAPID_PUBLIC_KEYを使い、E2E用の`.dev.vars`(`scripts/prepare-dev-vars.mjs`)へテスト専用の固定鍵を加える
- 起動ガード(`assertEnvSafety`): production で`LATCH_PUSH_MODE`がreal以外、またはVAPID_*のいずれかが無いときは起動を拒否する

### 5.6 取りこぼしの回収(毎分Cronへ走査を追加)

- `push_state='pending'`で、作成から30秒以上たち、かつ未試行または試行から60秒以上たった行を拾い、dispatchPushで送る(1回あたり上限100件)
- 作成から10分を過ぎた`pending`は`failed`へ倒して送らない(遅れて鳴る提案はかえって混乱を招く)
- F4aの走査と同じく互いに隔離し、失敗はログ(cron.sweep.failed)を出して次の走査へ進む

### 5.7 Intentの期限切れ通知

- Cron(c)の第1窓でexpired化したIntentごとに、本人へintent_expired(intent_id付き・push_state=none)を1行書く。expired化の条件付きUPDATEと同じバッチに置き、UNIQUE(intent_id, type)の衝突は無視する(再実行でも1回)
- Intent削除(DELETE /v1/intents/{id})はintent_idが一致する通知行を削除する(05 §2.5「当該Intent由来の通知を削除」)

### 5.8 計測

- 許可リストのログに`push.sent`・`push.failed`(notification_id・結果コード・HTTPステータス。endpoint・鍵・本文は出さない・08 §6)を加える

## 6. 試験

### 6.1 worker E2E(`e2e/notifications.spec.ts`・#16のAPI部分の証明)

dev専用`GET /v1/dev/notifications`(呼び出した本人の全通知行・push_stateを含む。既存のdev観測APIと同じく本人の行だけを返し、prodは404の二重防御)で到達記録を観測する。

1. proposals_onlyのIntent2件で提案が生まれると、双方にproposalのお知らせが届き、購読を登録した側は`push_state=sent`で記録される
2. 一方のIntentがmutedのとき、その人にもお知らせは届き、`push_state=muted`で送られない。提案はproposedで、その人が参加する(yes)と回答できる
3. 購読の無い人は`no_subscription`で記録され、お知らせだけで回答まで成り立つ(10 §4の「iOS未インストール状態ではアプリ内通知のみで成立する」確認ケース)
4. 双方の参加で成立すると、matchedのお知らせとWeb Pushの記録ができる(mutedの側はmuted)。POST /v1/notifications/readで未読数が0になる

### 6.2 単体・統合試験(vitest)

- 暗号化: RFC 8291 §5の試験ベクトルと出力が一致する
- VAPID: joseで検証でき、aud・exp(24時間以内)・subが正しい
- dispatchPush: muted / 購読なし / 成功でlast_success_at / 410で購読failed / 一時失敗でpendingのまま / 順番の取り合いで1回だけ送る(送り手は記録用の試験実装)
- Cronの回収: 30秒後の再送・60秒の再試行間隔・10分でfailed・intent_expiredの作成と再実行での二重防止
- 一覧: 種別ごとの欄・抜けた/表示から消したLATCHの除外・cursorの頁送り・unread_count・既読のup_to_id・他人の行に触れない
- 購読: ホストの許可リスト・鍵の長さ・10件の上限・別ユーザーへの付け替え・解除の冪等
- Intent削除でintent_expiredの行が消える
- 起動ガード: productionでstub・鍵の欠落を拒否する

## 7. 文書の更新(docs/00 §3)

変更した文書は版数を上げ、冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える。

- 01: 冒頭の決定記録にオーナー裁定1(mutedはWeb Pushだけを止める)を追加
- 02: #16の内訳(API部分=F7b・画面部分=F7c)を必要に応じて注記
- 04: §3.4・§4のWeb Pushの実装確定(送信の流れ・stub/real・鍵・起動ガード)
- 05: §2.2のnotificationsの列・種別・索引とpush_subscriptionsの扱い、§2.5のIntent削除、§3.2の新API、§3.3のNotificationDTOと購読の検証、dev API
- 06: §2のCronへ回収走査と(c)の期限切れ通知
- 08: §3にペイロードへIDを載せないこと・送信先ホストの制限
- 10: §4に#16のAPI部分のworker E2E
- 12: §2のフェーズ表と決定記録にF7bの完了
- AGENTS.md: 現在の状態
