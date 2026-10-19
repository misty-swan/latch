/**
 * E2E起動前の残置データ後始末(worker E2EのwebServerチェーンで実行)。
 * 過去回のE2Eで作成され後始末されなかったIntent(失敗時に残る)をexpiredへ倒し、
 * マッチングパイプラインE2Eの観測対象から外す。
 *
 * なぜ必要か: ローカルD1は実行間で永続する(helpers.tsの汚染回避コメント参照)。
 * activeのまま残ったIntentは、パイプラインE2EがGET /__scheduledでCronを発火した
 * 項に埋め込みバックフィル(docs/06 §2(e))でベクトル化され、検索取り出し幅
 * (topK=100)を汚染して観測を非決定にする。対象はE2Eユーザー(subjectの接頭辞
 * e2e-・apps/worker/e2e/helpers.tsとapps/web/e2e/helpers.tsの両方)に限定するため、
 * 手元開発で作ったデータには触れない。CIは常に空のD1から始まるため効果は同一
 *
 * 実行タイミング: マイグレーション適用の後(webServerのcommandチェーン内)。
 */
import { execSync } from "node:child_process";

const command =
	"UPDATE intents SET status = 'expired' WHERE status = 'active' AND user_id IN (SELECT id FROM users WHERE auth_subject LIKE 'e2e-%')";

execSync(`wrangler d1 execute DB --local --command "${command}"`, {
	stdio: "inherit",
});
