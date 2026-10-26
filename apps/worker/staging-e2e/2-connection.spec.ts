/**
 * stagingの通し試験(2): つながりIntentの主な流れ(docs/10 §4・02 #9・#16・#21・#25〜#27・
 * フィードバック申告・退会)。本物のParser・Jev・EmbeddingとVectorizeで次を順に流す。
 * 1. Aと、語彙の違う意味の近い文のBが預ける(#9: 候補として生成される)。Aの意思がVectorizeへ
 *    反映したのを確かめてからBが預ける(負荷試験の(b)と同じ2段・docs/10 §5)
 * 2. 提案とアプリ内通知(#16)・双方の[参加する]で成立と成立の通知
 * 3. チャット(#25): WebSocketとRESTで双方向に送り、履歴に残る
 * 4. フィードバック申告: 成立を8日前へずらし(dev専用のbackdate・05 §3.3)、問いが出て申告できる
 * 5. 成立の後もA・Bの意思はactiveのまま、第三者Cの意味の近い意思と新しい提案が生まれる(#21)
 * 6. 通報(#27): Cが提案を、成立後に相手の発言を通報し、受付の記録が残る
 * 7. ブロック(#26): Cが相手Pをブロックすると成立中のつながりは終わり、Cが新しく預けた
 *    意味の近い意思はPと提案されず、評価の記録にブロックによる除外が残る
 * 8. 退会: Aが本人の再認証で退会し、Bの側ではつながりが終わり名前を出さずメッセージが残る
 * 提案はJev(閾値0.60)が決めるため、文は互いに組みたくなる内容にしてある。提案が生まれないと
 * きは、評価の記録・候補(検索の近さ・Jevの7軸)・LATCHを出して失敗する(lib.tsのexplain)。
 * 本物のAIの呼び出しの目安: Parser 4回・Embedding 4回・Jev 4回前後(A×B・C×A・C×B・
 * Cの2件目×ブロックしていない相手。他の利用者の意思が候補に入るとその分増える)
 */

import type { LatchDTO, MessageDTO } from "@latch/shared";
import { expect, test } from "@playwright/test";
import {
	bearer,
	type ChatSocket,
	connectChat,
	devCandidates,
	devIdpToken,
	devLatches,
	explain,
	flowBody,
	log,
	matchEvents,
	nextFrame,
	parse,
	poll,
	registerUser,
	respond,
	type SavedIntent,
	type StagingUser,
	saveIntent,
	waitForEvaluated,
	waitForNotification,
	waitForPairLatch,
	waitForReflection,
} from "./lib";

/** 意味の近い別の文(語彙をなるべく重ねない・#9の「個人開発仲間」と「Railsで何か作っている」の形) */
const TEXT_A = "個人開発の仲間が欲しい。週末に一緒にもくもく作業したい";
const TEXT_B =
	"Railsで自分のWebサービスを作っています。休日に並んで開発できる人と知り合いたい";
const TEXT_C =
	"趣味でアプリを作っているので、週末に一緒にコードを書ける人を探しています";
const TEXT_C2 =
	"副業でスマホアプリを開発中。休みの日に作業を見せ合える相手が欲しい";

test.setTimeout(60 * 60_000);

test("つながり: 意味の近い文どうしの提案から成立・チャット・申告・再提案・通報・ブロック・退会まで", async ({
	request,
	baseURL,
	extraHTTPHeaders,
}) => {
	const access = extraHTTPHeaders ?? {};
	const save = async (user: StagingUser, text: string): Promise<SavedIntent> =>
		saveIntent(
			request,
			user,
			flowBody(await parse(request, user, text), text, "connection"),
		);
	const latchOf = async (
		user: StagingUser,
		latchId: string,
	): Promise<LatchDTO> => {
		const res = await request.get(`/v1/latches/${latchId}`, {
			headers: bearer(user.access_token),
		});
		expect(res.status(), "GET /v1/latches/{id}").toBe(200);
		return (await res.json()) as LatchDTO;
	};

	const a = await registerUser(request, "a", "通し試験A");
	const b = await registerUser(request, "b", "通し試験B");
	const c = await registerUser(request, "c", "通し試験C");

	let x!: SavedIntent;
	let y!: SavedIntent;
	let latchAB!: string;
	await test.step("#9 意味の近い別の文どうしが候補になり、提案される", async () => {
		x = await save(a, TEXT_A);
		await waitForReflection(request, a, x.id, "Aの意思");
		y = await save(b, TEXT_B);
		await waitForEvaluated(request, b, y.id, "Bの意思");
		const latch = await waitForPairLatch(
			request,
			b,
			y.id,
			[x.id],
			"AとBの提案",
		);
		latchAB = latch.id;
		const candidate = [
			...(await devCandidates(request, b, y.id)),
			...(await devCandidates(request, a, x.id)),
		].find(
			(r) =>
				[r.intent_a_id, r.intent_b_id].includes(x.id) &&
				[r.intent_a_id, r.intent_b_id].includes(y.id),
		);
		// #9の合格の証拠: 候補として生成されている(検索の近さ・Jevの点も手がかりに出す)
		expect(candidate, "AとBの候補の行").toBeDefined();
		log("AとBの候補", candidate);
	});

	await test.step("#16 提案のアプリ内通知が双方に届き、参加すると成立の通知が届く", async () => {
		await waitForNotification(request, a, "proposal", latchAB, "A");
		await waitForNotification(request, b, "proposal", latchAB, "B");
		await respond(request, a, latchAB, "yes");
		expect((await respond(request, b, latchAB, "yes")).status).toBe("matched");
		await waitForNotification(request, a, "matched", latchAB, "A");
		await waitForNotification(request, b, "matched", latchAB, "B");
	});

	await test.step("#25 チャットで双方向に送受信し、履歴に残る", async () => {
		const sockets: ChatSocket[] = [];
		try {
			const sa = await connectChat(request, baseURL ?? "", a, latchAB, access);
			sockets.push(sa);
			const sb = await connectChat(request, baseURL ?? "", b, latchAB, access);
			sockets.push(sb);
			sa.send({ type: "message", body: "はじめまして", client_id: "stg-a-1" });
			const toB = await nextFrame(sb, "message");
			expect(toB.body).toBe("はじめまして");
			expect(toB.user_id).toBe(a.user.id);
			const sent = await request.post(`/v1/latches/${latchAB}/messages`, {
				data: { body: "よろしくお願いします", client_id: "stg-b-1" },
				headers: bearer(b.access_token),
			});
			expect(sent.status(), "POST /v1/latches/{id}/messages").toBe(201);
			const toA = await poll(
				async () =>
					sa.frames.some(
						(f) => f.type === "message" && f.body === "よろしくお願いします",
					),
				30_000,
				100,
			);
			expect(toA, "RESTの送信がAのWebSocketに届く").toBe(true);
		} finally {
			for (const s of sockets) s.close();
		}
		const history = await request.get(`/v1/latches/${latchAB}/messages`, {
			headers: bearer(a.access_token),
		});
		expect(history.status()).toBe(200);
		const { items } = (await history.json()) as { items: MessageDTO[] };
		expect(items.map((m) => m.body)).toEqual([
			"はじめまして",
			"よろしくお願いします",
		]);
	});

	await test.step("フィードバック申告: 成立から7日を過ぎると問いが出て、申告とスキップを受け付ける", async () => {
		const dueOf = async (user: StagingUser): Promise<string | null> => {
			const res = await request.get("/v1/latches?type=matched", {
				headers: bearer(user.access_token),
			});
			expect(res.status(), "GET /v1/latches?type=matched").toBe(200);
			const { items } = (await res.json()) as {
				items: { id: string; feedback_due: string | null }[];
			};
			return items.find((l) => l.id === latchAB)?.feedback_due ?? null;
		};
		expect(await dueOf(a)).toBeNull();
		const back = await request.post(`/v1/dev/latches/${latchAB}/backdate`, {
			data: {
				matched_at: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString(),
			},
			headers: bearer(a.access_token),
		});
		expect(back.status(), "POST /v1/dev/latches/{id}/backdate").toBe(200);
		expect(await dueOf(a)).toBe("connection_quality");
		const post = (user: StagingUser, score: number | null) =>
			request.post(`/v1/latches/${latchAB}/feedback`, {
				data: { kind: "connection_quality", value: { score } },
				headers: bearer(user.access_token),
			});
		expect((await post(a, 4)).status(), "Aの申告").toBe(200);
		expect((await post(b, null)).status(), "Bのスキップ").toBe(200);
		expect(await dueOf(a)).toBeNull();
		expect(await dueOf(b)).toBeNull();
	});

	let z!: SavedIntent;
	let latchC!: string;
	let partner!: { user: StagingUser; intent: SavedIntent };
	let other!: { user: StagingUser; intent: SavedIntent };
	await test.step("#21 成立の後もA・Bの意思はactiveのまま、第三者Cと新しい提案が生まれる", async () => {
		for (const [user, intent] of [
			[a, x],
			[b, y],
		] as const) {
			const res = await request.get(`/v1/intents/${intent.id}`, {
				headers: bearer(user.access_token),
			});
			expect(((await res.json()) as SavedIntent).status).toBe("active");
		}
		// Bの意思も検索に載ってからCが預ける(どちらと組んでもよい)
		await waitForReflection(request, b, y.id, "Bの意思");
		z = await save(c, TEXT_C);
		await waitForEvaluated(request, c, z.id, "Cの意思");
		const latch = await waitForPairLatch(
			request,
			c,
			z.id,
			[x.id, y.id],
			"CとA・Bのどちらかの提案",
		);
		latchC = latch.id;
		const withA = latch.intent_ids.includes(x.id);
		partner = withA ? { user: a, intent: x } : { user: b, intent: y };
		other = withA ? { user: b, intent: y } : { user: a, intent: x };
		log(`Cの提案の相手は${withA ? "A" : "B"}`);
	});

	await test.step("#27 提案と成立後の発言を通報でき、受付の記録が残る", async () => {
		const proposalReport = await request.post("/v1/reports", {
			data: { latch_id: latchC, target: "proposal", reason: "spam" },
			headers: bearer(c.access_token),
		});
		expect(proposalReport.status(), "通報(proposal)").toBe(201);
		await respond(request, c, latchC, "yes");
		expect((await respond(request, partner.user, latchC, "yes")).status).toBe(
			"matched",
		);
		const message = await request.post(`/v1/latches/${latchC}/messages`, {
			data: { body: "通報の対象になる発言", client_id: "stg-p-1" },
			headers: bearer(partner.user.access_token),
		});
		expect(message.status()).toBe(201);
		const messageId = ((await message.json()) as { id: string }).id;
		const messageReport = await request.post("/v1/reports", {
			data: {
				latch_id: latchC,
				target: "message",
				reason: "harassment",
				reportee_user_id: partner.user.user.id,
				message_id: messageId,
			},
			headers: bearer(c.access_token),
		});
		expect(messageReport.status(), "通報(message)").toBe(201);
		const res = await request.get("/v1/dev/reports", {
			headers: bearer(c.access_token),
		});
		const { reports } = (await res.json()) as {
			reports: { target: string; reason: string; reportee: string }[];
		};
		expect(reports.map((r) => [r.target, r.reason, r.reportee]).sort()).toEqual(
			[
				["message", "harassment", partner.user.user.id],
				["proposal", "spam", partner.user.user.id],
			].sort(),
		);
	});

	await test.step("#26 ブロックすると成立中のつながりは終わり、新しい意思は相手と提案されない", async () => {
		const block = await request.post(
			`/v1/users/${partner.user.user.id}/block`,
			{
				headers: bearer(c.access_token),
			},
		);
		expect(block.status(), "POST /v1/users/{id}/block").toBe(201);
		expect((await latchOf(partner.user, latchC)).status).toBe("cancelled");
		const z2 = await save(c, TEXT_C2);
		const events = await waitForEvaluated(request, c, z2.id, "Cの2件目の意思");
		const withPartner = (await devLatches(request, c, z2.id)).filter((l) =>
			l.intent_ids.includes(partner.intent.id),
		);
		const blocked = events.some(
			(e) =>
				Number(
					(e.payload?.l1_exclusions as Record<string, number> | undefined)
						?.blocked ?? 0,
				) >= 1,
		);
		if (withPartner.length > 0 || !blocked) {
			await explain(
				request,
				c,
				[z2.id, partner.intent.id],
				"ブロックの除外が確かめられない",
			);
		}
		expect(withPartner, "ブロックした相手とは提案されない").toEqual([]);
		// 相手の意思は検索に載ってLayer 1でブロックとして除かれる(06 §3)
		expect(blocked, "評価の記録にブロックによる除外が残る").toBe(true);
		log(
			"Cの2件目の意思の提案(ブロックしていない相手とは提案されてよい)",
			(await devLatches(request, c, z2.id)).map((l) => ({
				status: l.status,
				with_other: l.intent_ids.includes(other.intent.id),
			})),
		);
	});

	await test.step("退会: Aが本人の再認証で退会し、Bの側ではつながりが終わってメッセージが残る", async () => {
		const wrong = await request.delete("/v1/users/me", {
			data: {
				provider: "google",
				idp_token: await devIdpToken(request, `${a.subject}-other`),
			},
			headers: bearer(a.access_token),
		});
		expect(wrong.status(), "別のアカウントの再認証").toBe(403);
		const res = await request.delete("/v1/users/me", {
			data: {
				provider: "google",
				idp_token: await devIdpToken(request, a.subject),
			},
			headers: bearer(a.access_token),
		});
		expect(res.status(), "DELETE /v1/users/me").toBe(204);
		const me = await request.get("/v1/users/me", {
			headers: bearer(a.access_token),
		});
		expect(me.status(), "退会者のトークン").toBe(401);
		const seen = await latchOf(b, latchAB);
		expect(seen.status).toBe("cancelled");
		expect(seen.members?.map((m) => m.display_name)).toEqual([
			"つながっていた相手",
		]);
		const history = await request.get(`/v1/latches/${latchAB}/messages`, {
			headers: bearer(b.access_token),
		});
		const { items } = (await history.json()) as { items: MessageDTO[] };
		expect(items).toHaveLength(2);
		const send = await request.post(`/v1/latches/${latchAB}/messages`, {
			data: { body: "届かない", client_id: "stg-b-2" },
			headers: bearer(b.access_token),
		});
		expect(send.status(), "終わったつながりへの送信").toBe(400);
		// 退会者の意思は消えている(評価の記録も残らない)
		expect(await matchEvents(request, b, x.id)).toEqual([]);
		const again = await request.post("/v1/auth/token", {
			data: {
				provider: "google",
				idp_token: await devIdpToken(request, a.subject),
			},
		});
		expect(
			((await again.json()) as { registration_required: boolean })
				.registration_required,
			"同じアカウントで入り直すと未登録",
		).toBe(true);
	});
});
