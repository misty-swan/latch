/**
 * 遷移元が渡すトースト(location.state.toast)の共通部品の単体試験。
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RouteToast, useRouteToast } from "./RouteToast";

function Page() {
	const toast = useRouteToast();
	return <RouteToast text={toast} />;
}

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

/** 見えている範囲(高さ844)の中で、下の操作の上端がtopにある画面 */
function ScreenWithFoot({ footTop }: { footTop: number }) {
	const toast = useRouteToast();
	return (
		<div className="screen">
			<div
				className="screen__foot"
				ref={(el) => {
					if (el === null) return;
					vi.spyOn(el, "getBoundingClientRect").mockReturnValue(
						new DOMRect(0, footTop, 390, 844 - footTop),
					);
				}}
			/>
			<RouteToast text={toast} />
		</div>
	);
}

describe("RouteToast", () => {
	it("state.toastをrole=statusで出し・stateを消す", async () => {
		const router = createMemoryRouter([{ path: "/x", element: <Page /> }], {
			initialEntries: [{ pathname: "/x", state: { toast: "直しました。" } }],
		});
		render(<RouterProvider router={router} />);
		expect(screen.getByRole("status").textContent).toBe("直しました。");
		await waitFor(() => expect(router.state.location.state).toBeNull());
	});

	it("stateがなければ何も出さない", () => {
		const router = createMemoryRouter([{ path: "/x", element: <Page /> }], {
			initialEntries: ["/x"],
		});
		render(<RouterProvider router={router} />);
		expect(screen.queryByRole("status")).toBeNull();
	});

	it("見えている下の操作の上に置き・下の操作が見えていなければ下端から120pxに置く(LAT-110)", () => {
		vi.spyOn(window, "innerHeight", "get").mockReturnValue(844);
		const at = (footTop: number) => {
			const router = createMemoryRouter(
				[{ path: "/x", element: <ScreenWithFoot footTop={footTop} /> }],
				{
					initialEntries: [
						{ pathname: "/x", state: { toast: "直しました。" } },
					],
				},
			);
			render(<RouterProvider router={router} />);
			const bottom = screen.getByRole("status").style.bottom;
			cleanup();
			return bottom;
		};
		// フッターが下から200pxの高さまである→その上16px
		expect(at(644)).toBe("216px");
		// フッターが低い(下から60px)→既定の120px
		expect(at(784)).toBe("120px");
		// フッターが見えている範囲の外(長い画面のスクロールの先)→既定の120px
		expect(at(1200)).toBe("120px");
	});
});
