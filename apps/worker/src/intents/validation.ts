/**
 * Intentのactive化(draft→active)時の検証(docs/05 §2.2)。
 * 違反は理由コードの配列として列挙し、ルート層がVALIDATION_FAILEDに付す。
 * 現在時刻は呼び出し側から受け取る(時刻の規律・docs/04 §4)。
 */
import {
	type IntentForm,
	OCCASION_STARTS_AT_MAX_DAYS_AHEAD,
} from "@latch/shared";
import { ageAtYears } from "../auth/age";
import { LEGAL_DRINKING_AGE } from "../pipeline/layer1";
import {
	connectionExpiry,
	type ExpiryDays,
	MS_PER_DAY,
	occasionDefaultExpiry,
} from "./expiry";

/** active化検証に必要なIntent欄(DB行やリクエスト本文からの必要部分のみ) */
export interface IntentFieldsForActive {
	form?: IntentForm | null;
	topic?: string | null;
	startsAt?: Date | null;
	alcoholInvolved?: boolean;
	/** draft保存時に確定していたexpires_at(機会のみ参照される) */
	storedExpiresAt?: Date | null;
	/** active化リクエストで明示されたexpires_at(機会のみ設定可) */
	explicitExpiresAt?: Date | null;
	expiresInDays?: ExpiryDays;
}

/** 検証結果。ok時は確定したexpires_at・違反時は理由コード配列 */
export type ActiveValidation =
	| { ok: true; expiresAt: Date }
	| { ok: false; reasons: string[] };

export const validateIntentForActive = (
	f: IntentFieldsForActive,
	now: Date,
): ActiveValidation => {
	const reasons: string[] = [];

	// form確定必須・topic 1..40(docs/05 §2.2)
	if (!f.form) {
		reasons.push("form_required");
	}
	if (!f.topic) {
		reasons.push("topic_required");
	}

	if (f.form === "occasion") {
		if (!f.startsAt) {
			// 機会Intentはstarts_at必須
			reasons.push("starts_at_required");
		} else {
			// 現在以降〜now+7日以内(nowちょうど・上限ちょうどは可)
			const t = f.startsAt.getTime();
			const maxMs =
				now.getTime() + OCCASION_STARTS_AT_MAX_DAYS_AHEAD * MS_PER_DAY;
			if (t < now.getTime() || t > maxMs) {
				reasons.push("starts_at_out_of_range");
			}
			// 明示expires_atはstartより後
			if (f.explicitExpiresAt && f.explicitExpiresAt.getTime() <= t) {
				reasons.push("expires_at_before_start");
			}
		}
	}

	if (f.form === "connection") {
		// つながりIntentはstarts_at=null・alcohol_involved=false・明示expires_at不可
		if (f.startsAt) {
			reasons.push("starts_at_not_allowed");
		}
		if (f.alcoholInvolved) {
			reasons.push("alcohol_not_allowed");
		}
		if (f.explicitExpiresAt) {
			reasons.push("expires_at_not_allowed");
		}
	}

	if (reasons.length > 0) {
		return { ok: false, reasons };
	}

	if (f.form === "connection") {
		// 期限はactive化時刻+7/30/90日(未指定は既定30日)
		return { ok: true, expiresAt: connectionExpiry(now, f.expiresInDays) };
	}
	if (f.startsAt) {
		// 期限は明示expires_atを最優先・draft保存値・既定start+3時間の順
		return {
			ok: true,
			expiresAt:
				f.explicitExpiresAt ??
				f.storedExpiresAt ??
				occasionDefaultExpiry(f.startsAt),
		};
	}
	// 機会でstarts_at無し(上でstarts_at_requiredを列挈済みのため通常到達しない)
	return { ok: false, reasons };
};

/**
 * 20歳未満の飲酒を含む機会Intentか(F7a設計 §4・docs/08 §8)。
 * form=occasionかつalcohol_involvedで、満年齢が飲酒年齢(Layer 1と同じ定数)未満なら制限する。
 * 現在時刻は呼び出し側から受け取る(docs/04 §4)
 */
export const isAlcoholRestricted = (
	f: { form: IntentForm | null; alcoholInvolved: boolean },
	birthDate: string,
	now: Date,
): boolean =>
	f.form === "occasion" &&
	f.alcoholInvolved &&
	ageAtYears(now, birthDate) < LEGAL_DRINKING_AGE;
