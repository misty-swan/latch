import { Hono } from "hono";
import type { AppEnv } from "./auth/middleware";
import { ChatRoomDO } from "./do/chat";
import { assertEnvSafety, type Env } from "./env";
import { internalOnError } from "./http/errors";
import { authRoutes } from "./routes/auth";
import { devRoutes } from "./routes/dev";
import { iconRoutes } from "./routes/icons";
import { intentRoutes } from "./routes/intents";
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
