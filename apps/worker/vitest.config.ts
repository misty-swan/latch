import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		cloudflareTest({
			// ローカルのminiflareエミュレータで完結させる(アカウント不要・AGENTS.md環境方針)
			remoteBindings: false,
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				compatibilityFlags: ["nodejs_compat"],
			},
		}),
	],
});
