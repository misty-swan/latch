# F7a 安全のAPI 設計書

- 作成日: 2026-10-21
- 対象: docs/12 §2 のF7「安全と通知」のうちF7a(安全のAPI: ブロック・通報・飲酒年齢・開示制御の証明)。通知のAPIはF7b、画面と規約ページはF7cで別に設計する
- 正本: docs/01 §9・§10・§22 / docs/02 §4(#26〜#30) / docs/05 §2.2・§3.1〜§3.3 / docs/06 §4 / docs/08 §8 / docs/10 §2
- 前段: docs/superpowers/specs/2026-10-20-f4a-proposal-to-match-design.md・2026-10-20-f4b-group-latch-design.md・2026-10-21-f6a-chat-backend-design.md(本書はその上に載る)
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提

### 0.1 目的とゲート

- #26「ブロックユーザーを候補から除外できる」・#27「通報できる」・#28「Intent全文が相手に直接公開されない」・#29「正確な位置情報を相手に公開しない」・#30「20歳未満は飲酒機会Intentを作成できない」をworker E2E(`e2e/safety.spec.ts`)で証明する(§5.1)
- F7の内容(12 §2): ブロック/通報・年齢検証・Web Push・アプリ内通知・規約ページ。F7aはこのうち安全のAPIを作り、F7b(通知のAPI・#16のAPI部分)・F7c(画面・規約ページ・#16の画面部分と#31)が続く

### 0.2 現状の確認(着手時点のコード)

1. blocks(PK(blocker_user_id, blocked_user_id)・created_at)とreports(id / reporter / reportee / reason / latch_id / note / status / created_at)はF0の初回マイグレーションで作成済み。書き込みのAPIは無い
2. Layer 1(`src/pipeline/layer1.ts`)はblocksの両方向と飲酒年齢(組のいずれかがalcohol_involved=trueなら判定時点で両者満20歳)を判定済み。グループのPool内のHard判定(F4b)も同じ判定を持つ
3. 提案化(`proposeSet`・`src/latches/propose.ts`)は直前の再検証(version照合)と提案履歴の確保を1バッチで行うが、blocksは照合しない(評価の開始からバッチまでの間にブロックされると提案が作られ得る)
4. 離脱(`leave`・`src/latches/respond.ts`)と表示削除(`hideLatch`・`src/latches/hide.ts`)はF6aで完成。Intent削除・PATCHによる進行中の提案の取り消し(`src/routes/intents.ts`)は提案履歴を消費しない取り消しの流れを持つ
5. `ALCOHOL_RESTRICTED`(422)はエラーコードの定義(`packages/shared/src/constants.ts`)だけがあり、Intentの作成・有効化では判定していない
6. LatchDTOは成立前にproposal・membersを出さず、成立後のproposalは地域名(region_name)だけを持つ(F4a・F4c)。#28・#29を直接確かめる試験は無い

### 0.3 オーナー裁定(2026-10-21・本書のブレインストーミング)

| # | 決定内容 | 根拠 |
|---|---|---|
| 1 | F7(安全と通知)をF7a(安全のAPI: ブロック・通報・飲酒年齢・#26〜#30)・F7b(通知のAPI: アプリ内通知の一覧と既読・Web Pushの購読と送信・#16のAPI部分)・F7c(画面: お知らせ・自分・設定・通報・ブロック・お酒と年齢・プッシュの許可・規約ページ・#16の画面部分と#31)に3分割し、各単位で設計→計画→実装を1周する。F7bはF7aの後、F7cはF7bの後に着手する | F4・F6と同じく、画面はAPIの上に載るため、APIを先に完成させる方が設計と検証の単位を小さく保てる |
| 2 | 1対1のつながり(matched)でのブロックは、ブロックした本人の参加の取り消し(leave)と同じ処理でLATCH全体をcancelledにする。双方とも読み取り専用の履歴が残り、ブロックされた側には取り消しと区別できない「このつながりは終了しました」だけが見える。08 §8の「ブロックされた側は当該LATCHのメッセージを取得できない(NOT_FOUND)」は撤回する | 01 §10「相手の参加取り消し・ブロック・退会のいずれであっても、残された側には理由を開示せず読み取り専用の履歴のみを表示する」に揃える。NOT_FOUNDにすると一覧から消えることで取り消しとブロックの違いが相手に分かる |
| 3 | グループLATCH(matched)でメンバーの1人をブロックしたときは、ブロックした本人がleaveと同じ処理でそのLATCHから抜ける(残りが必要人数の下限を割ればLATCH全体がcancelled)。ブロックされた人を外すことはしない | ブロックされた人にも他のメンバーにも「1人が抜けた」としか分からない。1対1の扱い(裁定2)と同じく、ブロックした本人が自分の参加を終える考え方で揃える |
| 4 | 提案段階(成立前)の通報(「この提案を通報する」)は、自分以外の全参加者を通報対象者として1人1行で記録する。通報しても提案は閉じない(回答は別に行う)。対象者には通知しない | 成立前は相手が見えないため本人に選ばせられない。対象者ごとの行にしておくと、同一対象への重複通報の統合(08 §8)を運用で行える |

### 0.4 F7aで行わないこと

画面(F7c)・アプリ内通知の一覧/既読とWeb Push(F7b)・規約ページと法務確認(F7c・#31)・通報の対応操作(reports.statusの更新は運用の手作業。管理画面は作らない)・通報者をまたぐ重複通報の統合(運用)・open通報の滞留の警報(09 §6・F10のアラート設定)・レート制限(後続の工程)・退会(DELETE /v1/users/me の工程)。

## 1. 構成

| 配置 | 責務 |
|---|---|
| `src/safety/block.ts`(新設) | ブロック可能な相手の判定・ブロックの即時効果(blocks行の書き込み→効果の順次適用)・解除・一覧の照会 |
| `src/safety/report.ts`(新設) | 通報の検証(提案段階/成立後)・対象者の決定・同一通報の統合 |
| `src/routes/safety.ts`(新設) | `POST/DELETE /v1/users/{user_id}/block`・`GET /v1/blocks`・`POST /v1/reports` |
| `src/latches/propose.ts` | `proposeSet`のバッチへblocksの不在条件を加える(§2.4) |
| `src/intents/`・`src/routes/intents.ts` | 飲酒年齢の判定を有効化の3経路へ加える(§4) |
| `src/routes/dev.ts` | dev専用の観測API `GET /v1/dev/reports`(§5.1。prodは404) |
| `packages/shared` | ブロック・通報の入出力のzodスキーマと定数(target・reason) |

ブロックの即時効果はリクエストの中で反映する(キューで後から処理しない。後から処理すると、ブロックの直後に提案が届く隙間ができるため)。既存の離脱(leave)・提案の取り消し(closeLatch)は条件付きの書き込みを順に行う作りのため、ブロックも1回のバッチにまとめず、blocks行の書き込みを先に行い、その後で各効果を順に適用する(§2.2)。各効果は再実行しても結果が変わらない

## 2. ブロック(#26)

### 2.1 API

```
POST   /v1/users/{user_id}/block    # 201(新規)/ 200(既にブロック済み・効果は再適用・冪等)。本文なし
DELETE /v1/users/{user_id}/block    # 204(ブロックしていなくても204・冪等)
GET    /v1/blocks                   # 200 {blocks: [{user_id, display_name, has_icon, created_at}]}(新しい順)
```

- 対象は「自分と同じLATCHに成立後の参加者として居たことがある相手」(latch_membersで同じLATCHに属し、そのLATCHがmatched・completed・matched経由のcancelledのいずれか)に限る。該当しない相手・存在しない相手・退会済み(deleted)の相手は一律404 NOT_FOUND(05 §3.1。成立前は相手のIDを開示しない設計であり、任意IDでの存在の探索を塞ぐ)。自分自身は400 VALIDATION_FAILED(理由コードself_block)
- DELETEは対象の判定を行わず、自分のblocks行を消すだけ(行が無ければ何もしない)
- GETの表示名は退会済みの相手でも「つながっていた相手」(prototype README §7 #2の扱い)とし、has_icon=false とする
- 応答とログにブロックの相手を記録しない(ログは許可リストの項目のみ・08 §6)

### 2.2 ブロックの即時効果

POSTはまずblocks行を書き込み(既にあれば何もしない)、その後で次を順に適用する。既にブロック済みの再送でも同じ適用を行う(途中で失敗した前回の効果を再送で完了させるため。各効果は対象が既に閉じていれば何もしない)。blocks行が先に書かれるため、適用中に別の評価が作ろうとした提案は§2.4の照合で作られない。

1. **進行中の提案の取り消し**: 状態がcandidate・proposed・partial_acceptで、参加者にこの2人を含むLATCHをcancelledで閉じる。グループの提案も提案全体を閉じる。取り消しはシステム都合なので提案履歴を消費しない(新規確保の行は削除・再提案で確保した既存行はexpiredへ戻す・05 §2.2のIntent削除と同じ流れ)。提示済みなら参加者へclosedのアプリ内通知を作り、参加者の保留(他のLATCHの機会の排他)を解放する。以後の再提案はblocksそのものがLayer 1で恒久に除外する
2. **続いているつながりからの離脱**: 2人がともに参加者のmatchedのLATCHごとに、ブロックした本人についてleaveと同じ処理を行う(裁定2・3)。1対1は全体cancelled(本人もleft_atを持たない読み取り専用の参加者として残る・F6a裁定3)、グループは本人だけがleft_atを持って抜け、下限割れなら全体cancelled
3. completed・cancelledのLATCHは変えない(どちらの側も読み取り専用の履歴のまま)

バッチの後、ルートは2.の各LATCHについて既存のleaveと同じく`notifyClosed`でチャット接続中の人へ`closed`を知らせる(1対1と下限割れは全員・グループで本人だけが抜けたら本人)。ブロックされた側への通知は作らない(closed通知は1.の提示済み提案の不成立としてだけ、通常の不成立と区別せずに届く)。

### 2.3 解除

blocks行を消す。候補化は再開するが、提案履歴による同一ペアの恒久排除(成立・no)と、2.2で終わったLATCHは戻さない(08 §8)。

### 2.4 提案直前の照合

`proposeSet`のバッチで後続の文の条件に使う確保条件(`secured`)へ「参加者のどの2人の間にもblocks行が無いこと」を加え、満たさなければLATCHを作らず既存の巻き戻し(compensations)で確保を戻す。D1の書き込みは直列に実行されるため、blocks行の書き込みが先なら提案は作られず、提案のバッチが先なら2.2の1.が取り消す。どちらの順でもブロック後に提示が残らない。

### 2.5 他の操作の再検証

05 §2.3の「権限が関わる操作(チャット送信・回答)はblocksを再検証する」は、2.2により該当するLATCHがcancelled(読み取り専用・回答不可)になることで満たす。送信・回答の各処理へblocksの照会は加えない。

## 3. 通報(#27)

### 3.1 API

```
POST /v1/reports
  {latch_id, target: "proposal"|"profile"|"icon"|"message", reason: "spam"|"harassment"|"inappropriate"|"other",
   note?: string(0..500字), reportee_user_id?: string, message_id?: string}
→ 201 {received: true}
```

- **target=proposal(提案段階)**: latch_idは自分が参加者で、状態がproposed・partial_accept(提示済み・未成立)のLATCHに限る。reportee_user_id・message_idは指定不可(400)。自分以外の全参加者をreporteeとして1人1行で記録する(裁定4)。提案は閉じない
- **target=profile・icon・message(成立後)**: latch_idは自分が成立後の参加者だった(left_at・hidden_atは問わない。ブロックや参加取り消しで抜けた後も通報できる。実装後の最終レビューを受けた2026-10-21のオーナー裁定・01冒頭の決定記録(安全のAPI)の4)LATCHで、状態がmatched・completed・matched経由のcancelledのLATCHに限る。reportee_user_idは必須でそのLATCHのメンバー(自分以外)。target=messageはmessage_idが必須で、そのLATCHのreportee_user_idの発言であること
- 上記に合わないLATCH・参加していないLATCH・存在しないLATCHは一律404。形の誤りは400 VALIDATION_FAILED(理由コードを付ける)
- noteは前後の空白を除いて0〜500字。ログに出さない
- 応答は通報の件数・対象者を返さない(提案段階で対象者の人数を推測させない)

### 3.2 テーブル(マイグレーション0006)

reportsへ `target`(proposal|profile|icon|message・NOT NULL)と `message_id`(null可)を追加し、INDEX(reporter, latch_id, reportee, target, status)を置く。既存行は無い(書き込みのAPIが無かった)ため既定値の埋め戻しは要らない。戻すマイグレーション(`migrations_rollback/`)を対で作る(12 §4)。

### 3.3 同一通報の統合

同じreporter・latch_id・reportee・target(messageはmessage_idも)でstatus=openの行があれば、新しい行を作らずreason・note・created_atを今回の値で上書きする(08 §8の「同一対象への重複通報は統合する」のうち通報者内の部分。通報者をまたぐ統合は運用で行う)。

### 3.4 被通報者への非開示

通報の存在・内容は被通報者のどのAPI応答・通知にも現れない(08 §8)。通報は提案・LATCHの状態を変えない。

## 4. 飲酒年齢(#30)

- 判定: 機会Intent(form=occasion)で alcohol_involved=true のとき、判定時点で本人が満20歳未満なら422 ALCOHOL_RESTRICTED(年齢は`src/auth/age.ts`の`ageAtYears`・Clockの現在時刻で算出・08 §8)
- 判定する経路(有効化する時点の3つ): (a) POST /v1/intents で即activeとして作成 (b) PATCHでdraftからactiveへ (c) activeのPATCHで結果のalcohol_involvedがtrueになる変更(PATCHの可変フィールドの範囲で生じる場合)。draftの保存は従来どおり検証しない(01 §9)
- 実装時の注記: activeのPATCHの可変フィールド(05 §3.3)にalcohol_involvedは無く、formも変えられないため、(c)は生じない。判定は(a)・(b)の2経路で行う
- 実装時の注記(文書の裁量で確定した技術的事項): 飲酒を含む機会Intentで本人のusers行が無い・statusがactiveでないときは年齢を確かめられないため、同じ422 ALCOHOL_RESTRICTEDで拒否する(安全側に倒す。飲酒を含まないIntentの挙動は変えない・05 §3.3・08 §8)
- 判定順はform検証の後・Active Intent上限の前とする(form検証の400が先・同時に満たす場合は422 ALCOHOL_RESTRICTEDを返す)
- つながりIntentでのalcohol_involved=trueは従来どおり400(alcohol_not_allowed)
- 候補化時の判定(Layer 1・Pool内)は実装済み(§0.2の2)

## 5. 試験

### 5.1 worker E2E(`e2e/safety.spec.ts`・#26〜#30の証明)

1. **#26**: AとBを成立させ、AがBをブロックする。1対1のLATCHがcancelledになりBの側でもcancelledに見えることを確かめたうえで、ブロック前なら一致するIntentをAとBに新たに置き、それぞれの評価のmatch_events.payloadで`l1_exclusions.blocked`が1以上・提案0件であり、2人の間に新しいLATCHが作られない(dev観測APIのmatch-events・latches)。Layer 1はブロックを提案履歴より先に判定するため、成立済みで提案履歴でも恒久排除される組でも、ブロックによる除外として区別して観測できる(実装時に除外記録による証明へ改めた。候補が無いことだけでは提案履歴の恒久排除と区別できないため)
2. **#27**: 提案段階の通報(提示済みの提案でtarget=proposal)と、成立後の通報(target=message)の両方が201で完走し、`GET /v1/dev/reports`で対象・理由・LATCH・対象者が記録されている(同じ通報の再送が1件にまとまることは統合試験が確かめる・§5.2)
3. **#28**: 提示済みの提案を相手側で取得した応答(一覧・単一)にraw_text・NG条件(negative_constraints)・相手のIntentの中身が含まれない
4. **#29**: 地理を添付した機会Intentどうしの成立後、相手側の応答にregion_name(地域名)だけがあり、緯度経度・半径・距離の数値が含まれない
5. **#30**: 18〜19歳のテストユーザー(10 §2のbirth_date可変ユーザー)が飲酒を含む機会Intentを作成すると422 ALCOHOL_RESTRICTED。20歳のユーザーは作成できる

`GET /v1/dev/reports`はdev専用の観測API(既存のmatch-eventsと同じ扱い・prodは404の二重防御)で、自分が通報者の行だけを返す。

### 5.2 統合試験(vitest・miniflare)

- ブロック: 対象の判定(成立前だけの相手・存在しない・退会済み=404・自分=400)/冪等/進行中の提案(1対1・グループ・提示前のcandidate)の取り消しと提案履歴の不消費/1対1のmatchedの全体cancelled/グループで本人だけ抜ける・下限割れで全体cancelled/completedは不変/一覧/解除と候補化の再開・恒久排除は戻らない
- 提案直前の照合: 評価の開始後にブロックされた組で`proposeSet`が提案を作らない
- 通報: 提案段階で自分以外の全参加者の行/成立後のreportee・message_idの検証/状態・非参加の404/noteの字数/統合/被通報者の応答に現れない
- 飲酒年齢: 有効化の経路((a)・(b)。(c)は生じない・§4)・19歳と20歳の境界(誕生日の前日・当日)・draft保存は通る・年齢を確かめられないときの拒否

## 6. 文書の更新(docs/00 §3)

- 01: 冒頭の決定記録に裁定2〜4を追加(裁定1は12に置く)
- 05: §2.2 reportsのtarget・message_idと統合規定、§3.2のブロック・通報のAPIの確定値(GET /v1/blocks)、§3.3の応答形状と対象の判定、マイグレーション0006
- 08: §8のブロックされた側の扱い(NOT_FOUNDの撤回)とグループ時の扱い・提案段階の通報の対象者と通報者内の統合
- 10: §4へF7aのゲート試験の分担(§5)
- 12: §2へF7の3分割の決定記録(裁定1)とF7aの完了
- AGENTS.md: 現在の状態へF7aの完了
- 各文書の版数・変更点行・前提文書欄と00 §1の版数表を揃える
