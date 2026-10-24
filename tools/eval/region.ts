/**
 * 地域名の比較(設計書 §7・docs/07 §4・`pnpm eval:region`)。
 * jev-pairs.yamlの各組を、正規化テキストの末尾に「・<地域名>」を足す/足さないの2通りで
 * Workers AI(bge-m3)に通し、yes・noの組のcosine類似度の分かれ方を比べる。
 * 認証情報は環境変数CLOUDFLARE_ACCOUNT_ID・CLOUDFLARE_AI_API_TOKEN、無ければtools/eval/.envから読む。
 * アカウントID・トークン・URLは出力しない(失敗時もHTTPの状態コードだけ)。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildNormalizedText } from "../../apps/worker/src/pipeline/normalize";
import { loadJevGoldset } from "./lib/goldset";
import { fixtureToRow } from "./lib/intent-row";
import { cosine, median, separation } from "./lib/separation";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../..");
const OUT = "eval/records/region.json";
const BATCH = 50;

const embed = async (
	accountId: string,
	token: string,
	texts: string[],
): Promise<number[][]> => {
	const out: number[][] = [];
	for (let i = 0; i < texts.length; i += BATCH) {
		const res = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/baai/bge-m3`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ text: texts.slice(i, i + BATCH) }),
			},
		);
		if (!res.ok)
			throw new Error(`Embeddingの呼び出しに失敗しました(HTTP ${res.status})`);
		const body = (await res.json()) as { result?: { data?: number[][] } };
		const data = body.result?.data;
		if (!data || data.length !== Math.min(BATCH, texts.length - i)) {
			throw new Error("Embeddingの応答の形が想定と違います");
		}
		out.push(...data);
	}
	return out;
};

type Sims = { yes: number[]; no: number[] };
const stat = (s: Sims) => ({
	yesCount: s.yes.length,
	noCount: s.no.length,
	yesMedian: median(s.yes),
	noMedian: median(s.no),
	...separation(s.yes, s.no),
});
const r3 = (n: number) => (Number.isNaN(n) ? "-" : n.toFixed(3));

const main = async (): Promise<number> => {
	const envPath = join(here, ".env");
	if (existsSync(envPath)) process.loadEnvFile(envPath);
	const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
	const token = process.env.CLOUDFLARE_AI_API_TOKEN ?? "";
	if (accountId === "" || token === "") {
		console.error(
			"比較を始められません: CLOUDFLARE_ACCOUNT_ID・CLOUDFLARE_AI_API_TOKEN がありません。tools/eval/.env に書くか、環境変数で渡してください。",
		);
		return 2;
	}
	const gold = loadJevGoldset(join(repoRoot, "eval/goldset/jev-pairs.yaml"));
	const pairs = gold.pairs;
	const base = (f: (typeof pairs)[number]["a"]) =>
		buildNormalizedText(fixtureToRow(f));
	const withArea = (f: (typeof pairs)[number]["a"]) =>
		f.area ? `${base(f)}・${f.area}` : base(f);

	const variants = {
		なし: (f: (typeof pairs)[number]["a"]) => base(f),
		あり: withArea,
	};
	const result: Record<string, Record<string, ReturnType<typeof stat>>> = {};
	for (const [name, mk] of Object.entries(variants)) {
		const texts = pairs.flatMap((p) => [mk(p.a), mk(p.b)]);
		const vecs = await embed(accountId, token, texts);
		const all: Sims = { yes: [], no: [] };
		const same: Sims = { yes: [], no: [] };
		const diff: Sims = { yes: [], no: [] };
		pairs.forEach((p, i) => {
			const sim = cosine(vecs[2 * i] as number[], vecs[2 * i + 1] as number[]);
			const key = p.match === "yes" ? "yes" : "no";
			all[key].push(sim);
			(p.a.area === p.b.area ? same : diff)[key].push(sim);
		});
		result[name] = {
			全体: stat(all),
			同じ地域の組: stat(same),
			違う地域の組: stat(diff),
		};
	}

	console.log(`地域名の比較(組${pairs.length}件・bge-m3・cosine)`);
	console.log("変種\t区分\tyes件\tno件\tyes中央値\tno中央値\t差\tAUC");
	for (const [v, groups] of Object.entries(result)) {
		for (const [g, s] of Object.entries(groups)) {
			console.log(
				[
					v,
					g,
					s.yesCount,
					s.noCount,
					r3(s.yesMedian),
					r3(s.noMedian),
					r3(s.medianGap),
					r3(s.auc),
				].join("\t"),
			);
		}
	}
	const out = join(repoRoot, OUT);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(
		out,
		`${JSON.stringify({ model: "@cf/baai/bge-m3", pairCount: pairs.length, goldsetVersion: gold.version, variants: result }, null, 2)}\n`,
	);
	console.log(`記録: ${OUT}`);
	return 0;
};

main().then(
	(c) => {
		process.exitCode = c;
	},
	(e: unknown) => {
		console.error(
			`比較を中断しました: ${e instanceof Error ? e.message : String(e)}`,
		);
		process.exitCode = 2;
	},
);
