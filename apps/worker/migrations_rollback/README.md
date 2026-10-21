このディレクトリは、D1スキーマを元に戻すためのマイグレーション(戻すマイグレーション)を置く場所です。docs/11 §3の「マイグレーションは元に戻すマイグレーションを必ず対で作成する」規律の運用手順にあたり、`migrations/`(wranglerが自動適用する正規ディレクトリ)とは別のディレクトリに置くことで、wranglerの自動適用対象外とします。適用は `wrangler d1 execute latch-db --file=migrations_rollback/0000_rollback.sql --local`(リモート環境では `--remote`)のように環境指定付きで明示実行してください。初回マイグレーションは `migrations/0000_initial_schema.sql`(drizzle-kit生成・2026-10-17作成)で、本ディレクトリの `0000_rollback.sql`(同日作成)はその対です。以降のマイグレーション `NNNN_xxx.sql` を追加する際は、対となる `migrations_rollback/NNNN_rollback.sql` を同じタイミングで作成してください。


0006(通報のtarget・message_id列と検索索引)の対は `0006_rollback.sql`(2026-10-21作成)です。0006はtargetをDEFAULTなしのNOT NULLで追加するため、staging・prodへ適用する前に `SELECT COUNT(*) FROM reports` が0であることを確かめてください(F7a以前は書き込みAPIが無く0のはずです。行があればALTERは止まり、データは壊れません)。
