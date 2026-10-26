/**
 * ゴールドセット(eval/goldset/*.yaml)の形式と読み込み(設計書 §2・docs/09 §3)。
 * zodで検証し、違反は件のidつきで例外にする。
 */
import { readFileSync } from "node:fs";
import { CATEGORIES } from "@latch/shared";
import { parse } from "yaml";
import { z } from "zod";

/** 日時文字列(ISO 8601・オフセット必須)。Parserへ渡す現在時刻の基準 */
const isoDateTime = z
	.string()
	.refine(
		(s) =>
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
				s,
			) && !Number.isNaN(Date.parse(s)),
		"ISO 8601(オフセット付き)の日時ではありません",
	);

/** YAMLの日時文字列をDateへ(buildNormalizedTextに渡すIntentRowの時刻列の型) */
const dateFromIso = isoDateTime.transform((s) => new Date(s));

const approvedSchema = z.union([z.string().min(1), z.null()]);

// ---- Parser ----

/**
 * 期待値。キーを書かない=採点しない。null=「出力にその値が無いこと」を期待する(time_start・budget・category)。
 * - topic: 出力のtopicに含まれるべき主題語。topic_any: そのうちどれかが出力のtopicに含まれればよい(topicとは併用不可)
 * - topic_none: 出力のtopicに含まれてはならない語(地名・店名・駅名・施設名。#31)。topic・topic_anyのどちらかが必須で、
 *   同じ項目のtopic・topic_anyの語と互いに含み合ってはならない(「渋谷系」と「渋谷」のような組は誤判定になるため)
 * - time_start: Date.parseによる時刻の同一性で比べる(文字列の一致ではない)
 * - geo_warning: warnings.some(w => w.field === "geo") の真偽
 */
const parserExpectSchema = z
	.object({
		form: z.enum(["connection", "occasion"]).optional(),
		topic: z.string().min(1).optional(),
		topic_any: z.array(z.string().min(1)).min(1).optional(),
		topic_none: z.array(z.string().min(1)).min(1).optional(),
		category: z.enum(CATEGORIES).nullable().optional(),
		time_start: isoDateTime.nullable().optional(),
		participants: z
			.object({ min: z.number().int().min(1), max: z.number().int().min(1) })
			.strict()
			.refine((p) => p.min <= p.max, "participantsのmin<=maxではありません")
			.optional(),
		budget: z
			.object({
				min: z.number().int().nullable(),
				max: z.number().int().nullable(),
			})
			.strict()
			.refine(
				(b) => b.min === null || b.max === null || b.min <= b.max,
				"budgetのmin<=maxではありません",
			)
			.nullable()
			.optional(),
		alcohol_involved: z.boolean().optional(),
		geo_warning: z.boolean().optional(),
	})
	.strict()
	.refine(
		(e) => !(e.topic !== undefined && e.topic_any !== undefined),
		"topicとtopic_anyは併用できません",
	)
	.refine(
		(e) =>
			e.topic_none === undefined ||
			e.topic !== undefined ||
			e.topic_any !== undefined,
		"topic_noneにはtopicまたはtopic_anyが必要です",
	)
	.refine((e) => {
		const wanted = e.topic !== undefined ? [e.topic] : (e.topic_any ?? []);
		const n = (s: string) => s.normalize("NFKC").toLowerCase();
		return !(e.topic_none ?? []).some((none) =>
			wanted.some((w) => n(w).includes(n(none)) || n(none).includes(n(w))),
		);
	}, "topic_noneの語とtopic/topic_anyの語が互いを含んでいます");

const parserItemSchema = z
	.object({
		id: z.string().min(1),
		raw_text: z.string().min(1),
		now: isoDateTime,
		tags: z.array(z.string()),
		expect: parserExpectSchema,
	})
	.strict();

export type ParserItem = z.infer<typeof parserItemSchema>;

export type ParserGoldset = {
	version: number;
	approved_by_owner: string | null;
	items: ParserItem[];
};

// ---- Jev ----

/** buildNormalizedTextに渡せる最小の列(IntentRowの該当列と同じ名前・型) */
const intentFixtureSchema = z
	.object({
		form: z.enum(["connection", "occasion"]),
		topic: z.string().min(1),
		softConstraints: z.array(z.string()),
		negativeConstraints: z.array(z.string()),
		participantsMin: z.number().int().min(1),
		participantsMax: z.number().int().min(1),
		participantsIncludesOwner: z.boolean(),
		startsAt: dateFromIso.nullable().default(null),
		endsAt: dateFromIso.nullable().default(null),
		budgetMin: z.number().int().nullable().default(null),
		budgetMax: z.number().int().nullable().default(null),
		/** 地域名の比較(設計書 §6)に使う任意の地域名 */
		area: z.string().min(1).optional(),
	})
	.strict()
	.refine(
		(f) => f.participantsMin <= f.participantsMax,
		"participantsMin<=maxではありません",
	)
	.refine(
		(f) =>
			f.budgetMin === null ||
			f.budgetMax === null ||
			f.budgetMin <= f.budgetMax,
		"budgetMin<=maxではありません",
	);

export type IntentFixture = z.infer<typeof intentFixtureSchema>;

const jevPairSchema = z
	.object({
		id: z.string().min(1),
		a: intentFixtureSchema,
		b: intentFixtureSchema,
		match: z.enum(["yes", "no"]),
		/** falseならJevの採点(順序整合・Precision/Recall@0.60)から外す。地域の比較(region.ts)では使う(LAT-114) */
		jev_scored: z.boolean().optional(),
	})
	.strict();

export type JevPair = z.infer<typeof jevPairSchema>;

/** Jevの採点に使う組(jev_scored: false の組を除く・LAT-114) */
export const jevScoredPairs = (pairs: JevPair[]): JevPair[] =>
	pairs.filter((p) => p.jev_scored !== false);

export type JevGoldset = {
	version: number;
	approved_by_owner: string | null;
	pairs: JevPair[];
};

// ---- 共通 ----

const rawIdOf = (raw: unknown, index: number): string => {
	const id = (raw as { id?: unknown } | null)?.id;
	return typeof id === "string" && id !== "" ? id : `#${index + 1}`;
};

const readYaml = (path: string): unknown => parse(readFileSync(path, "utf8"));

/** ヘッダ(version・承認日)と、件のリスト(キー名)を件ごとに検証して返す */
const loadList = <T>(
	path: string,
	listKey: string,
	itemSchema: z.ZodType<T>,
	idOf: (item: T) => string,
): { version: number; approved_by_owner: string | null; list: T[] } => {
	const doc = readYaml(path);
	// 計算されたキーは型が広がるため、ヘッダ2項目と件のリストを分けて型付けする
	const head = z
		.object({
			version: z.number().int().positive(),
			approved_by_owner: approvedSchema,
		})
		.and(z.object({ [listKey]: z.array(z.unknown()) }))
		.safeParse(doc);
	if (!head.success) {
		throw new Error(`${path}: 形式が不正です: ${head.error.message}`);
	}
	const rawList = head.data[listKey] as unknown[];
	const seen = new Set<string>();
	const list = rawList.map((raw, i) => {
		const r = itemSchema.safeParse(raw);
		if (!r.success) {
			throw new Error(
				`${path}: 件 ${rawIdOf(raw, i)} が不正です: ${r.error.message}`,
			);
		}
		const id = idOf(r.data);
		if (seen.has(id)) {
			throw new Error(`${path}: idが重複しています: ${id}`);
		}
		seen.add(id);
		return r.data;
	});
	return {
		version: head.data.version,
		approved_by_owner: head.data.approved_by_owner,
		list,
	};
};

export const loadParserGoldset = (path: string): ParserGoldset => {
	const { version, approved_by_owner, list } = loadList(
		path,
		"items",
		parserItemSchema,
		(i) => i.id,
	);
	return { version, approved_by_owner, items: list };
};

export const loadJevGoldset = (path: string): JevGoldset => {
	const { version, approved_by_owner, list } = loadList(
		path,
		"pairs",
		jevPairSchema,
		(i) => i.id,
	);
	return { version, approved_by_owner, pairs: list };
};
