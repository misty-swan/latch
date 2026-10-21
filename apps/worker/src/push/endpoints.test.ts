import { describe, expect, it } from "vitest";
import { isAllowedPushEndpoint } from "./endpoints";

describe("isAllowedPushEndpoint(F7b設計 §4)", () => {
	it.each([
		"https://fcm.googleapis.com/fcm/send/a",
		"https://web.push.apple.com/x",
		"https://wns2-par02p.notify.windows.com/w",
		"https://updates.push.services.mozilla.com/wpush/v2/a",
	])("許可: %s", (url) => {
		expect(isAllowedPushEndpoint(url)).toBe(true);
	});

	it.each([
		"http://fcm.googleapis.com/fcm/send/a",
		"https://evil.example/",
		"https://push.apple.com.evil.example/",
		"https://fcm.googleapis.com.evil.example/",
		"https://notpush.apple.com/",
		"not a url",
	])("拒否: %s", (url) => {
		expect(isAllowedPushEndpoint(url)).toBe(false);
	});
});
