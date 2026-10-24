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
      # category: 食・飲み               # CATEGORIES(@latch/shared)のいずれか。nullは「categoryなし」
      # time_start: "2026-11-07T19:00:00+09:00"  # 時刻の同一性(Date.parseが等しい)で比べる。文字列一致ではない。nullは「時刻なし」
      # participants: { min: 2, max: 4 }  # 1以上・min<=max
      # budget: { min: 3000, max: 5000 }  # 片側はnull可。budget: null は「予算なし」
      alcohol_involved: false
      # geo_warning: true                # warnings.some(w => w.field === "geo") の真偽
```

## jev-pairs.yaml

`pairs` に次の形を並べます。a・b は正規化の関数(`buildNormalizedText`)に通す構造化データを直接書き、Parserの結果ではありません。`startsAt`・`endsAt` はオフセット付きISO 8601の文字列(読み込み時にDateへ変換)。`area` は任意で、地域名の比較に使います。

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
```

## 承認の手順

1. Claudeが下書きを置く(`approved_by_owner: null`)。
2. オーナーが読み、不自然な文や正解の判断の違いを指摘する。
3. 直した版をコミットし、**オーナーの確認が済んでから**`approved_by_owner`に日付を入れる。
4. 以後の変更もオーナーの承認を通す。

`approved_by_owner` が null のゴールドセットで採点した記録は合格として扱いません(CIの照合が落ちます)。

## 採点の実行

```bash
pnpm eval:gate   # ルートで実行。tools/eval/gate.ts を起動し eval/records/gate.json を書く
```

APIキー(`ANTHROPIC_API_KEY`・`TYPESAFE_API_KEY`)は `tools/eval/.env`(git管理外)に置きます。形式の試験は `pnpm --filter eval test`。
