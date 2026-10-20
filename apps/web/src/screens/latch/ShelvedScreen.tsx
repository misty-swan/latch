/**
 * /latches/:id/shelvedの親画面(F4c設計 §1.1・§1.3)。見送った本人だけが使う。
 * 見送っていない(my_responseがdefer以外)なら/latches/:idへ置き換える。
 */

import { Navigate, useParams } from "react-router";
import { ApiError } from "../../api/client";
import { useDeferReasonMutation, useLatchQuery } from "../../latches/queries";
import { latchPath } from "../../routes/paths";
import { LatchLoadFailed } from "./LatchScreen";
import { NotEstablished } from "./NotEstablished";
import { Shelved } from "./Shelved";

export function ShelvedScreen() {
	const { id = "" } = useParams();
	const query = useLatchQuery(id);
	const deferReason = useDeferReasonMutation(id);

	if (query.error instanceof ApiError && query.error.code === "NOT_FOUND") {
		return <NotEstablished variant="not_found" />;
	}
	const data = query.data;
	if (!data) {
		if (query.isPending) return <div className="screen shelved" />;
		return <LatchLoadFailed onRetry={() => void query.refetch()} />;
	}
	if (data.my_response !== "defer") {
		return <Navigate to={latchPath(id)} replace />;
	}
	return (
		<Shelved
			form={data.form}
			onSaveReason={async (reason) => {
				await deferReason.mutateAsync(reason);
			}}
		/>
	);
}
