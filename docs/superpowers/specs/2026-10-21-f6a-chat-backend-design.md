# F6a チャット(バックエンド) 設計書

- 作成日: 2026-10-21
- 対象: docs/12 §2 のF6「チャット」のうちF6a(バックエンド)。画面はF6bで別に設計する
- 正本: docs/01 §8・§10 / docs/02 D-06・D-08・§4(#25) / docs/04 §4 / docs/05 §2.2・§3.2〜§3.4 / docs/08 §11
- 前段: docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md・2026-10-20-f4b-group-latch-design.md・2026-10-21-f5-connection-nature-design.md(本書はその上に載る)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提

### 0.1 目的とゲート

- #25「成立LATCHでメッセージを送受信する → 双方向の送受信記録」をworker E2Eで証明する(§6.1)
- F6の内容(12 §2): DO+WebSocket・messages・既読・REST代替・チケット認証・completed/離脱後の読み取り専用化・LATCHの自分の側の削除(DELETE /v1/latches/{id}・02 D-08)。F6aはこのすべてをAPIとして作り、F6bが`prototype/`基準の画面を載せる

### 0.2 現状の確認(着手時点のコード)

1. messages(id / latch_id / user_id / body / created_at・INDEX(latch_id, id))とchat_reads(PK(latch_id, user_id)・last_read_message_id)はF0の初回マイグレーションで作成済み。書き込み・読み出しのコードは無い
2. `src/do/chat.ts`の`ChatRoomDO`は501を返す空の枠。`wrangler.jsonc`にCHAT_DOのバインディングとnew_sqlite_classesの登録は済んでいる
3. 離脱(`leave`・`src/latches/respond.ts`)は1文の条件付きUPDATEで「本人のleft_atだけを記録する/下限割れで全体cancelled」を決める。離脱した本人は以降、一覧・単一取得・各操作で非参加と同じ扱い(一律404)
4. `latches.last_message_at`は成立時刻で初期化され(F5)、Cron (d)のつながりの90日判定の起点になっている。メッセージ送信での更新はF6の担当
5. web側にチャット画面・つながり一覧画面は無い(F6b)

### 0.3 オーナー裁定(2026-10-21・本書のブレインストーミング)

| # | 決定内容 | 根拠 |
|---|---|---|
| 1 | F6をF6a(バックエンド: DO・WebSocket・REST・既読・チケット・読み取り専用化・削除。#25をworker E2Eで証明)とF6b(画面: チャット・操作メニュー・送信失敗・つながり一覧・`prototype/`基準・web E2E)に2分割し、各単位で設計→計画→実装を1周する。F6bはF6aの完了後に着手する | F4の3分割と同じく、画面はAPIの上に載るため、APIを先に完成させる方が設計と検証の単位を小さく保てる |
| 2 | matched(続いている)のLATCHを「表示から消す」(DELETE)と、本人はそのLATCHから抜けたものとして扱う(leaveと同じ処理に表示削除の印を加える)。1対1は全体がcancelledとなり、相手の側は「このつながりは終了しました」と読み取り専用の履歴になる。グループは本人だけが抜ける(下限割れで全体cancelled)。completed・matched経由のcancelledのLATCHを消したときは本人の表示から隠すだけで、相手の側の表示・人数は変えない | 消した本人に見えないメッセージが相手から届き続ける状態を作らない。相手の側に理由を区別して見せない原則(01 §10)にも合う。D-08の「相手側の表示は残る」は履歴の表示として守られる |

### 0.4 F6aで行わないこと

画面(F6b)・ブロックによる読み取り専用化と新着のアプリ内通知・Web Push(F7。本書の送信条件とDOへの`closed`配信を再利用できる形にしておく)・退会時の扱い(DELETE /v1/users/me の工程)・送信のレート制限(レート制限の工程)・メッセージの本人削除要求(05 §2.5・退会の工程)・つながり品質の集計(チャット開始率等・F9の集計で messages から算出する)。

## 1. 構成(案1: 送信はWebSocketでもRESTでもDOの1か所で処理する)

| 配置 | 責務 |
|---|---|
| `src/chat/messages.ts`(新設) | D1に対する保存(条件付き)・履歴の取得・既読の記録・LatchDTO用の最終メッセージと未読数の照会。DOからもルートからも呼ぶ純粋なD1操作 |
| `src/chat/ticket.ts`(新設) | WebSocket接続チケットの発行と検証(jose・JWT_SECRET・用途を区別するクレーム) |
| `src/chat/notify.ts`(新設) | ルートからDOへの内部呼び出し(送信の転送・`closed`の通知)。通知は失敗しても例外を外へ出さない |
| `src/do/chat.ts`(実装) | 接続の受け入れ(Hibernation API)・送信の直列処理と配信・`closed`の配信と切断・チケットの使用済み記録 |
| `src/routes/chat.ts`(新設) | `POST /v1/ws-ticket`・`GET/POST /v1/latches/{id}/messages`・`POST /v1/latches/{id}/read`・`GET /v1/latches/{id}/ws` |
| `src/routes/latches.ts`(変更) | `DELETE /v1/latches/{id}` の追加・`POST /leave` 後のDO通知・LatchDTOの`last_message`/`unread_count` |
| `packages/shared` | MessageDTO・送信/既読/チケットの要求・WebSocketのフレームのzodスキーマ |

DOはLATCHごとに1つ(`CHAT_DO.idFromName(latch_id)`)。ルートからDOへの内部要求はLATCH IDと確認済みのユーザーIDを渡し、DOは外部から直接到達できない(Workerのルートだけが`stub.fetch`する)。

### 1.1 接続の流れ

1. 画面が`POST /v1/ws-ticket`でチケットを得る(§3.1)
2. `GET /v1/latches/{id}/ws?ticket=…`。ルートはAuthorizationヘッダを要求しない(ブラウザのWebSocketはヘッダを送れない)。チケットの署名・期限・用途・latch_idの一致を検証し、D1で本人が当該LATCHの参加者でありstatus=matchedであることを再検証する(08 §11)。ここまでの失敗は401(参加の再検証の失敗も401とし、理由を区別しない)
3. ルートはDOへ接続を委譲する。DOはチケットのjtiを自分のストレージ(SQLite)に期限付きで記録し、既に記録済みなら401を返して接続しない(1回限り)。期限切れのjtiは記録のたびに掃除する
4. DOは`ctx.acceptWebSocket(ws, [user_id])`で受け入れ、`serializeAttachment({userId, latchId})`で休止後も誰の接続か分かるようにする。ping→pongは`setWebSocketAutoResponse`で返す(DOを起こさない)

### 1.2 送信の流れ

- WebSocket: `webSocketMessage`でフレームを検証し、`messages.send`(§2.1)を呼ぶ。成功は接続中の全員へ`message`を配信、失敗は送信者だけに`error`を返す
- REST: ルートが認証(requireRegistered)と要求の検証を行い、DOの内部`/send`へ転送する。DOは同じ`messages.send`→配信を行い、結果をルートへ返す
- 配信の前に、DOはD1で現在の参加者(left_at・hidden_atがnull)のユーザーIDを1回照会し、その集合に含まれる接続にだけ配信する。含まれない接続(離脱・削除の`closed`の知らせが届かなかった場合)には`closed`を送って閉じる(§2.4の知らせが最善努力であることの補い)
- 送信がすべてDOを通るため、1つのLATCHの送信は直列に処理される。メッセージIDはDO内で単調増加のULIDを採番し、IDの順=保存の順=配信の順になる
- 時刻はDOとルートの合成の起点で`systemClock`を使い、`messages.*`はnowを引数で受け取る(04 §4の時刻の規律)

## 2. 保存・読み取り専用・削除

### 2.1 送信の条件付き保存

`messages.send(db, latchId, userId, body, clientId, id, now)`は1バッチで次を行う。

1. `INSERT INTO messages … SELECT … WHERE EXISTS(latchesがid一致かつstatus='matched') AND EXISTS(latch_membersが本人でleft_at IS NULLかつhidden_at IS NULL) ON CONFLICT(latch_id, user_id, client_id) DO NOTHING`
2. `UPDATE latches SET last_message_at = now WHERE id = … AND status = 'matched' AND EXISTS(SELECT 1 FROM messages WHERE id = 新ID)`(F5のCron (d)の起点を進める。挿入が起きたときだけ)

挿入されなかった場合は次の順で判定する: 同じclient_idの保存済み行があればそれを成功として返す(再送の冪等)/本人が参加者でない(行が無い・left_atまたはhidden_atがある)なら`not_found`/それ以外は`read_only`。終了・離脱と送信が並行しても、条件はD1の直列化で評価されるため、終了後のメッセージは保存されない。

本文は前後の空白を除いて1〜2,000字(05 §2.2)。除いた後に空・2,000字超なら`invalid_message`。保存する本文は前後の空白を除いた形とする(表示名等の既存の入力検証(zodの`trim()`)と同じ扱い)。

### 2.2 読める人と書ける人

| LATCHの状態と本人 | 履歴・既読 | 送信・チケット |
|---|---|---|
| 保留中(candidate)・非参加・存在しない | 404 | 404 |
| 成立前(proposed / partial_accept)・成立せず閉じた(rejected / expired / matchedを経ないcancelled) | 400 invalid_status | 400 invalid_status |
| matched・本人がleft_at / hidden_atなし | 可 | 可 |
| completed・matched経由のcancelled | 可(読み取り専用) | 400 read_only |
| 本人がleft_atまたはhidden_atを持つ | 404 | 404 |

「matched経由のcancelled」の判定は既存どおりlatch_status_eventsのto_status=matchedの記録による(05 §3.3)。

### 2.3 DELETE /v1/latches/{id}(表示から消す)

- 新しい列 `latch_members.hidden_at`(datetime | null)に本人が消した時刻を記録する
- matched: 既存の`leave`を実行し、成功したら本人のhidden_atを記録する。`leave`が並行した状態変化(completed等)でinvalid_statusになった場合は、状態を読み直してcompletedまたはmatched経由のcancelledならhidden_atの記録だけを行う
- completed・matched経由のcancelled: hidden_atの記録だけ(left_at・人数・相手の表示は変えない)
- 上記以外の状態は400 invalid_status・非参加は404
- 成功は204。本人のhidden_atが既にある場合も204(再試行の冪等)
- hidden_atを持つ本人には、一覧(`GET /v1/latches`)・単一取得・回答系(response・response/retract・leave・defer-reason)・チャットの各APIで当該LATCHを出さない(left_atと同じ非参加の扱い・一律404。例外はDELETEの再試行の204のみ)。他の参加者のmembers・participants_countの数え方はleft_atだけで決め、hidden_atは影響しない
- 成功後、ルートは§2.4の通知を行う

### 2.4 つないでいる人への`closed`の知らせ

- `POST /leave`と`DELETE`の成功後、ルートはDOの内部`/closed`を呼ぶ。LATCHがcancelledになったときは全員の接続へ、本人だけが抜けたときは本人の接続だけへ`{"type":"closed"}`を送ってから接続を閉じる
- Cron (d)のcompletedは1回最大500件のためDOへ知らせない。その後の送信は`read_only`で止まり、画面が読み取り専用に切り替わる
- 知らせは最善努力(失敗はログに記録して握りつぶす)。正しい状態はD1にあり、送信は必ず§2.1の条件で止まる
- F7のブロックは同じ`/closed`を再利用できる

### 2.5 マイグレーション(0005)

- `latch_members.hidden_at`(integer timestamp_ms・null可)の追加
- `messages.client_id`(text・null可)の追加と`UNIQUE(latch_id, user_id, client_id)`の索引(APIでは必須だが、列は既存行のためnull可。SQLiteの一意索引はnullを重複とみなさない)
- 戻す手順 `migrations_rollback/0005_rollback.sql` と対で作る(12 §4)

## 3. API

形はすべて`packages/shared`のzodスキーマで定め、余分なキーは400とする(既存のAPIと同じ)。失敗の写像は既存のLATCH APIと同じ(非参加・存在しない=一律404・それ以外=400 VALIDATION_FAILEDのdetails.reasons)。

### 3.1 REST

| API | 要求 → 応答 | 失敗 |
|---|---|---|
| `POST /v1/ws-ticket` | `{scope:"chat", latch_id}` → 200 `{ticket, expires_in:60}` | §2.2の表のとおり(matchedのみ発行) |
| `GET /v1/latches/{id}/messages?before=<message_id>` | 200 `{items: MessageDTO[], next_before: string\|null}`。beforeより前(省略時は最新)の50件をID昇順で返す。さらに古い行があればnext_beforeに返した中で最古のID、無ければnull | beforeがULID形式外は400 |
| `POST /v1/latches/{id}/messages` | `{body, client_id}` → 201 MessageDTO(再送で既存行を返すときも201) | 本文不正は400 invalid_message・§2.2 |
| `POST /v1/latches/{id}/read` | `{last_read_message_id}` → 204 | 当該LATCHのメッセージでないIDは400 unknown_message。既読は前にだけ進め、古いIDは何もせず204 |
| `DELETE /v1/latches/{id}` | → 204 | §2.3 |

- MessageDTO = `{id, user_id, body, created_at(ISO 8601), client_id}`。client_idは本人の送信にだけ値を入れ、他の参加者の送信はnull
- client_idは1〜64字の`[A-Za-z0-9_-]`
- 既読の記録は`chat_reads`へのUPSERTで、`last_read_message_id`は既存値との大きい方(ULIDの文字列比較)を残す

### 3.2 LatchDTOの追加(F6bのつながり一覧の準備)

成立後(matched・completed・matched経由のcancelled)に限り、次の2キーを加える(成立前はキー自体を出さない既存の規則と同じ)。

- `last_message`: `{body, created_at, user_id}` または null(メッセージ0件)
- `unread_count`: 本人以外が送り、本人の`last_read_message_id`より新しいメッセージの数

一覧は1頁最大50件のため、LATCHごとの副問い合わせ(INDEX(latch_id, id)を使う)で求める。

### 3.3 成立一覧にmatched経由のcancelledを含める

`GET /v1/latches?type=matched`は従来matched・completedだけを返し、成立後にcancelledとなったLATCH(相手の離脱・削除)が残された側の一覧から消えていた。§0.3の2(相手の側に「このつながりは終了しました」と履歴を残す)と02 D-08の「相手側の表示は残る」を満たすため、type=matchedの条件に「status=cancelledかつlatch_status_eventsにto_status=matchedの記録がある」を加える(id降順・cursor・limitは不変)。離脱・削除した本人はleft_at・hidden_atにより従来どおり出ない。

### 3.4 WebSocket

```text
接続: GET /v1/latches/{latch_id}/ws?ticket=<署名チケット>
      チケット不正・期限切れ・使用済み・latch_id不一致・参加の再検証の失敗 → 401
      Upgrade: websocket でない要求 → 426(エラーコードUPGRADE_REQUIRED を05 §3.1の表に追加)
クライアント→サーバ: {"type":"message","body","client_id"}
サーバ→クライアント: {"type":"message","id","user_id","body","created_at","client_id"}
                      (client_idは送信者の接続にだけ値を入れ、他の接続はnull)
                      {"type":"closed"}(読み取り専用になった・直後に接続を閉じる)
                      {"type":"error","code","client_id"}
                      code = read_only | invalid_message | internal
ping → pong: DOの自動応答(setWebSocketAutoResponse)
```

不正なJSON・未知のtypeは`invalid_message`(client_idが読めなければnull)。`not_found`(接続中に本人が抜けた等)は`closed`を送って閉じる。

### 3.5 チケット

- joseのHS256・JWT_SECRETで署名。クレームは`sub`(user_id)・`latch_id`・`jti`(ULID)・`exp`(発行から60秒)・`typ:"ws_ticket"`。アクセストークンの検証はtypを持つトークンを拒否し、チケットの検証はtyp一致を必須とする(用途の取り違えを防ぐ)
- KVは使わない(05 §2.3のとおり)。1回限りはDOのストレージで担う(§1.1)

## 4. 失敗と計測

- DOの`webSocketMessage`・内部要求は例外を外へ出さない。D1の失敗は送信者へ`error(internal)`・RESTは500(既存の共通エラー応答)
- `webSocketClose`・`webSocketError`は接続を閉じるだけ(状態はD1にあり、DO側に残す永続データはチケットのjtiのみ)
- DOの再起動・休止: 接続は休止をまたいで保持され、再起動で切れた場合は画面が再接続して履歴をRESTで取り直す(10 §6の「履歴はD1から復元・接続再確立」)
- ログは既存の許可リスト方式。本文・client_id・チケットは出さない。出すのはイベント名・latch_id・結果種別のみ
- 06 §7の観測項目に追加はない(つながり品質の集計はF9でmessagesから算出する)

## 5. 他の機能との関係

- LatchDTOの`members`は従来どおりleft_atで決める。終了したつながりの相手の表示名(「つながっていた相手」)は画面の責務(F6b)
- `leave`の既存の挙動(冪等・下限割れでcancelled・次集合の提案)は変えない。DELETEはその上に載る。ただし実装中の裁定により、下限割れでLATCH全体をcancelledにしたとき(1対1は常にこれ)も取り消しを確定させた本人のleft_atを記録する(成立一覧にmatched経由のcancelledを含めたため、離脱した本人を非参加と同じに扱うのに要る。残った参加者のmembers・participants_countから離脱者は外れ、1対1はmembers=[]・participants_count=1。docs/05 §3.3)
- Cron (d)は送信で進む`last_message_at`を起点に90日判定を行う(F5のまま)

## 6. 試験

### 6.1 worker E2E(#25の証明)

`apps/worker/e2e/chat.spec.ts`(新設)。既存の補助関数で2人のつながりLATCHを成立させたあと、Node 22のグローバルWebSocketで接続する。

1. A・Bともチケットを取得して接続 → AがWebSocketで送信 → Bに`message`が届き、Aには自分のclient_id付きで届く
2. BがRESTで送信 → AにWebSocketで届く
3. 履歴APIで2件がID昇順で保存されていることを確認する(双方向の送受信記録)
4. Aが既読を記録 → Bの側は変わらず、Aの一覧で`unread_count`が0、Bの一覧で`last_message`がBの送信
5. Aが`DELETE` → Bに`closed`が届く・BのRESTの送信は400 read_only・Bの履歴は読める・AからのGETは404
6. チケットの再使用は401

### 6.2 統合試験(vitest・miniflare)

- `tests/chat-messages.test.ts`: 条件付き保存(matched以外・離脱者・hidden_atは保存されない)・last_message_atの更新・client_idの冪等・本文の検証・履歴の頁送り(50件・next_before)・既読の前進のみ
- `tests/chat-api.test.ts`: §2.2の表の各行・成立一覧にmatched経由のcancelledが残された側にだけ出ること・チケット(期限・typ・latch_id不一致・再使用)・LatchDTOの`last_message`/`unread_count`と成立前にキーが無いこと
- `tests/chat-do.test.ts`: WebSocket接続(SELF.fetchのUpgrade)・全員への配信・RESTの転送の配信・`closed`の配信と切断(全員/本人だけ)・pingの自動応答
- `tests/latches-delete.test.ts`: matchedの1対1(全体cancelled)・グループ(本人だけ・下限割れでcancelled)・completedとmatched経由のcancelled(hidden_atのみ・相手のDTO不変)・成立前400・非参加404・再試行204・hidden_atの本人の一覧と単一取得からの除外
- `tests/migration.test.ts`: 0005の列と索引・戻す手順
- 時刻はClockの注入で固定する(既存の規律)

## 7. 文書の更新(docs/00 §3)

変更した文書は版数を上げ、冒頭に変更点行を追記し、前提文書欄と00 §1の版数表を揃える。

- 12: F6をF6a/F6bに分ける決定記録(§0.3の1)・F6aの完了の記録
- 01冒頭の決定記録・02 D-08: §0.3の2(続いているLATCHの削除=本人の離脱)
- 05: §2.2(latch_members.hidden_at・messages.client_id)・§3.2(ws-ticketの応答・DELETEの挙動)・§3.3(LatchDTOのlast_message・unread_count・MessageDTO・成立一覧のmatched経由のcancelled)・§3.1(UPGRADE_REQUIRED=426)・§3.4(チケットの検証はWorker・1回限り・`retract`を`closed`へ改める・フレームのclient_id)
- 04 §4: チケットの検証場所(WorkerのルートとDOの使用済み記録)
- 08 §11: チケットの1回限りと参加の再検証の位置
- 10 §4: #25をworker E2E(chat.spec.ts)で証明する対応
- 11 §3: マイグレーション0005と戻す手順
- 00 §1の版数表・各文書の前提文書欄・AGENTS.mdの「現在の状態」
