/// <reference types="@cloudflare/vitest-pool-workers/types" />

// テストがIdPトークン署名用の秘密鍵JWKフィクスチャをviteの?rawで文字列として読むための宣言
declare module "*.jwk?raw" {
	const value: string;
	export default value;
}

// テストが戻しマイグレーションSQLをviteの?rawで文字列として読むための宣言
declare module "*.sql?raw" {
	const value: string;
	export default value;
}
