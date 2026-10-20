# F4c 提案〜成立の画面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提案の到着から回答(参加する/今回は見送る)・回答待ち・見送り・不成立・成立までの画面を`prototype/`基準で実装し、02 §4 #17のUI 2択をブラウザE2Eで証明する。

**Architecture:** 提案1件のURL`/latches/:id`の親画面が`GET /v1/latches/{id}`の結果から表示(提案/回答待ち/つながりました/成立しませんでした)を選び、見送った直後だけ`/latches/:id/shelved`に分ける(設計書の案A)。worker側はLatchDTOへ`my_intent_id`・`matched_at`を足すだけで、新しいAPIは作らない。Homeは提案一覧を並行取得して到着カードと意思カードの状態表示に使う。

**Tech Stack:** React 19・react-router・TanStack Query・vitest+Testing Library(web)・`@cloudflare/vitest-pool-workers`(worker)・Playwright(web E2E)・zod(`@latch/shared`)

**Spec:** `docs/superpowers/specs/2026-10-20-f4c-proposal-screens-design.md`

## Global Constraints

- 応答・コメント・コミットメッセージ・文書は日本語。コミットは`git add <パス>`で対象を限定する(`git add -A`・`git commit -a`禁止)。コミットメッセージは`F4c: …`で始め、末尾に`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
- `apps/web/src/styles/latch.css`は編集しない。見た目は`prototype/app/app.js`の該当画面関数と`prototype/project/*.dc.html`のクラス名・文言をそのまま移植する
- 回答UIは2択のみ: yes=[参加する] / defer=[今回は見送る]。noは画面に置かない
- 一致度(`score`)はUIに表示しない。成立前は相手の情報を一切出さない
- 時刻はJST(UTC+9固定オフセット・Intlは使わない)で表示する(Home.tsxの`jstParts`と同方式)
- 用語: 「アプリ内通知」(「お知らせ」は画面名としてのみ)・「機会Intent」「つながりIntent」。旧実装への言及をしない
- 毎コミット前に`pnpm lint`・`pnpm typecheck`・該当パッケージの`vitest run`が緑であること
- 文書の変更は00 §3に従い、版数を上げ・冒頭に変更点行を追記し・前提文書欄と00 §1の版数表を揃える

## Review Focus

1. 回答期限を過ぎた提案画面で[参加する]を押す → 400 `deadline_passed`。画面は落ちず、取り直した状態を出し「この提案には、もう回答できません。」と知らせる(Task 6で試験)
2. [参加する]の連打 → POSTは1回だけ(送信中は両ボタンが`disabled`)(Task 4で試験)
3. グループで他の人がyes済み(`partial_accept`)・自分は未回答 → 回答待ちではなく提案を出す(Task 6の振り分け表の試験)
4. localStorageが例外を投げる環境 → 見送りの説明は毎回出て、画面は落ちない(Task 2で試験)
5. 自分がdeferしていない提案の`/latches/:id/shelved`を直接開く → `/latches/:id`へ置き換え遷移する(Task 6で試験)

---

## ファイル構成

| ファイル | 責務 |
|---|---|
| `packages/shared/src/schema.ts`(変更) | `latchDtoSchema`へ`my_intent_id`・`matched_at` |
| `apps/worker/src/latches/view.ts`・`apps/worker/src/routes/latches.ts`(変更) | 2欄の算出 |
| `apps/web/src/latches/queries.ts`(新規) | 取得・送信のhooks |
| `apps/web/src/latches/deferNote.ts`(新規) | 見送りの説明の表示済み記録 |
| `apps/web/src/latches/format.ts`(新規) | 回答期限・残り時間・成立時刻・金額の表示文字列 |
| `apps/web/src/screens/latch/art.tsx`(新規) | 半円・グループの円・棚の半円・縦書き・アバター |
| `apps/web/src/screens/latch/Proposal.tsx`・`Awaiting.tsx`・`Matched.tsx`・`NotEstablished.tsx`・`Shelved.tsx`(新規) | 各画面(表示と押下の通知のみ・取得はしない) |
| `apps/web/src/screens/latch/LatchScreen.tsx`・`ShelvedScreen.tsx`(新規) | URLごとの親(取得・振り分け・送信・失敗時の取り直し・定期取得) |
| `apps/web/src/routes/paths.ts`・`apps/web/src/router.tsx`(変更) | 2つのURL |
| `apps/web/src/screens/Home.tsx`(変更) | 到着カード・意思カードの状態・器の灯り |
| `apps/web/e2e/latch-flow.spec.ts`(新規)・`apps/web/e2e/helpers.ts`(変更) | ゲートE2E |

---

### Task 1: LatchDTOへmy_intent_id・matched_atを追加(worker・shared・05)

**Files:**
- Modify: `packages/shared/src/schema.ts`(`latchDtoSchema`)
- Modify: `apps/worker/src/latches/view.ts`(`LatchDtoOptions`・`toLatchDto`)
- Modify: `apps/worker/src/routes/latches.ts`(`loadLatchDto`)
- Modify: `docs/05-data-model-api.md`(§3.3のLatchDTOの段落・版数)と`docs/00-document-roadmap.md` §1の版数表、05を前提文書に挙げる文書の前提文書欄
- Test: `apps/worker/tests/latches-api.test.ts`

**Interfaces:**
- Produces: `LatchDTO.my_intent_id: string`(全状態で必須)・`LatchDTO.matched_at: string | null`(ISO 8601。latch_status_eventsのto_status=matchedの`created_at`・無ければnull)
- `LatchDtoOptions`へ`myIntentId: string`・`matchedAt: Date | null`を追加

- [ ] **Step 1: 失敗する試験を書く**(`describe("GET /v1/latches/:id の表示範囲")`へ追加)
  - `it("my_intent_idは自分側のIntent IDで、成立前のmatched_atはnull")`: 1対1の提案を作り、ユーザーAの応答`my_intent_id === intentA.id`・Bの応答`my_intent_id === intentB.id`・両者`matched_at === null`・成立前のキー集合が`["id","form","status","response_deadline","participants_count","my_response","score","my_intent_id","matched_at"]`と一致(proposal・membersを含まない・#20)
  - `it("双方yes後のmatched_atはmatchedの状態記録の時刻")`: yes→yes後の`matched_at`が、latch_status_eventsのto_status=matched行の`created_at.toISOString()`と一致
  - 既存のグループ試験のファイル(`rg -l "proposeSet|group" apps/worker/tests`で探す)に`it("グループでも各参加者のmy_intent_idは本人のIntent")`を1件追加
- [ ] **Step 2: 失敗を確認** — `pnpm --filter worker exec vitest run tests/latches-api.test.ts` → 新規itがFAIL(`my_intent_id`がundefined)
- [ ] **Step 3: 実装** — `latchDtoSchema`へ`my_intent_id: z.string()`・`matched_at: isoDateTimeSchema.nullable()`。`loadLatchDto`で`latch.intentIds`を`intents`表から`user_id = 自分`で引いて1件を得る(見つからないことは無い前提だが、見つからなければnull返却=404扱い)。matched経由判定で既に引いている`latchStatusEvents`の照会を`created_at`も選ぶ形に広げ、`status === "matched"`の場合も同じ照会で時刻を得る
- [ ] **Step 4: 通過を確認** — 同コマンドでPASS。続けて`pnpm --filter worker exec vitest run`全体と`pnpm typecheck`が緑(web側で`LatchDTO`を使う箇所はまだ無い)
- [ ] **Step 5: 05を改版** — §3.3のLatchDTOの形状に2欄を追記(`my_intent_id`=自分側の参加Intent・全状態で含む/`matched_at`=成立時刻・成立を経ていなければnull)。版数を上げ変更点行「F4c(提案〜成立の画面)に伴い…」を追加。00 §1の版数表と、05を前提文書に挙げる文書の前提文書欄の05の版数を揃える(`rg -n "05 データモデル・API仕様書 v" docs`で列挙)
- [ ] **Step 6: コミット** — `git add packages/shared/src/schema.ts apps/worker/src/latches/view.ts apps/worker/src/routes/latches.ts apps/worker/tests/ docs/` → `F4c: LatchDTOへ自分側のIntent IDと成立時刻を追加する`

---

### Task 2: 取得・送信のhooks、見送りの説明の記録、表示文字列

**Files:**
- Create: `apps/web/src/latches/queries.ts`・`apps/web/src/latches/deferNote.ts`・`apps/web/src/latches/format.ts`
- Test: `apps/web/src/latches/queries.test.ts`・`deferNote.test.ts`・`format.test.ts`

**Interfaces:**
- Consumes: `apiFetch<T>(path, init?)`(`src/api/client.ts`・`json`オプションでJSON送信・失敗は`ApiError{code, details}`)、Task 1の`LatchDTO`
- Produces(queries.ts):
  - `LATCHES_QUERY_KEY = ["latches"] as const`・`latchQueryKey(id: string) = ["latches", id] as const`・`PROPOSALS_QUERY_KEY = ["latches", "proposals"] as const`
  - `useProposalsQuery()` → `GET /latches?type=proposals&limit=50`の`{items: LatchDTO[]; next_cursor: string | null}`
  - `useLatchQuery(id: string, options?: { refetchInterval?: number | false })` → `GET /latches/{id}`(`refetchOnWindowFocus: true`)
  - `useRespondMutation(id)`(引数`"yes" | "defer"`)・`useRetractMutation(id)`・`useDeferReasonMutation(id)`(引数`DeferReason`)。いずれも成功時に応答`LatchDTO`を`latchQueryKey(id)`へ`setQueryData`し、`LATCHES_QUERY_KEY`配下と`INTENTS_QUERY_KEY`を`invalidateQueries`
- Produces(deferNote.ts): `shouldShowDeferNote(form: IntentForm): boolean`・`markDeferNoteSeen(form: IntentForm): void`。キーは`latch.deferNoteSeen.connection` / `latch.deferNoteSeen.occasion`(値`"1"`)
- Produces(format.ts、すべて`now: Date`を引数に取り時計を直接読まない):
  - `formatWhen(iso: string, now: Date): string` — `今日 H:MM`/`明日 H:MM`/`昨日 H:MM`/`M月D日 H:MM`(時は0埋めしない・分は2桁。prototype app.jsの`when`)
  - `formatLeft(iso: string, now: Date): string` — `期限を過ぎました`/`あとN日`(48時間以上・日は切り上げ)/`あとH時間M分`(Mが0なら`あとH時間`)/`あとM分`(最小1)(prototypeの`left`)
  - `formatMatchedAt(iso: string): string` — `M月D日 H:MM`
  - `formatYen(value: number): string` — `4,000円`(3桁区切り)

- [ ] **Step 1: 失敗する試験を書く**
  - format: `formatLeft`の境界(期限ちょうど→`期限を過ぎました`・47時間59分→`あと47時間59分`・48時間→`あと2日`・3時間0分→`あと3時間`・30秒→`あと1分`)、`formatWhen`がJSTの日付境界で`今日`/`明日`を切り替える(UTC 14:59と15:00をまたぐ例)
  - deferNote: 初回`true`→`markDeferNoteSeen("connection")`後は`connection`だけ`false`・`occasion`は`true`のまま/`localStorage.getItem`と`setItem`が例外を投げるとき`shouldShowDeferNote`は`true`・`markDeferNoteSeen`は例外を出さない(Review Focus 4)
  - queries: `fetch`をモックし、`useRespondMutation`が`POST /v1/latches/L1/response`へ`{"response":"yes"}`を送る・成功後`latchQueryKey("L1")`のキャッシュが応答に置き換わる/`useDeferReasonMutation`が`{"reason":"other"}`を送る
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/latches` → FAIL(モジュール無し)
- [ ] **Step 3: 実装** — 既存`src/intents/queries.ts`と同じ形で書く
- [ ] **Step 4: 通過を確認** — 同コマンドでPASS
- [ ] **Step 5: コミット** — `F4c: 提案の取得・回答のhooksと表示文字列・見送りの説明の記録を追加する`

---

### Task 3: 共通の絵(art.tsx)

**Files:**
- Create: `apps/web/src/screens/latch/art.tsx`
- Test: `apps/web/src/screens/latch/art.test.tsx`

**Interfaces:**
- Produces:
  - `type LatchArtState = "arrived" | "pressed" | "latched"`
  - `LatchArt({ state, size, gap, className?, theirsFill?, ring? })` — `<div class="latch is-{state} {className}" style="--size;--gap;--theirs-fill" aria-hidden>`と内側の`latch__light/mine/theirs>latch__ink`(既存Placed.tsxと同じ構造)。`ring`で`<span class="latch__ring"/>`を先頭に入れる。外から`classList`で状態を差し替えられるよう`ref`を受ける(`forwardRef`は使わずReact 19の`ref` prop)
  - `GroupDisc({ count, size, light?, fills? })` — prototype `groupDisc(n, size, opts)`の扇形パス計算を移植(左=自分のみ`g-mine`・他は`g-blank`、`fills`指定時は全て`g-mine`で各色)
  - `DomeRest({ size, style? })` — `.dome-rest > .dome + .shelf`
  - `Tategaki({ text, className?, style? })` — `\n`で改行、1文字ずつ`<span class="ch" style="--i">`、`role="img"`・`aria-label`は改行を除いた全文(Placed.tsxの書き方)
  - `Avatar({ userId?, hasIcon, size, tone, label? })` — `hasIcon`なら`<img src="/v1/users/{userId}/icon">`を`.avatar`内に、無ければ`avatar avatar--{tone}`の無地。`tone`は`"b" | "c" | "d" | "e"`
- [ ] **Step 1: 失敗する試験** — `GroupDisc count=4`のpathが4本で1本だけ`g-mine`/`fills`指定時は4本とも`g-mine`/`Tategaki text="そっと、\n棚に戻しました。"`の`aria-label`が`そっと、棚に戻しました。`/`Avatar hasIcon=false`は`img`を含まない
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/latch/art.test.tsx`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F4c: 提案〜成立の画面で共有する絵の部品を追加する`

---

### Task 4: 提案・回答待ちの画面(表示のみ)

**Files:**
- Create: `apps/web/src/screens/latch/Proposal.tsx`・`apps/web/src/screens/latch/Awaiting.tsx`
- Test: `apps/web/src/screens/latch/Proposal.test.tsx`・`Awaiting.test.tsx`

**Interfaces:**
- Consumes: Task 2の`formatWhen`・`formatLeft`、Task 3の`LatchArt`・`GroupDisc`
- Produces:
  - `Proposal({ latch: LatchDTO, now: Date, busy: boolean, notice: string | null, onJoin(): void, onDefer(): void, artRef?: Ref<HTMLDivElement> })`
  - `Awaiting({ latch: LatchDTO, now: Date, busy: boolean, notice: string | null, onRetract(): void })`
  - 両画面とも最外は`<div className="screen room proposal{ is-pressed}" data-theme="dark">`(prototype `screens.proposal`)。左上は`<Link className="icon-btn" to={PATHS.home} aria-label="あとで回答する">`(閉じるアイコン)。右上の「…」は置かない
  - 回答期限は`.deadline`(`t-label`「回答期限」・`deadline__when`=`{formatWhen} まで`・`deadline__left`=`formatLeft`)。残り時間は15秒ごとに再描画する(`setInterval`をeffectで張り、unmountで解除)
  - `notice`が非nullなら`.screen__foot`の先頭に`<p className="t-caption" role="status">`で出す
- 文言(prototypeのまま): 提案=`t-eyebrow`「提案」・見出し「条件が合う候補が<br>あります。」・グループ(`participants_count > 2`)は`group-need`「あなたを含む{N}人で成立します」・ボタン「参加する」(`btn btn--primary btn--block`)・「今回は見送る」(`btn btn--secondary btn--block`)・注記「お互いが参加すると、はじめて相手が見えます。」(グループは「全員が…」)/回答待ち=見出し「相手の回答を<br>待っています。」・ボタン「回答を取り消す」(`btn btn--quiet btn--block`)
- 絵: 1対1は提案=`LatchArt state="arrived" size=212 gap=22`・回答待ち=`pressed`。グループは`GroupDisc count={participants_count} size=224 light={提案のとき}`

- [ ] **Step 1: 失敗する試験**
  - `it("ボタンは参加する・今回は見送るの2つだけ(noの操作は無い)")`: `getAllByRole("button")`の名前が`["参加する","今回は見送る"]`と一致し、`/拒否|参加しない/`のテキストが無い
  - `it("scoreと相手の情報を表示しない")`: `latch.score = 0.87`のとき`0.87`・`87`がテキストに無い
  - `it("グループは人数と全員の注記")`: `participants_count=4`で「あなたを含む4人で成立します」「全員が参加すると…」
  - `it("busyのとき両ボタンがdisabledで、連打してもonJoinは1回")`: `busy=false`で1回クリック→呼び出し側が`busy=true`で再描画→再クリックしても`onJoin`は1回(Review Focus 2)
  - `it("15秒ごとに残り時間を更新する")`: `vi.useFakeTimers()`・期限=now+3分→「あと3分」、`vi.advanceTimersByTime(60_000)`後「あと2分」(`now`は親から来るため、試験では画面内の再描画が`Date.now()`基準で`now`を進める実装にする: 再描画時は`new Date(Math.max(props.now, Date.now()))`)
  - 回答待ち: 見出し・期限・「回答を取り消す」のみで、「参加する」が無い
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/latch`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F4c: 提案と回答待ちの画面を追加する`

---

### Task 5: つながりました・成立しませんでした・見送ったの画面(表示のみ)

**Files:**
- Create: `apps/web/src/screens/latch/Matched.tsx`・`NotEstablished.tsx`・`Shelved.tsx`
- Test: `Matched.test.tsx`・`NotEstablished.test.tsx`・`Shelved.test.tsx`(同ディレクトリ)

**Interfaces:**
- Consumes: Task 2の`formatMatchedAt`・`formatWhen`・`formatYen`・`shouldShowDeferNote`・`markDeferNoteSeen`、Task 3の部品
- Produces:
  - `Matched({ latch: LatchDTO, now: Date, fresh: boolean })` — prototype `screens.matched`。`fresh`なら最外に`is-fresh`、`LatchArt`を`pressed`で出し、650ms後に`is-pressed`を外して`is-latched is-bleeding`、さらに1700ms後に`is-bleeding`を外す(`navigator.vibrate?.(14)`はtry内)。`fresh=false`は`latched`の静止。グループは`GroupDisc fills`(自分=`var(--ink)`・他はアバター色)。下部は`<Link className="btn btn--quiet" to={PATHS.home}>あとで</Link>`のみ
  - 「重なったところ」(`dl.facts`・各行`.fact > dt.fact__key + dd.fact__val + span`): つながり=主題・預け方(「つながり」)・人数(`{members.length + 1}人`)・地域(`region_name ?? "指定なし(全国)"`・nullは`fact__val--muted`)/機会=主題・日時(`{formatWhen(time_window.start)}〜`)・場所(`region_name ?? "指定なし"`)・人数・予算(`budget ? `${formatYen(budget.max)}以内` : "指定なし"`)。主題がnullなら「指定なし」
  - 1対1の相手: `.partner`に`Avatar size="l"`・表示名(`t-title`)・`{formatMatchedAt(matched_at)} につながりました`(`t-meta`)、`bio`が非nullなら`p.t-words.partner__bio`。グループ: 各memberを`Avatar size="m"`+名前(`t-head`)
  - `NotEstablished({ variant: "closed" | "ended" | "not_found" })` — prototype `screens.closed`。見出しは順に「この提案は成立しませんでした。」/「このつながりは終了しました。」/「この提案は見つかりませんでした。」、本文「あなたの意思は、そのまま預けています。」(not_foundは本文なし)、ボタン`<Link className="btn btn--secondary btn--block" to={PATHS.home}>預けている一覧へ</Link>`
  - `Shelved({ form: IntentForm, onSaveReason(reason: DeferReason): Promise<void> })` — prototype `screens.shelved`。初回描画時に`shouldShowDeferNote(form)`を1度だけ評価してstateに固定し、trueなら`markDeferNoteSeen(form)`(再描画で消えない)。理由シートは内部state。選択肢と値: いまは余裕がない=`no_capacity`/日時や場所が合わない=`schedule_mismatch`/なんとなく、今回は=`just_not_now`/その他=`other`。[残す]は未選択の間disabled、成功で閉じてトースト`<p className="toast" role="status">ありがとうございます。相手には伝わりません。</p>`を約2.4秒表示。[スキップ]は閉じるだけ。送信後は「見送った理由を残す(任意)」を消す(理由は1回だけ保存できるため)
- [ ] **Step 1: 失敗する試験**
  - Matched: 1対1で表示名・自己紹介・「10月20日 9:05 につながりました」(`matched_at`をJST 9:05に置く)/`bio=null`で`partner__bio`が無い/機会の予算`{min:0,max:4000}`で「4,000円以内」・`budget=null`で「指定なし」/「メッセージを送る」が無く「あとで」がある/`fresh=true`で650ms後に`.latch`が`is-latched`(fake timers)
  - NotEstablished: 3つのvariantの見出し
  - Shelved: つながりで「この相手との提案は今後届きません。」・機会で「条件が変われば、また届くことがあります。」/同じformで2回目のmountでは説明が無い/理由を選び[残す]で`onSaveReason("schedule_mismatch")`・トースト表示・導線が消える/[スキップ]で`onSaveReason`は呼ばれない
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/latch`
- [ ] **Step 3: 実装**(各試験の`beforeEach`で`localStorage.clear()`)
- [ ] **Step 4: 通過を確認**
- [ ] **Step 5: コミット** — `F4c: つながりました・成立しませんでした・見送ったの画面を追加する`

---

### Task 6: 親画面・URL・操作の流れ

**Files:**
- Create: `apps/web/src/screens/latch/LatchScreen.tsx`・`apps/web/src/screens/latch/ShelvedScreen.tsx`
- Modify: `apps/web/src/routes/paths.ts`・`apps/web/src/router.tsx`
- Test: `apps/web/src/screens/latch/LatchScreen.test.tsx`・`ShelvedScreen.test.tsx`

**Interfaces:**
- Consumes: Task 2のhooks、Task 4・5の画面
- Produces:
  - `PATHS.latch = "/latches/:id"`・`PATHS.latchShelved = "/latches/:id/shelved"`と、`latchPath(id: string): string`・`latchShelvedPath(id: string): string`(`paths.ts`)。両ルートとも`RequireAuth`で包む
  - `selectLatchView(latch: LatchDTO): "proposal" | "awaiting" | "matched" | "shelved" | "closed" | "ended"`(`LatchScreen.tsx`からexport)。判定順: `my_response === "defer"`→shelved / statusがproposed・partial_acceptで`my_response === null`→proposal / 同じく`yes`→awaiting / matched→matched / cancelledで`proposal`キーあり→ended / それ以外(rejected・expired・cancelled・noの本人)→closed
- 親の振る舞い(LatchScreen):
  - 取得中は空の`screen room`(暗い部屋)だけ、404(`ApiError.code === "NOT_FOUND"`)は`NotEstablished variant="not_found"`、その他の取得失敗は「読み込めませんでした。」と[もう一度読み込む](Home.tsxの失敗表示と同形)
  - `useLatchQuery(id, { refetchInterval: view === "awaiting" ? 30_000 : false })`
  - [参加する]: `artRef`の要素から`is-arrived`を外し`is-pressed`を付け520ms待ってから`respond("yes")`を待つ(`prefers-reduced-motion: reduce`のときは待たない)。応答が`matched`なら`fresh=true`で`Matched`
  - [今回は見送る]: `.latch`または`.group-wrap`に`is-shelving`を付け760ms待って(同上)から`respond("defer")`、成功で`navigate(latchShelvedPath(id), { replace: true })`
  - [回答を取り消す]: `retract`
  - 送信失敗: `refetch()`し、`notice`に`ApiError.details.reasons`に`deadline_passed`・`invalid_status`・`already_responded`があれば「この提案には、もう回答できません。」、それ以外(通信失敗等)は「送れませんでした。もう一度お試しください。」
  - 表示がawaitingの間に取得結果がmatchedへ変わったら`fresh=true`(useRefで直前のviewを保持して判定)。URLを開いた最初の取得でmatchedなら`fresh=false`
- 親の振る舞い(ShelvedScreen): `useLatchQuery(id)`の`my_response !== "defer"`なら`navigate(latchPath(id), { replace: true })`。deferなら`Shelved form={latch.form}`、`onSaveReason`は`useDeferReasonMutation`
- [ ] **Step 1: 失敗する試験**(`createMemoryRouter(appRoutes, { initialEntries: ["/latches/L1"] })`+`withQueryClient`+`fetch`モック。認証はHome.test.tsxと同じく`authSession`を準備)
  - `it.each`で振り分け表: (proposed, null)→「参加する」/(partial_accept, null)→「参加する」(Review Focus 3)/(partial_accept, yes)→「回答を取り消す」/(matched)→「つながりました。」/(rejected, defer)→`/latches/L1/shelved`へ遷移/(rejected, no)→「この提案は成立しませんでした。」/(expired, yes)→同/(cancelled・proposalあり)→「このつながりは終了しました。」/404→「この提案は見つかりませんでした。」
  - `it("参加するで応答がmatchedなら演出つきのつながりました")`: 最後のyesの応答をmatchedにし、`.matched.is-fresh`がある
  - `it("回答期限切れの400では取り直して知らせる")`: POSTが400 `{error:{code:"VALIDATION_FAILED",details:{reasons:["deadline_passed"]}}}`→GETが2回呼ばれ「この提案には、もう回答できません。」(Review Focus 1)
  - `it("回答待ちは30秒ごとに取り直し、matchedへ切り替わる")`: `vi.useFakeTimers({ shouldAdvanceTime: true })`、1回目GET=partial_accept/yes、2回目=matched→`advanceTimersByTime(30_000)`後に`.matched.is-fresh`
  - `it("URLを開いた時点でmatchedなら演出しない")`: `.matched`があり`is-fresh`が無い
  - ShelvedScreen: `my_response: "yes"`の提案で`/latches/L1/shelved`→`/latches/L1`へ置き換え(Review Focus 5)/deferなら「そっと、棚に戻しました。」
  - 動きの待ちは試験で`matchMedia("(prefers-reduced-motion: reduce)")`をtrueにして省く(`src/test/`に既存のmatchMediaモックがあればそれを使う)
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/latch`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** — 加えて`pnpm --filter web exec vitest run`全体(既存のrouter・onboarding試験が壊れていない)
- [ ] **Step 5: コミット** — `F4c: 提案1件の画面を状態で切り替え、回答・取り消し・見送りの流れをつなぐ`

---

### Task 7: Homeの到着カードと意思カードの状態

**Files:**
- Modify: `apps/web/src/screens/Home.tsx`
- Test: `apps/web/src/screens/Home.test.tsx`

**Interfaces:**
- Consumes: Task 2の`useProposalsQuery`・`formatWhen`、Task 3の`LatchArt`、Task 6の`latchPath`
- 振る舞い:
  - 到着カード(prototype `arrivalBlock`): `<Link className="arrival{ is-pressed} rise" to={latchPath(id)}>`に`LatchArt state={yes済み ? "pressed" : "arrived"} size=40 gap=5`・`arrival__title`(未回答=「提案が届いています」/`my_response === "yes"`=「相手の回答を待っています」)・`t-meta`「回答期限 {formatWhen} まで」と、`participants_count > 2`なら`<span class="sep">·</span>{N}人`・`ic--s`の山形アイコン。到着カードは見出し(`t-display`「預けている」とcaption)の後、意思の一覧の前に並べる
  - 意思カード: 進行中の提案の`my_intent_id`集合に含まれる意思は、状態チップを`status status--lamp`の「回答を待っています」と灯りのグリフ(現行`LAMP_STATUSES`の分岐と同じ`gl`/`gm`)にする。`IntentCard`へ`waiting: boolean`を渡す形にし、`LAMP_STATUSES`の定数は削除する(Intentの状態にproposedは無いため)
  - 器: `vessel vessel--quiet`に`is-lit`を付けるのは未回答(`my_response === null`)の提案が1件以上あるときだけ
  - 提案の取得失敗・取得中は到着カードを出さず、意思の一覧はそのまま表示する
  - 空状態(`data.items.length === 0`)でも提案があれば到着カードを出す(意思の削除後にも提案は残り得ないが、表示の分岐を単純にするため空状態の判定は「意思0件かつ提案0件」に変える)
  - ファイル冒頭コメントの「提案が届いていますカード(arrival)はF4スコープ外のため出さない」を更新する
- [ ] **Step 1: 失敗する試験**(既存の「arrivalは出ていない」試験は置き換える)
  - `it("未回答の提案は到着カードとして出て、提案の画面へつながる")`: `href="/latches/L1"`・「提案が届いています」・`回答期限`
  - `it("yes済みは「相手の回答を待っています」でis-pressed")`
  - `it("グループの到着カードは人数を出す")`: `participants_count=3`で「3人」
  - `it("提案が届いている意思のカードは「回答を待っています」になる")`: `my_intent_id`が一致するカードだけ`status--lamp`
  - `it("器の灯りは未回答の提案があるときだけ")`: 提案なし→`.vessel`に`is-lit`が無い
  - `it("提案の取得に失敗しても意思の一覧を表示する")`: `/v1/latches`だけ500→意思カードがあり、再試行表示は出ない
- [ ] **Step 2: 失敗を確認** — `pnpm --filter web exec vitest run src/screens/Home.test.tsx`
- [ ] **Step 3: 実装**
- [ ] **Step 4: 通過を確認** — web全体の`vitest run`も緑
- [ ] **Step 5: コミット** — `F4c: Homeに提案の到着カードと回答待ちの状態表示を追加する`

---

### Task 8: ゲートE2E(#17のUI 2択)

**Files:**
- Create: `apps/web/e2e/latch-flow.spec.ts`
- Modify: `apps/web/e2e/helpers.ts`

**Interfaces:**
- Consumes: 既存`signInAndRegister(page)`、Task 6・7の画面
- Produces(helpers.ts):
  - `captureAccessToken(page: Page): Promise<string>` — `page.waitForRequest`で`/v1/`への要求の`authorization`ヘッダーから`Bearer `以降を取る(リフレッシュを呼ばないためページ側のトークンを失効させない)。呼び出し側はトークン取得のため`page.reload()`等で`/v1`要求を発生させる
  - `createConnectionIntent(page: Page, token: string, topic: string, site: number): Promise<{ id: string }>` — `page.request.post("/v1/intents", { data: { raw_text: topic, form: "connection", topic, geo: { center: { lat: 33 + site * 0.1, lng: 131.5 }, radius_m: 1_000 } }, headers })`で201を確認(apps/worker/e2e/latches.spec.tsの`site`と同じ地域の分け方。worker側と番号が衝突しないよう、web側は`site`に40以上を使う)
  - `waitForDevLatch(page: Page, token: string, intentId: string, match: (item) => boolean): Promise<{ id: string; status: string }>` — `GET /v1/dev/latches?intent_id=…&limit=50`を500ms間隔・60秒上限でポーリング
  - `expireLeftoverE2eIntents()` — `execSync("node scripts/clean-e2e-data.mjs", { cwd: <apps/worker> })`(apps/worker/e2e/latches.spec.tsと同じ)
- 試験の方針: 2人は`browser.newContext()`を2つ作って別々に登録する(UIの実フロー)。Intentの投入はAPIで行う(ゲートの対象は回答の画面であり、意思の投入画面はF2'のflow.spec.tsで証明済み・地域を分けて他specの残りと混ざらないようにするため)。各testの前に`expireLeftoverE2eIntents()`
- [ ] **Step 1: 試験を書く**
  - `test("2人が画面から参加すると成立し、待っていた側も切り替わる(#17)")`: A・Bを登録→つながりIntentを同じtopic(`e2e-web-latch-${uuid}`)・同じsite(40)で投入→`waitForDevLatch(status === "proposed")`→Aは`page.goto("/home")`で到着カード「提案が届いています」を押し、提案画面のボタンが「参加する」「今回は見送る」の2つだけであることを確認→[参加する]→「相手の回答を待っています。」→BもHomeの到着カードから[参加する]→Bに「つながりました。」とAの表示名→Aは`pageA.bringToFront()`と`pageA.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))`で取り直し(TanStack Query v5のfocusManagerはwindowの`visibilitychange`を合図にする)、「つながりました。」に切り替わる→`waitForDevLatch(status === "matched")`
  - `test("見送ると見送った画面と説明が出て理由を残せ、相手は成立しませんでした(#17)")`: site 41で同様に提案→Aが[参加する]→Bが[今回は見送る]→Bに「そっと、棚に戻しました。」相当(`role=img`の`aria-label`)と「この相手との提案は今後届きません。」→「見送った理由を残す(任意)」→「日時や場所が合わない」→[残す]→トースト→Aは同じく`visibilitychange`で取り直し「この提案は成立しませんでした。」→観測APIで`status === "rejected"`
- [ ] **Step 2: 実行** — `pnpm --filter web exec playwright test e2e/latch-flow.spec.ts`(ポート競合時は`LATCH_E2E_PORT=<空き>`)→ PASS。失敗したら原因を直してから次へ
- [ ] **Step 3: 全E2Eの確認** — `pnpm --filter web test:e2e`(既存8本+新規2本)と`pnpm --filter worker test:e2e`(36本)が緑
- [ ] **Step 4: コミット** — `F4c: 提案への回答の画面2択のゲートE2E(#17)を追加する`

---

### Task 9: 文書の更新

**Files:**
- Modify: `docs/12-development-roadmap.md`・`docs/10-test-env-nfr.md`・`docs/00-document-roadmap.md`・`AGENTS.md`(と、版数が変わる文書を前提文書に挙げる各文書の前提文書欄)

- [ ] **Step 1: 12** — §2のF4行の内訳に「F4c=#17のUI 2択(完了)」、決定記録1の影響へ「F4cは完了した(#17のUI 2択をweb E2E(latch-flow.spec.ts: 2人の参加による成立と待っていた側の切り替え、見送りと相手側の不成立)で証明)」を追記。版数・変更点行
- [ ] **Step 2: 10** — §4のE2Eの分担・本数の記載(`rg -n "web E2E|E2E 8本|8本" docs/10-test-env-nfr.md`で該当箇所を探す)をweb E2E 10本へ更新し、#17のUIがweb E2Eである旨を追記。版数・変更点行
- [ ] **Step 3: 版数の整合** — 00 §1の版数表、12・10を前提文書に挙げる文書の前提文書欄を揃える(`rg -n "12 開発ロードマップ v|10 テスト環境" docs`)
- [ ] **Step 4: AGENTS.md** — 「現在の状態」へF4c(提案〜成立の画面: Homeの到着カード・提案(1対1/グループ)・回答待ち・見送り+理由・成立しなかった・つながった・LatchDTOのmy_intent_id/matched_at)の完了とゲート(#17のUI 2択・web E2E 10本)を追記し、「次はF4c」をF5へ更新。注記の「提案・回答の画面はF4c」を外す
- [ ] **Step 5: 確認** — `pnpm lint`(Markdownは対象外だが整形確認として)・`rg -n "F4c" docs AGENTS.md`で記載の食い違いが無いこと
- [ ] **Step 6: コミット** — `F4c: 提案〜成立の画面の完了を10・12・AGENTS.mdへ記録する`
