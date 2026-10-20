/**
 * パイプライン共通のエラーコード抽出(docs/08 §6: ログにはerror_codeのみ出す)。
 */

/**
 * エラーメッセージ先頭のコード部(「CODE: 〜」形式・llm/embedding.tsの規約)を
 * 取り出す。コード形式でないメッセージ・Error以外はfallbackに倒す。
 * fallbackの既定はINTERNAL(Embedding経路は呼び出し側でEMBEDDING_FAILEDを渡す)
 */
export const errorCodeOf = (error: unknown, fallback = "INTERNAL"): string => {
	const raw = error instanceof Error ? error.message : String(error);
	const code = raw.split(":")[0]?.trim() ?? "";
	return /^[A-Z0-9_]+$/.test(code) ? code : fallback;
};
