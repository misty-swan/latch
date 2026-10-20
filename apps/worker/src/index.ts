import type { MatchQueueMessage } from "@latch/shared";
import { Hono } from "hono";
import type { AppEnv } from "./auth/middleware";
import { systemClock } from "./clock/clock";
import { ChatRoomDO } from "./do/chat";
import { assertEnvSafety, type Env } from "./env";
import { internalOnError } from "./http/errors";
import { handleQueueBatch } from "./pipeline/consumer";
import { runScheduledPipeline } from "./pipeline/cron";
import { authRoutes } from "./routes/auth";
import { devRoutes } from "./routes/dev";
import { iconRoutes } from "./routes/icons";
import { intentRoutes } from "./routes/intents";
import { latchRoutes } from "./routes/latches";
import { userRoutes } from "./routes/users";

// 各ルートがBindingsにEnv・Variablesにauthクレームを期待する(docs/05 §3.1)
const app = new Hono<AppEnv>();

// 未捕捉例外はerrorJson形状の500 INTERNALに倒す(エラー応答は1形状のみ・docs/05 §3.1)
app.onError(internalOnError);

app.get("/healthz", (c) => c.json({ status: "ok" }));
// 認証API(docs/05 §3.2)
app.route("/v1/auth", authRoutes);
// ユーザーAPI(登録・me・docs/05 §3.2)
app.route("/v1/users", userRoutes);
// アイコンAPI(POST/DELETE /v1/users/me/icon・GET /v1/users/{user_id}/icon・docs/05 §3.2)。
// userRoutesと同じ /v1/users にマウントする(userRoutes側に /me/icon と
// /:user_id/icon の形のルートは無いため競合しない)
app.route("/v1/users", iconRoutes);
// Intent API(構造化プレビュー・作成・一覧・取得・更新・削除・docs/05 §3.2)。
// pause/resumeは後続タスクでintentRoutesに追加する
app.route("/v1/intents", intentRoutes);
// LATCH(提案)API(一覧・取得・回答・取り消し・離脱・見送り理由・F4a設計 §4.1)
app.route("/v1/latches", latchRoutes);
// dev専用サインインAPI(POST /v1/dev/idp-token・F2'計画Task 2)。テスト鍵モードの
// ローカル/CI/E2Eでのみ存在し、prodでは404+起動ガードの二重防御(docs/10 §2)
app.route("/v1/dev", devRoutes);

// prod起動ガードはisolateごとに1回だけ(docs/04 §4・docs/10 §2)。
// Workersに起動フックはないため、モジュール変数フラグでfetchの先頭から1回だけ呼ぶ
let envSafetyChecked = false;

// 単一Worker: api(受信リクエスト処理)と pipeline(queue/cron)を出口分岐する(docs/04 §2)
export default {
	fetch: async (
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> => {
		if (!envSafetyChecked) {
			assertEnvSafety(env);
			envSafetyChecked = true;
		}
		return app.fetch(request, env, ctx);
	},
	// Queues consumer(match-eventsとmatch-events-dlq・docs/06 §2・§5)。
	// 消費は例外を外へ出さない(=全メッセージack)。失敗はイベント行のstatusで記録する。
	// 単体・統合試験では自動消費しない(vitest.config.tsだけが持つTEST_QUEUES_DISABLED
	// バインディングで判定・消費の試験はhandleQueueBatchの直接呼びで行う)
	queue: async (
		batch: MessageBatch<MatchQueueMessage>,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> => {
		if (env.TEST_QUEUES_DISABLED !== undefined) {
			return;
		}
		await handleQueueBatch(batch, env, ctx, systemClock);
	},
	// Cron(毎分・docs/04 §4・docs/06 §2)。bucket走査・catch-up・期限切れ2窓・
	// 埋め込みバックフィル・未評価回収・遅延再評価・保持期間削除を実行する
	scheduled: async (
		_controller: ScheduledController,
		env: Env,
		_ctx: ExecutionContext,
	): Promise<void> => {
		await runScheduledPipeline(env, systemClock);
	},
};

// Durable Objectクラスはエントリポイント(main)からのexportが必要
export { ChatRoomDO };
