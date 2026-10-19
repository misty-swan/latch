/**
 * 預ける(Compose)→読み解き中(Reading)→確認(Confirm)間の受け渡し状態
 * (docs/04 §3.2: グローバル単一ストアは持たず・画面間の純クライアント状態は専用の受け渡しで足す)。
 * - sessionStorage(latch.compose)に置く。タブを閉じれば消え・URLにも出ない
 * - Composeはparse前の入力(raw_text+draft id)を保存し・Readingがparse応答を埋めてConfirmへ渡す
 * - 読み出しはZodで検証し・壊れていれば破棄してnullを返す
 *   (直アクセス・リロードでconfirmが壊れない: F2'計画Review Focus #3)
 */

import {
	LIMITS,
	type ParseIntentResponse,
	parseResponseSchema,
} from "@latch/shared";
import { z } from "zod";

/** Composeが確定させる前の入力(parse呼び出し前・Readingへ渡す) */
export interface PendingCompose {
	/** 便箋に入力された文章(そのままparse・保存に使う) */
	raw_text: string;
	/** 下書き(?draft=<id>)から開いた場合のIntent id・新規はnull */
	draft_id: string | null;
}

/** parse成功後にConfirmへ渡す状態(parse応答+raw_text+draft編集時はdraft id) */
export interface ComposeState extends PendingCompose {
	/** POST /v1/intents/parseの応答(docs/05 §3.3) */
	parse: ParseIntentResponse;
}

const COMPOSE_STORAGE_KEY = "latch.compose";

/** sessionStorage上の形状(parseは未確定の間null)。idはULID(docs/05 §2.2) */
const composeStorageSchema = z.object({
	raw_text: z.string().max(LIMITS.RAW_TEXT_MAX_LENGTH),
	draft_id: z.string().length(26).nullable(),
	parse: parseResponseSchema.nullable(),
});

type ComposeStorage = z.infer<typeof composeStorageSchema>;

const write = (value: ComposeStorage): void => {
	try {
		sessionStorage.setItem(COMPOSE_STORAGE_KEY, JSON.stringify(value));
	} catch {
		// 保存できない環境では画面間の受け渡しができないだけ(parse前に読み解く画面へ戻る)
	}
};

/** 読み出しは常に検証し・壊れていれば破棄する(古い形式の残骸をconfirmに流さない) */
const read = (): ComposeStorage | null => {
	try {
		const stored = sessionStorage.getItem(COMPOSE_STORAGE_KEY);
		if (stored === null) {
			return null;
		}
		const parsed = composeStorageSchema.safeParse(JSON.parse(stored));
		if (!parsed.success) {
			sessionStorage.removeItem(COMPOSE_STORAGE_KEY);
			return null;
		}
		return parsed.data;
	} catch {
		// JSONとして壊れている値も残骸として破棄する
		try {
			sessionStorage.removeItem(COMPOSE_STORAGE_KEY);
		} catch {
			// 破棄できない環境では次の書き込みが上書きするだけとする
		}
		return null;
	}
};

/** Compose→Readingへparse前の入力を渡す(既存の状態があれば上書きする) */
export const savePendingCompose = (state: PendingCompose): void => {
	write({ raw_text: state.raw_text, draft_id: state.draft_id, parse: null });
};

/** Reading→Confirmへparse結果を埋めて渡す(parse前の入力は引き継ぐ) */
export const saveComposeState = (state: ComposeState): void => {
	write({
		raw_text: state.raw_text,
		draft_id: state.draft_id,
		parse: state.parse,
	});
};

/** parse前の入力を取り出す(Readingが消費する)。未保存・parse済み・壊損時はnull */
export const readPendingCompose = (): PendingCompose | null => {
	const stored = read();
	if (stored === null || stored.parse !== null) {
		return null;
	}
	return { raw_text: stored.raw_text, draft_id: stored.draft_id };
};

/** parse込みの状態を取り出す(Confirmが消費する)。未保存・parse前・壊損時はnull */
export const readComposeState = (): ComposeState | null => {
	const stored = read();
	if (stored === null || stored.parse === null) {
		return null;
	}
	return {
		raw_text: stored.raw_text,
		draft_id: stored.draft_id,
		parse: stored.parse,
	};
};

/** 受け渡し状態を破棄する(Confirmでの保存完了後などTask 5が呼ぶ) */
export const clearComposeState = (): void => {
	try {
		sessionStorage.removeItem(COMPOSE_STORAGE_KEY);
	} catch {
		// 破棄できない環境では次の保存が上書きするだけとする
	}
};
