/**
 * PCの「預けている」の右の提案の部屋(prototype/project/Desktop.dc.html の aside・LAT-14)。
 * 進行中の提案があれば、その1件を提案画面(LatchScreen)ごと描き、ここで参加する・今回は見送る・取り消しができる。
 * 無ければ部屋を消灯したまま残す(提案が届いても画面の配置が動かず、灯りだけがともる)
 * 出す提案は未回答のものを先に選び、無ければ相手の回答待ちのもの。部屋で成立まで見届けたLATCHは
 * 一覧(進行中の提案)から外れても、部屋を開いている間は出し続ける
 */

import { type CSSProperties, useEffect, useRef } from "react";
import { useProposalsQuery } from "../latches/queries";
import { LatchScreen } from "../screens/latch/LatchScreen";
import { ScreenGrain } from "../screens/shared";

/** 部屋に出す提案のID */
const useRoomLatchId = (): string | null => {
	const items = useProposalsQuery().data?.items ?? [];
	const pick =
		(items.find((latch) => latch.my_response === null) ?? items[0])?.id ?? null;
	const shown = useRef<string | null>(null);
	if (pick !== null) shown.current = pick;
	return shown.current;
};

export function HomeRoom({
	onPick,
}: {
	/** 選んだ提案を外枠へ知らせる(到着カードの「右に表示中」に使う) */
	onPick(latchId: string | null): void;
}) {
	const latchId = useRoomLatchId();
	useEffect(() => {
		onPick(latchId);
	}, [latchId, onPick]);
	useEffect(() => () => onPick(null), [onPick]);
	if (latchId !== null) {
		return (
			<aside className="desk__room" aria-label="届いた提案">
				<LatchScreen key={latchId} latchId={latchId} />
			</aside>
		);
	}
	return (
		<aside className="desk__room" aria-label="提案の部屋">
			<div className="screen desk-room--quiet" data-theme="dark">
				<ScreenGrain />
				<p className="t-eyebrow">提案</p>
				<div className="desk-room__stage">
					<div
						className="latch is-waiting"
						style={{ "--size": "200px", "--gap": "22px" } as CSSProperties}
						aria-hidden="true"
					>
						<span className="latch__light" />
						<span className="latch__mine" />
						<span className="latch__theirs">
							<span className="latch__ink" />
						</span>
					</div>
				</div>
				<h2 className="t-display t-display--s desk-room__title">
					いまは、届いている提案は
					<br />
					ありません。
				</h2>
				<p className="t-caption" style={{ marginTop: 12 }}>
					合う相手が現れたときだけ、ここに灯りがともります。待つあいだ、何もしなくてかまいません。
				</p>
			</div>
		</aside>
	);
}
