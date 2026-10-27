-- マイグレーション0009(migrations/0009_recent_vectors.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- 直近のベクトルの控え(recent_vectors・#47)の表と索引を撤去する。
-- 注意: 失われるのは埋め込みから15分以内のベクトルの控えだけで、意思やVectorizeのベクトルは残る。
-- 戻す前に、表へ書き込む・読む版のWorkerを先に戻しておく(書き込みの失敗はログだけで進むが、ログが毎回出る)。

DROP INDEX `recent_vectors_embedded_at_idx`;
--> statement-breakpoint
DROP TABLE `recent_vectors`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0009_recent_vectors.sql';
