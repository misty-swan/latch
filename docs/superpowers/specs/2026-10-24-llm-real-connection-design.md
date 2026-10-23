# LLM real接続 設計書

- 作成日: 2026-10-24
- 対象: Parser(Anthropic)・Jev(TypeSafe・予備Anthropic)のreal接続、ゴールドセットと精度ゲート、地域名をEmbedding入力に含めるかの判断、stagingをreal接続へ切り替えた#33の測り直し。あわせて、その前提としてissue #11(stagingのテスト用サインインが誰でも使える)を直す
- 正本: docs/07 §1〜§8 / docs/08 §5 / docs/09 §3・§4 / docs/12 §2(LLM real接続の行・決定記録(stagingと負荷試験))/ docs/02 #33 / docs/runbooks/staging.md
- 前段: docs/superpowers/specs/2026-10-22-f8b-staging-load-test-design.md・2026-10-23-bugfix-phase2-design.md・docs/reports/f8b-load-test.md
- 本書の位置づけ: ブレインストーミングでオーナー合意した設計の記録。実装計画(docs/superpowers/plans/)の入力とする

## 0. 前提と範囲

### 0.1 対象

| 項目 | 内容 |
|---|---|
| #11 | stagingの前にCloudflare Accessを置き、Worker側でもAccessの証明を検証する |
| ゴールドセット | Parser用の例文と期待値・Jev用の意思の組と正解(09 §3)をYAMLで作る |
| 採点の道具 | ゴールドセットでreal実装を採点し、結果の記録を残す(手元で実行) |
| 精度ゲートのCI | CIは記録だけを照合し、合格の記録の無いreal設定を落とす |
| Parser real | Anthropic(Haikuクラス)の構造化出力 |
| Jev real | TypeSafe(System One・Jev)を第一候補、Anthropic(Haikuクラス)を予備 |
| 外部送信の集計 | 送信先・種別・件数を記録する(08 §5) |
| 地域名の判断 | realのEmbeddingとゴールドセットで、地域名を含める/含めないを比べ、オーナーが決める(07 §4) |
| #33の測り直し | stagingをLATCH_LLM_MODE=realにして、F8bと同じシナリオと集計を流し直す |

### 0.2 範囲外

| 項目 | 扱い |
|---|---|
| #27〜#30 | 本工程の後の修正工程で、本工程で見つかる不具合とまとめて直す |
| #4・#5・#6 | オーナーの実機確認・Braveでの確認を待つ(本工程と並行してよい) |
| #14 | 後の工程(12 §2の決定記録) |
| prodのreal化 | F10(公開準備)で行う。本工程はstagingまで |
| D-D-02(Jev軸の重み) | 運用データの後(07 §9) |

### 0.3 オーナー合意(2026-10-24)

| # | 論点 | 合意 |
|---|---|---|
| 1 | 外部AI事業者のアカウント | AnthropicとTypeSafeの両方のAPIキーをオーナーが用意できる |
| 2 | ゴールドセットの作り方 | Claudeが下書きし、オーナーが読んで直す。オーナーが承認したものを正式な版とする(09 §3のレビュー制) |
| 3 | 精度ゲートの採点の時期 | 採点は手元のコマンドで行い、結果の記録をリポジトリへ入れる。CIは本物のAIを呼ばず、「今の指示文・ゴールドセット・モデルの版で合格した記録があるか」を照合し、無ければreal設定を落とす(09 §4の「CIで自動測定」を改める) |
| 4 | #11の守り | stagingの前にCloudflare Accessを置く(workers.devのEnable Cloudflare Access)。k6とCIのスモークはサービストークンで通る |
| 5 | 工程の順番 | #11 → ゴールドセットと採点 → real接続と調整 → 地域名の判断 → stagingのreal化と#33の測り直し。#27〜#30はこの後の修正工程 |

### 0.4 文書の裁量で決めたこと

- Anthropic・TypeSafeのSDKは使わず、`fetch`で直接呼ぶ。依存を増やさず、時間切れ・失敗の種別の写像を自前で一か所に持つため(Web Pushの自前実装と同じ方針)
- TypeSafeのモデルは`jev-latest`を使わず、採点に合格した版の名前を固定して使う。応答の`model`(例: `jev-1.13.0`)を記録し、固定した名前と違えば記録に残す。AnthropicもモデルIDを固定する(`claude-haiku-5-5`)
- 指示文(プロンプト)はコード内の定数として版を持つ(D-D-01の暫定案どおり)
- 07 §6の機会Intentの「location 90%」は、Parserが地域を解決しない(05 §3.3: parseは`geo: null`を返し、ユーザーが添付で確定する)ため、採点の対象から外す。代わりに、入力文の場所の言及を確認UIで見落とさないよう、場所の言及があるときにwarningsへ`{field:"geo"}`を載せることを採点する(一致率90%)。オーナーの確認を設計書の確認の場で受ける
- Jevの順序整合(07 §6)は、同じ2つの意思を(A,B)と(B,A)の順で送り、意味の同じ軸どうし(Aを先に送ったときのwould_a_accept_bと、Bを先に送ったときのwould_b_accept_aなど)の差の絶対値を全軸・全組で集め、その中央値で判定する
- Offline Precision@0.60(09 §4)は参考値として記録し、合否には使わない(07 §6の表に無いため)
- 外部送信の集計は、既存の`usage_counters`に新しいscopeを足して日ごとに数える。新しい表は作らない

### 0.5 順番

1. #11(§1)
2. ゴールドセットの下書き → オーナーの確認(§2)
3. 採点の道具・CIの照合(§3)
4. Parser real・Jev real・外部送信の集計(§4・§5・§6)
5. 手元での採点と指示文の調整 → 合格の記録(§3)
6. 地域名の比較 → オーナーの判断(§7)
7. stagingのreal化 → #33の測り直し → 報告書(§8)
8. 文書の更新(§9)

## 1. #11 stagingの門

### 1.1 オーナーの操作(Cloudflareの管理画面・手順書に書く)

1. Workers & Pages → `latch-worker-staging` → Settings → Domains & Routes → workers.devの「Enable Cloudflare Access」
2. Accessのアプリケーションの方針を、オーナーのメールアドレスだけに絞る
3. サービストークンを1つ発行し、同じアプリケーションの方針に「Service Auth」で加える
4. アプリケーションのAUD(Audience)タグとチームのドメインを控える

いずれもCloudflareの新しい設定を作る操作なので、実行の直前にオーナーへ確認する。

### 1.2 Worker側の検証

- `LATCH_ENV=staging`のとき、全リクエスト(`/healthz`・`/v1/*`・静的配信)の先頭で`Cf-Access-Jwt-Assertion`を検証する。チームのドメインの`/cdn-cgi/access/certs`の公開鍵で署名を確かめ、`iss`=チームのドメイン・`aud`=AUDタグ・有効期限を確かめる。失敗は403(本文は固定文・理由はログの許可リストのerror_codeだけ)
- 公開鍵は取得結果をisolateの中で保持し、`kid`が見つからないときだけ取り直す
- AUDとチームのドメインはstagingのシークレット(`ACCESS_AUD`・`ACCESS_TEAM_DOMAIN`)に置く。URLやアカウントの手がかりを設定ファイルに書かないため
- `assertEnvSafety`で、`LATCH_ENV=staging`なのにこの2つが無ければ起動を拒む。この検証はstaging限定とし、localとtestでは行わない。prodの扱いはF10で決める
- Cron・キューの消費はfetchを通らないので影響しない

### 1.3 道具とCIの対応

- `tools/load/run.mjs`・`cleanup.mjs`・`report.mjs`は、環境変数`LATCH_ACCESS_CLIENT_ID`・`LATCH_ACCESS_CLIENT_SECRET`があれば全リクエストへ`CF-Access-Client-Id`・`CF-Access-Client-Secret`を付ける。k6のシナリオには`run.mjs`から渡す(URLと同じく出力に出さない)
- CIの`deploy-staging`のスモークも同じヘッダーを付ける。GitHubのシークレットに2件を足す(オーナーの登録)
- 値は手元では`.superpowers/sdd/2026-10-22-f8b-staging-load-test/`の下の管理外ファイルに置く

### 1.4 確かめ方

単体試験(検証の成功・署名の不一致・aud違い・期限切れ・ヘッダー無し)。デプロイ後に、通行証なしで403・通行証ありで`/healthz`が200になることを確かめる。

## 2. ゴールドセット

### 2.1 置き場所と形式

- `eval/goldset/parser.yaml` と `eval/goldset/jev-pairs.yaml`(リポジトリ直下・YAML)
- 先頭に`version`(整数)と`approved_by_owner`(日付またはnull)を持つ。オーナーが承認したらその日付を入れる。nullのゴールドセットで採点した記録は合格として扱わない

### 2.2 Parser用(parser.yaml)

1件は次の形。`expect`には採点するフィールドだけを書く(書いていないフィールドは採点しない)。

```yaml
- id: conn-001
  raw_text: "週末に一緒にボードゲームをしてくれる人を探しています"
  now: "2026-11-02T10:00:00+09:00"   # 相対日時の基準(Parserへ渡す現在時刻)
  tags: [connection]
  expect:
    form: connection
    topic: ボードゲーム
    alcohol_involved: false
```

- 規模: つながりIntent 40件以上・機会Intent 40件以上・境界20件以上(form曖昧・お酒の暗示・地域のみの言及・人数のみ)
- お酒の境界は必ず含める(07 §6: 「ワイン会」「バーの誕生日会」/負例「コーヒー」など)
- topicの一致は「期待値の主題語が出力のtopicに含まれる」で判定する(係り受けを除く主題語・07 §6)。同義の表記ゆれは`topic_any: [..]`で複数を許す

### 2.3 Jev用(jev-pairs.yaml)

- 2つの意思の正規化テキスト(Parserの結果ではなく、正規化の関数に通す構造化データを直接書く)と、手で付けた正解`match: yes|no`
- 規模: 40組以上(yes・noを半々程度・機会とつながりの両方)
- 地域名の比較(§6)に使うため、各意思に任意の`area`(例: 「渋谷区」)を持たせる

### 2.4 確認の進め方

Claudeが下書きをコミットせずに置き、オーナーが読む(不自然な文・正解の判断の違いを指摘)。直した版をコミットし、`approved_by_owner`に日付を入れる。以後の変更もオーナーの承認を通す。

## 3. 採点の道具と精度ゲート

### 3.1 採点のコマンド

- `pnpm eval:gate`(ルート)。`tools/eval/`に置き、workerのreal実装(§4・§5)を直接importして呼ぶ(Workersの外・Node 22の`fetch`)
- APIキーは環境変数`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`から読む。手元では管理外のファイル(`tools/eval/.env`・.gitignoreに追加)に置く
- 呼び出しは同時に数件までに絞り、429はRetry-Afterに従って待つ(採点の中だけ。本番の経路は再試行しない)
- 出力: `eval/records/gate.json`(合否・項目ごとの値・件数・失敗の内訳・指紋)と、人が読む要約を標準出力へ

### 3.2 指紋

記録に次のSHA-256を持つ。CIはこれを今のファイルから計算し直して照合する。

- Parserの指示文と出力スキーマ
- Jevの質問文(TypeSafe用・Anthropic用)
- 正規化の関数のファイル
- parser.yaml・jev-pairs.yaml
- 固定したモデル名(Anthropic・TypeSafe)

### 3.3 合格基準(07 §6)

| 項目 | 基準 |
|---|---|
| form | 完全一致90%以上 |
| topic | 85%以上 |
| 機会Intent | category 85% / time.start 90% / participants 80% / budget 90% / 場所の言及のwarnings 90%(§0.4) |
| alcohol_involved | recall 100%・precision 90%以上 |
| Jev順序整合 | 差の中央値0.3以下(§0.4) |
| Jevの予備 | 予備(Anthropic)単独でも順序整合を満たす(第一候補が落ちたときに使うため) |

参考値(合否に使わない): Precision@0.60・Jevの応答時間のp95・Parserの応答時間のp95・1回あたりの入力トークン。

### 3.4 CIの照合

workerの単体試験として置く(本物のAIは呼ばない)。

- `wrangler.jsonc`のどれかの環境で`LATCH_LLM_MODE`が`real`なら、`eval/records/gate.json`が存在し、`passed: true`、ゴールドセットが承認済み、指紋が今のファイルと一致することを求める
- 指示文を1文字でも変えると指紋が変わり、採り直すまでCIが落ちる

## 4. Parser real

### 4.1 呼び出し

- `POST https://api.anthropic.com/v1/messages`・モデル`claude-haiku-5-5`・`output_config.format`にJSONスキーマ(05 §3.3のparse応答のうちParserが埋めるフィールド)
- 入力はraw_textと現在時刻(JST)だけ(07 §3・08 §5)。system文で、丸め規則(「くらい」→確定値・「2〜4人」→min/max・人数は2〜4へ丸め注意を載せる)・formの判定基準・カテゴリの一覧(`CATEGORIES`)・時刻は0〜23時・JSTオフセット付きISOを指示する
- timeout 10秒・再試行0(07 §3)

### 4.2 差し替え口の形

- `Llm.parser`を非同期・失敗型付きに改める: `(raw_text: string) => Promise<ParserOutcome>`。`ParserOutcome = { ok: true; output: ParserOutput } | { ok: false; kind: "timeout" | "rate_limited" | "overloaded" | "invalid_output" | "other" }`(Jevと同じ種別)
- stubも同じ形に合わせる(常にok)
- 出力は今のルートと同じく、組み立て後に応答スキーマで検証する。モデルの出力がスキーマに合わない・カテゴリが一覧外などは`invalid_output`
- ルートは失敗をすべて422 PARSE_FAILEDに倒す(画面は今の「読み解けませんでした」の流れのまま)。種別はログの許可リストのerror_codeへ

### 4.3 stubの変化

`ParserStubOutput`を`ParserOutput`へ名前を改め、categoryを`Category | null`へ広げる(stubはnullのまま)。

## 5. Jev real

### 5.1 第一候補(TypeSafe)

- `POST https://api.typesafe.ai/v1/systemone`・`model`は固定した版・`state`は`{ "intent_a": <正規化テキストA>, "intent_b": <正規化テキストB> }`
- `questions`に7軸(07 §5)を`type: "noul"`で並べる。各軸の`instructions`は`intent_a`・`intent_b`をバッククォートで指す日本語の問い、`criteria.true/false`でyes/noの意味を書く。timing_fitは機会=日時の一致・つながり=関係の温度と開始時機の一致(07 §5)
- 応答の`answers.<軸>.noul`を0〜1で受ける。7軸のどれかが欠ける・範囲外は`invalid_output`
- timeout 6秒。HTTP 429=rate_limited・503/529=overloaded・時間切れ=timeout・その他=other

### 5.2 予備(Anthropic)

- Parserと同じ呼び方で、7軸の数値だけのJSONスキーマ(各0〜1)。理由文は求めない(07 §5)
- 切り替えは今の共通部(timeout・rate_limited・overloadedのときだけ)のまま

### 5.3 予算と計上

予算・circuit breakerは今の共通部(06 §6)のまま。実API呼び出しはすべて計上する(07 §7)。

## 6. 外部送信の集計(08 §5)

- `usage_counters`に`scope="external_send"`・`key="<送信先>:<系統>"`(例: `anthropic:parser`・`typesafe:jev`・`anthropic:jev`)・`period`=JSTの日付で、呼び出しのたびに1加える(成否を問わず、送った回数)
- 送る中身は記録しない。dev専用の観測API(`GET /v1/dev/usage`)で日ごとの件数を返す

## 7. 地域名の判断(07 §4)

- jev-pairs.yamlの組を、realのEmbedding(Workers AI bge-m3)で「地域名を正規化テキストに含める/含めない」の2通りにベクトル化し、yesの組とnoの組のcosine類似度の分かれ方(yesの組の類似度の中央値−noの組の中央値、AUC)を比べる
- Workers AIはREST API(`/accounts/{id}/ai/run/@cf/baai/bge-m3`)で手元から呼ぶ。アカウントIDとトークンは手元の管理外ファイルから読み、記録や出力に出さない
- 比較の結果を表にしてオーナーへ示し、次の観点で決めてもらう: 精度の差/地域名がJevの外部送信(TypeSafe・Anthropic)に乗ること(08 §5の「送るもの」の表の更新が要る)
- 含めると決めた場合は、正規化の関数に地域名を足し、Jevの採点を採り直す(指紋が変わるため)

## 8. stagingのreal化と#33の測り直し

### 8.1 切り替え

- オーナーが`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`をstagingのシークレットへ登録する(`! pnpm --filter worker exec wrangler secret put ANTHROPIC_API_KEY --env staging`の形。キーの値はClaudeに見せない)
- `env.staging`の`LATCH_LLM_MODE`を`real`にする(この時点で合格の記録が要る・§3.4)
- `assertEnvSafety`: `LATCH_LLM_MODE=real`なのにキーが無ければ起動を拒む
- オーナーはAnthropic・TypeSafe・Cloudflareの管理画面で利用額の上限か通知を設定する(推奨)

### 8.2 測り直し

- 手順書7章どおり、後始末→(a)→(b)→(d)→(c)を同じRUN_IDで流し、集計は後始末の前に行う
- 流す前に、(a)〜(c)で呼ぶParser・Jevの回数と費用の概算をオーナーへ示し、承認を取る
- 報告書`docs/reports/f8b-load-test.md`へ§8として追記する。#33の状態を「real接続での計測済み」へ改める(合否は#30の扱いを含めて結果で書く)
- 新しく見つけた不具合はissueへ登録する

## 9. 文書の更新

- 07 §1(Jevのモデル版の固定)・§3(差し替え口の形)・§4(地域名の判断の結果)・§6(location項目の置き換え・順序整合の測り方)・§9(D-D-01の扱い)
- 09 §3(置き場所と形式)・§4(採点は手元・CIは記録を照合=オーナー合意3)
- 08 §5(外部送信の集計・地域名の判断の結果次第で送るものの表)
- 01冒頭の決定記録(オーナー合意1〜5・地域名の判断)・12 §2(工程の完了)・02 #33・10 §5・AGENTS.md・docs/runbooks/staging.md(Accessと通行証・シークレットの登録)
- 版数と前提文書欄の同期(00 §3)

## 10. 試験

- 単体: Accessの検証/Parser realとJev realの応答の写像(fetchを差し替えて成功・429・529・時間切れ・形の崩れ)/外部送信の加算/指紋の計算/CIの照合(real設定×記録の有無・不合格・指紋違い・未承認)/採点の集計(各項目の一致率・recall・中央値)
- 本物のAIを呼ぶ試験はCIに置かない(手元の`pnpm eval:gate`だけ)
- 既存のE2E・統合試験はstubのまま緑であること

## 11. リスク

| リスク | 手当て |
|---|---|
| TypeSafeは先行利用の段階で、仕様や版が変わり得る | 版を固定し、応答のmodelを記録する。予備のAnthropicでも合格を求める(§3.3) |
| 合格まで指示文の調整が長引く | 調整の回数を台帳に記録する。基準に届かない項目が残ったら、基準の見直しか指示文の方針の変更をオーナーに相談する(独断で基準を下げない) |
| 負荷試験の費用 | 流す前に概算を示して承認を取る(§8.2) |
| Accessの設定の誤り | Worker側の検証が二重の守りになる。デプロイ後に通行証の有無で確かめる(§1.4) |
