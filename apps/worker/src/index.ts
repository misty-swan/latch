import { Hono } from "hono";
import { ChatRoomDO } from "./do/chat";

const app = new Hono();

app.get("/healthz", (c) => c.json({ status: "ok" }));

// 単一Worker: api(受信リクエスト処理)と pipeline(queue/cron)を出口分岐する(docs/04 §2)
export default {
	fetch: app.fetch,
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
