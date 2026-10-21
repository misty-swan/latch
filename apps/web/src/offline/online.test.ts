/** useOnlineの試験: navigator.onLineとonline/offlineイベントに追従する */

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { restoreOnline, setOnline } from "../test/offline";
import { useOnline } from "./online";

afterEach(restoreOnline);

describe("useOnline", () => {
	it("offlineイベントでfalse、onlineイベントでtrueになる", () => {
		const { result } = renderHook(() => useOnline());
		expect(result.current).toBe(true);
		act(() => setOnline(false));
		expect(result.current).toBe(false);
		act(() => setOnline(true));
		expect(result.current).toBe(true);
	});
});
