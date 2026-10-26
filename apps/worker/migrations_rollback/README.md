このディレクトリは、D1スキーマを元に戻すためのマイグレーション(戻すマイグレーション)を置く場所です。docs/11 §3の「マイグレーションは元に戻すマイグレーションを必ず対で作成する」規律の運用手順にあたり、`migrations/`(wranglerが自動適用する正規ディレクトリ)とは別のディレクトリに置くことで、wranglerの自動適用対象外とします。適用は `wrangler d1 execute latch-db --file=migrations_rollback/0000_rollback.sql --local`(リモート環境では `--remote`)のように環境指定付きで明示実行してください。初回マイグレーションは `migrations/0000_initial_schema.sql`(drizzle-kit生成・2026-10-17作成)で、本ディレクトリの `0000_rollback.sql`(同日作成)はその対です。以降のマイグレーション `NNNN_xxx.sql` を追加する際は、対となる `migrations_rollback/NNNN_rollback.sql` を同じタイミングで作成してください。


0006(通報のtarget・message_id列と検索索引)の対は `0006_rollback.sql`(2026-10-21作成)です。0006はtargetをDEFAULTなしのNOT NULLで追加するため、staging・prodへ適用する前に `SELECT COUNT(*) FROM reports` が0であることを確かめてください(F7a以前は書き込みAPIが無く0のはずです。行があればALTERは止まり、データは壊れません)。

0007(通知のWeb Push記録の3列と2索引)の対は `0007_rollback.sql`(2026-10-21作成)です。0007の列はすべてnull可かDEFAULT付きのため、適用前の確認は要りません。戻すと送出状態(push_state)と試行時刻、intent_expired通知の対象Intentが失われます。intent_expired通知の行自体は残るため、戻した後にそれらの行を表示する経路があれば先に止めてください。

0008(match_eventsの2索引)の対は `0008_rollback.sql`(2026-10-23作成)です。0008は索引の追加だけで、列やデータは変わらないため適用前の確認は要りません。戻すとデータは失われませんが、意思の削除APIとCronの掃査(未処理・反映待ち)が全件走査に戻って遅くなります。

0009(直近のベクトルの控えの表recent_vectorsと索引・#47)の対は `0009_rollback.sql`(2026-10-25作成)です。0009は新しい表の追加だけで、既存の表は変わらないため適用前の確認は要りません。戻すと埋め込みから15分以内のベクトルの控えが失われ、Layer 2 Candidate Retrievalの補いが無くなります(意思とVectorizeのベクトルは残ります)。表を使う版のWorkerを先に戻してから適用してください。

0010(正解データの列calibration_records.context・latches.calibrated_atと3索引・LAT-108)の対は `0010_rollback.sql`(2026-10-26作成)です。0010の列はすべてnull可で、索引の一意性(calibration_recordsのlatch_id)は0010より前に行を書く処理が無かったため、適用前の確認は要りません。戻すと匿名化した行の提案の条件と、LATCHごとの作成済みの印が失われます。印が無いと匿名化済みのLATCHの行を二重に作るため、正解データを作る版のWorkerを先に戻してから適用してください。
