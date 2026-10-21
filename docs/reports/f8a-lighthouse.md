# F8a Lighthouse 監査の記録

F8a(PWAと仕上げ)の設計書 §4.2 に基づく、現行 Lighthouse(性能・アクセシビリティ・ベストプラクティス)の実行記録。実装の担当(エージェント)が実行した。

## 実行条件

| 項目 | 内容 |
|---|---|
| 実行日 | 2026-10-21 |
| Lighthouse の版 | 13.5.0(`npx lighthouse@13.5.0`) |
| 対象 URL | `http://localhost:8799/welcome`(サインインなしで開ける画面) |
| 配信 | 本番ビルド(`VITE_DEV_AUTH` なし)を `wrangler dev --local` の Workers Assets から配信(同一オリジン) |
| 端末の想定 | モバイル(`--form-factor=mobile`。Lighthouse 既定の低速 4G 相当・CPU 4 倍遅延のシミュレーション) |
| ブラウザ | Playwright 同梱の HeadlessChrome 156(`--headless=new --no-sandbox`) |

注意: ローカルのサーバーは圧縮や CDN を通さない。Cloudflare 上の本番では転送が速くなる見込みだが、数値は本番のものではない。

## 結果

| カテゴリ | 点数 |
|---|---|
| 性能(Performance) | 97 |
| アクセシビリティ(Accessibility) | 98 |
| ベストプラクティス(Best Practices) | 100 |

性能の主な指標: First Contentful Paint 2.0 秒(0.85)・Largest Contentful Paint 2.3 秒(0.94)・Total Blocking Time 0 ミリ秒・Cumulative Layout Shift 0・Speed Index 2.0 秒。

## 主な指摘(点数が満点でない監査項目)

| # | カテゴリ | 監査項目 | 内容 |
|---|---|---|---|
| 1 | 性能 | Render-blocking requests | 描画をふさぐ読み込みがあり、約 300 ミリ秒の短縮余地 |
| 2 | 性能 | Reduce unused JavaScript | 使われていない JavaScript が約 134 KiB(初回表示に不要な画面のコードも同じ束に入っている) |
| 3 | 性能 | Network dependency tree | 読み込みの連鎖が長い(上の 1 と同じ原因の指摘) |
| 4 | アクセシビリティ | landmark-one-main | `main` ランドマークが無い(画面の本体を `main` 要素で囲っていない) |
| 5 | ベストプラクティス | valid-source-maps | 大きな自前 JavaScript にソースマップが無い(点数には影響しない参考表示) |

## 扱い

- 点数が満点でない指摘は、この作業では直さず記録に留める。対応するかどうかはF8b以降の判断とする。
- 実行結果の JSON(`lh.json`)は大きいためコミットしない。再実行は次のコマンドで行う。

```bash
# 事前: pnpm --filter web build と wrangler dev --local --port 8799 を起動しておく
cd apps/web
npx lighthouse@13.5.0 http://localhost:8799/welcome \
  --only-categories=performance,accessibility,best-practices --form-factor=mobile \
  --chrome-path="$(node -e 'console.log(require("@playwright/test").chromium.executablePath())')" \
  --chrome-flags="--headless=new --no-sandbox" --output=json --output-path=/tmp/lh.json
```

(Lighthouse を実行し、結果を JSON ファイルへ書き出すコマンド。数十秒かかる。)
