# LATCH リポジトリ エージェント指示

## 現在の状態

- 文書駆動開発のフェーズ。`docs/`(00〜12)が製品仕様の正本。実装はF0骨組み(モノレポ・wrangler・D1初回マイグレーション・CI・stub LLM・Clock・ログ許可リスト)・F1アカウント(auth 3API・users登録/me・アイコンR2)・F2 Intent API(parse/CRUD/draft→active/期限・form検証・pause/resume・Active Intent上限5件)・F2'フロント基盤(web基盤(apiFetch・Router・Query・latch.css移植)・dev専用サインイン(POST /v1/dev/idp-token・テスト鍵・prod拒否の二重防御)・Workers Assets同一オリジン配信(SPAフォールバック)・ようこそ〜サインイン/登録/同意・預ける〜読み解き確認・Home一覧・PWA設定)・F3パイプライン前段(Queues消費2段(Embedding→upsert確認→embedding_completed→Layer 2 Candidate Retrieval→Layer 1→Layer 3)・Embedding real実装(Workers AI bge-m3・LATCH_EMBEDDING_MODE分離)・VectorStore抽象(LATCH_ENV=localはインメモリ・staging/prodはVectorize)・層別計測(match_events.payload+Analytics Engine+許可リストログ)・毎分Cron(bucket/catch-up/期限切れ2窓/バックフィル/未評価回収/遅延再評価/保持期間・評価本体の直接呼び出し)・dev専用観測API(GET /v1/dev/match-events・match-candidates)・Intent削除のベクトル先行削除・D1照会のチャンク化(48件/100件))・F4a 1対1の提案〜成立(Jevの差し替え口とstub(目印__jev_low__/__jev_timeout__)・予算の起点側計上とcircuit breaker(PIPELINE_KV)・Layer 4〜5・提案化の直列化(proposal_history確保を1文目に置く1バッチ)・通知上限と保留・回答(yes/defer/no・取り消し・leave・見送り理由)と同時YESの1バッチ判定・機会の排他・回答期限切れ・再提案規則・/v1/latches API(成立前はproposal・membersを出さない)・Cron(f)予算アラート/(i)提案クローズ後続/pending掃査・dev専用backdateと観測API)まで完了。F2のゲート「02 §4の#1〜#5(Intent E2E緑)」・F2'のゲート「画面フローが`prototype/`基準であること」・F3のゲート「02 §4の#6〜#11・#13」・F4aのゲート「02 §4の#12・#14・#15・#18〜#20・#23と#17のAPI部分」を証明済み(worker E2E 32本・web E2E 8本=Playwright chromium・CIジョブあり。F3はE2Eと統合試験の分担で証明・10 §4)。F4はF4a/F4b/F4cに3分割(2026-10-20オーナー合意・docs/12 §2の決定記録)。次はF4b(グループLATCH・#24)→F4c(提案〜成立の画面・#17のUI 2択)。Parser/Jevのreal接続と精度ゲートはF9前の独立工程。索引は `docs/00-document-roadmap.md`
- 注記: レート制限(60req/分・作成20/日・更新6/時)と退会DELETE /v1/users/me(05 §2.5)は後続フェーズで計上。Active Intent上限(5件)はF2で実装済み。Cronの(f)予算アラート・(i)提案クローズ後続処理はF4aで実装済み・(d)つながりLATCH completed判定はF5で計上。F3は未決D-C-01/D-C-02を暫定案(K_v=50・0.7/0.3)で着手済み(調整は運用データ後・06 §8)。F2'で実装した画面はwelcome〜confirmとhomeのみで、提案・回答の画面はF4c・チャット画面等の残りのUIはF5〜F8で計上。本番IdP(Google/Apple)への接続はF10公開準備前に実施
- 03(UX仕様)は不作成(2026-10-18オーナー裁定・docs/00の決定記録)。`prototype/` がUIの正本(README・project/latch.css)で、実装側のスタイリング正本は`apps/web/src/styles/latch.css`(prototypeから不改変コピー・docs/04 §3.2)
- READMEは現在没有。リポジトリの案内はこのファイルとdocs/00が担う
- ローカルでE2Eを実行するときの注意: 既定ポートはworker E2E=8787・web E2E=8788で分離している。他プロセスがポートを占有している場合は `LATCH_E2E_PORT=<空きポート>` で回避する(占有側のプロセスは停止しない・webとworkerには別ポートを割り当てる)

## 絶対に守ること

1. **コミットは `git add <パス>` で対象を限定する。**`git add -A`・`git commit -a` は禁止
2. **レガシー実装への言及をしない。**旧リポジトリ・旧実装を参照・引用する表現は文書にもコードにも入れない(docs は自己完結が確定方針)。既存文書を編集する際もこの方針を壊さない
3. **応答とコミットメッセージは日本語。**文書も日本語で書く

## docs の扱い(必要に応じて変更してよい)

- docs は固定物ではなく、必要に応じてエージェントが変更してよい。ただし `docs/00` §3 の運用ルールに従う:
  - 変更した文書は版数を上げ、冒頭に変更点行を追記する
  - 「前提文書」欄と 00 §1 の版数表を実態に揃える(版数の食い違いは過去にレビューで大量指摘された)
  - 数値・用語は文書横断で一致させる(閾値・期限・K上限等の主要値は01・04〜06・02を行き来する)
- 未決事項はD-IDで管理(製品レベル=01のD-xx、技術は各文書ローカルのD-A〜F)。解消済みIDは再利用しない。台帳は00 §4
- プロダクトオーナーの判断を要する事項は、決定を「決定内容/根拠/影響」の形式で該当文書に記録する(独断で決めない。ただし軽微な技術的事項は文書の裁量で確定してよい)

## 用語の統一(ぶれると実装バグになる)

- 「機会Intent(form=occasion)」「つながりIntent(form=connection)」。「機会form」等の表記は使わない
- 検索層は「Layer 2 Candidate Retrieval」(「Vector Search」と呼ばない)。通知は「アプリ内通知」(「お知らせ」は使わない)
- 数値の単位は「1日30,000回」「1か月600,000回」「p95 0.5秒」の形式(「日次/月次」「500ms」の混在は禁止)
- 文書間参照は「文書番号 §節番号」(例: 01 §8)。「〜相当」表記は使わない

## 確定済みの重要裁定(再議しない)

- 段階リリース(MVP・クローズドベータ)は行わない。v1.0完成形を作り切って一発公開(品質保証としての社内クローズドテストのみ)
- visibilityはhidden_until_match単値(成立前の条件サマリは一切開示しない)。一致度(LATCH Score)はUIに表示しない
- 同一ユーザーペアの恒久排除は「成立・明示の拒否(no)」のみ。見送り(defer)後の条件付き再提案は機会Intentのみ可
- 回答UIは2択: yes=[参加する] / defer=[今回は見送る]。noはUIに置かずAPI専用
- チャットはリアルタイム(Durable Objects + WebSocket・メッセージの正はD1)

## 実装開始後の環境メモ(F0〜)

- TypeScript単一言語・pnpmモノレポ(apps/web・apps/worker・packages/shared)・Cloudflare(Workers/D1/Vectorize/Queues/DO/R2/KV)
- ローカル開発は `wrangler dev` のエミュレータで完結(Cloudflareアカウント不要。デプロイ時のみトークンが必要・prodは手動承認トリガー)
- LLMは既定stub(決定的・課金なし)。real適用は精度ゲート(07 §6)合格が条件
- 工程とゲートは `docs/12` のF0〜F10に従い、完了は02 §4の#1〜#35で証明する

## グローバル指示(~/.config/opencode/AGENTS.md より重複掲載)

以下はグローバル設定(~/.config/opencode/AGENTS.md)からも読み込まれるが、このファイル単独でも機能するよう重複して掲載する。

# Global instructions

- Think and reason in English, but always write your responses in Japanese.
- The user's input language does not matter: responses must always be in Japanese.
- Use `rg` instead of `grep`

## Explanation style

- Assume I have no hands-on software development experience.
- Avoid terse, telegraphic replies. Along with the conclusion, briefly explain what you are doing and why.
- When using a technical term for the first time (e.g., repository, build, migration, dependency), add a short plain-language gloss.
- When showing a command or procedure, add a one-line note on what it does and what happens when it runs.
- When something fails, don't fall back to apologies or boilerplate. Explain what is happening and what you will do next, in order.
- Still don't be verbose: the goal is clarity for a non-engineer, not longer answers.
