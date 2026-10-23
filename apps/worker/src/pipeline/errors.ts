/**
 * パイプライン共通のエラーコード抽出(docs/08 §6: ログにはerror_codeのみ出す)。
 */

/** causeを辿る最大の段数(外側のErrorを含めず内側へ最大3段) */
const MAX_CAUSE_DEPTH = 3;

/**
 * 1つのメッセージを分類名へ倒す。合わなければundefined。
 * 返すのは分類名だけで、メッセージの中身(個人情報を含み得る)は出さない
 */
const classifyMessage = (message: string): string | undefined => {
	const vector = /^VECTOR_(GET|UPSERT)_ERROR \(code = (\d+)\)/.exec(message);
	if (vector !== null) {
		return `VECTOR_${vector[1]}_${vector[2]}`;
	}
	if (message.startsWith("D1_ERROR")) {
		return /overloaded/i.test(message) ? "D1_OVERLOADED" : "D1_ERROR";
	}
	if (message.startsWith("Queue send failed")) {
		return "QUEUE_SEND_FAILED";
	}
	const ai = /^(\d{4}):/.exec(message);
	if (ai !== null) {
		return `AI_${ai[1]}`;
	}
	return undefined;
};

/**
 * エラーの分類名を返す(Cloudflareの資源ごとの失敗を見分けるため・docs/08 §6)。
 * causeを最大3段辿り、内側から順にVectorize(VECTOR_GET_40007等)・D1
 * (D1_OVERLOADED/D1_ERROR)・Queues(QUEUE_SEND_FAILED)・Workers AI(AI_3040等)の
 * 規則で判定する。どれにも合わなければTypeError、次いで従来の判定
 * (メッセージ先頭の「CODE: 〜」形式のコード)、それでもだめならfallback。
 * fallbackの既定はINTERNAL(Embedding経路は呼び出し側でEMBEDDING_FAILEDを渡す)
 */
export const errorCodeOf = (error: unknown, fallback = "INTERNAL"): string => {
	const chain: unknown[] = [error];
	for (let i = 0; i < MAX_CAUSE_DEPTH; i += 1) {
		const cause: unknown =
			chain[chain.length - 1] instanceof Error
				? (chain[chain.length - 1] as Error).cause
				: undefined;
		if (cause === undefined || cause === null) {
			break;
		}
		chain.push(cause);
	}
	for (let i = chain.length - 1; i >= 0; i -= 1) {
		const node = chain[i];
		if (node instanceof Error) {
			const classified = classifyMessage(node.message);
			if (classified !== undefined) {
				return classified;
			}
		}
	}
	if (error instanceof TypeError) {
		return "TypeError";
	}
	const raw = error instanceof Error ? error.message : String(error);
	const code = raw.split(":")[0]?.trim() ?? "";
	return /^[A-Z0-9_]+$/.test(code) ? code : fallback;
};
