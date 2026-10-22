# 不具合の修正工程 設計書

- 作成日: 2026-10-22
- 対象: GitHubのissue #2〜#10(F8a・F8bと本工程の設計中に見つけた不具合)の修正と、F8bで延期したTask 10(負荷試験の全規模の計測と報告書・02 §4 #33)
- 正本: docs/01 §20(性能目標)/ docs/02 §4 #32・#33 / docs/04 §4 / docs/05 §2.3 / docs/06 §2・§4・§7 / docs/12 §2
- 前段: docs/superpowers/specs/2026-10-22-f8b-staging-load-test-design.md(§0.2の実装後のオーナー決定)・docs/superpowers/plans/2026-10-22-f8b-staging-load-test.md(Task 10)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提と範囲

### 0.1 対象

| issue | 内容 | 場所 |
|---|---|---|
| #2 | 預けた画面の「通知を受け取る」が4秒の自動遷移で押せない | web |
| #3 | 試験用VAPIDの送信者`mailto:dev@latch.invalid`をAppleが403 BadJwtTokenで拒否する | worker・staging |
| #4 | refreshが中継の404・5xxでもセッションを捨てる | web |
| #5 | #32実機確認の項目6(オフライン表示)が未確認・「404 auth…」の画面の出どころが不明 | オーナーの実機確認 |
| #6 | マニフェストの警告(icon.svgを読めない・正方形のアイコン・screenshotsが無い) | web |
| #7 | 本物のVectorizeでは反映が5秒の確認待ちより遅く、新しい意思のキュー経由の評価が毎回失敗する | worker・shared |
| #8 | 提案・LATCHのあるactiveの意思を直すと第2段`embedding_completed`がINTERNALで失敗する | worker |
| #9 | Cronが直接評価した提案のWeb Pushがその場で送られず、30秒以上遅れる | worker |
| #10 | Cronの遅延再評価(h)が30分の再評価抑制に止められ、実際には評価しない | worker |

#10は本工程の設計中(#7の検討)に見つけて登録した。

### 0.2 オーナー合意(2026-10-22)

| # | 論点 | 合意 |
|---|---|---|
| 1 | 進め方 | 設計書→実装計画→サブエージェント方式で実行する。作業はmainで直接行う |
| 2 | 本工程で新しく見つけた不具合 | 直さずにまずissueへ登録する(計測を止めるほどのものかはその時点で相談する) |
| 3 | #7の直し方 | 「即評価+反映後に1回評価し直す」(§2)。比べた他の案: 反映を待ってから評価する(待ち方だけ直す)/待たずに評価して安全網(h)だけ直す |
| 4 | #10 | 本工程の対象に含める |
| 5 | 工程の順番・#8・#9・画面と設定・stagingでの確認と負荷試験 | §1〜§6のとおり |

合意#3(#7の直し方)は、決定内容/根拠/影響の形で12 §2の決定記録に残す(§7)。

### 0.3 本工程で行わないこと

- manifestの`screenshots`(#6の警告1・2)。F10の公開準備で判断する
- 本番の`VAPID_SUBJECT`の値の設定・本番VAPID鍵の発行(F10)
- Parser/Jevのreal接続(F9前の独立工程)。#33は「stubでの計測済み・LLM real接続後の測り直し待ち」のまま
- F8bの最終レビューで延期した軽微な指摘(`.superpowers/sdd/2026-10-22-f8b-staging-load-test/progress.md`)。Task 10の実行で支障が出たものだけを扱う
- つながりIntent以外への遅延再評価(h)の拡大

## 1. 工程の順番

| 順 | 内容 | 主な場所 |
|---|---|---|
| 1 | #8の原因調査と修正(§3.1)。評価の流れを作り替える前に、現在のstagingで再現させて調べる | worker |
| 2 | #7・#10(§2) | worker・shared |
| 3 | #9(§3.2) | worker |
| 4 | #4(§4.1) | web |
| 5 | #2(§4.2) | web |
| 6 | #3・#6(§4.3・§4.4) | worker・web |
| 7 | 文書の更新(§7) | docs |
| 8 | stagingへのデプロイと確認(§5)。シークレット`VAPID_SUBJECT`の登録し直しは、その時点でオーナーの承認を取る | staging |
| 9 | F8b Task 10(§6) | staging・docs |

オーナーの実機確認(#5の項目6、#2の修正後の項目3〜5)は8の後に依頼する(§5.3)。

## 2. #7・#10 評価の流れ

### 2.1 第1段(intent_created・intent_updated)

1. Embedding計算→VectorStoreへのupsert(現行どおり)。ベクトルのmetadataに`version`(意思のversion・文字列)を足す
2. `intents.embedding_model`・`embedded_at`を更新する(現行どおり)
3. 反映確認の待ち(`waitUntilReflected`・`EMBED_CONFIRM_TIMEOUT_MS`・`EMBED_CONFIRM_INTERVAL_MS`)を削除し、`embedding_completed`(同version)を即時に投入する。キューのメッセージに自分のベクトル(`vector: number[]`)を載せる
4. 反映確認のイベント(新しい種類`vector_reflection`・同version)を遅延付き(§2.3の初回の遅延)で投入する

Cronのバックフィル(e)は第1段を`emitCompleted=false`で呼び、直後に評価本体を直接呼ぶ(現行どおり)。反映確認のイベントは投入する(§2.3の再評価が同時投入の取りこぼしを拾う)。

メッセージの形: `MatchQueueMessage`に任意の`vector?: number[]`を足す(bge-m3の1024次元でJSON約20KB・Queuesの1メッセージの上限128KB以内)。match_events行のpayloadには載せない。

### 2.2 第2段(embedding_completed)

- メッセージに`vector`があれば、Layer 2 Candidate Retrievalの照会にそれを使い、VectorStoreから自分のベクトルを読まない。反映前でも評価でき、直した意思で古いベクトルを使うこともない
- `vector`が無い(Cronの経路・旧形式のメッセージ)ときは現行どおり`getByIds`で読む
- 評価本体`evaluateIntent`に、ベクトルを外から渡す任意の引数を足す。グループのPool内の他人どうしの類似度(`group-eval.ts`の`getByIds`)は現行どおりで、未反映の相手はPoolから外れる(§2.3の再評価で拾う)

### 2.3 反映確認のイベント(vector_reflection)

消費のたびに:

1. 意思が無い・active以外・versionが進んでいる → `skipped`(理由をpayloadへ)でprocessedへ倒す
2. `getByIds([intentId])`で自分のベクトルを読み、metadataの`version`が当該versionと一致すれば反映済みとする(直した意思の古いベクトルを反映済みと誤らない)
3. 未反映で、イベントの作成から`REFLECTION_GIVE_UP_MS`(5分)未満 → 同じイベントidを遅延付きで送り直す。遅延は作成からの経過で決め、2→4→8→16→30秒(以後30秒)とする。送り直しの回数はメッセージに持たず、行の`created_at`からの経過で決める
4. 未反映で5分以上 → `failed`(`error_code=REFLECTION_TIMEOUT`)。以後はCronの(h)(つながりIntent)が拾う
5. 反映済み → `evaluateIntent`を**30分の再評価抑制の例外**として1回呼び、第2段と同じ計測項目と`reflect_ms`(作成から反映を確かめるまでのミリ秒)をpayloadへ記録してprocessedへ倒す

1回きりの保証はmatch_eventsのUNIQUE(event_type, source_intent_id, version)と処理済みの再消費スキップ(現行)による。同じ組のJevの結果は同一version組の`jev_result`の再利用(06 §3)で再実行しないため、Jevの呼び出しが増えるのは新しく見つかった組だけで、予算は通常どおり起点側に計上する。

定数(packages/shared/src/constants.ts の`PIPELINE`): `EMBED_CONFIRM_TIMEOUT_MS`・`EMBED_CONFIRM_INTERVAL_MS`を削除し、`REFLECTION_DELAYS_S`(2・4・8・16・30)・`REFLECTION_GIVE_UP_MS`(5分)を足す。`MATCH_EVENT_TYPES`へ`vector_reflection`を足す。`event_type`はTEXT列でCHECK制約が無いため、マイグレーションは要らない(計画で確認する)。

既存のベクトルにはmetadataの`version`が無い。反映確認は新しく書いたベクトルだけを見るため影響しない。Cronのmetadata整合の修復は既存のmetadataを展開して書き直すため`version`を保つ。

### 2.4 #10 遅延再評価(h)

(h)の`evaluateIntent`呼び出しを30分抑制の例外にする(§2.3と同じ引数)。対象(つながりIntent・埋め込みから10分・1回きり)と刻印の規則は変えない。試験は「埋め込みの直後に評価済み(`last_evaluated_at`が約10分前)」という通常の状態で書き直し、抑制にかからず評価されることを確かめる。

### 2.5 試験

- 単体・統合(worker vitest): 第2段がメッセージのベクトルで照会し`getByIds`を呼ばない/反映確認の各分岐(未反映の送り直しの遅延・5分の打ち切り・version不一致を未反映とみなす・反映済みで抑制を越えて1回評価・stale/非activeのskipped)/同時に預けた2件が反映確認の再評価で提案される/(h)の通常状態での評価
- インメモリのVectorStoreは即時に反映されるため、反映の遅れは試験用の遅れる実装(またはgetByIdsの差し替え)で再現する
- worker E2E(既存47本)が緑のままであること

## 3. #8・#9

### 3.1 #8 直した意思の再評価がINTERNALで失敗する

原因が未特定のため、直し方は本書で決めない。superpowers:systematic-debuggingに沿って:

1. 現在のstagingで、2人の意思から提案ができた状態を作る(提案は#7によりバックフィル経由で約5〜9分後)
2. 片方の意思の主題をPATCHで変え、`wrangler tail --env staging`で失敗の瞬間を見る
3. 許可リストのため例外の文が出なければ、一時的に例外の種類(個人情報を含まない名前・メッセージの先頭)を出す変更をstagingにだけ入れて調べ、調べ終えたら戻す(コミットしない)
4. 原因を手元の試験で再現させてから直す(TDD)

原因が§2の作り替え(自分のベクトルの読み方など)と重なる場合は、報告したうえで§2の作業でまとめて直す。調査の結果は issue #8 へ記録する。

### 3.2 #9 Cronが直接評価した提案のWeb Push

`runScheduledPipeline`で、評価を行う走査((a)・(b)・(e)・(g)・(h)・保留の走査・次の集合の提案)の後に、その回のCronで作られた通知(作成時刻がCronの開始以後のpending)を`flushPush`でその場で送る。既存のPushの回収(`runPushSweep`・作成から30秒以上)は送り損ねの安全網として残す。同じ行の二重送信は既存の行ごとの順番取り(条件付きUPDATE)で防ぐ。送出の失敗は他の走査へ波及させない(`runIsolated`)。

`flushPush`に作成時刻の下限を指定する引数が無ければ足す。試験: Cronの評価で作られた提案の通知が、同じCronの実行の中で送信を試みられる(push_attempted_atが入る)こと。

## 4. 画面と設定

### 4.1 #4 refreshの失敗の判定

`apps/web/src/auth/session.ts`の`performRefresh`で、`rejected`(セッションを捨てる)とするのは次の応答だけにする。

- 401
- 400で、本文がLATCHのAPIのエラー形式(`error.code`が`VALIDATION_FAILED`)のもの

それ以外の応答(404・408・429・5xxなど・本文が読めないもの)は`network_error`としてセッションを残す。試験(`session.test.ts`): 404・503ではセッションが残る/401・LATCH形式の400では捨てる/LATCH形式でない400では残る。文書は04 §4のrefreshの失敗時の扱いを揃える。

### 4.2 #2 預けた画面の自動遷移

`apps/web/src/screens/Placed.tsx`で、通知の枠を出しているとき(`permission() === "default"`)は自動でホームへ移らない。許可が決まっている端末(granted・denied・unsupported)は従来どおり4秒で移る。試験(`Placed.test.tsx`): 自動遷移の試験を通知の枠を出さない条件に改め、「通知の枠を出しているあいだは自動で進まない」を足す。prototypeとの差(prototypeには自動遷移が無い)は、許可が決まっている端末だけの実装の裁量として残す。

### 4.3 #3 試験用VAPIDの送信者

- `apps/worker/scripts/prepare-dev-vars.mjs`(と共有部)の既定値を`mailto:dev@example.com`に改める。試験の値(`vitest.config.ts`・`sender.test.ts`)も揃える
- prodの起動時の点検(`assertEnvSafety`・`src/env.ts`)に、`VAPID_SUBJECT`の宛先のドメインが`.invalid`で終わるか`example.com`・`example.org`・`example.net`のときは起動を止める規則を足す(F10で実在の連絡先の設定を忘れない)
- `docs/reports/f8a-pwa-device-check.md`の1-3に`sub`の注意を書き足す
- stagingのシークレット`VAPID_SUBJECT`を`mailto:dev@example.com`で登録し直す(§5・オーナーの承認後)

### 4.4 #6 マニフェストの警告

`apps/web/public/icon.svg`に`width="512" height="512"`を足す。Chromiumの開発者向けの仕組み(CDPの`Page.getAppManifest`のerrors)で、警告3(icon.svgを読めない)・4(正方形のアイコン)が消えたことを確かめる(web E2Eの`pwa-flow.spec.ts`の「ホーム画面追加の要件」に加える)。消えなければmanifestからSVGを外す(PNGで足りる)。

## 5. stagingでの確認

### 5.1 デプロイ

mainへのpushでCI(ci・web-e2e)が緑ならstagingへ自動デプロイされる。手元からは`pnpm --filter worker deploy:staging`。本工程のコードの変更はD1のマイグレーションを伴わない見込み(§2.3)。

### 5.2 確かめること

- #7: 新しい意思の`embedding_completed`が数秒でprocessedになる/同時に預けた2件に、反映確認の再評価で提案が届く/`vector_reflection`の`reflect_ms`の値
- #8: 提案のある意思を直したとき、新しいversionの`embedding_completed`がprocessedになる
- #9: Cron経由の提案の通知で`push_attempted_at − created_at`が5秒以内
- #3: シークレットの登録し直しの後、スモーク(手順書の確認)が通る

結果は各issueへ記録し、確かめられたissueを閉じる。

### 5.3 オーナーの実機確認

stagingではなく、F8aの手順(手元のサーバーを一時トンネルで見せる・`docs/reports/f8a-pwa-device-check.md`)で、オーナーが行う。

- #2の後: 項目3〜5(預けた画面の「通知を受け取る」→許可→購読→受信)
- #4の後: 項目6(オフライン表示)を、PCをiPhone以外の回線につないで行う。「404」の画面が出たら全文とスクリーンショットを残す(#5)

#5と#2は、オーナーの記録で確かめられた後に閉じる。#32は引き続きオーナーの記録待ち。

## 6. F8b Task 10(負荷試験の全規模の計測と報告書)

F8bの計画(docs/superpowers/plans/2026-10-22-f8b-staging-load-test.md)のTask 10と手順書`docs/runbooks/staging.md` §7に従う。

1. 後始末→(a)→(b)→(d)→(c)を同じRUN_IDで流す(k6は`tools/load/run.mjs`経由)
2. 集計(`tools/load/report.mjs`)は後始末の**前**に行う(後始末でmatch_eventsが消えるため)
3. 報告書`docs/reports/f8b-load-test.md`を書く。本物のVectorizeの反映時間(`reflect_ms`)の分布を添える。stagingのURL・アカウントIDは書かない
4. 02 #33・12 §2・AGENTS.md・00の索引を更新する。#33は「stubでの計測済み・LLM real接続後の測り直し待ち」(01冒頭の決定記録(stagingと負荷試験))
5. 目標を外れた項目・新しく見つけた不具合はissueへ登録して報告書に記録する

## 7. 文書の更新

docs/00 §3の運用(版数・変更点行・前提文書欄・00 §1の版数表)に従う。

- 06 §2: 2段構成の記述(「upsert完了を確認してから`embedding_completed`を投入」)を§2.1〜§2.3の順序に改める。(h)が30分抑制の例外であることを書く。§7の計測項目に`reflect_ms`を足す
- 06 §4: 30分抑制の例外(反映確認の再評価・(h))を書く
- 05 §2.3: Vectorizeのmetadataに`version`を足す。match_eventsのevent_typeに`vector_reflection`を足す
- 04 §4: refreshの失敗時の扱い(§4.1)・prodの起動時の点検(§4.3)
- 12 §2: #7の直し方(本書§0.2の合意#3)を決定内容/根拠/影響の形で記録する
- 10 §5または報告書: 反映時間の実測
- AGENTS.md: 現在の状態(不具合の修正工程の完了・#33の状態)
- 計画で該当箇所を確かめ、上記以外に食い違う記述があれば揃える
