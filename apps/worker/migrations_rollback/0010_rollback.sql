-- マイグレーション0010(migrations/0010_calibration_records.sql)と対になる「元に戻すマイグレーション」。
-- docs/11 §3: マイグレーションは「元に戻すマイグレーション」を必ず対で作成する。
-- migrations/ 配下はwrangler d1 migrationsの自動適用対象のため、本ファイルは
-- 別ディレクトリ migrations_rollback/ に置き、明示実行(--file)でのみ適用する。
-- 正解データ(LAT-108)で足した列(calibration_records.context・latches.calibrated_at)と3索引を撤去する。
-- 注意: 匿名化した行の提案の条件(人数・時間帯・市区町村)と、LATCHの正解データの作成済みの印が失われる。
-- 戻した後に作成の処理を動かすと、匿名化済みのLATCHの行が二重に作られるため、
-- 戻す前に正解データを作る版のWorkerを先に戻しておく。行(calibration_records)そのものは残る。

DROP INDEX `latches_calibrated_at_status_idx`;
--> statement-breakpoint
ALTER TABLE `latches` DROP COLUMN `calibrated_at`;
--> statement-breakpoint
DROP INDEX `calibration_records_anonymized_idx`;
--> statement-breakpoint
DROP INDEX `calibration_records_latch_id_uniq`;
--> statement-breakpoint
ALTER TABLE `calibration_records` DROP COLUMN `context`;
--> statement-breakpoint
-- 当て済みの記録を消し、直した同じ番号を wrangler d1 migrations apply で当て直せるようにする(docs/11 §3・LAT-88)
DELETE FROM `d1_migrations` WHERE `name` = '0010_calibration_records.sql';
