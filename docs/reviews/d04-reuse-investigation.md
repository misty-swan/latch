# D-04 再利用調査 — 旧実装(latch-legacy)から新規リポジトリへの再利用範囲

- 日付: 2026-10-17
- 対象: 旧リポジトリ latch-legacy(旧コンセプト=飲み・食事領域の段階的検証MVP。FastAPI backend・Vite+React frontend・Cloudflare Workers実装)
- 方法: 旧リポジトリの README・pyproject.toml・package.json・旧文書群(docs/)の確認
- 本書の位置づけ: 01 要件定義書 v0.5 の未決事項D-04(新規リポジトリの構成と再利用範囲)の確定記録

## 1. 新規リポジトリの構成(確定)

```
latch/
  docs/          # 文書群(正本)。01・02・reviews/
  prototype/     # UI実装基準のプロトタイプ(プロダクトオーナーが手配・配置)
  backend/       # 04(アーキテクチャ)・05(データモデル)策定後に骨組み作成
  frontend/      # 03(UX仕様)=新プロトタイプ確定後に骨組み作成
```

- 単一リポジトリ(モノレポ)。旧リポジトリと同じ形(docs/backend/frontend/prototype)とする
- 空ディレクトリは先に作らない。各領域は担当文書の策定時に作成する
- CI(GitHub Actions)は backend/frontend の骨組み作成時に旧 `.github/workflows/ci.yml` を参考に組む

## 2. 再利用判定(旧実装の資産ごと)

| 資産 | 判定 | 内容 |
|---|---|---|
| 開発基盤(compose常設環境・Makefile・mise/uv・ruff・pytest規律・CI) | **移植** | 旧と同じ開発規律を最初から適用する。毎コミットのlint/test・構造化ログ許可リスト・Clock抽象(実時間の直接参照禁止)の規律は新01も踏襲指定している |
| 認証(IdPトークン検証+JWT発行・回転式リフレッシュ・Redis失効リスト・prod起動ガード) | **移植** | ドメイン非依存でそのまま動く。テスト鍵(testkeys)・staging鍵生成CLIの運用も含む |
| 5層パイプライン骨格(Event Queue・debounce・idempotency・version・K上限・Jev予算・circuit breaker・縮退) | **移植+改修** | 改修点: form分岐(つながり/機会)・同一ペア提案履歴のLayer 1追加・時間Bucketを機会Intent限定へ縮小・つながりcompleted(チャット非活動90日)の判定バッチ |
| DBスキーマ(alembic) | **流用+改修** | 改修点: Intentへform/topic追加・time/geoのnullable化・提案履歴テーブル新設・nearby系(also通知)の除去。マイグレーション番号は新規採番(旧履歴は持ち込まない) |
| LLM統合(Parser/Embedding/Jev・stub/real両モード・精度ゲート資産) | **移植+拡張** | 拡張点: Parserへのform判定・topic抽出。期待値表・ゴールドセットは新ドメインで作り直す(01 D-03と同時) |
| 地物データ(PostGIS geofeatures・geo-download/import・逆ジオコーディング) | **移植(範囲は04で判断)** | 用途: 地域添付Intentの地名表示・機会Intentの地域表示。全国取り込みにするか一部分とするかは04の技術選定 |
| ブロック/通報/チャット/アプリ内通知(お知らせ) | **移植** | ドメイン変更は小さい。ブロックの即時適用・読み取り専用化もそのまま |
| プッシュ通知基盤 | **再設計(旧資産を参考)** | FCM+VAPID混在からWeb Push(VAPID)一本化。旧のService Worker(latch-push-sw.js)・pushRegistration.js・許可4状態の扱いの知見を参考にする |
| frontend(旧prototype v2基準のUI・vitest・Playwright E2E・録画ギャラリー) | **再構築(構成のみ移植)** | UIは新プロトタイプ基準で全て作り直す。構成(Vite+React・vitest・Playwright・E2E録画ギャラリー)と設計パターン(fetchモック・開発用トークンパネル等)は同じ形で作る |
| Cloudflare実装(Workers+D1+Queues・契約試験) | **保留** | v1.0の配備先決定(04の技術選定)まで作らない。二重実装の維持コストを先に払わない |
| テスト資産(unit・integration・contract・E2E) | **形式を移植・中身は新規** | 旧テストは旧ドメイン(時間・場所必須)前提。テストの書き方・構成・規律は流用する |
| 旧文書群(docs/00〜13・plans・reviews・testassets) | **アーカイブ参照** | latch-legacy の docs/ を読み物として参照する。新docsへは必要な規定だけを01・02が引き継いだ(「踏襲」の引用元) |

## 3. 開発着手時の順序

1. **04(アーキテクチャ)・05(データモデル・API)の策定** — 配備先(PostgreSQL単独か、Cloudflare継続か)とスキーマ改修の方針を確定する。これがbackend骨組みの前提
2. **backend骨組み** — 旧リポジトリから開発基盤・認証・パイプライン骨格・LLM統合をコピーし、新ドメイン(Intent 2形式・提案履歴)で再構築する
3. **frontend骨組み** — 新プロトタイプの確定後に、構成のみ流用して作り直す(PWA・Web Push含む)
4. **テスト・CI** — 02の対応表(#1〜#35)を社内クローズドテスト(#34)の試験計画へ展開する

## 4. 決定

上記のとおりD-04を確定する。01第26節の当該行を解消し、残る未決はD-02(初期ユーザー獲得施策)・D-03(topic/categoryの初期セット)・D-05(ネイティブアプリ着手基準)の3件とする。
