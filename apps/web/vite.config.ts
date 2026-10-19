import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			includeAssets: ["icon.svg"],
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
	},
});
