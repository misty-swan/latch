/**
 * composeState(預ける→読み解き中→確認の画面間受け渡し)の単体試験。
 * parse前後の保存・読み出しと・壊れた値の扱い(直アクセス・リロードでconfirmが壊れない:
 * F2'計画Review Focus #3)を確かめる
 */

import type { ParseIntentResponse } from "@latch/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
	clearComposeState,
	readComposeState,
	readPendingCompose,
	saveComposeState,
	savePendingCompose,
} from "./composeState";

/** Intentのid(ULID・26字)。docs/05 §2.2 */
const DRAFT_ID = "01J00000000000000000000000";
const WORDS =
	"イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。";

/** parse応答のフィクスチュア(docs/05 §3.3の形状) */
const parseResponse = {
	form: "connection",
	topic: "イラストを描く人とゆるくつながりたい",
	category: "創作・クリエイティブ",
	time: null,
	geo: null,
	participants: { min: 2, max: 2, includes_owner: true },
	budget: null,
	expires_at_options: [
		"2026-10-26T12:00:00+09:00",
		"2026-11-18T12:00:00+09:00",
		"2027-01-17T12:00:00+09:00",
	],
	alcohol_involved: false,
	warnings: [],
} satisfies ParseIntentResponse;

afterEach(() => {
	sessionStorage.clear();
});

describe("composeState", () => {
	it("parse前の入力を保存・読み出しでき・parse済みとしてはまだ読めない", () => {
		savePendingCompose({ raw_text: WORDS, draft_id: DRAFT_ID });

		expect(readPendingCompose()).toEqual({
			raw_text: WORDS,
			draft_id: DRAFT_ID,
		});
		expect(readComposeState()).toBeNull();
	});

	it("新規(draft idなし)の入力もそのまま保持する", () => {
		savePendingCompose({ raw_text: WORDS, draft_id: null });

		expect(readPendingCompose()).toEqual({
			raw_text: WORDS,
			draft_id: null,
		});
	});

	it("parse結果を保存するとComposeStateとして読める(raw_text・draft idを保持)", () => {
		savePendingCompose({ raw_text: WORDS, draft_id: DRAFT_ID });
		saveComposeState({
			raw_text: WORDS,
			draft_id: DRAFT_ID,
			parse: parseResponse,
		});

		expect(readComposeState()).toEqual({
			raw_text: WORDS,
			draft_id: DRAFT_ID,
			parse: parseResponse,
		});
		// parse済みはparse前としても読めない(Readingの再parse防止)
		expect(readPendingCompose()).toBeNull();
	});

	it("壊れたJSONは破棄してnullを返す(直アクセス・リロードで壊れない)", () => {
		sessionStorage.setItem("latch.compose", "{not-json");

		expect(readPendingCompose()).toBeNull();
		expect(readComposeState()).toBeNull();
		expect(sessionStorage.getItem("latch.compose")).toBeNull();
	});

	it("形状が違う値(parse応答の欠落・draft idの形式不正)は破棄してnullを返す", () => {
		sessionStorage.setItem(
			"latch.compose",
			JSON.stringify({
				raw_text: WORDS,
				draft_id: "short",
				parse: { form: "connection" },
			}),
		);

		expect(readComposeState()).toBeNull();
		expect(sessionStorage.getItem("latch.compose")).toBeNull();

		sessionStorage.setItem(
			"latch.compose",
			JSON.stringify({ raw_text: WORDS, draft_id: null, parse: null }),
		);
		// parseが入っていないのにparse前として読めるのは正しい(直アクセス耐性の確認)
		expect(readPendingCompose()).toEqual({
			raw_text: WORDS,
			draft_id: null,
		});
	});

	it("clearComposeStateで破棄できる", () => {
		saveComposeState({
			raw_text: WORDS,
			draft_id: null,
			parse: parseResponse,
		});

		clearComposeState();

		expect(readComposeState()).toBeNull();
		expect(sessionStorage.getItem("latch.compose")).toBeNull();
	});
});
