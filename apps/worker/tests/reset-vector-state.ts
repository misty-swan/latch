/**
 * 試験用: 試験の間のベクトルの状態を空にする。インメモリVectorStore(シングルトン)に加え、
 * 直近のベクトルの控え(recent_vectors・#47)も消す。D1の意思の行は試験の間で残るため、
 * 控えが残ると評価の補いが前の試験の意思を候補に混ぜてしまう
 */
import { env } from "cloudflare:test";
import { resetMemoryVectorStore } from "../src/vectorstore/memory";

export const resetVectorState = async (): Promise<void> => {
	resetMemoryVectorStore();
	await (env as unknown as { DB: D1Database }).DB.prepare(
		"DELETE FROM recent_vectors",
	).run();
};
