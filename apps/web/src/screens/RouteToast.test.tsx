/**
 * 遷移元が渡すトースト(location.state.toast)の共通部品の単体試験。
 */

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { RouteToast, useRouteToast } from "./RouteToast";

function Page() {
	const toast = useRouteToast();
	return <RouteToast text={toast} />;
}

afterEach(cleanup);

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
});
