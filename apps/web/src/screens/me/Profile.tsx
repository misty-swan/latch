/**
 * プロフィール編集(/me/profile・F7c設計)。prototype/app/app.jsのscreens.profile・
 * Profile.dc.htmlの移植。文字数は[...str].lengthで数える(prototypeと同じ)。
 */

import { LIMITS } from "@latch/shared";
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError } from "../../api/client";
import {
	useMeQuery,
	useResetIcon,
	useUpdateProfile,
	useUploadIcon,
	validateIconFile,
} from "../../me/queries";
import { PATHS } from "../../routes/paths";
import { Avatar } from "../latch/art";
import { ScreenGrain } from "../shared";
import "./me.css";

const FAILED = "送れませんでした。時間をおいて、もう一度お試しください。";
const ICON_NOTE = "PNG・JPEG・WebP、1MBまで。";
const count = (s: string): number => [...s].length;

export function Profile() {
	const navigate = useNavigate();
	const me = useMeQuery();
	const update = useUpdateProfile();
	const upload = useUploadIcon();
	const reset = useResetIcon();
	const fileRef = useRef<HTMLInputElement>(null);
	const [name, setName] = useState("");
	const [bio, setBio] = useState("");
	const [loaded, setLoaded] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);
	const [bioError, setBioError] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const [iconWarn, setIconWarn] = useState(false);
	const [iconFailed, setIconFailed] = useState(false);

	// 初回に取得できた値を入力欄の初期値にする(入力中に再取得で上書きしない)
	useEffect(() => {
		if (me.data && !loaded) {
			setName(me.data.display_name);
			setBio(me.data.bio);
			setLoaded(true);
		}
	}, [me.data, loaded]);

	const saving = update.isPending;
	const canSave = loaded && !saving && name.trim() !== "";

	const save = async (): Promise<void> => {
		if (!me.data || !canSave) return;
		const body: { display_name?: string; bio?: string } = {};
		if (name.trim() !== me.data.display_name) body.display_name = name.trim();
		if (bio !== me.data.bio) body.bio = bio;
		if (Object.keys(body).length === 0) {
			navigate(PATHS.me);
			return;
		}
		setNameError(null);
		setBioError(null);
		setFailed(false);
		try {
			await update.mutateAsync(body);
			navigate(PATHS.me);
		} catch (e) {
			if (e instanceof ApiError && e.code === "VALIDATION_FAILED") {
				const field = (e.details as { field?: unknown }).field;
				if (field === "bio") setBioError(e.message);
				else setNameError(e.message);
			} else {
				setFailed(true);
			}
		}
	};

	const pick = async (file: File | undefined): Promise<void> => {
		if (!file) return;
		setIconFailed(false);
		if (validateIconFile(file) !== null) {
			setIconWarn(true);
			return;
		}
		setIconWarn(false);
		try {
			await upload.mutateAsync(file);
		} catch {
			setIconFailed(true);
		}
	};

	const resetIcon = async (): Promise<void> => {
		setIconWarn(false);
		setIconFailed(false);
		try {
			await reset.mutateAsync();
		} catch {
			setIconFailed(true);
		}
	};

	const iconBusy = upload.isPending || reset.isPending;
	const danger = { color: "var(--danger)" };

	return (
		<div className="screen profile">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link className="btn btn--quiet btn--small" to={PATHS.me}>
						やめる
					</Link>
				</div>
				<div className="topbar__title">プロフィール</div>
				<div className="topbar__side topbar__side--end">
					<button
						className="btn btn--quiet btn--small"
						type="button"
						style={{ color: "var(--ink)" }}
						disabled={!canSave}
						onClick={save}
					>
						保存
					</button>
				</div>
			</header>
			<div
				className="screen__body pad"
				style={{ paddingTop: 12, paddingBottom: 28 }}
			>
				<div className="row" style={{ gap: 18 }}>
					<Avatar
						userId={me.data?.id}
						hasIcon={me.data?.has_icon ?? false}
						size="xl"
						tone="b"
						label="あなたのアイコン"
						version={me.dataUpdatedAt}
					/>
					<div className="stack" style={{ gap: 6 }}>
						<button
							className="btn btn--secondary btn--small"
							type="button"
							disabled={iconBusy}
							onClick={() => fileRef.current?.click()}
						>
							<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
								<rect x="4" y="5" width="16" height="14" rx="2.4" />
								<circle cx="9" cy="10" r="1.6" />
								<path d="M5 17l4.6-4.4 3.4 3.2 2.4-2.2L19 17" />
							</svg>
							画像を選ぶ
						</button>
						<button
							className="btn btn--quiet btn--small"
							type="button"
							style={{ justifyContent: "flex-start", paddingLeft: 4 }}
							disabled={iconBusy}
							onClick={resetIcon}
						>
							既定のアイコンに戻す
						</button>
						<input
							ref={fileRef}
							type="file"
							accept="image/png,image/jpeg,image/webp"
							hidden
							onChange={(e) => {
								const file = e.target.files?.[0];
								e.target.value = "";
								void pick(file);
							}}
						/>
					</div>
				</div>
				<p className="t-caption" style={{ marginTop: 10 }}>
					{ICON_NOTE}未設定のときは、この模様が表示されます。
				</p>
				{iconWarn ? (
					<p
						className="t-caption"
						role="alert"
						style={{ ...danger, marginTop: 6 }}
					>
						{ICON_NOTE}
					</p>
				) : null}
				{iconFailed ? (
					<p
						className="t-caption"
						role="alert"
						style={{ ...danger, marginTop: 6 }}
					>
						{FAILED}
					</p>
				) : null}
				<div className="stack" style={{ gap: 28, marginTop: 30 }}>
					<div className="field">
						<div className="row" style={{ justifyContent: "space-between" }}>
							<label className="field__label" htmlFor="p-name">
								表示名
							</label>
							<span className="counter">
								<b>{count(name)}</b> / {LIMITS.DISPLAY_NAME_MAX_LENGTH}
							</span>
						</div>
						<input
							className="input"
							id="p-name"
							maxLength={LIMITS.DISPLAY_NAME_MAX_LENGTH}
							value={name}
							onChange={(e) => setName(e.target.value)}
						/>
						{nameError ? (
							<p className="field__help" role="alert" style={danger}>
								{nameError}
							</p>
						) : null}
					</div>
					<div className="field">
						<div className="row" style={{ justifyContent: "space-between" }}>
							<label className="field__label" htmlFor="p-bio">
								ひとこと
								<span
									style={{
										fontWeight: 400,
										color: "var(--ink-3)",
										marginLeft: 6,
									}}
								>
									任意
								</span>
							</label>
							<span className="counter">
								<b>{count(bio)}</b> / {LIMITS.BIO_MAX_LENGTH}
							</span>
						</div>
						<textarea
							className="input"
							id="p-bio"
							rows={4}
							maxLength={LIMITS.BIO_MAX_LENGTH}
							style={{
								fontFamily: "var(--f-mincho)",
								fontWeight: 500,
								fontSize: 16,
							}}
							placeholder="例: 夜に散歩しながら、写真を撮っています。"
							value={bio}
							onChange={(e) => setBio(e.target.value)}
						/>
						{bioError ? (
							<p className="field__help" role="alert" style={danger}>
								{bioError}
							</p>
						) : null}
						<p className="field__help">
							つながった相手にだけ表示されます。年齢・性別・所在地を書く欄はありません。
						</p>
					</div>
				</div>
				{failed ? (
					<p
						className="t-caption"
						role="alert"
						style={{ ...danger, marginTop: 16 }}
					>
						{FAILED}
					</p>
				) : null}
			</div>
		</div>
	);
}
