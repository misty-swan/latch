import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["icon.svg"],
			// プッシュの受信だけを素のJSで足す(生成するsw.jsは変えない・設計書 §3.2)
			workbox: { importScripts: ["push-sw.js"] },
			manifest: {
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
						src: "icon.svg",
						sizes: "any",
						type: "image/svg+xml",
						purpose: "any maskable",
					},
				],
			},
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
