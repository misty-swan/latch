/**
 * 外部送信の同意画面(ボード: Consent.dc.htmlの移植)。
 * - docs/07 §8の3系統(Parser/Jev/Embedding)の同意文言をボード表現どおり置く
 * - 「同意して進む」でlocalStorage(latch.consent=true)に記録してcomposeへ進む
 *   (同意後は最初の1件を預ける導線・ボードConsent.dc.htmlのリンク先どおり)
 * - 「同意しないで進む」は記録せずhomeへ(同意したユーザーのみがIntentを作成できる・07 §8)
 * 文言・構造・クラス名はボードどおり。記録と遷移の細部だけ実装の裁量
 */

import { Link, useNavigate, useSearchParams } from "react-router";
import { PATHS } from "../routes/paths";
import { ScreenGrain } from "./shared";

const CONSENT_STORAGE_KEY = "latch.consent";

/** 同意項目(番号・見出し・docs/07 §8の文言) */
const CONSENT_ITEMS: ReadonlyArray<{ n: string; k: string; d: string }> = [
	{
		n: "01",
		k: "読み解き",
		d: "入力した文章を、意思の解析のためそのまま外部AI事業者(Anthropic)へ送信します(学習利用はありません)",
	},
	{
		n: "02",
		k: "成立の判定",
		d: "相手との成立判定のため、預けた意思から生成したテキストを外部AI事業者(TypeSafe・緊急時はAnthropic)へ送信します(入力原文は送りません・学習利用はありません)",
	},
	{
		n: "03",
		k: "意味の近さの計算",
		d: "意味検索の埋め込み計算はCloudflare内で行われ、外部送信はありません",
	},
];

export function Consent() {
	const navigate = useNavigate();
	// ?view=1は自分の画面からの閲覧。同意の操作を出さず・戻り先を自分の画面にする
	const viewOnly = useSearchParams()[0].get("view") === "1";

	const accept = (): void => {
		try {
			localStorage.setItem(CONSENT_STORAGE_KEY, "true");
		} catch {
			// 保存できない環境では次回の起動時にまた問うだけとする
		}
		// 同意後は最初の1件を預ける導線へ(ボードConsent.dc.htmlのリンク先どおり)
		navigate(PATHS.compose);
	};

	return (
		<div className="screen">
			<ScreenGrain />
			<header className="topbar">
				<div className="topbar__side">
					<Link
						className="icon-btn"
						to={viewOnly ? PATHS.me : PATHS.register}
						aria-label="戻る"
					>
						<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
							<path d="M14.5 5.5L8 12l6.5 6.5" />
						</svg>
					</Link>
				</div>
				<span />
				<div className="topbar__side topbar__side--end">
					{viewOnly ? null : (
						<span className="t-meta" style={{ paddingRight: 14 }}>
							2 / 2
						</span>
					)}
				</div>
			</header>
			<div
				className="screen__body pad"
				style={{ paddingTop: 12, paddingBottom: 12 }}
			>
				<h1 className="t-display t-display--s">預けた言葉の、扱いについて。</h1>
				<p className="t-body" style={{ marginTop: 12 }}>
					意思を読み解き、合う相手との成立を判定するために、次のように扱います。
				</p>
				<ol className="consent">
					{CONSENT_ITEMS.map((item) => (
						<li key={item.n} className="consent__item">
							<span className="consent__n t-num">{item.n}</span>
							<div>
								<p className="consent__k">{item.k}</p>
								<p className="consent__d">{item.d}</p>
							</div>
						</li>
					))}
				</ol>
				<p className="note" style={{ marginTop: 20 }}>
					<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
						<rect x="5.5" y="10.5" width="13" height="9.5" rx="2.4" />
						<path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
					</svg>
					<span>
						預けた文章そのものが、
						<b>ほかの利用者に表示されることはありません。</b>
					</span>
				</p>
			</div>
			{viewOnly ? null : (
				<div className="screen__foot">
					<button
						type="button"
						className="btn btn--primary btn--block"
						onClick={accept}
					>
						同意して進む
					</button>
					<button
						type="button"
						className="btn btn--quiet"
						onClick={() => navigate(PATHS.home)}
					>
						同意しないで進む
					</button>
					<p
						className="t-caption"
						style={{ textAlign: "center", marginTop: -4 }}
					>
						同意しない場合、意思を預けることはできません。閲覧と設定はできます。
					</p>
				</div>
			)}
		</div>
	);
}
