-- マイグレーション0004(migrations/0004_group_member_left_at.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- グループLATCHで足した列(latch_members.left_at)を撤去する。
-- 注意: 離脱時刻の記録は失われる(離脱済みメンバーの行は残るため、戻す前にグループLATCHを止めること)。

ALTER TABLE `latch_members` DROP COLUMN `left_at`;
