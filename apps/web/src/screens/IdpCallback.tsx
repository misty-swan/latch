/**
 * 本番IdP(Google/Apple)からの戻り先(/auth/callback・docs/04 §4)。
 * - URLの#以降を出発の控えと照合し(auth/idp.ts)、目的に応じて進む:
 *   サインイン=POST /v1/auth/token→登録(/register)かホーム、退会=DELETE /v1/users/me→はじめの画面
 * - 失敗は出発した画面(サインイン・退会)へ戻して一言を出す。利用者の取り消しは一言を出さずに戻す
 * - IDトークンを履歴に残さないため、照合の直後にURLの#以降を消し、移るときもreplaceで履歴を置き換える
 * 退会の戻りは保護画面だが、AuthGateが起動時にセッションを復元してから描くため、ここでは確かめない
 * (セッションが無ければDELETEが401になり、apiFetchがはじめの画面へ送る)
 * 本文は実装の裁量(ボードに無い・確かめている間の短い一言だけ)
 */

import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { ApiError } from "../api/client";
import { completeIdpRedirect } from "../auth/idp";
import { signInWithIdpToken } from "../auth/signin";
import { PATHS } from "../routes/paths";
import { useCompleteWithdraw, type WithdrawLocationState } from "./me/Withdraw";
import type { SignInLocationState } from "./SignIn";
import { ScreenGrain } from "./shared";

/** サインインの失敗の一言(サーバーの文言が無いとき) */
const SIGNIN_FAILED = "サインインできませんでした。もう一度お試しください";

/** 戻りの照合の失敗(控え無し・不一致・期限切れ)の一言 */
const VERIFY_FAILED = "確かめられませんでした。もう一度お試しください";

export function IdpCallback() {
	const location = useLocation();
	const navigate = useNavigate();
	const completeWithdraw = useCompleteWithdraw();
	// 照合は1回だけ(控えは1回で捨てるため、描き直しで2回目を走らせない)
	const started = useRef(false);

	useEffect(() => {
		if (started.current) {
			return;
		}
		started.current = true;
		const result = completeIdpRedirect(location.hash);
		window.history.replaceState(window.history.state, "", PATHS.idpCallback);

		const backTo = (
			purpose: "signin" | "withdraw" | undefined,
			idpError: string | undefined,
		) => {
			const state: SignInLocationState & WithdrawLocationState =
				idpError === undefined ? {} : { idpError };
			navigate(purpose === "withdraw" ? PATHS.withdraw : PATHS.signin, {
				replace: true,
				state,
			});
		};

		if (!result.ok) {
			backTo(
				result.purpose,
				result.reason === "cancelled" ? undefined : VERIFY_FAILED,
			);
			return;
		}
		const { provider, purpose, idToken } = result;
		if (purpose === "withdraw") {
			void completeWithdraw(provider, idToken).then((failure) => {
				if (failure !== null) {
					backTo("withdraw", failure);
				}
			});
			return;
		}
		signInWithIdpToken(provider, idToken)
			.then(({ registrationRequired }) => {
				navigate(registrationRequired ? PATHS.register : PATHS.home, {
					replace: true,
				});
			})
			.catch((cause: unknown) => {
				backTo(
					"signin",
					cause instanceof ApiError ? cause.message : SIGNIN_FAILED,
				);
			});
	}, [location.hash, navigate, completeWithdraw]);

	return (
		<div className="screen">
			<ScreenGrain />
			<div className="screen__body pad" style={{ paddingTop: 48 }}>
				<p className="t-body" role="status">
					確かめています…
				</p>
			</div>
		</div>
	);
}
