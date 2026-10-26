# ゴールドセット

LLM real接続の精度ゲート(docs/07 §6・設計書 §2)で採点に使う正解データです。

- `parser.yaml`: Parser用(入力文と期待する読み解き)
- `jev-pairs.yaml`: Jev用(2つの意思と、手で付けた正解 yes/no)

読み込みは `tools/eval/lib/goldset.ts` が行い、形式の違反は件のidつきで例外になります。

## 共通のヘッダ

```yaml
version: 1                # 整数
approved_by_owner: null   # 承認日(例 "2026-11-05")またはnull
```

## parser.yaml

`items` に次の形を並べます。idは重複不可。`expect` には採点するフィールドだけを書きます。**キーを書かない=採点しない**。`null` は「出力にその値が無いこと」を期待する意味です(`time_start`・`budget`・`category` のみ)。

```yaml
items:
  - id: conn-001
    raw_text: "週末に一緒にボードゲームをしてくれる人を探しています"
    now: "2026-11-02T10:00:00+09:00"   # 相対日時の基準(オフセット付きISO 8601)
    tags: [connection]
    expect:
      form: connection                  # connection | occasion
      topic: ボードゲーム               # 出力のtopicに含まれるべき主題語
      # topic_any: [ボドゲ, ボードゲーム]  # どれか1つが出力のtopicに含まれればよい(topicとは併用不可)
      # topic_none: [渋谷]                 # 出力のtopicに含まれてはならない語(集合場所・店・駅・住んでいる地域。topicかtopic_anyが必須・それらの語と互いに含み合う語は不可)
      # category: 食・飲み               # CATEGORIES(@latch/shared)のいずれか。nullは「categoryなし」
      # time_start: "2026-11-07T19:00:00+09:00"  # 時刻の同一性(Date.parseが等しい)で比べる。文字列一致ではない。nullは「時刻なし」
      # participants: { min: 2, max: 4 }  # 1以上・min<=max
      # budget: { min: 3000, max: 5000 }  # 片側はnull可。budget: null は「予算なし」
      alcohol_involved: false
      # geo_warning: true                # warnings.some(w => w.field === "geo") の真偽
```

## jev-pairs.yaml

`pairs` に次の形を並べます。a・b は正規化の関数(`buildNormalizedText`)に通す構造化データを直接書き、Parserの結果ではありません。`startsAt`・`endsAt` はオフセット付きISO 8601の文字列(読み込み時にDateへ変換)。`area` は任意で、地域名の比較に使います。`jev_scored` は任意で、`false` の組はJevの採点(順序整合・Precision/Recall@0.60)から外し、地域名の比較(`pnpm eval:region`)だけで使います(noの理由がLayer 1の条件(距離など)で、正規化テキストに出ない組のため・docs/09 §3・LAT-114)。書かなければ採点に使います。

版2(承認 2026-10-26)で、LAT-109の下書きの12組(pair-050〜061)を本採用し、pair-027・pair-041に `jev_scored: false` を付けました。

```yaml
pairs:
  - id: pair-001
    match: "yes"              # "yes" | "no"(手で付けた正解・必ず引用符で囲む)
    a:
      form: occasion
      topic: ボードゲーム
      softConstraints: [初心者歓迎]
      negativeConstraints: []
      participantsMin: 2
      participantsMax: 4
      participantsIncludesOwner: true
      startsAt: "2026-11-07T19:00:00+09:00"
      endsAt: "2026-11-07T21:00:00+09:00"
      budgetMin: 3000
      budgetMax: 5000
      area: 渋谷区
    b: { ... }
  - id: pair-027
    match: "no"
    jev_scored: false         # 任意。falseならJevの採点から外す(地域名の比較では使う)
    a: { ... }
    b: { ... }
```

## Jevの少数の組の確かめ

`pnpm --filter eval exec tsx jev-probe.ts` は、`jev-pairs.yaml` のうちJevの採点に使う組を(A,B)の順だけでJevのrealへ送り、組ごとのLATCH ScoreとPrecision・Recall@0.60を出します(`--primary-only`・`--fallback-only` で絞れます)。指示文を直したときの見当づけに使う道具で、精度ゲートの採点ではありません(順序整合を測らず、記録も書きません)。本物のAIを呼ぶため課金があります。

## 承認の手順

1. Claudeが下書きを置く(`approved_by_owner: null`)。
2. オーナーが読み、不自然な文や正解の判断の違いを指摘する。
3. 直した版をコミットし、**オーナーの確認が済んでから**`approved_by_owner`に日付を入れる。
4. 以後の変更もオーナーの承認を通す。

`approved_by_owner` が null のゴールドセットで採点した記録は合格として扱いません(CIの照合が落ちます)。

## 採点の決まり(`tools/eval/lib/score.ts`)

- Parserの呼び出しが失敗した件は、その件が採点するすべての項目で不一致として数えます(alcoholは正例ならfnに数えます)。
- 予算の期待値の片側がnull(例 `{ min: 3000, max: null }`)のときは、その側を採点しません(出力の予算は両側とも数値のため、nullの側は比べようがありません)。`budget: null` そのものは「予算なし」を期待します。
- 合格の境界は「以上」で、ちょうど基準値(例 90%)は合格です。採点できる件が0件の項目は不合格です。
- Jevの順序整合は、同じ組を(A,B)・(B,A)の順で送り、意味の同じ軸どうし(Aを先に送ったwould_a_accept_bとBを先に送ったwould_b_accept_aなど)の差の絶対値を全軸・全組で集めた中央値です。どちらかの順が失敗した組は中央値から除きます。ただし失敗が呼び出し全体の10%を超えたら不合格です(除いた組が多いと、残りの組だけで中央値が良く見えてしまい、本番で使えるかを判断できないため。失敗が多いこと自体も本番での切り替えや見送りの多さを意味します)。第一候補(TypeSafe)と予備(Anthropic)のそれぞれで判定します。
- Recall@0.60(正解yesの組のうち0.60を超えた割合・見逃しの少なさ)は合否に使い、基準は80%以上です。第一候補(TypeSafe)と予備(Anthropic)のそれぞれで判定し、採点できる正解yesの組が0件なら不合格です(オーナー決定 2026-10-26・LAT-114)。Precision@0.60は参考値で、合否には使いません。CIの照合も、記録にRecall@0.60が無いか基準未満なら落とします。スコアはLayer 5と同じ式(min(would_a_accept_b, would_b_accept_a)×補正係数C・Hard Constraintは通過とみなす)で、0.60を超えた組(Layer 5と同じ「>」)のうち正解yesの割合です。(A,B)の順の結果で数え、`jev_scored: false` の組は数えません。
- 記録は指紋を2種類持ちます。1つはファイルの指紋(`fingerprint`・指示文・realの呼び出し部品・期限の計算・第一候補と予備のつなぎ方・正規化の関数・ゴールドセットの各ファイルのSHA-256)、もう1つは描いた値の指紋(`fingerprintArtifacts`)です。描いた値の指紋は、Parserの指示文(固定の時刻 `2026-01-01T00:00:00+09:00` で描く)・出力スキーマ・Jevの問いと予備の指示文・出力スキーマ・モデル名・人数の注意表示・カテゴリの一覧・期限の選択肢を実際に作り、キーを辞書順に並べたJSONのSHA-256を取ったものです。共有の定数(`@latch/shared` のカテゴリや字数の上限など)だけを変えたときも採り直しになります。CIは両方を今の値から計算し直して照合し、TypeSafeが応答した版が固定した版(`TYPESAFE_MODEL`)だけであることも確かめます。
- 429はRetry-Afterだけ待って最大5回呼び直します(採点の中だけ)。記録(`eval/records/gate.json`)にはAPIキー・URL・応答の本文を入れず、失敗の内訳は件のidと項目だけを持ちます。

## 採点の実行

```bash
pnpm eval:gate   # ルートで実行。tools/eval/gate.ts を起動し eval/records/gate.json を書く
```

APIキー(`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`)は `tools/eval/.env`(git管理外)に置きます。形式の試験は `pnpm --filter eval test`。
