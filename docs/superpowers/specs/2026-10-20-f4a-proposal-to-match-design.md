# F4a 1対1の提案〜成立 設計書

- 作成日: 2026-10-20
- 対象: docs/12 §2 のF4「Jevと提案」を3分割したうちの F4a(1対1の提案〜成立・バックエンド)
- 正本: docs/01 §8・§10・§13 / docs/05 §2.2・§3 / docs/06 §2〜§6 / docs/07 §2・§5 / docs/02 §4
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提と分割

### 0.1 F4の3分割(オーナー合意 2026-10-20)

| 単位 | 内容 | ゲート(02 §4) |
|---|---|---|
| **F4a(本書)** | Jev層(stub)・Layer 5・提案化(直列化・履歴)・通知上限と保留・回答・双方YES成立・期限切れ・機会の排他・再提案・F3掃除リスト | #12・#14・#15・#18・#19・#20・#23、#17のAPI部分 |
| F4b | グループLATCH(Pool最大15・集合選択・1対1最低4回保証の配分) | #24 |
| F4c | 提案〜成立の画面(Proposal・DeferReason・Awaiting・Matched・NotEstablished等・`prototype/`基準) | #17のUI 2択 |

各単位で 設計→計画→実装 を1周する。F4bとF4cはF4a完了後に着手する。

### 0.2 Jevのreal化の扱い(オーナー合意 2026-10-20)

- F4aはJevの差し替え口・stub・フォールバック/circuit breaker/予算計上の共通部分までを作る。real(TypeSafe・Anthropic)の接続実装と精度ゲート(07 §6・09 §4)は **F9の前の独立工程** に移す。F3計画で「F4」としていたParserのreal化も同工程へ移す
- 根拠: F5〜F8のゲートはstub(Jev=0.9)で証明できる(10 §3)。realが必須となるのは公開チェックリスト(11 §1)とstagingのreal疎通(11 §2)である。F8の負荷試験(#33)で初期判定10秒をreal遅延で測る場合はその時点でrealが要る旨を12に注記する
- 手戻りの抑制: 差し替え口は「1ペア→7軸の数値 または 失敗種別」の最小形とし、切替・停止・計上は共通部に置く。TypeSafeのAPI形状が想定と異なっても修正は接続実装1ファイルに閉じる

### 0.3 F4aで行わないこと

グループLATCH(F4b)・提案系画面(F4c)・つながりLATCHのcompleted(90日)と機会LATCHのcompleted(対象時刻経過)(F5)・成立後のIntent active復帰の証明#21(F5)・チャット/メッセージ/leave後の読み取り専用化(F6)・`POST /v1/latches/{id}/feedback`と`DELETE /v1/latches/{id}`(F5)・Web Push送信と`GET /v1/notifications`(F7)・ブロック/通報API(F7)・geofeaturesのデータ取り込み(F7・#29)・Parser/Jevのreal接続(F9前の独立工程)。

## 1. 構成(案A: 第2段の評価を延長)

F3の`evaluateIntent`(L2→L1→L3→match_candidates保存)の後段に、同一処理内で Layer 4 → Layer 5 → 提案化 を連結する。キュー段は増やさない(06 §1の「1イベント処理あたりK_j=8」を1か所で守るため)。

| 配置 | 責務 |
|---|---|
| `src/jev/` | Jevの差し替え口・stub・実行器(上限・並列・フォールバック・再利用)・予算(usage_counters)・circuit breaker(KV) |
| `src/pipeline/layer4.ts` | L3通過候補からJev対象を選び実行器へ渡し、jev_resultを保存する |
| `src/pipeline/layer5.ts` | Hの最終再検証・LATCH Score算出・閾値判定・ペア単位の最大1件選択 |
| `src/latches/` | 提案化(直列化・保留)・回答期限・保留の解放・回答の状態遷移・成立後処理・提案の表示範囲 |
| `src/routes/latches.ts` | `/v1/latches` 系API |
| `src/pipeline/cron.ts` | 回答期限切れ・保留の期限切れ・保留の解放・予算アラート・usage_counters掃除・pending残留掃査 |

案B(第3段キュー)・案C(Durable Objectで直列化)は不採用。理由: Bはイベント種別と状態が増え上限計上が段をまたぐ。CはD1のUNIQUEで足りる直列化に対して過大。

## 2. Jev層(Layer 4)

### 2.1 差し替え口

- `Llm.jev` を `(input: JevInput) => Promise<JevOutcome>` に変更する
- `JevOutcome = { ok: true, axes: JevAxes } | { ok: false, kind: "timeout" | "rate_limited" | "overloaded" | "invalid_output" | "other" }`
- 第一候補(primary)と予備(fallback)の2つの実装を持てる形とする。F4aでは両方stub。`LATCH_LLM_MODE=real` は従前どおり未実装例外

### 2.2 stub(07 §2(b)の拡張許容の範囲)

- 既定: 7軸すべて0.9
- 入力の正規化テキストの先頭が試験用の目印のとき: `__jev_low__`(F3で導入済みの既存目印)→ 7軸すべて0.3、`__jev_timeout__` → `{ok:false, kind:"timeout"}`(フォールバック・circuit breakerの試験用)。正規化テキストはtopicから始まる(normalize.ts)
- 目印はテスト用seedのtopic先頭に置く。決定的(同一入力→同一出力)を保つ

### 2.3 実行器(`src/jev/runner.ts`)

- 上限: 1イベント処理あたり **K_j=8回**。実API呼び出しごとに計上し、フォールバック呼び出しも1回と数える(06 §3・§6)
- 対象: Layer 3スコア降順。8件を **並列** 実行する
- 第一候補が `timeout` / `rate_limited` / `overloaded` → 予備へ切替(07 §5)。予備も失敗 → 当該候補は保留(match_candidatesはcandidateのまま)。第一候補の `invalid_output` / `other` は切替せず保留
- 再利用: 両Intentが未更新(match_candidatesの同一バージョン組の行)でjev_resultが既にあれば実行しない(計上しない)
- 1対1の最低4回保証の配分規則はF4bで入れる。F4aは8回すべてを1対1に使う
- jev_resultは7軸の数値のみ保存する(理由文なし・07 §5)

### 2.4 予算(usage_counters・04 §5)

- 実行の前に4カウンタを原子的な1文(`UPDATE … SET count=count+1 … RETURNING`、行が無ければINSERT)で加算して判定する
  - `jev_intent`(key=起点Intent・日次): 40回
  - `jev_user`(key=起点ユーザー・日次): 120回
  - `jev_global_daily`(key='-'): 30,000回
  - `jev_global_monthly`(key='-'): 600,000回
- いずれかが上限を超えたら、以降の候補は保留する(超過分の加算は残してよい。上限判定は加算後の値で行う)
- **計上対象は起点側(イベントを生じたIntentとそのユーザー)のみ**。相手側の予算を他人の行動で消費させないため(文書の裁量で確定・06へ記録)
- 日の区切りはJST。periodは `YYYY-MM-DD`(日次)・`YYYY-MM`(月次)

### 2.5 circuit breaker(06 §5)

- 5分窓で10連続失敗(第一候補・予備を問わず実呼び出しの失敗)で30分オープン。オープン中はJevを実行せず保留する
- 状態はKVに置く(キー例 `jev:breaker`)。KVの反映遅延は許容する(安全装置としての近似で足りる)
- 成功1回で連続失敗数を0に戻す

### 2.6 計測(06 §7)

- 起点イベント(embedding_completed)のmatch_events.payloadへ `jev_calls` / `jev_reused` / `jev_held`(理由別: budget / breaker / failed / cap)/ `jev_latency` / `l5_over_threshold` / `proposed` / `held_proposals` を追加
- 同内容をAnalytics Engine(PIPELINE_AX)へ書く。ログは許可リストのみ
- #14(Jev回数の上限)・#15(双方向の判定値)の証拠となる

## 3. Layer 5と提案化

### 3.1 Layer 5

- 提案の直前に、そのペアの最新のD1値で H を再検証する: 双方active・ブロック・提案履歴(matched/rejected)・飲酒年齢・自己ペア・form一致。F3の`fetchL1Data`/`layer1Judge`を再利用する。不合格は H=0
- `L = H × min(would_a_accept_b, would_b_accept_a) × C`(C=1・01 §13)。a/bはmatch_candidatesの正規化順(a.id < b.id)。Jev入力も同じ順で渡す
- **L > 0.60** で提案化の対象(0.60ちょうどは対象外)。match_candidates.latch_scoreへ保存する(閾値未満も保存する)
- 同一処理内で同一ユーザーペアの候補が複数閾値を超えたら、L最大の1件のみ(同点はmatch_candidatesのid昇順)。複数ペアはL降順に処理する

### 3.2 直列化(proposal_historyの確保を完了条件とする)

1. **履歴の確保**: `proposal_history` は UNIQUE(user_low, user_high) の1ペア1行。新規は INSERT(outcome=proposed, latch_id=新LATCH id)。既存行は「再提案可の条件」を満たす場合にだけ UPDATE(outcome=proposed, latch_id=新id, updated_at=now)。条件はSQLのWHEREで表し、1文で原子的に判定する
2. **後続の書き込み**: latches・latch_members・latch_status_events・match_candidates.status=proposed・notifications を1つのD1バッチで書く。各文は「proposal_historyに latch_id=新id の行が存在すること」を条件とする(`INSERT … SELECT … WHERE EXISTS` 形式)。確保に失敗した場合は後続が0行となり何も残らない
3. 履歴の確保に失敗する場合(進行中の提案がある・恒久排除・再提案条件の不成立)は提案しない

**再提案可の条件(機会Intentのみ・01 §8)**: 既存行のoutcomeが deferred または expired、かつ双方のIntentが機会Intent、かつ `now ≥ updated_at + min(24時間, (対象時刻 − updated_at)/2)`、かつ(スコア変化(prev_latch_scoreとの差が0でない)または どちらかのIntentのversionが前回提案時より大きい)。つながりIntentは既存行があれば一切再提案しない。

### 3.3 提示か保留か(通知上限・01 §10)

- 次をすべて満たせば **proposed**(回答期限を計算・proposed_at=now・参加者全員にnotifications(type=proposal))
  - 参加者全員が、当日(JST)に作成された type=proposal の通知が6件未満
  - 各参加Intentの進行中(proposed / partial_accept)のLATCHが3件未満
- 満たさなければ **candidate(保留)** としてLATCHを作る(通知なし・proposed_atはnull・response_deadlineは暫定でexpires_at)
- 上限の判定と書き込みは同一文ではないため、並行消費で上限を1件程度超え得る。直列化はペア単位であるため完全には防がず、これを許容する(06へ記録)
- 機会Intentで対象時刻まで75分未満のペアは提案しない(LATCHを作らず、match_candidatesはcandidateのまま)

### 3.4 回答期限(01 §8)

- 機会: `min( max(提示+15分, min(提示+2時間, 対象時刻−60分)), 参加Intentのexpires_atの最小値 )`。対象時刻は双方のstarts_atの遅い方(重なりの開始)
- つながり: `min(提示+24時間, 参加Intentのexpires_atの最小値)`
- latches.expires_at = 参加Intentのexpires_atの最小値

### 3.5 保留の解放(06 §2の(i))

- 呼び出し元: 提案のクローズ時(matched / rejected / expired / cancelled)に関係ユーザーを対象に、および毎分Cronで全体を対象に(日付の変わり目で上限に空きが出る場合を拾う)
- 順序: 機会=対象時刻の近い順 / つながり=score降順(同点はid昇順)
- 提示時に3.3の上限を再判定し、満たすものだけ proposed へ昇格(回答期限を提示時刻で計算・通知を作る)
- 保留中に Intent期限を過ぎたもの・機会で対象時刻まで75分未満となったものは、提示せず expired で閉じる(通知なし・proposal_historyはexpired)

### 3.6 提案の中身(latches.proposal)

`{form, topic, time_window, region_name, participants, budget}`

- topic・地域の基準は **先に預けられた側(created_atの早い方・同値はid昇順)** のIntent
- time_window: 機会は双方の時間の重なり(開始=遅い方のstarts_at・終了=早い方の終端)。つながりはnull
- participants・budget: 双方の区間の共通部分(budgetは機会のみ・無ければnull)
- region_name: 基準Intentが地理添付ありのとき、中心座標を約1km(0.01度)グリッドに丸め、その代表点に最も近いgeofeaturesの地名(08 §4)。地理なし・geofeaturesに該当なしはnull。F4aは逆引き処理のみ作り、データ取り込みはF7

## 4. 回答と成立

### 4.1 API(F4aで実装)

| API | 内容 |
|---|---|
| `GET /v1/latches?type=proposals\|matched` | 自分が参加する提案(proposed / partial_accept)・成立(matched)の一覧。保留(candidate)は含めない。ページネーションは05 §3.1 |
| `GET /v1/latches/{id}` | **新設**。単一取得(通知から提案画面を開くため)。05へ追記 |
| `POST /v1/latches/{id}/response` | `{response: "yes"\|"defer"\|"no"}`。noはAPI専用(UIに置かない) |
| `POST /v1/latches/{id}/response/retract` | 回答の取り消し |
| `POST /v1/latches/{id}/leave` | 成立後の参加取り消し |
| `POST /v1/latches/{id}/defer-reason` | **新設**。`{reason: "no_capacity"\|"schedule_mismatch"\|"just_not_now"\|"other"}`(画面の4択「いまは余裕がない/日時や場所が合わない/なんとなく、今回は/その他」)。見送った本人が1回だけ・latch_responses.defer_reasonへ保存。05へ追記 |

- 本人が参加しないLATCH・存在しないLATCHは一律404(05 §3.1)。保留(candidate)のLATCHも参加者に対して404とする(未提示のため存在を見せない)
- 回答できない状態は400 VALIDATION_FAILED、details.reasons に `invalid_status` / `deadline_passed` / `already_responded` / `not_deferred`(defer-reason用)を入れる

### 4.2 状態遷移(05 §3.3)

| 操作 | 前状態 | 後状態 | proposal_history |
|---|---|---|---|
| yes(全員揃わない) | proposed | partial_accept | — |
| yes(全員揃う) | proposed / partial_accept | matched | matched |
| defer | proposed / partial_accept | rejected | deferred |
| no | proposed / partial_accept | rejected | rejected(恒久排除) |
| retract(自分のyesを取り消し・期限内) | partial_accept | proposed | — |
| leave | matched | cancelled | (matchedのまま) |
| 回答期限切れ(Cron) | proposed / partial_accept | expired | expired |
| 排他(他のLATCH成立・機会のみ) | candidate / proposed / partial_accept | cancelled | expired |
| 参加Intentの削除 | candidate / proposed / partial_accept | cancelled | expired |

- retract後は同じ提案に回答し直せる(latch_responsesの行をUPDATEし retracted_at を消す)
- leave: 機会Intentはmatchedのまま(復帰しない)。チャットの読み取り専用化はF6
- 状態遷移はすべてlatch_status_eventsへ記録する
- 通知: matched → 参加者全員にtype=matched。rejected / expired / cancelled → **提示済み(proposed_atあり)の提案に限り**参加者全員にtype=closed。文言は「この提案は成立しませんでした」のみ(画面はF4c)

### 4.3 同時YES

回答の記録と状態更新を1つのD1バッチで行う。状態更新は `UPDATE latches SET status = CASE WHEN (有効なyesの数) = (参加人数) THEN 'matched' ELSE 'partial_accept' END WHERE id=? AND status IN ('proposed','partial_accept') AND response_deadline > now` とし、YESの数をDB内で数える。どの順で並行してもYESが揃った時点の処理がmatchedにする。更新0行なら状態を再読込して400(invalid_status / deadline_passed)を返す。

### 4.4 成立後処理

- proposal_historyをmatchedへ。参加者全員にmatched通知
- **機会**: 参加Intentを matched にする。同じIntentを含む他のLATCH(candidate / proposed / partial_accept)を **すべて cancelled**(#23)。提示済みのものには closed 通知
- **つながり**: 参加Intentは active のまま(01 §8の複数成立。#21の証明はF5)
- 関係ユーザーの保留の解放(3.5)を呼ぶ

### 4.5 表示範囲(#20・01 §10)

- 成立前(candidate以外の非matched): `{id, form, status, response_deadline, participants_count, my_response, score}`。相手の情報・proposal(主題・時間・地域等)は含めない。scoreは05に従い応答に含めるがUIでは描画しない
- 成立後(matched・およびmatched経由のcancelled): 上記 + `proposal` + `members: [{user_id, display_name, bio, has_icon}]`(自分を除く)

### 4.6 他機能との連携

- Intent削除(DELETE /v1/intents/{id}): F3の候補削除に加え、当該Intentを含むcandidate / proposed / partial_accept のLATCHを cancelled にする(01 §8の不成立経路)
- pause: 進行中の提案は継続し本人は回答できる(06 §2)
- 通知はF4aでは行を作るのみ。一覧APIとWeb PushはF7

## 5. Cronと期限

### 5.1 追加する走査(毎分・1回の処理上限500件)

| 走査 | 内容 |
|---|---|
| 回答期限切れ | response_deadline ≤ now の proposed / partial_accept を expired。proposal_history=expired・既存のYESは無効(持ち越さない)・closed通知・保留の解放 |
| 保留の期限切れ | 3.5の条件の candidate を expired(通知なし) |
| 保留の解放(i) | 3.5を全体に対して実行 |
| 予算アラート(f) | jev_global_daily / jev_global_monthly が上限の80%以上で警告ログ+Analytics Engine。同一periodで1回(KVに送信済みの印) |
| usage_counters掃除 | periodが90日より古い行を削除(既存の保持期間削除に追加) |
| pending残留掃査 | 作成から10分を超えて pending のままの match_events を failed にする(再評価は既存の(g)未評価回収が担う) |

- Intent期限切れによる提案のクローズは新しい経路を作らない(回答期限 ≤ 参加Intent期限の最小値のため、回答期限切れと保留の期限切れで閉じる)
- 索引: latches(status, response_deadline)・latches(status, proposed_at) 等を3.7のマイグレーションに含める
- (d)completed判定はF5

### 5.2 再提案(#12b)の起動

新しい仕組みは足さない。Intent更新(PATCH)・機会のbucket/catch-up等の既存の評価経路で評価が走ったとき、3.2の再提案条件を満たせば提案される。jev_resultの再利用規則(両Intent未更新ならスコア不変)により、変化のない再提案は起きない。

### 5.3 F3の掃除リスト(F3計画末尾の7項目)

1. 第2段の消費失敗ログを `pipeline.stage2.failed` に分離
2. `pipeline.stage1.completed` ログに count を追加
3. `errorCodeOf` を共通化し、フォールバック値を揃える
4. docs/04 §6 の「Vectorize込み」をインメモリ代替の表記へ
5. `emitMatchEvent` を Clock 引数化(systemClock直参照の解消)
6. 評価失敗時の起点イベント pending 残留 → 5.1 の pending残留掃査
7. バックフィルの二重評価 → Cronからの第1段呼び出しでは embedding_completed を発行しない。Embeddingの連続5件失敗でその回の走査を打ち切る

## 6. データモデルの変更(マイグレーション0003・戻すマイグレーションと対)

- `latch_status_events`: `latch_id`・`from_status`・`to_status` 列を追加(05 §2.2の定義に揃える)
- `latches`: `proposed_at`(timestamp_ms・null可)を追加
- `proposal_history`: `updated_at`(timestamp_ms)を追加(見送り時刻の基準)
- 索引: latches(status, response_deadline)・latches(status, proposed_at)・latch_members は既存・notifications(user_id, type, created_at)(当日件数の集計)

## 7. 試験とゲートの証明

### 7.1 単体・統合(vitest・注入Clock)

- Jev実行器: 上限8回・並列・フォールバック・breaker・予算4カウンタ・再利用
- Layer 5: Hの再検証・式・閾値境界(0.60ちょうどは提案しない)
- 提案化: 同一ペア並行で1件のみ・再提案条件・通知上限と保留・解放順・回答期限の2式
- 回答: 同時YES・retract・期限後の拒否・機会の排他・表示範囲
- Cron: 回答期限切れ・保留の期限切れ・予算アラート・pending残留掃査・バックフィルの打ち切り

### 7.2 dev専用APIの追加

- `POST /v1/dev/latches/{id}/backdate` `{response_deadline?, history_updated_at?}`: 提案の回答期限と提案履歴の見送り時刻を過去へずらす(E2Eで時計を操作せずに期限経過を作るため・オーナー合意 2026-10-20)
- dev観測APIの拡張: match-candidatesへ jev_result・latch_score を追加。LATCHと提案履歴の観測(GET /v1/dev/latches?intent_id=・GET /v1/dev/proposal-history?user_id=)
- 存在隠しは `POST /v1/dev/idp-token` と同一条件(prod・テスト鍵2変数のいずれか未設定は一律404)

### 7.3 worker E2E(stub Jev=0.9・seed配置)

| ゲート | 証明 |
|---|---|
| #14 | 大量の一次候補を配置し、1イベントのjev_callsが8以下 |
| #15 | 候補のjev_resultにwould_a_accept_b・would_b_accept_aの両方 |
| #17(API) | yes / defer / no の回答記録と状態遷移(UIの2択はF4c) |
| #18 | 双方YESでmatched |
| #19 | backdate → Cron強制発火(GET /__scheduled)→ 提案がexpired。Intent期限側はF3 #6で証明済み |
| #20 | 成立前後のGET /v1/latches/{id}の比較 |
| #23 | 同一機会Intentを含む2提案のうち一方の成立で他方がcancelled |
| #12 | (a)成立・no後に新規Intentを作っても提案されない (b)見送り → backdate → 機会Intent更新 → 再提案 |

## 8. 文書の更新(F4aの最後に実施)

- 05: 新設API(GET /v1/latches/{id}・defer-reason・dev API)・追加列・表示範囲・理由コード
- 06: 予算は起点側のみ計上・直列化の方式・通知上限の僅少超過の許容・F4aの実装確定
- 07: Jevの差し替え口とstubの目印・real化の移動
- 10 §3: dev APIによる時刻ずらしの方式
- 12: F4の3分割(F4a/F4b/F4c)・Parser/Jevのreal化と精度ゲートをF9前の独立工程へ移動・F8負荷試験の注記
- AGENTS.md「現在の状態」
- 各文書の版数・変更点行・前提文書欄・00 §1の版数表を揃える(00 §3)
