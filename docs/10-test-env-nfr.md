# LATCH テスト環境・非機能検証計画書

- 文書バージョン: v0.27
- ステータス: Draft
- プロダクト名: LATCH
- 作成日: 2026-10-17(v0.27更新: 2026-10-23)
- v0.2の変更点: 多角レビュー(loop1)の指摘を反映。年齢検証のエラーcode切り分け・E2E対象の明示列挙(#22除外)・負荷試験のレート制限除外規定を追加
- v0.3の変更点: §1環境表にLATCH_ENV変数値の対応を追記(環境名prodと変数値productionの対応の明記。設定取り違えによる起動ガードの素通しを防ぐ)。前提文書欄の09の版数をv0.3に更新(09の版上げの反映漏れ)
- v0.4の変更点: 前提文書欄の版数同期(F2実装に伴う05・09改版への追従)
- v0.5の変更点: 前提文書欄の版数同期(03不作成裁定に伴う各前提文書の改版への追従)
- v0.6の変更点: 前提文書欄の版数同期(プロトタイプREADME §7のオーナー裁定(2026-10-19)に伴う01・02・04・05・09改版への追従)。内容の変更はない
- v0.7の変更点: F2'実装に伴い§2へブラウザE2E(web E2E)のテストユーザー方式(UI経由のテストサインイン・dev専用サインイン04 §4)を追記し、§4のE2E層にweb E2E(Playwright chromium・CI)を追記。前提文書欄の04の版数をv0.9に更新
- v0.8の変更点: 前提文書欄の版数同期(F2'実装に伴う05・09改版への追従)。内容の変更はない
- v0.9の変更点: F3実装に伴い§1のlocal環境の表記をVectorStoreのインメモリ代替(04 §4)どおりに整合し、§3へworker E2EでのCron強制発火(wrangler dev --test-scheduledのGET /__scheduled・run_worker_firstへの追加)を追記、§4へパイプライン前段(F3)のゲート試験の分担(E2Eと統合試験の分割)を追記。前提文書欄の版数を更新
- v0.10の変更点: F4a(1対1の提案〜成立)実装に伴い§3へworker E2Eでの期限経過・再提案条件の作り方(時計は操作せず、dev専用のbackdate APIで回答期限・見送り時刻・最終評価時刻を過去へずらす・05 §3.3)と、共有インメモリストアでのspec間干渉を防ぐ残置データの後始末を追記。前提文書欄の版数を更新
- v0.11の変更点: 前提文書欄の版数同期(F4aの最終レビューの修正に伴う04・05・09改版への追従)。内容の変更はない
- v0.12の変更点: オーナー裁定(2026-10-20・01冒頭の決定記録)に伴い、§3のbackdateによる最終評価時刻の書き換えは意味フィールドの更新を伴わない再評価の抑制を外す用途である旨を追記(意味フィールドの更新は30分再評価抑制を自ら解除する・05 §3.3)。前提文書欄の版数同期(01・02・04・05・09改版への追従)
- v0.13の変更点: 前提文書欄の版数同期(F4b(グループLATCH)実装とオーナー裁定3件(2026-10-20・01冒頭の決定記録)に伴う01・02・04・05・09改版への追従)。内容の変更はない
- v0.14の変更点: F4c(提案〜成立の画面)実装に伴い、§3へweb E2Eの直列実行(workers: 1)と残置データの後始末の干渉の理由、ローカルでworker E2Eとweb E2Eを同時に実行しない旨を追記し、§4のE2E層へ#17のUI 2択がweb E2E(latch-flow.spec.ts)で証明される旨を追記。前提文書欄の版数は変更なし
- v0.15の変更点: F5(つながりの性質)実装に伴い、§4へF5のゲート試験(#21=worker E2E・#22=注入clockの統合試験)の所在を追記した。前提文書欄の版数を更新
- v0.16の変更点: F6a(チャットのバックエンド)実装に伴い、§4へF6aのゲート試験(#25=worker E2E chat.spec.ts)と統合試験の分担の所在を追記した(worker E2Eは39本)。前提文書欄の版数を更新
- v0.17の変更点: F6b(チャットの画面)の完了に伴い、§4のE2E層とF6aのゲート試験の段落へ画面のweb E2E(chat-flow.spec.ts)の所在を追記した(web E2Eは12本・worker E2Eは39本)。F6bは02の番号を持たない。前提文書欄の版数を更新
- v0.18の変更点: F7a(安全のAPI)の完了に伴い、§4へF7aのゲート試験の分担(#26〜#30をworker E2E safety.spec.tsで証明・#29の地名データの投入・統合試験の分担)を追記した(worker E2Eは44本・web E2Eは12本)。前提文書欄の版数を更新
- v0.19の変更点: F7b(通知のAPI)の完了に伴い、§4へF7bのゲート試験の分担(#16のAPI部分をworker E2E notifications.spec.tsの3本で証明・iOS未インストール状態の確認ケースを購読の無い利用者で確かめる・統合試験の分担・実機ブラウザでの受信はF7c・F8)を追記し、§2へテスト専用VAPID鍵を追記した(worker E2Eは47本・web E2Eは12本)。前提文書欄の版数を更新
- v0.20の変更点: F7c(安全と通知の画面)の完了に伴い、§4へF7cのゲート試験の分担(#16の画面部分をweb E2E notices-flow.spec.tsで証明・同じspecで通報とブロックを確かめる・プッシュの購読はE2Eに含めず単体試験で確かめる・実機ブラウザでの受信はF8)を追記し、§4の表のE2Eの行にnotices-flow.spec.tsを加えた(web E2Eは15本・worker E2Eは47本)。前提文書欄の版数を更新
- v0.21の変更点: F8a(PWAと画面の仕上げ)の完了に伴い、§4へF8aのゲート試験の分担(#32の自動の部分をweb E2E pwa-flow.spec.tsの3本で証明・単体・結合試験の分担・実機確認の記録は`docs/reports/f8a-pwa-device-check.md`でオーナーの記録待ち・Lighthouseの監査の記録は`docs/reports/f8a-lighthouse.md`)を追記し、§4の表のE2Eの行にpwa-flow.spec.tsを加えた(web E2Eは18本・worker E2Eは47本)。前提文書欄の版数を更新
- v0.22の変更点: F8b(stagingの構築と負荷試験)の実装確定とオーナー決定(2026-10-22・01冒頭の決定記録(stagingと負荷試験)・12 §2の決定記録(stagingと負荷試験))に伴い、§1へstagingの値(LATCH_ENV=staging・Embeddingはreal・Parser/Jev・Web Pushはstub)と手順書を、§5へ負荷試験の実施方法(k6のシナリオ(a)〜(d)の規模・(c)の組の間隔を2時間とした理由・後始末・集計の方法(応答で見える時間はk6・内部の時間はD1の記録から集計)・レート制限は未実装のため緩和の設定は該当しないこと・全規模の計測は不具合の修正の後に行うこと)を追記し、§5と§7のD-E-01の記録にk6 v1.8.1の`k6/websockets`の確認済みを添えた。前提文書欄の版数を更新
- v0.23の変更点: 不具合の修正工程(2026-10-22)に伴い、§2のWeb Pushの試験用の送信者(`mailto:dev@example.com`)とprodの起動ガードの仮の送信者の拒否(04 §4・issue #3)を、§5の実施方法へVectorizeの反映時間(reflect_ms・06 §7)を合否を付けない参考の行として集計することを、§5の状態へissue #7・#8・#9のコードの修正が済みstagingでの確認と全規模の計測がこれからであることを追記した。前提文書欄の版数を更新
- v0.24の変更点: F8bの負荷試験の全規模の計測(2026-10-22・不具合の修正工程の後)の結果を§5の状態に記録した(目標を外れた初期判定と通知=issue #18・#19・計測の中で見つけた不具合=issue #15・#16・#17・#20・記録は`docs/reports/f8b-load-test.md`)。前提文書欄の版数を更新
- v0.25の変更点: 記述の整合のみ(「Candidate Retrieval」の略記を「Layer 2 Candidate Retrieval」に揃えた)。内容の変更はない
- v0.26の変更点: 前提文書欄の同期のみの改版(最終の直しに伴う版数の連鎖。内容の変更はない)
- v0.27の変更点: 不具合の修正工程(第2回・2026-10-23)と初期LATCH判定の目標のオーナー合意(01冒頭の決定記録(初期判定の目標))に伴い、§5の目標と実施方法へ初期判定の合否の対象(保存の時点で組の相手の意思がVectorizeに反映済みの場合)と、シナリオ(b)を2段にしたこと・集計の振り分け(「相手が先に反映済み」と「同時・参考」)・反映の欠けの内訳を、§5の状態へ第2回の修正工程のコードの完了とstagingでの測り直し待ちを加えた。§3へE2Eのローカルの状態を手元開発と分けたこと(issue #12)を、§4のF8aのゲート試験へマニフェストのアイコンをPNGだけにしたこと(issue #6)を、§6の表のEmbeddingの全断へキューのやり直しを加えた。前提文書欄の版数を更新
- 前提文書: 01 要件定義書 v0.21 / 02 スコープ・受け入れ条件合意書 v0.17 / 04 アーキテクチャ設計書 v0.26 / 05 データモデル・API仕様書 v0.26 / 09 検証・評価計画書 v0.25
- 本書の位置づけ: 02の対応表(#1〜#35)をどう試験で証明するかを確定する。環境・テストユーザー・時刻制御・試験の層・負荷試験・縮退試験の計画

## 1. 環境(04 §6準拠)

| 環境 | 構成 | 用途 |
|---|---|---|
| local | `wrangler dev`(ローカルD1/Queues/DO・VectorStoreはインメモリ代替(04 §4)・LLM=stub) | 単体・統合・E2E(開発中) |
| staging | 実D1・Queues等(stub既定・real切替可) | クローズドテスト(02 #34)・負荷試験・real精度確認 |
| prod | カスタムドメイン・real固定 | 公開 |

D1・Vectorize・KV・R2は環境ごとに分離。マイグレーション適用は`wrangler d1 migrations apply`の明示実行のみ。
`LATCH_ENV`の値: local / staging / production(04 §6の環境名prodに対応する変数値は`production`)。誤って`prod`等を設定すると起動ガード(04 §4)が素通しとなるため、prodデプロイ時は変数値を`production`で統一する。
stagingの値(F8b実装確定): `LATCH_ENV=staging`(VectorStoreはVectorize)・`LATCH_EMBEDDING_MODE=real`(Workers AI)・`LATCH_LLM_MODE=stub`・`LATCH_PUSH_MODE=stub`。テスト用IdP鍵とテスト用VAPID鍵をシークレットに置き、dev専用サインインとdev専用APIを有効のまま使う(04 §6)。資源の作成・デプロイ・戻し方・負荷試験の実行の手順は`docs/runbooks/staging.md`に置く。マイグレーションはCIの`deploy-staging`ジョブ(04 §6)と手元のデプロイの工程として`wrangler d1 migrations apply DB --env staging --remote`を明示的に実行する

## 2. テストユーザーと認証

- staging専用IdP鍵ペア(04 §4)で発行する内部トークンを使用。prodの起動ガードがテスト鍵を拒否する構成とする
- ブラウザE2E(web E2E)のテストユーザーはUI経由で作る: ようこそ画面→サインイン→dev専用サインイン(04 §4のPOST /v1/dev/idp-token)を画面の実フローで通し、ストレージへのトークン直接注入は行わない。実行ごとに新規ユーザーを作る(ローカルD1は実行間で永続するため、実行ごとの新規作成を汚染回避とする)
- Web Pushはローカル・E2Eでは送り手をstub(LATCH_PUSH_MODE=stub・外部へ送らず送信を成功として扱う・04 §4)とし、VAPID鍵はコミット済みのテスト専用鍵(tests/fixtures/test-vapid.json・E2Eの`.dev.vars`へ自動で加える)を使う。試験用の送信者(VAPID_SUBJECT)は`mailto:dev@example.com`とする(`.invalid`の予約ドメインはAppleのPushサービスが拒否するため・issue #3)。prodの起動ガードがテスト用VAPID鍵とstubを拒否する(F7b実装確定)。あわせて、prodでVAPID_SUBJECTが仮の送信者(宛先のドメインが`.invalid`で終わるか`example.com`・`example.org`・`example.net`)のままなら起動を拒否する(04 §4・不具合の修正工程で確定)
- 年齢検証用にbirth_date可変のユーザーを用意する。(a)18歳未満の登録=UNDER_AGE(422)、(b)18〜19歳による飲酒機会Intentの作成=ALCOHOL_RESTRICTED(422)の2系統を検証する(02 #30・05 §3.1)

## 3. 時刻の制御

- 単体・統合: 注入clockの固定時刻(04 §4の規律)。期限切れ・90日completed・回答期限を決定的に試験する
- E2E(staging): 実時間。時間依存ケースは**期限を近未来に設定したデータの投入(seed)**で制御する(例: 回答期限1分後の提案を配置して期限切れを待つ)。時計を操作する仕組みは持たない。提案の発生を保証するため、E2E用seedはstubスコアが閾値0.60を超える構成(07 §2のJev stub=0.9)を前提とする。**90日級の状態遷移(02 #22)は注入clockによる単体・統合試験で証明し、E2Eの対象外とする**
- E2E(ローカル・worker E2E): Cronを強制発火できる。`wrangler dev --test-scheduled`が提供するGET /__scheduledを呼ぶとCron Triggerが即時実行される(F3実装確定)。`/__scheduled`はassetsのSPAフォールバックに代替されないようrun_worker_firstに含める(04 §4)。stagingのE2Eは本エンドポイントに依存しない(前項のseed+実時間待ち)
- E2E(ローカル・worker E2E)の期限経過と再提案(F4a実装確定): 時計を操作しない方針は変えず、dev専用API POST /v1/dev/latches/{id}/backdate(05 §3.3・prodでは存在を隠す)で回答期限(response_deadline)・見送り時刻(proposal_history.updated_at)・参加Intentの最終評価時刻(last_evaluated_at)を過去へずらし、続けてCronを強制発火して回答期限切れ(02 §4の#19)と見送り後の再提案(#12(b))を作る。最終評価時刻の書き換えは、意味フィールドの更新を伴わない再評価の30分抑制を外す用途である(意味フィールドの更新は抑制を自ら解除する・05 §3.3。#12(b)は引き続きこの書き換えを使う)。90日級(#22)は従来どおり注入clockの統合試験で証明する
- worker E2Eの残置データ(F4a実装確定): worker E2Eは1プロセスのインメモリ・ベクトルストアとローカルD1を全specで共有するため、起動時(webServer)と提案系specの各test前に `scripts/clean-e2e-data.mjs` で既存E2EユーザーのactiveなIntentをexpiredへ倒し、spec間の干渉(候補検索の取り出し幅の汚染)を防ぐ。対象はE2Eユーザーに限り、手元開発のデータには触れない
- E2Eのローカルの状態の置き場(不具合の修正工程(第2回)で確定): worker E2Eとweb E2Eの`wrangler dev`・D1のマイグレーション・`scripts/clean-e2e-data.mjs`は、E2E専用の保存先(`apps/worker/.wrangler/e2e-state`・`--persist-to`)を使い、手元開発のローカルD1(既定の`.wrangler/state`)と分ける。手元開発で残した意思がE2Eの候補検索に混ざって失敗する(issue #12)ことを防ぎ、E2Eも手元開発のD1を変えない。CIの動きは変わらない
- web E2Eの直列実行(F4c実装確定): web E2Eも `workers: 1`(apps/web/playwright.config.ts)で直列に実行する。提案系spec(latch-flow.spec.ts)の各test前の `scripts/clean-e2e-data.mjs` が全E2EユーザーのactiveなIntentをexpiredへ倒すため、並列実行すると他spec(flow.spec.ts)の進行中のIntentを巻き込むからである
- worker E2Eとweb E2Eの同時実行の禁止(F4c実装確定): ローカルではworker E2Eとweb E2Eを同時に実行しない。両者は同じローカルD1を使い、`scripts/clean-e2e-data.mjs` が全E2EユーザーのactiveなIntentをexpiredへ倒すため、一方の後始末が他方の進行中のIntentを巻き込むからである(ポートを分けても防げない)

## 4. 試験の層と自動化

| 層 | 対象 | 実行 |
|---|---|---|
| 単体 | 純関数(期限式・スコア計算・地理判定・匿名化) | vitest・毎コミット |
| 統合 | Worker+ローカルD1/Queues/DO(API→キュー→pipeline→提案化まで) | vitest-pool-workers・毎コミット |
| E2E | ブラウザ実操作(全画面フロー・通知・チャット) | Playwright・CI(wrangler dev)。API起点のworker E2Eと、画面フローのweb E2E(Playwright chromium・CIは別ジョブで実行)の2系統+staging手動/自動。#17のUI 2択(参加する/今回は見送る)はweb E2E(apps/web/e2e/latch-flow.spec.ts)で証明する。チャットの画面(F6b)はweb E2E(apps/web/e2e/chat-flow.spec.ts)で確かめる(§4)。#16の画面部分はweb E2E(apps/web/e2e/notices-flow.spec.ts)で証明する(F7c・§4)。#32の自動の部分はweb E2E(apps/web/e2e/pwa-flow.spec.ts)で証明する(F8a・§4) |
| Offline精度 | Parser/Jevのゲート | CI・ゴールドセット(09 §4) |

**E2Eマトリクス。** 02 §4の#1〜#35のうち、#1〜#6・#8〜#21・#23〜#31をPlaywrightで自動化し(#22は単体・統合試験で証明・§3)、#32(PWA実機)・#34(実機ブラウザ含む)は手動確認と自動の併用、#33(負荷)は§5、#35(計測)は集計クエリで証明する。#7・#35の観測系は06 §7の計測記録による。iOS Safariはホーム画面追加後でないとWeb Pushを受信できないため、「未インストール状態ではアプリ内通知のみで成立する」確認ケースを#16に含める。進捗は02の対応表に紐づけて管理する。

**F3(パイプライン前段)のゲート試験の分担(F3実装確定)。** worker E2Eが#6の機会Intentの期限遷移・#7〜#10・#11(つながり×機会の非候補化)・#13の自己ペアと地理の重なりを証明する(dev専用観測API(05 §3.3)とGET /__scheduledを使用・§3)。一方で、#6のつながりIntentの期限遷移(7日級)・#11のLayer 1除外記録の直接観測(payloadのl1_exclusions=form_mismatch)・#13のblocks・提案履歴・飲酒年齢の除外は**統合試験(vitest-pool-workers)が証明する**(注入clockが要る遷移とpayloadの直接検証は統合試験が適するため)。

**F5(つながりの性質)のゲート試験(F5実装確定)。** #21はworker E2E(latches.spec.ts: つながりIntentの成立後に第三者が意味的に近いつながりIntentを登録し、元のIntentがactiveのまま新しい提案が記録される)で証明する。#22は注入clockの統合試験(tests/latches-complete.test.ts: 90日の1ミリ秒前はmatchedのまま・ちょうどでcompleted・状態遷移の記録・機会LATCHの対象時刻から3時間の境界・matched以外の非対象・走査上限500件・冪等・並行したleaveとlast_message_atの更新との競合)で証明する(§3・E2Eの対象外)。worker E2Eは37本となる

**F6a(チャットのバックエンド)のゲート試験(F6a実装確定)。** #25はworker E2E(chat.spec.ts)で証明する。2人のつながりLATCHを成立させたあと、Node 22のグローバルWebSocketで双方が接続し、WebSocketの送信が相手に届き送信者には自分のclient_id付きで届くこと・RESTの送信がWebSocketで相手に届くこと・履歴APIで2件がID昇順で保存されていること(双方向の送受信記録)・既読と一覧のunread_count / last_messageを確かめる。同じspecの2本目で、使用済みチケットの再使用が401になること、一方が表示から消す(DELETE /v1/latches/{id})と双方の接続に`closed`が届き(1対1は全体cancelled)、相手の送信は400 read_only・相手の履歴は読める・消した本人からは404となることを確かめる(05 §3.3・§3.4)。条件付き保存・頁送り・既読の前進(tests/chat-messages.test.ts)、状態ごとの可否・チケットの期限と用途と1回限り・LatchDTOの要約(tests/chat-api.test.ts)、DOの配信と`closed`と自動応答(tests/chat-do.test.ts)、表示削除の状態ごとの挙動(tests/latches-delete.test.ts)、マイグレーション0005と戻す手順(tests/migration.test.ts)は統合試験が証明する。worker E2Eは39本となる。**F6b(チャットの画面)のweb E2E(F6b実装確定)。** 02の番号は持たず、web E2E(apps/web/e2e/chat-flow.spec.ts)の2本で確かめる。1本目は2人の送受信と一覧の未読(一方の送信が相手の画面に届き、相手の一覧に未読が出て、チャットを開くと既読になる)、2本目は参加の取り消し(確認の段を経る)で双方が読み取り専用の「このつながりは終了しました」になることと、相手が終了の区分で表示から消すと一覧から消えることである。web E2Eは12本となる

**F7a(安全のAPI)のゲート試験(F7a実装確定)。** #26〜#30はworker E2E(safety.spec.ts)の5本で証明する。#26は2人を成立させた後に一方がブロックし(201)、1対1のLATCHが相手の側でもcancelledになること、ブロック前なら一致する新しいつながりIntentを双方に置くと、それぞれの評価のmatch_events.payloadで`l1_exclusions.blocked`が1以上・提案0件となり、2人の間に新しいLATCHが作られないことを確かめる(Layer 1はブロックを提案履歴より先に判定するため、成立済みで提案履歴でも恒久排除される組でもブロックによる除外として区別して観測できる・06 §3)。#27は提示済みの提案の通報(target=proposal)と成立後の発言の通報(target=message)がともに201で、dev専用API(GET /v1/dev/reports・05 §3.3)に対象・理由・LATCH・被通報者を持つ2件が記録されていることを確かめる。#28は本文に固有の文と否定条件を持つIntentの提案を相手の側で取得し(一覧・単一取得)、応答の文字列にその文と否定条件の語が含まれず、proposal・membersのキーが無いことを確かめる。#29は地理を添付した機会Intentどうしの成立後、双方の単一取得の応答でproposal.region_nameが地域名の文字列であり、応答全体に緯度経度・半径・距離のキー(lat・lng・radius_m・distance)が無いことを確かめる。ローカルD1の地名データ(geofeatures)は空で、CIも空のD1から始まるため、#29はspecの中で`wrangler d1 execute --local`により地名を1件(固定id・INSERT OR IGNOREで冪等)入れてから試験する。#30は19歳(誕生日当日)のユーザーが飲酒を含む機会Intentをactiveで作ると422 ALCOHOL_RESTRICTED、20歳(誕生日当日)のユーザーは作成できることを確かめる(§2のbirth_date可変ユーザー)。ブロックの対象の判定・冪等・進行中の提案の取り消しと提案履歴の不消費・1対1の全体cancelled・グループで本人だけが抜けることと下限割れ・completedの不変・一覧と解除(tests/safety-block.test.ts)、評価の開始後にブロックされた組で提案が作られないこと(tests/latches-propose.test.ts)、通報の対象者・状態ごとの404・理由コード・noteの保存・通報者内の統合・被通報者の応答に現れないこと(tests/safety-report.test.ts)、飲酒年齢のactive作成とdraftからのactive化・Active Intent上限より先の判定・年齢を確かめられないときの拒否・draft保存は通ること(tests/intents-create-api.test.ts・tests/intents-crud-api.test.ts)、マイグレーション0006と戻す手順(tests/migration.test.ts)は統合試験が証明する。worker E2Eは44本となる(web E2Eは12本のまま)

**F7b(通知のAPI)のゲート試験(F7b実装確定)。** #16のAPI部分はworker E2E(notifications.spec.ts)の3本で証明する。到達記録はdev専用API(GET /v1/dev/notifications・05 §3.3)の通知行とpush_stateで観測し、Web Pushの送り手はstub(§2)とする。1本目はnotification_level=proposals_onlyのIntent2件で提案が生まれると、双方にproposalのアプリ内通知の行が作られ、購読を登録した側はpush_state=sent、購読の無い側はno_subscriptionで記録され、購読の無い側も一覧(GET /v1/notifications)で提案を受け取れることを確かめる。後者がiOS未インストール状態(Web Pushを受信できない)で「アプリ内通知のみで成立する」確認ケース(§4のE2Eマトリクス)にあたる。2本目は購読を登録した側のIntentをmutedにしたとき、その人にもアプリ内通知の行は作られpush_state=mutedで送られないこと、提案がproposedで、その人が参加する(yes)と回答できることを確かめる(01冒頭の決定記録(2026-10-21・通知のAPI))。3本目は双方の参加で成立すると、matchedの行が購読のある側でsent・無い側でno_subscriptionで記録され、POST /v1/notifications/readで未読数が0になることを確かめる。RFC 8291の暗号化の試験ベクトル・VAPID署名の検証・本文とTTL・送信先ホストの許可リスト(src/push/*.test.ts)、送信の判断(muted・購読なし・成功でlast_success_at・410で購読failed・一時失敗でpendingのまま・順番の取り合いで1回だけ送る。tests/push-dispatch.test.ts)、入口とキューのバッチの後の送出と失敗の非波及(tests/push-flush.test.ts)、Cronの回収(30秒後の再送・60秒の再試行間隔・10分でfailed)とintent_expiredの作成と再実行での二重防止(tests/pipeline-cron.test.ts)、一覧の種別ごとの欄・抜けた/表示から消したLATCHの除外・頁送り・未読数・既読(tests/notifications-api.test.ts)、購読の検証・10件の上限・付け替え・解除の冪等(tests/push-api.test.ts)、Intent削除でintent_expiredの行が消えること(tests/intents-crud-api.test.ts)、マイグレーション0007と戻す手順(tests/migration.test.ts)、起動ガード(src/env.test.ts)は単体・統合試験が証明する。#16の画面部分と実機ブラウザでのWeb Pushの受信確認はF7c・F8(#32)で行う。worker E2Eは47本となる(web E2Eは12本のまま)

**F7c(安全と通知の画面)のゲート試験(F7c実装確定)。** #16の画面部分はweb E2E(apps/web/e2e/notices-flow.spec.ts)の1本目で証明する。2人が一致する意思を預けて提案が生まれると、ホームのベルに未読の点が出て、アプリ内通知の一覧(画面名「お知らせ」)に提案の行が届き、そこから提案を開いて[参加する]で回答できること、相手も参加して成立すると一覧に「つながりました」の行が届き、押すとチャットが開き、未読が0になって点が消えることを確かめる(相手の投入と回答はAPIで行う)。同じspecの2本目は提案画面の「…」からの通報とチャットの相手の発言からの通報が、dev専用API(GET /v1/dev/reports・05 §3.3)にそれぞれtarget=proposal・messageで記録されることを、3本目は1対1のチャットでブロックすると、ブロックした側の「ブロックしたユーザー」に相手が出て、相手の側は「このつながりは終了しました」の読み取り専用になることを確かめる。プッシュの購読はE2Eに含めない(Chromiumの`pushManager.subscribe`は実際のプッシュサービスへ通信し、CIの環境で結果が揺れるため)。購読の手順(許可・拒否・非対応・登録失敗・解除の順)はpushManagerを差し替えた単体試験(src/push/subscription.test.ts)で、Service Workerの通知の題名・本文・タップの遷移先(src/push/push-sw.test.ts)、各画面の文言・入口・API呼び出し・失敗表示(src/screens/notices・me・safety・legal・chat等の*.test.tsx)、ログアウトでの購読の解除とトークンの破棄(src/auth/session.test.ts)、422 ALCOHOL_RESTRICTEDの表示とお酒のオフでの解除(src/screens/Confirm.test.tsx)は単体・結合試験(vitest)が証明する。実機ブラウザでのWeb Pushの購読と受信はF8(#32)、#31の法務確認はオーナー(人間領域)が行う。web E2Eは15本となる(worker E2Eは47本のまま)

**F8a(PWAと画面の仕上げ)のゲート試験(F8a実装確定)。** #32のうち自動で確かめられる部分は、web E2E(apps/web/e2e/pwa-flow.spec.ts)の3本で証明する。1本目は意思の詳細画面で、一時停止(一時停止中は「提案をお知らせする」のスイッチが押せない)→再開・スイッチを切るとnotification_level=mutedになること・内容を直す画面で主題を直し、確認(「直すと、届いている提案は取り消されます。」)を経て詳細へ戻ると「直しました。」と新しい主題が出ること・取り下げの確認を経てホームから行が消えることを、APIの単一取得(GET /v1/intents/{id})と合わせて確かめる。2本目はService Workerの制御下に置いた後にオフラインにして読み込み直すと、ホームに帯「オフラインです。最後に確かめた内容を表示しています。」と保存済みの意思の一覧が出ること、読み解きは入力欄へ戻って「オフラインのため、いまは読み解けません。」の案内が出ること、オンラインに戻すと帯が消えることを確かめる。3本目はホーム画面追加の要件(マニフェストのname・display=standalone・start_url・PNGのアイコンの配信と種別・PNGが正方形であること・マニフェストにSVGが無いこと・apple-touch-iconのPNG)を確かめる(マニフェストからSVGを外したのは不具合の修正工程(第2回)・issue #6・04 §4)。端末への保存の範囲(4つのキーの完全一致・成功した結果だけ)・利用者IDの紐づけ・7日・消去(src/offline/persister.test.ts)、接続の回復での復元と再取得(src/offline/reconnect.test.ts・online.test.ts)、オフラインの案内の判定と帯(src/offline/errors.test.ts・OfflineBanner.test.tsx)、オフライン中のセッションと利用者の切り替え(src/auth/session.test.ts・guard.test.tsx・src/api/client.test.ts)、Service Workerの除外とマニフェスト(src/pwa-config.test.ts)、意思の詳細・内容を直す画面・共通の修正部品の状態ごとの操作と文言とversion_conflictの読み直し(src/screens/intent/*.test.tsx・src/intents/FactsEditor.test.tsx・queries.test.tsx)、ホームとつながり一覧の保存済みの表示と読み込み失敗(src/screens/Home.test.tsx・src/screens/chat/Connections.test.tsx)は単体・結合試験(vitest)が証明する。実機での「ホーム画面に追加・Web Pushの受信・最小限のオフライン表示」の確認はオーナー(人間領域)が行い、手順と記録は`docs/reports/f8a-pwa-device-check.md`(cloudflaredの一時トンネル・`LATCH_PUSH_MODE=real`・テスト用VAPID鍵)に置く。記録が揃うまで#32は「実機確認待ち」とする。現行Lighthouseの監査の記録は`docs/reports/f8a-lighthouse.md`に置く。web E2Eは18本となる(worker E2Eは47本のまま)

## 5. 負荷試験(02 #33・公開前)

- 目標: 01 §20のp95(Intent保存0.5秒・Parser 3秒・Candidate Retrieval 1秒・判定10秒・通知5秒)。判定10秒の合否は、保存の時点で組の相手の意思がVectorizeに反映済みの場合に限って付け、ほぼ同時に預けた組の値は反映の時間と並べた参考値とする(01冒頭の決定記録(初期判定の目標))
- シナリオ: (a)Intent作成バースト(複数ユーザー合計100件/分)、(b)新規Intent→評価→提案化の縦断、(c)チャット同時接続100(WebSocket)、(d)通知同時送信バースト。負荷試験では試験用ユーザーに対するレート制限(1ユーザー60req/分)をstaging設定で緩和する(F8bの時点ではレート制限が未実装(後続フェーズで計上)のため該当しない。報告書にその旨を記す)
- ツール: **k6に確定**(D-E-01解消)。WebSocketはk6の`k6/websockets`を使い、k6 v1.8.1で読み込めることとstagingのチャットへ接続して送受信できることを確かめた(実施時の再確認は済み)。実施はstaging・結果はdocs/reportsに残す

**実施方法(F8b実装確定)。** スクリプトは`tools/load/`(pnpmのワークスペースの一員・パッケージ名load。k6本体はpnpmの依存に入れない)に置き、手元のPCからstagingへ向けて実行する。k6はURLを伏せる包み(`tools/load/run.mjs`)を通して動かす。試験用の利用者はテスト用サインインで作り(subjectは`load-<実行の印>-<連番>`・実行の印は実行ごとに時刻から作る)、各シナリオの前後に`tools/load/cleanup.mjs`で`load-`の利用者の意思を削除API(ベクトルを先に消す・05 §3.3)で消す。Parser/Jevはstub・Embeddingはrealで測る(01冒頭の決定記録(stagingと負荷試験)の1)。規模は次のとおり。(a)読み解き→保存(status=activeで直接保存)を合計100件/分で5分間(100人×5件・Active Intent上限5件に収まる)。(b)2人組×30組の機会Intentを組ごとに2秒間隔で投入し、提案のアプリ内通知が届くまで待つ。(b)の組の中は2段とし、片方が先に保存して、その意思の反映確認(vector_reflection)がprocessedになる(Vectorizeへ反映済み)のをdev専用の観測API(GET /v1/dev/match-events・05 §3.3)で確かめてから、もう片方が保存する(待ちの上限は提案待ちと同じ`PROPOSAL_WAIT_SEC`で、超えたらそのまま保存する。(b)の実行の上限はこの待ちの分だけ延びる・不具合の修正工程(第2回)で確定)。組kの意思は基準時刻(実行時刻+24時間を1時間単位に切り上げ)+k×3時間から2時間とし、相手の組とはLayer 1の時間の重なりの条件(time_no_overlap)で外れる(stubのJevは0.9を返すため、ずらさないと組どうしが混ざって提案される)。(d)は(b)と同じスクリプトで全組を同時に投入する(60件前後の提案の通知が同時に発生)。(c)は事前に通常のAPIで1対1を50組成立させ、100人が同時にWebSocketで接続し5分間、5秒ごとに送り合う。(c)の組の間隔は(b)の3時間ではなく2時間とする(50組×3時間+24時間では最後の組が機会Intentの開始の上限(7日以内)を超えるため。幅2時間の隣の組とは重なりが0分で、下限15分を下回るため組どうしは混ざらない)。k6のthresholdsに01 §20の目標値を置き、外れたときはk6の終了コードで分かるようにする(合否の正本は報告書)。測り方は、応答で見える時間(Intent保存・Parser・チャットの到着)はk6が測り、内部の時間はstagingのD1に残る記録から試験の後に`tools/load/report.mjs`(読み取りの問い合わせのみ)で集計する(オーナー合意 2026-10-22)。Candidate Retrievalはmatch_events.payloadのretrieval_ms(06 §7)、初期判定は有効化のイベント行の作成時刻→その意思の利用者への提案の通知のpush_attempted_at(01 §20の「active化の保存コミットから通知送信記録まで」・起点は保存のコミットよりわずかに後になる)、通知は提案の通知行のcreated_at→push_attempted_at(試験の利用者は購読を持たないためno_subscriptionで確定し、暗号化と送信の時間は含まない)とする。チャット((c))の値は01 §20に目標値が無いため参考値とする。本物のVectorizeの反映時間は、反映確認のイベント行のpayloadのreflect_ms(06 §7)から参考の行として集計する(01 §20に目標値が無いため合否は付けない。同時に預けた組の提案は反映確認の評価し直しで作られることがあり、この時間が初期判定に表れるため報告書に分布を添える・不具合の修正工程で確定)。**初期判定の振り分け(不具合の修正工程(第2回)で確定)。** 集計は、組ごとに相手の意思の反映確認がprocessedになった時刻と自分の有効化のイベント行の作成時刻を比べ、相手の反映が自分の有効化より前(同時刻は含めない)なら「相手が先に反映済み」として目標の行(合否あり)に、それ以外((d)の組・(b)の先に保存した側・相手が未反映のとき)は「同時」として参考の行(合否なし)に出す。(b)の後から保存した側が「相手が先に反映済み」の標本になる。反映の参考の行の欠けは、内訳(skipped・failed・その他)を添える。手順は`docs/runbooks/staging.md` §7に置く

**状態(2026-10-22)。** 各シナリオの小さな試し実行はstagingで成功した(試しの値は#33の証拠に使わない)。試し実行で、本物のVectorizeでは新しい意思のキュー経由の評価が登録の反映の確認待ち(5秒)を超えて毎回失敗し毎分Cronの取りこぼし回収でしか評価されないこと(issue #7)・提案のあるactiveの意思を直すと再評価がINTERNALで失敗すること(issue #8)・Cronが直接評価した提案のWeb Pushが30秒ごとの回収まで送られないこと(issue #9)が分かった。このままでは初期判定と通知の値が不具合の遅れを測るだけになるため、全規模の計測と報告書(`docs/reports/f8b-load-test.md`)は不具合の修正工程の後に行う(01冒頭の決定記録(stagingと負荷試験)の2)。計測の後も、#33はLLM real接続の工程で同じシナリオと集計を流し直すまで「stubでの計測済み・測り直し待ち」とする。不具合の修正工程で、issue #7(第1段は反映を待たず、反映確認で1回評価し直す・06 §2)・#8(Analytics Engineのdata pointの数値が上限20個を超えていた・06 §7)・#9(Cronが評価で作った通知をその実行の中で送る・06 §4)のコードの修正を終えた。その後、stagingで#13(Cronの修復が反映待ちの意思を埋め込み直す)も直し、2026-10-22に全規模の計測を行った(記録は`docs/reports/f8b-load-test.md`・実行の印202610221144)。Intent保存(p95 0.43秒)・Parser(stub・p95 0.27秒)・Layer 2 Candidate Retrieval(p95 0.01〜0.05秒)は目標内だった。初期判定(stub・p95 211.49秒/272.20秒)と通知(p95 24.97秒/6.16秒)は目標を外れた(issue #18・#19)。同時に預けた組の提案は、Vectorizeの反映(p95 187.54秒/210.87秒)の後の評価し直しで作られるためである。チャットは参考値で、到着のp95 1.19秒・接続の失敗0/82だった。計測の中で、毎分Cronのベクトルの修復がVectorizeのgetByIdsの上限(20件)を超えて止まる不具合(issue #15)・削除APIの遅さ(issue #16)・第1段の失敗(issue #17)・削除後に残ったベクトル(issue #20)を見つけた。#33は「stubでの計測済み・LLM real接続後の測り直し待ち」

**状態(2026-10-23)。** 計測で見つけた不具合と目標を外れた項目(issue #15〜#26)を、不具合の修正工程(第2回)でコードの上で直した(12 §2)。初期判定の目標の定義を改め(01冒頭の決定記録(初期判定の目標))、シナリオ(b)と集計を上記の振り分けに合わせた。stagingでの原因の確認と、手順書7章どおりの負荷試験の流し直し(報告書へ「測り直し」の節を足す)は未了。#33は「stubでの計測済み・LLM real接続後の測り直し待ち」のまま

## 6. 縮退試験(障害時の挙動・公開前)

| 注入 | 期待 |
|---|---|
| Jev APIの全断(timeout固定) | 提案化停止・候補は保留・circuit breaker開放・Parser/Embeddingは継続 |
| Embedding APIの全断 | キューのやり直し(10秒・30秒・60秒)を使い切るとDLQでdeadになり、Intent未登録のまま滞留→復旧後バックフィルで回収(06 §5) |
| Queues消費の失敗 | 再試行ののちDLQへ・prodへの影響なし |
| DO再起動(チャット) | 履歴はD1から復元・接続再確立 |
| D1長時間障害 | API全断(エラー表示)・復旧後にキューが消化 |

## 7. 未決事項(本書ローカル)

| ID | 未決事項 | 暫定案 |
|---|---|---|
| D-E-01 | (解消)負荷ツールはk6に確定 | §5のとおり。WebSocket対応は実施時に再確認する予定だったが、F8bでk6 v1.8.1の`k6/websockets`がstagingのチャットへ接続して送受信できることを確かめた(2026-10-22) |
