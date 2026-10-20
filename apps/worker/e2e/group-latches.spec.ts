/**
 * グループLATCHのゲートE2E(APIレベル・docs/02 §4の#24・F4bのゲート)。
 * 3〜4人の集合(つながり・機会の双方)で必要人数のYESを揃えると、必要人数のmatchedが
 * 成立することを、Intent APIで投入した実データとパイプライン全体(Pool→集合選択→Jev配分→
 * 提案化)で証明する。
 *
 * seed方針は latches.spec.ts 冒頭に従う(新規ユーザー・testごとに離れた地域・各testの前に
 * scripts/clean-e2e-data.mjs・最後にDELETE)。Intentには participants を明示する:
 * 3人のつながり集合は{3,3}・4人の機会集合は{4,4}(上限を3〜4にすると3人集合が同点で
 * 勝ち、4人の成立を証明できない)。他specの残置Intentは{2,2}のためPoolに入らない。
 * stub Jevは全ペア0.9のため集計0.9>0.60で、集合は最後のメンバーの評価で
 * 組まれる(先のメンバーが後のメンバーのPoolに入る・F4b設計)
 */

import { execSync } from "node:child_process";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";
import {
	backdate,
	type CreatedIntent,
	createIntent,
	type DevLatchItem,
	type RegisteredUser,
	registerUser,
	respond,
	runCron,
	waitFor,
	waitForLatch,
} from "./helpers";

const MS_PER_HOUR = 3_600_000;

interface MatchEventItem {
	id: string;
	event_type: string;
	version: number;
	status: string;
	payload: unknown;
}

interface ProposalHistoryItem {
	user_low: string;
	user_high: string;
	latch_id: string;
	outcome: string;
}

interface Geo {
	center: { lat: number; lng: number };
	radius_m: number;
}

/** test・集合ごとの地域(半径1km)。番号ごとに緯度を0.1度ずらすため異なる番号は重ならない */
const site = (n: number): Geo => ({
	center: { lat: 33 + n * 0.1, lng: 131.5 },
	radius_m: 1_000,
});

const authHeaders = (accessToken: string): Record<string, string> => ({
	authorization: `Bearer ${accessToken}`,
});

const expireLeftoverE2eIntents = (): void => {
	execSync("node scripts/clean-e2e-data.mjs", {
		cwd: path.join(import.meta.dirname, ".."),
		stdio: "ignore",
	});
};

/** 集合の人数 n を participants {min:n,max:n} で固定する */
const participants = (n: number) => ({
	min: n,
	max: n,
	includes_owner: true,
});

const createConnection = (
	request: APIRequestContext,
	user: RegisteredUser,
	topic: string,
	geo: Geo,
	n: number,
): Promise<CreatedIntent> =>
	createIntent(request, user.access_token, {
		raw_text: topic,
		form: "connection",
		topic,
		geo,
		participants: participants(n),
	});

const createOccasion = (
	request: APIRequestContext,
	user: RegisteredUser,
	topic: string,
	geo: Geo,
	startMs: number,
	n: number,
): Promise<CreatedIntent> =>
	createIntent(request, user.access_token, {
		raw_text: topic,
		form: "occasion",
		topic,
		time: {
			start: new Date(startMs).toISOString(),
			end: new Date(startMs + 2 * MS_PER_HOUR).toISOString(),
		},
		geo,
		participants: participants(n),
	});

const listObserve = async <T>(
	request: APIRequestContext,
	accessToken: string,
	pathAndQuery: string,
): Promise<T[]> => {
	const res = await request.get(`/v1/dev/${pathAndQuery}&limit=50`, {
		headers: authHeaders(accessToken),
	});
	expect(res.status(), `GET /v1/dev/${pathAndQuery}`).toBe(200);
	return ((await res.json()) as { items: T[] }).items;
};

const waitForEvaluation = async (
	request: APIRequestContext,
	accessToken: string,
	intentId: string,
	timeout = 60_000,
): Promise<MatchEventItem> => {
	let found: MatchEventItem | undefined;
	await waitFor(
		async () => {
			const events = await listObserve<MatchEventItem>(
				request,
				accessToken,
				`match-events?intent_id=${intentId}`,
			);
			found = events.find(
				(e) =>
					e.event_type === "embedding_completed" &&
					e.version === 1 &&
					e.status === "processed",
			);
			return found !== undefined;
		},
		timeout,
		500,
	);
	return found as MatchEventItem;
};

interface Member {
	user: RegisteredUser;
	intent: CreatedIntent;
}

interface Group {
	members: Member[];
	latch: DevLatchItem;
	/** 最後に作ったメンバーの評価イベント(集合が組まれる評価) */
	lastEvent: MatchEventItem;
}

/**
 * n人を順に作成して各評価の完了を待ち(先のメンバーが後のメンバーのPoolに入る)、
 * n Intentを含むLATCHのproposedを待って返す
 */
const proposeGroup = async (
	request: APIRequestContext,
	label: string,
	n: number,
	create: (user: RegisteredUser) => Promise<CreatedIntent>,
): Promise<Group> => {
	const members: Member[] = [];
	let lastEvent: MatchEventItem | undefined;
	for (let i = 0; i < n; i++) {
		const user = await registerUser(request, `E2E${label}${i + 1}`);
		const intent = await create(user);
		lastEvent = await waitForEvaluation(request, user.access_token, intent.id);
		members.push({ user, intent });
	}
	const first = members[0] as Member;
	const latch = await waitForLatch(
		request,
		first.user.access_token,
		first.intent.id,
		(item) => item.intent_ids.length === n,
	);
	expect(latch.status, `${label}の集合の提案`).toBe("proposed");
	for (const m of members) {
		expect(latch.intent_ids).toContain(m.intent.id);
	}
	return { members, latch, lastEvent: lastEvent as MatchEventItem };
};

const getLatch = async (
	request: APIRequestContext,
	user: RegisteredUser,
	latchId: string,
) => {
	const res = await request.get(`/v1/latches/${latchId}`, {
		headers: authHeaders(user.access_token),
	});
	expect(res.status(), `GET /v1/latches/${latchId}`).toBe(200);
	return (await res.json()) as Record<string, unknown> & {
		status: string;
		participants_count: number;
		my_response: string | null;
		members?: { user_id: string }[];
	};
};

/** 全メンバーの提案履歴をペア単位で重複排除して返す */
const groupHistory = async (
	request: APIRequestContext,
	members: Member[],
): Promise<ProposalHistoryItem[]> => {
	const byPair = new Map<string, ProposalHistoryItem>();
	for (const m of members) {
		const rows = await listObserve<ProposalHistoryItem>(
			request,
			m.user.access_token,
			`proposal-history?user_id=${m.user.user.id}`,
		);
		for (const r of rows) {
			byPair.set(`${r.user_low}:${r.user_high}`, r);
		}
	}
	return [...byPair.values()];
};

const cleanup = async (
	request: APIRequestContext,
	members: Member[],
): Promise<void> => {
	for (const m of members) {
		const res = await request.delete(`/v1/intents/${m.intent.id}`, {
			headers: authHeaders(m.user.access_token),
		});
		expect(res.status(), `DELETE /v1/intents/${m.intent.id}`).toBe(204);
	}
};

const asStage2 = (payload: unknown): Record<string, unknown> =>
	payload as Record<string, unknown>;

test.setTimeout(240_000);

test.beforeEach(() => {
	expireLeftoverE2eIntents();
});

test("#24 3人のつながり集合で3人目のYESにより成立する", async ({ request }) => {
	const group = await proposeGroup(request, "三人", 3, (user) =>
		createConnection(
			request,
			user,
			"毎月みんなでボードゲームを遊ぶ仲間を募集しています",
			site(21),
			3,
		),
	);
	const [a, b, c] = group.members as [Member, Member, Member];
	// 集合は最後のメンバーの評価で1件だけ提案される
	expect(asStage2(group.lastEvent.payload).group_proposed).toBe(1);
	for (const m of group.members) {
		const dto = await getLatch(request, m.user, group.latch.id);
		expect(dto.participants_count).toBe(3);
		expect(dto.status).toBe("proposed");
		// 成立前はproposal・membersのキー自体を出さない(#20)
		expect("proposal" in dto).toBe(false);
		expect("members" in dto).toBe(false);
	}

	await respond(request, a.user.access_token, group.latch.id, "yes");
	const afterB = await respond(
		request,
		b.user.access_token,
		group.latch.id,
		"yes",
	);
	expect(afterB.status).toBe("partial_accept");
	const afterC = await respond(
		request,
		c.user.access_token,
		group.latch.id,
		"yes",
	);
	expect(afterC.status).toBe("matched");
	expect(afterC.members?.length).toBe(2);

	for (const m of group.members) {
		const dto = await getLatch(request, m.user, group.latch.id);
		expect(dto.status).toBe("matched");
		expect(dto.members?.length).toBe(2);
		expect(dto.proposal).toBeDefined();
	}
	const history = await groupHistory(request, group.members);
	expect(history.length).toBe(3);
	expect(history.every((h) => h.outcome === "matched")).toBe(true);
	expect(history.every((h) => h.latch_id === group.latch.id)).toBe(true);
	await cleanup(request, group.members);
});

test("#24 4人の機会集合で全員のYESにより成立する", async ({ request }) => {
	const startMs = Date.now() + 4 * MS_PER_HOUR;
	const group = await proposeGroup(request, "四人", 4, (user) =>
		createOccasion(
			request,
			user,
			"夜の公園でみんなでバドミントンをします",
			site(22),
			startMs,
			4,
		),
	);
	expect(group.latch.intent_ids.length).toBe(4);
	expect(asStage2(group.lastEvent.payload).group_proposed).toBe(1);
	for (const m of group.members) {
		const dto = await getLatch(request, m.user, group.latch.id);
		expect(dto.participants_count).toBe(4);
	}
	for (const m of group.members) {
		await respond(request, m.user.access_token, group.latch.id, "yes");
	}
	for (const m of group.members) {
		const dto = await getLatch(request, m.user, group.latch.id);
		expect(dto.status).toBe("matched");
		expect(dto.members?.length).toBe(3);
	}
	// 4件のIntentがmatchedになる
	for (const m of group.members) {
		const res = await request.get(`/v1/intents/${m.intent.id}`, {
			headers: authHeaders(m.user.access_token),
		});
		expect(res.status()).toBe(200);
		expect(((await res.json()) as { status: string }).status).toBe("matched");
	}
	const history = await groupHistory(request, group.members);
	expect(history.length).toBe(6);
	expect(history.every((h) => h.outcome === "matched")).toBe(true);
	await cleanup(request, group.members);
});

test("#24 1人のdeferで集合全体がrejectedになり履歴はAのペアだけ", async ({
	request,
}) => {
	const group = await proposeGroup(request, "見送り", 3, (user) =>
		createConnection(
			request,
			user,
			"休日にみんなで山登りに行く仲間を募集中",
			site(23),
			3,
		),
	);
	const [a] = group.members as [Member, Member, Member];
	const deferred = await respond(
		request,
		a.user.access_token,
		group.latch.id,
		"defer",
	);
	expect(deferred.status).toBe("rejected");
	const history = await groupHistory(request, group.members);
	// Aを含む2行がdeferred・B-Cの行は作らない
	expect(history.length).toBe(2);
	expect(history.every((h) => h.outcome === "deferred")).toBe(true);
	const aId = a.user.user.id;
	expect(history.every((h) => h.user_low === aId || h.user_high === aId)).toBe(
		true,
	);
	await cleanup(request, group.members);
});

test("#24 回答期限切れでexpiredになり履歴はAのペアだけ", async ({
	request,
}) => {
	const group = await proposeGroup(request, "期限", 3, (user) =>
		createConnection(
			request,
			user,
			"毎週末にみんなでフットサルをする仲間を募集",
			site(24),
			3,
		),
	);
	const [a, b, c] = group.members as [Member, Member, Member];
	await respond(request, b.user.access_token, group.latch.id, "yes");
	await respond(request, c.user.access_token, group.latch.id, "yes");
	await backdate(request, a.user.access_token, group.latch.id, {
		response_deadline: new Date(Date.now() - MS_PER_HOUR).toISOString(),
	});
	await runCron(request);
	let status = "";
	await waitFor(
		async () => {
			status = (await getLatch(request, a.user, group.latch.id)).status;
			return status === "expired";
		},
		30_000,
		500,
	);
	expect(status).toBe("expired");
	const history = await groupHistory(request, group.members);
	expect(history.length).toBe(2);
	expect(history.every((h) => h.outcome === "expired")).toBe(true);
	const aId = a.user.user.id;
	expect(history.every((h) => h.user_low === aId || h.user_high === aId)).toBe(
		true,
	);
	await cleanup(request, group.members);
});
