/**
 * Jevの組の確かめ(LAT-109)。ゴールドセット(jev-pairs.yaml)のうちJevの採点に使う組を
 * (A,B)の順だけでJevのrealへ送り、組ごとのLATCH ScoreとPrecision/Recall@0.60を標準出力へ出す。
 * 精度ゲートの採点ではない(順序整合を測らず、記録も書かない)。本物のAIを呼ぶ(課金あり)。
 * 使い方: pnpm --filter eval exec tsx jev-probe.ts [--primary-only] [--fallback-only]
 * APIキーはgate.tsと同じく環境変数かtools/eval/.envから読む。キー・URLは出力しない
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { anthropicJev } from "../../apps/worker/src/llm/real/jev-anthropic";
import { typesafeJev } from "../../apps/worker/src/llm/real/jev-typesafe";
import type { JevFn, JevOutcome } from "../../apps/worker/src/llm/types";
import { buildNormalizedText } from "../../apps/worker/src/pipeline/normalize";
import { type JevPair, jevScoredPairs, loadJevGoldset } from "./lib/goldset";
import { fixtureToRow } from "./lib/intent-row";
import { latchScore, precisionAt } from "./lib/score";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const envPath = join(here, ".env");
const THRESHOLD = 0.6;
const CONCURRENCY = 4;
const MAX_RETRIES = 5;

const args = new Set(process.argv.slice(2));

const sets: { name: string; pairs: JevPair[] }[] = [
	{
		name: "本体",
		pairs: jevScoredPairs(
			loadJevGoldset(join(repoRoot, "eval/goldset/jev-pairs.yaml")).pairs,
		),
	},
];

/** 429は5秒待って呼び直す(確かめの中だけ) */
const callWithRetry = async (
	jev: JevFn,
	pair: JevPair,
): Promise<JevOutcome> => {
	const input = {
		normalizedA: buildNormalizedText(fixtureToRow(pair.a)),
		normalizedB: buildNormalizedText(fixtureToRow(pair.b)),
	};
	for (let attempt = 0; ; attempt++) {
		const outcome = await jev(input);
		if (outcome.ok || outcome.kind !== "rate_limited" || attempt >= MAX_RETRIES)
			return outcome;
		await new Promise((r) => setTimeout(r, 5000));
	}
};

const mapLimit = async <T, R>(
	items: T[],
	fn: (item: T) => Promise<R>,
): Promise<R[]> => {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			results[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker),
	);
	return results;
};

const num = (v: number | null): string => (v === null ? "なし" : v.toFixed(3));

const main = async (): Promise<number> => {
	if (existsSync(envPath)) process.loadEnvFile(envPath);
	const anthropic = process.env.ANTHROPIC_API_KEY ?? "";
	const typesafe = process.env.TYPESAFE_API_KEY ?? "";
	const providers: { name: string; jev: JevFn }[] = [];
	if (!args.has("--fallback-only")) {
		if (typesafe === "") return missing("TYPESAFE_API_KEY");
		providers.push({
			name: "第一候補TypeSafe",
			jev: typesafeJev({ apiKey: typesafe }),
		});
	}
	if (!args.has("--primary-only")) {
		if (anthropic === "") return missing("ANTHROPIC_API_KEY");
		providers.push({
			name: "予備Anthropic",
			jev: anthropicJev({ apiKey: anthropic }),
		});
	}

	let calls = 0;
	for (const provider of providers) {
		for (const set of sets) {
			const outcomes = await mapLimit(set.pairs, (pair) => {
				calls++;
				return callWithRetry(provider.jev, pair);
			});
			console.log(`\n${provider.name}・${set.name}(${set.pairs.length}組)`);
			set.pairs.forEach((pair, i) => {
				const o = outcomes[i] as JevOutcome;
				const text = o.ok
					? `${num(latchScore(o.axes))}(a→b ${num(o.axes.would_a_accept_b)}・b→a ${num(o.axes.would_b_accept_a)}・purpose ${num(o.axes.purpose_fit)})`
					: `失敗(${o.kind})`;
				const miss =
					o.ok && latchScore(o.axes) > THRESHOLD !== (pair.match === "yes")
						? " ←食い違い"
						: "";
				console.log(`  ${pair.id} ${pair.match}: ${text}${miss}`);
			});
			const p = precisionAt(set.pairs, outcomes, THRESHOLD);
			console.log(
				`  Precision@0.60 ${num(p.precision)}(${p.truePositive}/${p.predictedPositive})・Recall@0.60 ${num(p.recall)}(${p.truePositive}/${p.actualPositive})・失敗 ${p.failedCalls}`,
			);
		}
	}
	console.log(`\n呼び出しの回数(429の呼び直しを除く): ${calls}`);
	return 0;
};

const missing = (key: string): number => {
	console.error(`確かめを始められません: APIキー(${key})がありません。`);
	return 2;
};

main().then(
	(code) => {
		process.exitCode = code;
	},
	(e: unknown) => {
		console.error(
			`確かめを中断しました: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exitCode = 2;
	},
);
