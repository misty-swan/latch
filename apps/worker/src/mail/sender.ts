/**
 * オーナーへのメール(予算アラート・日次サマリ)の送り手の差し替え口(docs/04 §9・LAT-124)。
 * stubは外部へ送らず常に成功、realはCloudflare Email Serviceの送信バインディング(send_email)で
 * ALERT_MAIL_FROMからALERT_MAIL_TOへ送る。本文は件数だけで、ID・本文・表示名は入れない(08 §6)。
 */

import type { Env } from "../env";

export interface AlertMail {
	subject: string;
	text: string;
}

export type MailSendResult =
	| { kind: "ok" }
	| {
			kind: "failed";
			/** Email Serviceの例外のcode(E_SENDER_NOT_VERIFIED等)か、設定の欠落 */
			errorCode: string;
	  };

export interface MailSender {
	send(mail: AlertMail): Promise<MailSendResult>;
}

/** 外部へ送らず常に成功(手元・試験・stagingを独自ドメインとEmail Serviceに依存させない) */
export const stubMailSender: MailSender = {
	async send() {
		return { kind: "ok" };
	},
};

/** Email Serviceの例外のcode。codeの無い例外は名前で代える */
const errorCodeOf = (error: unknown): string => {
	const code = (error as { code?: unknown } | null)?.code;
	if (typeof code === "string" && code !== "") return code;
	return error instanceof Error ? error.name : "UNKNOWN";
};

export const realMailSender = (
	binding: SendEmail,
	from: string,
	to: string,
): MailSender => ({
	async send(mail) {
		try {
			await binding.send({ from, to, subject: mail.subject, text: mail.text });
			return { kind: "ok" };
		} catch (error) {
			return { kind: "failed", errorCode: errorCodeOf(error) };
		}
	},
});

/**
 * LATCH_MAIL_MODE(既定stub)に応じた送り手を返す。realでバインディング・宛先・送り元の
 * どれかが無いときは、送るたびに失敗(MAIL_NOT_CONFIGURED)を返す送り手にする
 * (Cronを止めず、失敗のログで気づけるようにする)
 */
export const mailSenderOf = (env: Env): MailSender => {
	if (env.LATCH_MAIL_MODE !== "real") return stubMailSender;
	if (!env.ALERT_MAIL || !env.ALERT_MAIL_TO || !env.ALERT_MAIL_FROM) {
		return {
			async send() {
				return { kind: "failed", errorCode: "MAIL_NOT_CONFIGURED" };
			},
		};
	}
	return realMailSender(env.ALERT_MAIL, env.ALERT_MAIL_FROM, env.ALERT_MAIL_TO);
};
