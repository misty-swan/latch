/// <reference types="vite/client" />

/** ビルド時の環境変数(Vite・docs/04 §4)。未設定はundefined */
interface ImportMetaEnv {
	/** "1"でテスト用サインイン(dev専用)を出す */
	readonly VITE_DEV_AUTH?: string;
	/** GoogleのOAuthクライアントID(サーバーのGOOGLE_CLIENT_IDと同じ値) */
	readonly VITE_GOOGLE_CLIENT_ID?: string;
	/** AppleのServices ID(サーバーのAPPLE_CLIENT_IDと同じ値) */
	readonly VITE_APPLE_CLIENT_ID?: string;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
