/** OfflineBannerの試験: 帯の固定文とwifi-offの図 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OfflineBanner } from "./OfflineBanner";

afterEach(cleanup);

describe("OfflineBanner", () => {
	it("帯の固定文とアイコンを出す", () => {
		render(<OfflineBanner />);
		expect(
			screen.getByText("オフラインです。最後に確かめた内容を表示しています。"),
		).toBeTruthy();
		expect(document.querySelector("p.banner svg.ic")).toBeTruthy();
	});
});
