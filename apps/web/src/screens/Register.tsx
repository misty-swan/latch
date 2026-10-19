/**
 * 登録画面(ボード: Register.dc.htmlの移植)。
 * - 表示名(1..40)・生年月日をreact-hook-form+zodResolverで検証する
 *   (検証の核は@latch/sharedのregisterUserRequestSchemaが使う値と同じ:
 *   LIMITS.DISPLAY_NAME_MAX_LENGTH・birthDateSchemaを流用)
 * - 送信はPOST /v1/users(docs/05 §3.2)。成功応答でsub付きJWTへ付け替え・consentへ進む
 * - 422 UNDER_AGE(18歳未満)ではボードUnderAge.dc.htmlどおりの表示へ切り替える
 * 文言・構造・クラス名はボードどおり。エラー表示とAPI接続の細部だけ実装の裁量
 */

import { zodResolver } from "@hookform/resolvers/zod";
import { birthDateSchema, LIMITS } from "@latch/shared";
import { type CSSProperties, useState } from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate } from "react-router";
import { z } from "zod";
import { ApiError, apiFetch } from "../api/client";
import { authSession } from "../auth/session";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

/** POST /v1/usersの応答(docs/05 §3.2: sub付きJWTへの付け替えと新規リフレッシュ族) */
interface RegisterResponse {
	user: unknown;
	access_token: string;
	refresh_token: string | null;
	expires_in: number;
}

/** フォームの検証(項目はボードどおり表示名と生年月日のみ・bioは既定値で送らない) */
const registerFormSchema = z.object({
	display_name: z
		.string()
		.trim()
		.min(1, "表示名を入力してください")
		.max(
			LIMITS.DISPLAY_NAME_MAX_LENGTH,
			`表示名は${LIMITS.DISPLAY_NAME_MAX_LENGTH}文字までです`,
		),
	birth_date: z
		.string()
		.min(1, "生年月日を入力してください")
		.refine(
			(value) => birthDateSchema.safeParse(value).success,
			"生年月日を正しく入力してください",
		),
});
type RegisterFormValues = z.infer<typeof registerFormSchema>;

/** 今日の日付(YYYY-MM-DD・JST)。生年月日のmax(未来日を入れさせない) */
const todayJst = (): string =>
	new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(
		new Date(),
	);

export function Register() {
	const navigate = useNavigate();
	const [underAge, setUnderAge] = useState(false);
	const [submitError, setSubmitError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const {
		register,
		handleSubmit,
		formState: { errors },
	} = useForm<RegisterFormValues>({
		resolver: zodResolver(registerFormSchema),
		defaultValues: { display_name: "", birth_date: "" },
	});

	const onSubmit = async (values: RegisterFormValues): Promise<void> => {
		if (busy) {
			return;
		}
		setBusy(true);
		setSubmitError(null);
		try {
			const registered = await apiFetch<RegisterResponse>("/users", {
				method: "POST",
				json: {
					display_name: values.display_name,
					birth_date: values.birth_date,
				},
			});
			authSession.setTokens(registered.access_token, registered.refresh_token);
			navigate(PATHS.consent, { replace: true });
		} catch (cause) {
			if (cause instanceof ApiError && cause.code === "UNDER_AGE") {
				setUnderAge(true);
			} else {
				setSubmitError(
					cause instanceof ApiError
						? cause.message
						: "登録できませんでした。もう一度お試しください",
				);
			}
			setBusy(false);
		}
	};

	if (underAge) {
		return (
			<div className="screen">
				<ScreenGrain />
				<header className="topbar">
					<div className="topbar__side">
						<button
							type="button"
							className="icon-btn"
							aria-label="戻る"
							onClick={() => setUnderAge(false)}
						>
							<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
								<path d="M14.5 5.5L8 12l6.5 6.5" />
							</svg>
						</button>
					</div>
					<span />
					<div className="topbar__side topbar__side--end" />
				</header>
				<div
					className="screen__body pad"
					style={{
						display: "flex",
						flexDirection: "column",
						justifyContent: "center",
						paddingBottom: 40,
					}}
				>
					<div style={{ marginBottom: 40 }}>
						<div
							className="latch is-empty"
							style={{ "--size": "132px", "--gap": "12px" } as CSSProperties}
							aria-hidden="true"
						>
							<span className="latch__light" />
							<span className="latch__mine" />
							<span className="latch__theirs">
								<span className="latch__ink" />
							</span>
						</div>
					</div>
					<h1 className="t-display t-display--s">
						LATCHは、18歳以上の方のためのサービスです。
					</h1>
					<p className="t-body" style={{ marginTop: 14 }}>
						入力された生年月日では、いまはご利用いただけません。18歳になったら、またお越しください。
					</p>
				</div>
				<div className="screen__foot">
					<button
						type="button"
						className="btn btn--secondary btn--block"
						onClick={() => navigate(PATHS.welcome)}
					>
						閉じる
					</button>
				</div>
			</div>
		);
	}

	return (
		<div className="screen">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="icon-btn" to={PATHS.signin} aria-label="戻る">
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end">
					<span className="t-meta" style={{ paddingRight: 14 }}>
						1 / 2
					</span>
				</div>
			</header>
			<form
				className="screen__form"
				onSubmit={handleSubmit(onSubmit)}
				noValidate
			>
				<div className="screen__body pad" style={{ paddingTop: 12 }}>
					<h1 className="t-display t-display--s">あなたのことを、少しだけ。</h1>
					<div className="stack" style={{ gap: 28, marginTop: 30 }}>
						<div className="field">
							<label className="field__label" htmlFor="r-name">
								表示名
							</label>
							<input
								className="input"
								id="r-name"
								maxLength={40}
								autoComplete="nickname"
								placeholder="例: みなと"
								{...register("display_name")}
							/>
							{errors.display_name?.message === undefined ? (
								<p className="field__help">
									つながった相手にだけ表示されます。あとから変えられます。
								</p>
							) : (
								<p className="field__error" role="alert">
									{errors.display_name.message}
								</p>
							)}
						</div>
						<div className="field">
							<label className="field__label" htmlFor="r-birth">
								生年月日
							</label>
							<input
								className="input"
								id="r-birth"
								type="date"
								max={todayJst()}
								{...register("birth_date")}
							/>
							{errors.birth_date?.message === undefined ? (
								<p className="field__help">
									年齢の確認にだけ使います。誰にも表示されません。
								</p>
							) : (
								<p className="field__error" role="alert">
									{errors.birth_date.message}
								</p>
							)}
						</div>
						{submitError !== null && (
							<p className="field__error" role="alert">
								{submitError}
							</p>
						)}
					</div>
				</div>
				<div className="screen__foot">
					<button
						type="submit"
						className="btn btn--primary btn--block"
						disabled={busy}
					>
						次へ
					</button>
				</div>
			</form>
		</div>
	);
}
