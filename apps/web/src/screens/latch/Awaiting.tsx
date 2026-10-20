/**
 * 回答待ち画面(表示のみ・prototype/app/app.js screens.awaiting・Awaiting.dc.html)。
 * 提案画面と同じ枠で・絵は押した状態・操作は回答の取り消しだけ。
 */

import type { LatchDTO } from "@latch/shared";
import { ProposalFrame } from "./Proposal";

type AwaitingProps = {
	latch: LatchDTO;
	now: Date;
	busy: boolean;
	notice: string | null;
	onRetract(): void;
};

export function Awaiting({
	latch,
	now,
	busy,
	notice,
	onRetract,
}: AwaitingProps) {
	return (
		<ProposalFrame
			latch={latch}
			now={now}
			pressed
			notice={notice}
			text={
				<h1 className="t-display" style={{ marginTop: 2 }}>
					相手の回答を
					<br />
					待っています。
				</h1>
			}
			foot={
				<button
					className="btn btn--quiet btn--block"
					type="button"
					onClick={onRetract}
					disabled={busy}
				>
					回答を取り消す
				</button>
			}
		/>
	);
}
