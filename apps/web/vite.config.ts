import react from "@vitejs/plugin-react";
import { type ManifestOptions, VitePWA } from "vite-plugin-pwa";
import { configDefaults, defineConfig } from "vitest/config";

// Service Workerの設定。試験から読めるよう名前付きで出す
export const pwaWorkbox = {
	// プッシュの受信だけを素のJSで足す(生成するsw.jsは変えない・設計書 §3.2)
	importScripts: ["push-sw.js"],
	// APIと死活監視はSPAのindex.htmlへ読み替えない
	navigateFallbackDenylist: [/^\/v1\//, /^\/healthz$/],
};

export const pwaManifest: Partial<ManifestOptions> = {
	name: "LATCH",
	short_name: "LATCH",
	description: "繋がりたいことを、置いておけばいい。",
	lang: "ja",
	start_url: "./index.html",
	display: "standalone",
	background_color: "#EEF0F2",
	theme_color: "#EEF0F2",
	icons: [
		{
			src: "icon-192.png",
			sizes: "192x192",
			type: "image/png",
			purpose: "any",
		},
		{
			src: "icon-512.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "any",
		},
		{
			src: "icon-maskable-512.png",
			sizes: "512x512",
			type: "image/png",
			purpose: "maskable",
		},
		{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
	],
};

export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: [
				"icon.svg",
				"apple-touch-icon.png",
				"icon-192.png",
				"icon-512.png",
				"icon-maskable-512.png",
			],
			workbox: pwaWorkbox,
			manifest: pwaManifest,
		}),
	],
	test: {
		environment: "happy-dom",
		setupFiles: ["./src/test/setup.ts"],
		// e2e/はPlaywrightが担う(test:e2e)。既定のincludeは**/*.spec.tsまで
		// 見るため外す(apps/worker/vitest.config.tsと同じ方針)
		exclude: [...configDefaults.exclude, "e2e/**"],
	},
});
