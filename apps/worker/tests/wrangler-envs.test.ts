/**
 * wrangler.jsoncのトップレベルとenv.staging・env.productionの整合の確認(F8b設計 §1.1・
 * docs/04 §6・prodはF10)。
 * wranglerの環境ではバインディングとvarsが区画へ引き継がれないため、書き漏れを
 * 単体試験で防ぐ(workerd内からは実FSを読めないので?rawで文字列として読む)。
 */
import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";
import raw from "../wrangler.jsonc?raw";

interface Queues {
	producers?: { binding: string; queue: string }[];
	consumers?: {
		queue: string;
		max_retries?: number;
		max_batch_timeout?: number;
		max_batch_size?: number;
		dead_letter_queue?: string;
	}[];
}
interface Section {
	d1_databases?: { binding: string; database_name: string }[];
	kv_namespaces?: { binding: string }[];
	r2_buckets?: { binding: string; bucket_name: string }[];
	vectorize?: { binding: string; index_name: string }[];
	queues?: Queues;
	analytics_engine_datasets?: { binding: string; dataset: string }[];
	durable_objects?: { bindings: { name: string }[] };
	ai?: { binding: string };
	ratelimits?: {
		name: string;
		namespace_id: string;
		simple: { limit: number; period: number };
	}[];
	send_email?: { name: string }[];
	vars?: Record<string, string>;
	triggers?: { crons: string[] };
	workers_dev?: boolean;
	preview_urls?: boolean;
}
const config = parse(raw) as Section & {
	env?: { staging?: Section; production?: Section };
};
const top = config;
const staging = config.env?.staging as Section;
const production = config.env?.production as Section;

/** バインディング名の集合(種類ごと) */
const bindingNames = (s: Section) => ({
	d1: s.d1_databases?.map((b) => b.binding).sort(),
	kv: s.kv_namespaces?.map((b) => b.binding).sort(),
	r2: s.r2_buckets?.map((b) => b.binding).sort(),
	vectorize: s.vectorize?.map((b) => b.binding).sort(),
	producers: s.queues?.producers?.map((b) => b.binding).sort(),
	ae: s.analytics_engine_datasets?.map((b) => b.binding).sort(),
	do: s.durable_objects?.bindings.map((b) => b.name).sort(),
	ratelimits: s.ratelimits?.map((b) => b.name).sort(),
	sendEmail: s.send_email?.map((b) => b.name).sort(),
});

describe("wrangler.jsonc の env.staging", () => {
	it("区画が存在する", () => {
		expect(staging).toBeDefined();
	});

	it("バインディング名の集合がトップレベルと一致し、aiも両方にある", () => {
		expect(bindingNames(staging)).toEqual(bindingNames(top));
		expect(top.ai?.binding).toBe("AI");
		// オーナーへのメールの送信バインディング(docs/04 §9)。宛先と送り元はsecretに置く
		expect(top.send_email).toEqual([{ name: "ALERT_MAIL" }]);
		expect(staging.ai?.binding).toBe("AI");
	});

	it("varsが設計 §1.3の4値と応答の後の処理の切り替え(#30)に一致する", () => {
		expect(staging.vars).toEqual({
			LATCH_ENV: "staging",
			LATCH_EMBEDDING_MODE: "real",
			LATCH_LLM_MODE: "real",
			LATCH_PUSH_MODE: "stub",
			LATCH_MAIL_MODE: "stub",
			LATCH_INLINE_PIPELINE: "on",
			LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX: "load-",
		});
	});

	it("60req/分のバインディングが両方にあり、namespace_idが環境ごとに別(docs/04 §5)", () => {
		const simple = { limit: 60, period: 60 };
		expect(top.ratelimits).toEqual([
			{ name: "API_RATE_LIMITER", namespace_id: "1001", simple },
		]);
		expect(staging.ratelimits).toEqual([
			{ name: "API_RATE_LIMITER", namespace_id: "1002", simple },
		]);
		// トップレベル(手元・prodの元)には緩和を置かない(docs/10 §5)
		expect(top.vars?.LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX).toBeUndefined();
	});

	it("応答の後の第1段・第2段(LATCH_INLINE_PIPELINE)はトップレベルもstagingもon(#30)", () => {
		expect(top.vars?.LATCH_INLINE_PIPELINE).toBe("on");
		expect(staging.vars?.LATCH_INLINE_PIPELINE).toBe("on");
	});

	it("資源名がトップレベルと異なり、設計 §1.2の名前である", () => {
		expect(staging.d1_databases?.[0].database_name).toBe("latch-db-staging");
		expect(staging.r2_buckets?.[0].bucket_name).toBe("latch-icons-staging");
		expect(staging.vectorize?.[0].index_name).toBe("latch-intents-staging");
		expect(staging.analytics_engine_datasets?.[0].dataset).toBe(
			"latch_metrics_staging",
		);
		expect(staging.queues?.producers?.[0].queue).toBe("match-events-staging");
		expect(staging.d1_databases?.[0].database_name).not.toBe(
			top.d1_databases?.[0].database_name,
		);
		expect(staging.r2_buckets?.[0].bucket_name).not.toBe(
			top.r2_buckets?.[0].bucket_name,
		);
		expect(staging.vectorize?.[0].index_name).not.toBe(
			top.vectorize?.[0].index_name,
		);
		expect(staging.queues?.producers?.[0].queue).not.toBe(
			top.queues?.producers?.[0].queue,
		);
	});

	it("queuesのconsumerが-staging付きの名前とDLQ・再試行回数を持つ", () => {
		expect(staging.queues?.consumers).toEqual([
			{
				queue: "match-events-staging",
				max_retries: 3,
				max_batch_timeout: 1,
				max_batch_size: 1,
				dead_letter_queue: "match-events-dlq-staging",
			},
			{ queue: "match-events-dlq-staging", max_retries: 1 },
		]);
	});

	it("毎分Cronを持つ", () => {
		expect(staging.triggers?.crons).toEqual(["* * * * *"]);
	});

	it("workers.devは有効でプレビューURLは無効", () => {
		expect(staging.workers_dev).toBe(true);
		expect(staging.preview_urls).toBe(false);
	});
});

describe("wrangler.jsonc の env.production(F10・docs/04 §6)", () => {
	it("区画が存在する", () => {
		expect(production).toBeDefined();
	});

	it("バインディング名の集合がトップレベルと一致し、aiもある", () => {
		expect(bindingNames(production)).toEqual(bindingNames(top));
		expect(production.ai?.binding).toBe("AI");
	});

	it("varsは起動ガードの判定値(LATCH_ENV=production)・LLMとEmbeddingとPushとメールがreal・応答の後の処理on・緩和なし", () => {
		// LLMとEmbeddingは最初のデプロイからreal(2026-10-27オーナー決定・LAT-91)。
		// オーナーへのメールもreal(2026-10-27オーナー決定・docs/04 §9)
		expect(production.vars).toEqual({
			LATCH_ENV: "production",
			LATCH_EMBEDDING_MODE: "real",
			LATCH_LLM_MODE: "real",
			LATCH_PUSH_MODE: "real",
			LATCH_MAIL_MODE: "real",
			LATCH_INLINE_PIPELINE: "on",
		});
	});

	it("60req/分のバインディングがあり、namespace_idがトップレベル・stagingと別", () => {
		expect(production.ratelimits).toEqual([
			{
				name: "API_RATE_LIMITER",
				namespace_id: "1003",
				simple: { limit: 60, period: 60 },
			},
		]);
	});

	it("資源名が-production付きで、トップレベル・stagingと異なる", () => {
		expect(production.d1_databases?.[0].database_name).toBe(
			"latch-db-production",
		);
		expect(production.r2_buckets?.[0].bucket_name).toBe(
			"latch-icons-production",
		);
		expect(production.vectorize?.[0].index_name).toBe(
			"latch-intents-production",
		);
		expect(production.analytics_engine_datasets?.[0].dataset).toBe(
			"latch_metrics_production",
		);
		expect(production.queues?.producers?.[0].queue).toBe(
			"match-events-production",
		);
	});

	it("queuesのconsumerが-production付きの名前とDLQ・再試行回数を持つ", () => {
		expect(production.queues?.consumers).toEqual([
			{
				queue: "match-events-production",
				max_retries: 3,
				max_batch_timeout: 1,
				max_batch_size: 1,
				dead_letter_queue: "match-events-dlq-production",
			},
			{ queue: "match-events-dlq-production", max_retries: 1 },
		]);
	});

	it("毎分Cronを持つ", () => {
		expect(production.triggers?.crons).toEqual(["* * * * *"]);
	});

	it("独自ドメインが決まるまで公開のURLを持たない(workers.devもプレビューURLも無効)", () => {
		expect(production.workers_dev).toBe(false);
		expect(production.preview_urls).toBe(false);
	});
});

describe("主キューの消費者の待ち時間(#19)", () => {
	it("トップレベル・staging・productionの主キューのmax_batch_timeoutが1(秒)", () => {
		const mainOf = (s: Section) =>
			s.queues?.consumers?.find((c) => c.dead_letter_queue !== undefined)
				?.max_batch_timeout;
		expect(mainOf(top)).toBe(1);
		expect(mainOf(staging)).toBe(1);
		expect(mainOf(production)).toBe(1);
	});
});

describe("主キューの消費者のバッチ(#30・オーナー決定)", () => {
	it("トップレベル・staging・productionの主キューのmax_batch_sizeが1、DLQは指定しない", () => {
		for (const s of [top, staging, production]) {
			const consumers = s.queues?.consumers ?? [];
			const main = consumers.find((c) => c.dead_letter_queue !== undefined);
			const dlq = consumers.find((c) => c.dead_letter_queue === undefined);
			expect(main?.max_batch_size).toBe(1);
			expect(dlq?.max_batch_size).toBeUndefined();
		}
	});
});
