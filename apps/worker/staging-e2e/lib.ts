/**
 * stagingの通し試験(02 #34・docs/10 §4・LAT-106)の共通部品。
 * 手元のE2E(e2e/helpers.ts)と違い、次のものに頼らない:
 * - 手元の秘密鍵での署名(stagingの鍵は手元に無い): サインインはdev専用のPOST /v1/dev/idp-tokenで行う
 * - GET /__scheduled・手元のD1への書き込み: 待ちは実時間で、パイプラインの進み具合は
 *   dev専用の観測API(05 §3.3)で確かめる。観測APIはレート制限の対象外(04 §5)のため、
 *   待ちの問い合わせで制限に当たらない
 * - stubの決まった値: 本物のAIの出力は揺れるため、形式・必須の欄・提案が生まれること等で確かめる
 * 宛先のURLは出力に出さない(包みscripts/staging-e2e.mjsが出力を伏せる。ここでもパスだけを出す)。
 * 試験用の利用者のsubjectは`stg-e2e-<実行の印>-<役>-<乱数>`で、作る前に実行の記録へ書き、
 * 包みが試験の後に退会させて後始末する(docs/runbooks/staging.md 8章)
 */

import { appendFileSync } from "node:fs";
import type { LatchDTO, LatchResponseValue } from "@latch/shared";
import { type APIRequestContext, expect } from "@playwright/test";

/** 待ちの上限(秒)。負荷試験の反映待ち(PROPOSAL_WAIT_SEC=540・反映確認の打ち切り8分+余裕)にそろえる */
export const WAIT_MS =
	Number(process.env.LATCH_STAGING_E2E_WAIT_SEC ?? "540") * 1_000;

/** 実行の印(包みが渡す)。無ければ包みを通さずに起動したとして止める */
const runId = (): string => {
	const id = process.env.LATCH_STAGING_E2E_RUN_ID;
	if (id === undefined || id === "") {
		throw new Error(
			"包み(node scripts/staging-e2e.mjs)から起動してください(実行の印がありません)",
		);
	}
	return id;
};

/** 実行の記録(作った利用者のsubjectを1行ずつ書く・後始末が読む) */
const recordSubject = (subject: string): void => {
	const file = process.env.LATCH_STAGING_E2E_RECORD;
	if (file === undefined || file === "") {
		throw new Error("包みから起動してください(実行の記録の置き場がありません)");
	}
	appendFileSync(file, `${JSON.stringify({ subject })}\n`);
};

export const bearer = (token: string): Record<string, string> => ({
	authorization: `Bearer ${token}`,
});

/** 試験の進み具合と、成り立たなかったときの手がかりを出す(包みがURLを伏せる) */
export const log = (label: string, value?: unknown): void => {
	console.log(
		value === undefined
			? `[通し] ${label}`
			: `[通し] ${label}: ${JSON.stringify(value)}`,
	);
};

export interface StagingUser {
	subject: string;
	access_token: string;
	user: { id: string; display_name: string };
}

/** dev専用サインインでIdPトークンを取る(stagingの試験用の鍵で署名される・04 §4) */
export const devIdpToken = async (
	request: APIRequestContext,
	subject: string,
): Promise<string> => {
	const res = await request.post("/v1/dev/idp-token", { data: { subject } });
	expect(
		res.status(),
		"POST /v1/dev/idp-token(200以外は宛先がstagingでない)",
	).toBe(200);
	return ((await res.json()) as { idp_token: string }).idp_token;
};

/** 試験用の利用者を1人登録する。subjectは登録の前に実行の記録へ書く(途中で止まっても後始末できる) */
export const registerUser = async (
	request: APIRequestContext,
	role: string,
	displayName: string,
): Promise<StagingUser> => {
	const subject = `stg-e2e-${runId()}-${role}-${crypto.randomUUID().slice(0, 8)}`;
	recordSubject(subject);
	const tokenRes = await request.post("/v1/auth/token", {
		data: {
			provider: "google",
			idp_token: await devIdpToken(request, subject),
		},
	});
	expect(tokenRes.status(), "POST /v1/auth/token").toBe(200);
	const token = (await tokenRes.json()) as { access_token: string };
	const res = await request.post("/v1/users", {
		data: { display_name: displayName, birth_date: "2000-01-01", bio: "" },
		headers: bearer(token.access_token),
	});
	expect(res.status(), "POST /v1/users").toBe(201);
	const body = (await res.json()) as {
		access_token: string;
		user: StagingUser["user"];
	};
	return { subject, access_token: body.access_token, user: body.user };
};

/** POST /v1/intents/parseの応答のうち確かめる欄(05 §3.3) */
export interface ParsePreview {
	form: "connection" | "occasion";
	topic: string;
	category: string | null;
	time: { start: string; end: string | null } | null;
	participants: { min: number; max: number };
	budget: { min: number; max: number } | null;
	alcohol_involved: boolean;
	expires_at_options: string[];
}

/** 読み解き(本物のParserを1回呼ぶ)。応答は手がかりとして出す(試験の文なので個人情報は無い) */
export const parse = async (
	request: APIRequestContext,
	user: StagingUser,
	rawText: string,
): Promise<ParsePreview> => {
	const res = await request.post("/v1/intents/parse", {
		data: { raw_text: rawText },
		headers: bearer(user.access_token),
	});
	expect(res.status(), `POST /v1/intents/parse(${rawText})`).toBe(200);
	const preview = (await res.json()) as ParsePreview;
	log(`読み解き「${rawText}」`, {
		form: preview.form,
		topic: preview.topic,
		category: preview.category,
		time: preview.time,
		participants: preview.participants,
		budget: preview.budget,
		alcohol_involved: preview.alcohol_involved,
	});
	return preview;
};

export interface SavedIntent {
	id: string;
	form: "connection" | "occasion" | null;
	topic: string | null;
	status: string;
	version: number;
	time: { start: string; end: string | null } | null;
	participants: { min: number; max: number };
	budget: { min: number; max: number } | null;
	alcohol_involved: boolean;
	raw_text: string;
}

/** 意思を保存する(POST /v1/intents・201を確かめる) */
export const saveIntent = async (
	request: APIRequestContext,
	user: StagingUser,
	body: Record<string, unknown>,
): Promise<SavedIntent> => {
	const res = await request.post("/v1/intents", {
		data: body,
		headers: bearer(user.access_token),
	});
	if (res.status() !== 201) {
		log("保存の応答", await res.json().catch(() => null));
	}
	expect(res.status(), `POST /v1/intents(${String(body.raw_text)})`).toBe(201);
	return (await res.json()) as SavedIntent;
};

/** 地域(試験の意思どうしだけが重なる沖合の1点・半径1km)。地域名の照合(geofeatures)には頼らない */
export const SITE = {
	center: { lat: 30.4321, lng: 135.4321 },
	radius_m: 1_000,
};

/**
 * 主な流れの意思を、読み解きの結果から1対1(2人)で保存する本文にする。
 * formは試験が決める(読み解き確認でformを選び直せる・#3)ため、読み解きの揺れで流れが
 * 分かれない。主題と分類は本物のParserの出力を使い、機会は読み解いた時刻を使う
 */
export const flowBody = (
	preview: ParsePreview,
	rawText: string,
	form: "connection" | "occasion",
): Record<string, unknown> => {
	const base = {
		raw_text: rawText,
		form,
		topic: preview.topic.trim().slice(0, 40),
		category: preview.category,
		geo: SITE,
		participants: { min: 2, max: 2, includes_owner: true },
		status: "active",
	};
	if (form === "connection") {
		return { ...base, time: null, expires_in_days: 30 };
	}
	expect(preview.time, `機会の時刻が読み解けない(${rawText})`).not.toBeNull();
	const start = new Date(preview.time?.start ?? "");
	return {
		...base,
		time: { start: start.toISOString(), end: null },
		expires_at: new Date(start.getTime() + 3 * 3_600_000).toISOString(),
	};
};

export const deleteIntent = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
): Promise<void> => {
	const res = await request.delete(`/v1/intents/${intentId}`, {
		headers: bearer(user.access_token),
	});
	expect(res.status(), "DELETE /v1/intents/{id}").toBe(204);
};

/** 条件を満たすまで繰り返す。上限を過ぎたらfalse(呼び出し側が手がかりを出して失敗させる) */
export const poll = async (
	predicate: () => Promise<boolean>,
	timeoutMs = WAIT_MS,
	intervalMs = 2_000,
): Promise<boolean> => {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await predicate()) return true;
		if (Date.now() >= deadline) return false;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
};

export interface MatchEvent {
	event_type: string;
	status: string;
	version: number;
	payload: Record<string, unknown> | null;
	created_at: string;
	processed_at: string | null;
}

export const matchEvents = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
): Promise<MatchEvent[]> => {
	const res = await request.get(
		`/v1/dev/match-events?intent_id=${intentId}&limit=50`,
		{ headers: bearer(user.access_token) },
	);
	expect(res.status(), "GET /v1/dev/match-events").toBe(200);
	return ((await res.json()) as { items: MatchEvent[] }).items;
};

/**
 * 意思のベクトルがVectorizeへ反映したか(反映確認vector_reflectionがprocessedで、
 * 反映を確かめずに済ませた記録(payload.skipped。not_evaluatedを除く)でないもの)。
 * 負荷試験のisReflected(tools/load/lib/queries.mjs)と同じ判定
 */
const isReflected = (events: MatchEvent[]): boolean =>
	events.some(
		(e) =>
			e.event_type === "vector_reflection" &&
			e.status === "processed" &&
			(e.payload?.skipped == null || e.payload.skipped === "not_evaluated"),
	);

/**
 * 意思の反映を待つ(相手が後から保存したときに検索に載るようにする・負荷試験の(b)と同じ2段)。
 * 上限を過ぎても失敗にはせずに進む(相手の反映確認の後の評価し直しで提案される・06 §2)
 */
export const waitForReflection = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
	label: string,
): Promise<void> => {
	const started = Date.now();
	const ok = await poll(async () =>
		isReflected(await matchEvents(request, user, intentId)),
	);
	log(
		ok
			? `${label}の反映を確かめた(${Math.round((Date.now() - started) / 1000)}秒)`
			: `${label}の反映を上限までに確かめられなかった(そのまま進む)`,
	);
};

/** 意思の第2段の評価(embedding_completed)がprocessedになるまで待つ */
export const waitForEvaluated = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
	label: string,
): Promise<MatchEvent[]> => {
	let events: MatchEvent[] = [];
	const ok = await poll(async () => {
		events = await matchEvents(request, user, intentId);
		return events.some(
			(e) => e.event_type === "embedding_completed" && e.status === "processed",
		);
	});
	if (!ok) {
		await explain(request, user, [intentId], `${label}の評価が終わらない`);
	}
	expect(ok, `${label}の評価(embedding_completed)が上限までに終わる`).toBe(
		true,
	);
	return events;
};

export interface DevLatch {
	id: string;
	form: string;
	status: string;
	intent_ids: string[];
}

export const devLatches = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
): Promise<DevLatch[]> => {
	const res = await request.get(
		`/v1/dev/latches?intent_id=${intentId}&limit=50`,
		{ headers: bearer(user.access_token) },
	);
	expect(res.status(), "GET /v1/dev/latches").toBe(200);
	return ((await res.json()) as { items: DevLatch[] }).items;
};

/** match_candidatesの1行(Jevの7軸の数値とスコア・本文は含まれない) */
interface DevCandidate {
	intent_a_id: string;
	intent_b_id: string;
	retrieval_score: number | null;
	cheap_judge_score: number | null;
	jev_result: unknown;
	latch_score: number | null;
	status: string;
}

export const devCandidates = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
): Promise<DevCandidate[]> => {
	const res = await request.get(
		`/v1/dev/match-candidates?intent_id=${intentId}&limit=50`,
		{ headers: bearer(user.access_token) },
	);
	expect(res.status(), "GET /v1/dev/match-candidates").toBe(200);
	return ((await res.json()) as { items: DevCandidate[] }).items;
};

/**
 * 成り立たなかったときの手がかり: 意思ごとの評価の記録(段・状態・payloadの計測値=
 * 取り出し件数・Layer 1の除外の内訳・Jevの回数・閾値超え・提案数)、候補の行(検索の近さ・
 * Layer 3・Jevの7軸・LATCH Score・状態)、その意思を含むLATCHを出す。
 * 提案が生まれない原因(検索に載らない=反映待ち/Layer 1で除外/Jevが閾値0.60未満/
 * 他の利用者の意思と先に提案された等)を出力から見分けられるようにする
 */
export const explain = async (
	request: APIRequestContext,
	user: StagingUser,
	intentIds: string[],
	reason: string,
): Promise<void> => {
	log(`手がかり(${reason})`);
	for (const id of intentIds) {
		const events = await matchEvents(request, user, id);
		log(
			`  意思${id}の評価の記録`,
			events.map((e) => ({
				event: e.event_type,
				status: e.status,
				version: e.version,
				created_at: e.created_at,
				processed_at: e.processed_at,
				payload: e.payload,
			})),
		);
		log(`  意思${id}の候補`, await devCandidates(request, user, id));
		log(`  意思${id}を含むLATCH`, await devLatches(request, user, id));
	}
};

/**
 * 2つの意思を含むLATCHが観測APIに現れるまで待って返す。現れなければ手がかりを出して失敗させる。
 * 提案は後から評価した側でも、反映確認の後の評価し直しでも生まれる(06 §2)ため、待つ条件はLATCHの出現に置く
 */
export const waitForPairLatch = async (
	request: APIRequestContext,
	user: StagingUser,
	intentId: string,
	otherIds: string[],
	label: string,
): Promise<DevLatch> => {
	let found: DevLatch | undefined;
	const started = Date.now();
	const ok = await poll(async () => {
		found = (await devLatches(request, user, intentId)).find((l) =>
			otherIds.some((other) => l.intent_ids.includes(other)),
		);
		return found !== undefined;
	});
	if (!ok || found === undefined) {
		await explain(
			request,
			user,
			[intentId, ...otherIds],
			`${label}が生まれない`,
		);
	}
	expect(found, `${label}が上限までに生まれる`).toBeDefined();
	log(
		`${label}が生まれた(${Math.round((Date.now() - started) / 1000)}秒・状態${found?.status})`,
	);
	return found as DevLatch;
};

export const respond = async (
	request: APIRequestContext,
	user: StagingUser,
	latchId: string,
	response: LatchResponseValue,
): Promise<LatchDTO> => {
	const res = await request.post(`/v1/latches/${latchId}/response`, {
		data: { response },
		headers: bearer(user.access_token),
	});
	expect(res.status(), `POST /v1/latches/{id}/response(${response})`).toBe(200);
	return (await res.json()) as LatchDTO;
};

interface DevNotification {
	type: string;
	latch_id: string | null;
	push_state: string;
}

/** 指定の種別・LATCHのアプリ内通知の行ができるまで待つ(dev専用の観測で待ち、一覧で確かめる) */
export const waitForNotification = async (
	request: APIRequestContext,
	user: StagingUser,
	type: string,
	latchId: string,
	label: string,
): Promise<void> => {
	let rows: DevNotification[] = [];
	const ok = await poll(async () => {
		const res = await request.get("/v1/dev/notifications", {
			headers: bearer(user.access_token),
		});
		expect(res.status(), "GET /v1/dev/notifications").toBe(200);
		rows = ((await res.json()) as { notifications: DevNotification[] })
			.notifications;
		return rows.some((n) => n.type === type && n.latch_id === latchId);
	}, 60_000);
	if (!ok) log(`${label}の通知の行`, rows);
	expect(ok, `${label}にアプリ内通知(${type})が作られる`).toBe(true);
	// 利用者の見る一覧(GET /v1/notifications)にも届いている
	const list = await request.get("/v1/notifications", {
		headers: bearer(user.access_token),
	});
	expect(list.status(), "GET /v1/notifications").toBe(200);
	const { items } = (await list.json()) as {
		items: Array<{ type: string; latch_id?: string | null }>;
	};
	expect(
		items.some((n) => n.type === type && n.latch_id === latchId),
		`${label}のアプリ内通知の一覧に${type}が出る`,
	).toBe(true);
};

export interface ChatFrame {
	type: string;
	[key: string]: unknown;
}

export interface ChatSocket {
	frames: ChatFrame[];
	send: (frame: Record<string, unknown>) => void;
	close: () => void;
}

/**
 * チャットのWebSocketへつなぐ。stagingの前のCloudflare Accessを通るため、
 * NodeのWebSocket(undici)の拡張(第2引数のheaders)で通行証を付ける。URLは出さない
 */
export const connectChat = async (
	request: APIRequestContext,
	baseURL: string,
	user: StagingUser,
	latchId: string,
	accessHeaders: Record<string, string>,
): Promise<ChatSocket> => {
	const ticketRes = await request.post("/v1/ws-ticket", {
		data: { scope: "chat", latch_id: latchId },
		headers: bearer(user.access_token),
	});
	expect(ticketRes.status(), "POST /v1/ws-ticket").toBe(200);
	const { ticket } = (await ticketRes.json()) as { ticket: string };
	const url = `${baseURL.replace(/^http/, "ws")}/v1/latches/${latchId}/ws?ticket=${ticket}`;
	const ws = new WebSocket(url, {
		headers: accessHeaders,
	} as unknown as string[]);
	const frames: ChatFrame[] = [];
	ws.addEventListener("message", (event) => {
		frames.push(JSON.parse(String(event.data)) as ChatFrame);
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener(
			"error",
			() => reject(new Error("チャットのWebSocketにつなげない")),
			{ once: true },
		);
	});
	return {
		frames,
		send: (frame) => ws.send(JSON.stringify(frame)),
		close: () => ws.close(),
	};
};

/** 指定typeのフレームが届くまで待って取り出す */
export const nextFrame = async (
	socket: ChatSocket,
	type: string,
	timeoutMs = 30_000,
): Promise<ChatFrame> => {
	let found: ChatFrame | undefined;
	const ok = await poll(
		async () => {
			const index = socket.frames.findIndex((f) => f.type === type);
			if (index < 0) return false;
			found = socket.frames.splice(index, 1)[0];
			return true;
		},
		timeoutMs,
		100,
	);
	expect(ok, `WebSocketに${type}が届く`).toBe(true);
	return found as ChatFrame;
};
