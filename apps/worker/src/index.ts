import { Hono } from "hono";
import type { AppEnv } from "./auth/middleware";
import { ChatRoomDO } from "./do/chat";
import { assertEnvSafety, type Env } from "./env";
import { authRoutes } from "./routes/auth";
import { userRoutes } from "./routes/users";

// 各ルートがBindingsにEnv・Variablesにauthクレームを期待する(docs/05 §3.1)
const app = new Hono<AppEnv>();

app.get("/healthz", (c) => c.json({ status: "ok" }));
// 認証API(docs/05 §3.2)
app.route("/v1/auth", authRoutes);
// ユーザーAPI(登録・me。Task 10でアイコン /v1/users/me/icon もこのサブアプリ配下に追加する・docs/05 §3.2)
app.route("/v1/users", userRoutes);

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
	// TODO(F3で実装): Queues consumer(match-events)。
	// F0では何もしない(=全メッセージをackする)
	queue: async () => {
		// ackのみ
	},
	// TODO(F3で実装): Cronハンドラ(bucket走査・期限切れバッチ等)。F0では何もしない
	scheduled: async () => {
		// 空実装
	},
};

// Durable Objectクラスはエントリポイント(main)からのexportが必要
export { ChatRoomDO };
