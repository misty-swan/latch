/**
 * Jevのstub(docs/07 §2(b)・§5)。全7軸とも固定値を返しLLMを呼ばない。
 * 通常は0.9(閾値0.60を確実に超え、提案の発生をE2Eで保証する)。
 * テストseedの文字列先頭に応じた0.9/0.3の切替を許す(07 §2(b))。
 */
import { JEV_AXES, type JevAxes, type JevFn } from "../types";

/** 通常出力。全軸0.9(07 §2(b)) */
export const STUB_JEV_HIGH = 0.9;

/** 低値マーカー前置時の出力。全軸0.3(07 §2(b)のテストseed拡張) */
export const STUB_JEV_LOW = 0.3;

/** 低値へ切り替えるマーカー。正規化テキストの先頭に前置して使う */
export const JEV_LOW_MARKER = "__jev_low__";

/** タイムアウト失敗へ切り替えるマーカー。失敗経路の試験用・lowと併存したらこちらを優先する */
export const JEV_TIMEOUT_MARKER = "__jev_timeout__";

/** 両Intentの正規化テキストから7軸の確率を返す(数値のみ・07 §5) */
export const stubJev: JevFn = async (input) => {
	if (
		input.normalizedA.startsWith(JEV_TIMEOUT_MARKER) ||
		input.normalizedB.startsWith(JEV_TIMEOUT_MARKER)
	) {
		return { ok: false, kind: "timeout" };
	}
	const low =
		input.normalizedA.startsWith(JEV_LOW_MARKER) ||
		input.normalizedB.startsWith(JEV_LOW_MARKER);
	const score = low ? STUB_JEV_LOW : STUB_JEV_HIGH;
	const axes = Object.fromEntries(
		JEV_AXES.map((axis) => [axis, score]),
	) as JevAxes;
	return { ok: true, axes };
};
