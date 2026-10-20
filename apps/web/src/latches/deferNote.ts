/**
 * 「見送りの説明を見たか」の端末内記録(F4c設計)。formごとに1回だけ出す。
 * localStorageが使えない環境(プライベートモード等)では毎回表示に倒し・例外は出さない。
 */

import type { IntentForm } from "@latch/shared";

const keyOf = (form: IntentForm): string => `latch.deferNoteSeen.${form}`;

/** 説明を出すべきか(未記録・または記録を読めないときtrue) */
export const shouldShowDeferNote = (form: IntentForm): boolean => {
	try {
		return localStorage.getItem(keyOf(form)) !== "1";
	} catch {
		return true;
	}
};

/** 説明を見たことを記録する(書けなくても黙って無視する) */
export const markDeferNoteSeen = (form: IntentForm): void => {
	try {
		localStorage.setItem(keyOf(form), "1");
	} catch {
		// 記録できなくても画面の進行は止めない
	}
};
