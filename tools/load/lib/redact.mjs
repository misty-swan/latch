/**
 * stagingのURLを出力から伏せる(F8b設計 §2.1)。k6は通信の失敗のときに
 * `WARN Request Failed error="Post \"https://<host>/v1/intents\": ..."`のように
 * 宛先のURLをそのまま出すため、run.mjsがk6の出力をすべてここに通す。
 * 規則はapps/worker/scripts/lib/wrangler-cli.mjsのredactUrls(workers.devのURL)と同じで、
 * 加えて宛先のURLそのものとそのホスト名も伏せる(workers.dev以外の宛先でも漏らさない)。
 */

const MASK = "<url伏せ>";
const SECRET_MASK = "<伏せ>";

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** 宛先のURL(末尾の/は無視)からホスト名を取る。読めなければnull */
const hostOf = (baseUrl) => {
	try {
		return new URL(baseUrl).host || null;
	} catch {
		return null;
	}
};

/**
 * textの中の宛先のURL・ホスト名・workers.devのURLを伏せる。
 * secretsはAccessの通行証の値(IDとシークレット)で、そのまま出たものも伏せる
 */
export function redact(text, baseUrl = "", secrets = []) {
	let out = text;
	for (const secret of secrets) {
		if (typeof secret === "string" && secret !== "") {
			out = out.split(secret).join(SECRET_MASK);
		}
	}
	const base = baseUrl.replace(/\/+$/, "");
	const host = base === "" ? null : hostOf(base);
	if (host !== null) {
		// スキーム付き(http/https/ws/wss)のURLをパスごと伏せてから、残ったホスト名を伏せる
		out = out.replace(
			new RegExp(`[a-z]+://${escapeRegExp(host)}[^\\s"'\\\\]*`, "gi"),
			MASK,
		);
		out = out.replace(new RegExp(escapeRegExp(host), "gi"), MASK);
	}
	return out.replace(/https?:\/\/[^\s"']*workers\.dev[^\s"']*/g, MASK);
}

/**
 * 流れてくる出力を行(\nまたは\r=k6の進み具合の書き換え)の単位で伏せる。
 * 行の途中で切れた分は次のchunkまで持ち越す(ホスト名が2つのchunkに割れても伏せる)
 */
export function createLineRedactor(baseUrl, write, secrets = []) {
	let rest = "";
	return {
		push(chunk) {
			rest += chunk;
			const last = Math.max(rest.lastIndexOf("\n"), rest.lastIndexOf("\r"));
			if (last < 0) return;
			write(redact(rest.slice(0, last + 1), baseUrl, secrets));
			rest = rest.slice(last + 1);
		},
		end() {
			if (rest !== "") write(redact(rest, baseUrl, secrets));
			rest = "";
		},
	};
}
