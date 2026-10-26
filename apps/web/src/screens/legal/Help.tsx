/**
 * ヘルプ・お問い合わせ(/help・LAT-94)。「自分」画面の行から開く案内のページ。
 * 2026-10-26オーナー決定: アプリ内の案内のページとし、規約と同じく「公開前の版」の印を付け、
 * お問い合わせ先は利用規約(9.)と同じく公開準備(F10)で記入する。
 * prototypeにボードが無いため、規約ページの枠(LegalPage)を使う。困ったときの導線は既存の画面の名前に揃える
 */

import { Link } from "react-router";
import { PATHS } from "../../routes/paths";
import { LegalPage, LegalSection, TBD } from "./LegalPage";

export function Help() {
	return (
		<LegalPage title="ヘルプ・お問い合わせ">
			<LegalSection title="困ったときは">
				<ul>
					<li>
						相手の言動で困ったときは、チャットの操作メニューの「通報する」「ブロックする」を使ってください。通報したことは相手に知らされません。
					</li>
					<li>通知の受け取り方は、「自分」の「通知と表示」で変えられます。</li>
					<li>
						退会は、「自分」の「退会する」から行えます。退会で削除されるものは、
						<Link className="link" to={PATHS.privacy}>
							プライバシーポリシー
						</Link>
						に書いています。
					</li>
				</ul>
			</LegalSection>

			<LegalSection title="お問い合わせ">
				<p>LATCHについてのご質問やご意見は、次の窓口で受け付けます。</p>
				<ul>
					<li>お問い合わせ先: {TBD}</li>
				</ul>
			</LegalSection>
		</LegalPage>
	);
}
