/**
 * Web Pushの許可と購読(設計書 §3.1・docs/05のpush API)。
 * - ブラウザの許可とpushManagerはPushEnvで差し替えられる(試験では偽物を渡す)
 * - 有効化: 許可を求める→VAPID公開鍵の取得→pushManager.subscribe→POST /v1/push-subscriptions。
 *   途中で失敗したら作った購読を外してoffへ戻す
 * - 無効化: 購読があればDELETE /v1/push-subscriptions→unsubscribe。
 *   ログアウトでは失敗を飲む版(disablePushQuietly)を使う
 */

import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";

/** ブラウザの通知・プッシュの窓口 */
export type PushEnv = {
	permission(): NotificationPermission | "unsupported";
	requestPermission(): Promise<NotificationPermission>;
	/** 登録済みのService WorkerのpushManager。登録が無ければ待たずにnull(状態の確認・解除用) */
	pushManager(): Promise<PushManager | null>;
	/** 有効なService WorkerのpushManager。有効になるまで待つ(購読の作成用・呼び出し側で時間を区切る) */
	readyPushManager(): Promise<PushManager | null>;
};

/** unsupported=非対応・denied=ブラウザで拒否済み・off=購読なし・on=購読あり */
export type PushStatus = "unsupported" | "denied" | "off" | "on";

/** Service Workerが有効になるのを待つ上限(過ぎたら購読せずoff) */
export const SW_READY_TIMEOUT_MS = 5_000;
/** ログアウト時の購読の後始末の上限(過ぎたらログアウトを先へ進める) */
export const DISABLE_TIMEOUT_MS = 5_000;

const isSupported = (): boolean =>
	typeof Notification !== "undefined" &&
	typeof navigator !== "undefined" &&
	"serviceWorker" in navigator &&
	typeof PushManager !== "undefined";

/** 実際のブラウザのPushEnv */
export const browserPushEnv: PushEnv = {
	permission: () => (isSupported() ? Notification.permission : "unsupported"),
	requestPermission: () => Notification.requestPermission(),
	pushManager: async () => {
		if (!isSupported()) {
			return null;
		}
		// readyと違い・登録が無ければすぐundefinedで解決する
		const registration = await navigator.serviceWorker.getRegistration();
		return registration?.pushManager ?? null;
	},
	readyPushManager: async () => {
		if (!isSupported()) {
			return null;
		}
		const registration = await navigator.serviceWorker.ready;
		return registration.pushManager ?? null;
	},
};

const TIMED_OUT = Symbol("timed-out");

/** promiseをmsで区切る。過ぎたらTIMED_OUTで解決する */
const withTimeout = <T>(
	promise: Promise<T>,
	ms: number,
): Promise<T | typeof TIMED_OUT> => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
		timer = setTimeout(() => resolve(TIMED_OUT), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
};

/** base64urlの公開鍵をsubscribeへ渡すバイト列へ変える */
const base64UrlToBytes = (value: string): Uint8Array<ArrayBuffer> => {
	const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
};

/** この端末の通知の状態(on=許可済みかつ購読あり) */
export const getPushStatus = async (
	env: PushEnv = browserPushEnv,
): Promise<PushStatus> => {
	const permission = env.permission();
	if (permission === "unsupported" || permission === "denied") {
		return permission;
	}
	if (permission === "default") {
		return "off";
	}
	// 許可済みでもService Workerの登録が無ければ購読も無い(対応ブラウザなのでoff)
	const manager = await env.pushManager();
	if (manager === null) {
		return "off";
	}
	return (await manager.getSubscription()) ? "on" : "off";
};

/** 許可を求めて購読し・サーバーへ登録する。結果の状態を返す */
export const enablePush = async (
	env: PushEnv = browserPushEnv,
): Promise<PushStatus> => {
	if (env.permission() === "unsupported") {
		return "unsupported";
	}
	let subscription: PushSubscription | null = null;
	try {
		const permission = await env.requestPermission();
		if (permission === "denied") {
			return "denied";
		}
		if (permission !== "granted") {
			return "off";
		}
		// 購読の作成だけは有効なService Workerが要る。来なければoff(非対応ではない)
		const manager = await withTimeout(
			env.readyPushManager(),
			SW_READY_TIMEOUT_MS,
		);
		if (manager === TIMED_OUT || manager === null) {
			return "off";
		}
		const { public_key } = await apiFetch<{ public_key: string }>(
			"/push/vapid-public-key",
		);
		subscription = await manager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: base64UrlToBytes(public_key),
		});
		const { endpoint, keys } = subscription.toJSON();
		await apiFetch("/push-subscriptions", {
			method: "POST",
			json: {
				endpoint,
				keys: { p256dh: keys?.p256dh, auth: keys?.auth },
			},
		});
		return "on";
	} catch {
		// 登録できなかった購読を残すと・サーバーが知らない購読が端末に残るため外す
		await subscription?.unsubscribe().catch(() => false);
		return "off";
	}
};

/** 購読があればサーバーから外してから端末の購読も外す */
export const disablePush = async (
	env: PushEnv = browserPushEnv,
): Promise<void> => {
	// 許可していなければ購読は作れていない
	if (env.permission() !== "granted") {
		return;
	}
	const manager = await env.pushManager();
	const subscription = await manager?.getSubscription();
	if (!subscription) {
		return;
	}
	try {
		await apiFetch("/push-subscriptions", {
			method: "DELETE",
			json: { endpoint: subscription.endpoint },
		});
	} finally {
		// サーバーへ届かなくても・この端末には以後届かないよう購読は外す
		await subscription.unsubscribe();
	}
};

/** ログアウト用。失敗を飲み・時間も区切る(トークンの破棄を止めない) */
export const disablePushQuietly = async (
	env: PushEnv = browserPushEnv,
): Promise<void> => {
	await withTimeout(
		disablePush(env).catch(() => undefined),
		DISABLE_TIMEOUT_MS,
	);
};

/**
 * 退会用。この端末の購読だけを外す(サーバーの購読は退会の処理が消しているため・APIは呼ばない)。
 * 失敗を飲み・時間も区切る
 */
export const forgetPushOnDevice = async (
	env: PushEnv = browserPushEnv,
): Promise<void> => {
	const forget = async (): Promise<void> => {
		if (env.permission() !== "granted") {
			return;
		}
		const manager = await env.pushManager();
		const subscription = await manager?.getSubscription();
		await subscription?.unsubscribe();
	};
	await withTimeout(
		forget().catch(() => undefined),
		DISABLE_TIMEOUT_MS,
	);
};

/** 通知の状態のキャッシュのキー(有効化・無効化の後はsetQueryDataで結果を入れる) */
export const PUSH_STATUS_QUERY_KEY = ["push-status"] as const;

/** この端末の通知の状態 */
export const usePushStatus = () =>
	useQuery({
		queryKey: PUSH_STATUS_QUERY_KEY,
		queryFn: () => getPushStatus(),
	});
