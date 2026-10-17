import { DurableObject } from "cloudflare:workers";

/**
 * チャットルームのDurable Object(成立LATCHごとに1DO・docs/04 §2/§4)。
 * TODO(F6で実装): WebSocket(Hibernation API)でのリアルタイム配信。
 * メッセージの正はD1であり、DOは配信を担う。
 */
export class ChatRoomDO extends DurableObject {
	async fetch(): Promise<Response> {
		return new Response("not implemented (F6)", { status: 501 });
	}
}
