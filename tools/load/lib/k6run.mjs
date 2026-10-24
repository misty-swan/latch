/**
 * k6の起動の組み立て(run.mjsから使う)。宛先のURLとAccessの通行証は`-e`の引数で渡さず、
 * 子の環境変数で渡す(引数はプロセスの一覧から他の利用者にも見えるため)。
 * k6は既定でシステムの環境変数を__ENVに入れる(k6 v1.8.1で確認)ので、シナリオは今までどおり__ENVから読む。
 */
import { accessHeaders } from "./target.mjs";

/**
 * @param {{ env: Record<string, string | undefined>, scenario: string, k6Args: string[] }} p
 * @returns {{ args: string[], childEnv: Record<string, string | undefined>, base: string, secrets: string[] }}
 */
export function k6Invocation({ env, scenario, k6Args }) {
	const base = (env.LATCH_LOAD_BASE_URL || "").replace(/\/+$/, "");
	const access = accessHeaders(env);
	const childEnv = { ...env, LATCH_LOAD_BASE_URL: base };
	// 片方だけの通行証はシナリオにも渡さない(accessHeadersと同じ扱い)
	if (Object.keys(access).length === 0) {
		delete childEnv.LATCH_ACCESS_CLIENT_ID;
		delete childEnv.LATCH_ACCESS_CLIENT_SECRET;
	}
	return {
		args: ["run", ...k6Args, scenario],
		childEnv,
		base,
		secrets: Object.values(access),
	};
}
