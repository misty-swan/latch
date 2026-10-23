import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { pwaManifest, pwaWorkbox } from "../vite.config";

describe("PWAの設定", () => {
	it("Service Workerのナビゲーション代替からAPIと死活監視を除く", () => {
		const deny = pwaWorkbox.navigateFallbackDenylist ?? [];
		const hit = (path: string) => deny.some((re) => re.test(path));
		expect(hit("/v1/x")).toBe(true);
		expect(hit("/healthz")).toBe(true);
		expect(hit("/home")).toBe(false);
	});

	it("プッシュ受信用のスクリプトを読み込み続ける", () => {
		expect(pwaWorkbox.importScripts).toEqual(["push-sw.js"]);
	});

	it("マニフェストにPNGアイコンを持ち any maskable の行が無い", () => {
		const icons = pwaManifest.icons ?? [];
		const find = (src: string) => icons.find((i) => i.src === src);
		expect(find("icon-192.png")).toMatchObject({
			sizes: "192x192",
			purpose: "any",
		});
		expect(find("icon-512.png")).toMatchObject({
			sizes: "512x512",
			purpose: "any",
		});
		expect(find("icon-maskable-512.png")).toMatchObject({
			sizes: "512x512",
			purpose: "maskable",
		});
		expect(icons.some((i) => i.src.endsWith(".svg"))).toBe(false);
		expect(icons.some((i) => i.purpose === "any maskable")).toBe(false);
	});

	it("public/ にPNGアイコンが実在する", () => {
		for (const f of [
			"apple-touch-icon.png",
			"icon-192.png",
			"icon-512.png",
			"icon-maskable-512.png",
		]) {
			expect(existsSync(resolve(__dirname, "../public", f)), f).toBe(true);
		}
	});
});
