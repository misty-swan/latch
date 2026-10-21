/** 自分のユーザー情報の取得(TanStack Query)。docs/05 §2.5(GET /v1/users/me) */

import { LIMITS, type UserDTO } from "@latch/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "../api/client";

export const ME_QUERY_KEY = ["me"] as const;

/** 自分のユーザー情報(自分の発言かの判定・右上のアイコンに使う) */
export const useMeQuery = () =>
	useQuery({
		queryKey: ME_QUERY_KEY,
		queryFn: () => apiFetch<UserDTO>("/users/me"),
		staleTime: Number.POSITIVE_INFINITY,
	});

/** プロフィールの更新(PATCH /v1/users/me)。成功で応答をキャッシュへ反映する */
export const useUpdateProfile = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (body: { display_name?: string; bio?: string }) =>
			apiFetch<UserDTO>("/users/me", { method: "PATCH", json: body }),
		onSuccess: (user) => {
			queryClient.setQueryData(ME_QUERY_KEY, user);
		},
	});
};

/** アイコンの登録(POST /v1/users/me/icon)。本文はFileそのもの(形式はサーバーが判定する) */
export const useUploadIcon = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: (file: File) =>
			apiFetch<unknown>("/users/me/icon", {
				method: "POST",
				body: file,
				headers: { "Content-Type": file.type },
			}),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
	});
};

/** アイコンを既定へ戻す(DELETE /v1/users/me/icon) */
export const useResetIcon = () => {
	const queryClient = useQueryClient();
	return useMutation({
		mutationFn: () => apiFetch<void>("/users/me/icon", { method: "DELETE" }),
		onSuccess: () => queryClient.invalidateQueries({ queryKey: ME_QUERY_KEY }),
	});
};

const ICON_TYPES: ReadonlySet<string> = new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
]);

/** 選んだ画像を送る前に確かめる(PNG・JPEG・WebPで1MBまで) */
export const validateIconFile = (
	file: File,
): "too_large" | "bad_type" | null => {
	if (!ICON_TYPES.has(file.type)) return "bad_type";
	if (file.size > LIMITS.ICON_MAX_BYTES) return "too_large";
	return null;
};
