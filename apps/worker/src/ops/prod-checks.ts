/**
 * prodの設定とシークレットの名前の点検(F10・docs/11 §1「prodシークレットにテスト鍵が残っていない」・
 * LAT-122・手順はdocs/runbooks/prod.md 6章)。wrangler.jsoncのenv.productionのvarsと
 * `wrangler secret list --env production`の名前の一覧を受け取り、起動ガード(env.tsの
 * assertEnvSafety)が拒む名前の残存と、必須のシークレットの欠落を返す純粋関数。
 * Workerの部品は読み込まない(点検のコマンド`scripts/check-prod-secrets.mjs`がNodeから直接読み込むため)。
 * シークレットの値はwranglerからも読めないため、テスト用VAPID鍵の混入は名前では分からない。
 * それは疎通確認(GET /healthzが200=起動ガードを通った)で確かめる。
 */

/** prodのvarsにもシークレットにも置いてはいけない名前(起動ガードが起動を拒む・docs/10 §2・§5) */
export const FORBIDDEN_PROD_NAMES = [
	"LATCH_TEST_IDP_JWKS",
	"LATCH_TEST_IDP_PRIVATE_JWKS",
	"TEST_QUEUES_DISABLED",
	"LATCH_RATE_LIMIT_RELAX_SUBJECT_PREFIX",
] as const;

/** prodで常に必須のシークレット(docs/04 §4・F7b設計 §5.5) */
export const REQUIRED_PROD_SECRETS = [
	"JWT_SECRET",
	"VAPID_PUBLIC_KEY",
	"VAPID_PRIVATE_KEY",
	"VAPID_SUBJECT",
] as const;

/** LATCH_LLM_MODE=realのときに必須のシークレット(ENV_MISSING_LLM_KEY) */
export const LLM_KEY_SECRETS = [
	"ANTHROPIC_API_KEY",
	"TYPESAFE_API_KEY",
] as const;

/** 本番IdP(LAT-90)の接続で要る値。起動ガードは見ないため、欠落は注意として返す */
export const IDP_CLIENT_NAMES = [
	"GOOGLE_CLIENT_ID",
	"APPLE_CLIENT_ID",
] as const;

/**
 * オーナーへのメール(予算アラート・日次サマリ・docs/04 §9)の宛先と送り元。送り元は独自ドメイン
 * (LAT-121)のアドレスで、ドメインが決まるまで登録できないため、欠落は注意として返す
 */
export const ALERT_MAIL_SECRETS = ["ALERT_MAIL_TO", "ALERT_MAIL_FROM"] as const;

export interface ProdCheckResult {
	/** 起動ガードに拒まれる・公開の前提(docs/11 §1)を満たさない点 */
	problems: string[];
	/** 今は起動を妨げないが、公開までに埋める点 */
	notes: string[];
}

/** `wrangler secret list --format json`の出力(配列)から名前を取り出す */
export const secretNamesOf = (listed: unknown): string[] => {
	if (!Array.isArray(listed)) {
		throw new Error("wrangler secret listの出力が配列ではありません");
	}
	return listed.map((s) => {
		const name = (s as { name?: unknown } | null)?.name;
		if (typeof name !== "string") {
			throw new Error("wrangler secret listの出力に名前の無い行があります");
		}
		return name;
	});
};

/**
 * prodのvarsとシークレットの名前を点検する。
 * vars=wrangler.jsoncのenv.production.vars・secretNames=登録済みのシークレットの名前
 */
export const checkProdConfig = (
	vars: Record<string, string>,
	secretNames: readonly string[],
): ProdCheckResult => {
	const problems: string[] = [];
	const notes: string[] = [];
	const secrets = new Set(secretNames);

	if (vars.LATCH_ENV !== "production") {
		problems.push(
			`varsのLATCH_ENVがproductionではない(${vars.LATCH_ENV ?? "未設定"})。起動ガードが働かない`,
		);
	}
	if (vars.LATCH_PUSH_MODE !== "real") {
		problems.push("varsのLATCH_PUSH_MODEがrealではない(ENV_UNSAFE_PUSH)");
	}
	for (const name of FORBIDDEN_PROD_NAMES) {
		if (name in vars) problems.push(`varsに${name}がある(起動ガードが拒む)`);
		if (secrets.has(name)) {
			problems.push(`シークレットに${name}がある(起動ガードが拒む)`);
		}
	}
	for (const name of REQUIRED_PROD_SECRETS) {
		if (!secrets.has(name)) problems.push(`シークレットに${name}が無い`);
	}
	const llmReal = vars.LATCH_LLM_MODE === "real";
	for (const name of LLM_KEY_SECRETS) {
		if (llmReal && !secrets.has(name)) {
			problems.push(
				`LATCH_LLM_MODE=realなのにシークレットに${name}が無い(ENV_MISSING_LLM_KEY)`,
			);
		}
	}
	if (!llmReal || vars.LATCH_EMBEDDING_MODE !== "real") {
		notes.push(
			"Parser/JevかEmbeddingがrealではない(公開の前提はreal固定・docs/11 §1・LAT-91)",
		);
	}
	if (vars.LATCH_MAIL_MODE !== "real") {
		notes.push(
			"varsのLATCH_MAIL_MODEがrealではない(コストアラートと日次サマリが届かない・docs/11 §1)",
		);
	}
	for (const name of ALERT_MAIL_SECRETS) {
		if (!secrets.has(name)) {
			notes.push(
				`シークレットに${name}が無い(コストアラートと日次サマリが届かない・docs/runbooks/prod.md・LAT-86)`,
			);
		}
	}
	for (const name of IDP_CLIENT_NAMES) {
		if (!secrets.has(name) && !(name in vars)) {
			notes.push(`${name}が無い(本番IdPの接続・LAT-90)`);
		}
	}
	return { problems, notes };
};
