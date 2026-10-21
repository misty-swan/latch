/**
 * Web Pushの送り手の差し替え口(F7b設計 §5.2・§5.4・§5.5)。
 * stubは外部へ送らず常に成功、realはRFC 8291の暗号化とVAPID署名で実送信する。
 */

import { type Env, vapidKeysOf } from "../env";
import { encryptAes128gcm } from "./encrypt";
import { type VapidKeys, vapidAuthorization } from "./vapid";

export interface PushTarget {
	endpoint: string;
	p256dh: string;
	auth: string;
}

export type PushSendResult =
	| { kind: "ok" }
	| { kind: "gone" }
	| { kind: "rejected"; status: number }
	| { kind: "retry"; status: number | null };

export interface PushSender {
	send(
		target: PushTarget,
		payload: string,
		opts: { ttl: number; urgency: "high" },
	): Promise<PushSendResult>;
}

/** 外部へ送らず常に成功(テスト・E2Eを外部のPushサービスに依存させない・F7b設計 §5.5) */
export const stubPushSender: PushSender = {
	async send() {
		return { kind: "ok" };
	},
};

const fromBase64Url = (s: string): Uint8Array =>
	new Uint8Array(Buffer.from(s, "base64url"));

/** F7b設計 §5.2の応答の写像 */
const classify = (status: number): PushSendResult => {
	if (status >= 200 && status < 300) return { kind: "ok" };
	if (status === 404 || status === 410) return { kind: "gone" };
	if (status === 400 || status === 403 || status === 413) {
		return { kind: "rejected", status };
	}
	return { kind: "retry", status };
};

export const realPushSender = (
	keys: VapidKeys,
	fetchImpl: typeof fetch = fetch,
): PushSender => ({
	async send(target, payload, opts) {
		try {
			const body = await encryptAes128gcm(
				new TextEncoder().encode(payload),
				fromBase64Url(target.p256dh),
				fromBase64Url(target.auth),
			);
			const authorization = await vapidAuthorization(
				target.endpoint,
				keys,
				new Date(),
			);
			const res = await fetchImpl(target.endpoint, {
				method: "POST",
				headers: {
					"Content-Encoding": "aes128gcm",
					"Content-Type": "application/octet-stream",
					TTL: String(opts.ttl),
					Urgency: opts.urgency,
					Authorization: authorization,
				},
				body,
			});
			return classify(res.status);
		} catch {
			// ネットワーク例外・暗号化の失敗は一時失敗として回収に任せる(§5.2)
			return { kind: "retry", status: null };
		}
	},
});

/** LATCH_PUSH_MODE(既定stub)に応じた送り手を返す(F7b設計 §5.5) */
export const pushSenderOf = (env: Env): PushSender =>
	env.LATCH_PUSH_MODE === "real"
		? realPushSender(vapidKeysOf(env))
		: stubPushSender;
