/**
 * Web Pushの本文とTTL(F7b設計 §5.4)。本文は固定の汎用文だけで、IDなどは載せない。
 */

export type PushNotificationType = "proposal" | "matched";

export const PUSH_BODIES: Record<PushNotificationType, string> = {
	proposal: "提案が届いています。詳細はアプリでご確認ください。",
	matched: "つながりが成立しました。詳細はアプリでご確認ください。",
};

/** ペイロードは {type, body} だけ */
export function pushPayload(type: PushNotificationType): string {
	return JSON.stringify({ type, body: PUSH_BODIES[type] });
}

const MIN_TTL = 60;
const MAX_TTL = 86_400;

/** proposal は回答期限までの秒(60〜86,400)・matched は86,400(F7b設計 §5.4) */
export function pushTtlSeconds(
	type: PushNotificationType,
	now: Date,
	responseDeadline: Date | null,
): number {
	if (type === "matched" || responseDeadline === null) return MAX_TTL;
	const sec = Math.floor((responseDeadline.getTime() - now.getTime()) / 1000);
	return Math.min(MAX_TTL, Math.max(MIN_TTL, sec));
}
