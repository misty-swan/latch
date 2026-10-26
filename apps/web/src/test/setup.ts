/**
 * vitest(happy-dom)の共通セットアップ。
 * Nodeの実験的webstorageがglobalThis.localStorageを(undefinedを返すアクセサとして)
 * 占めており・happy-domのStorageがテストのグローバルへ届かないため、ここで置き換える。
 * 実装はテスト用の最小のin-memory Storage(テスト間の持ち回しは各テストのclearに任せる)
 */

class MemoryStorage implements Storage {
	#map = new Map<string, string>();

	get length(): number {
		return this.#map.size;
	}

	clear(): void {
		this.#map.clear();
	}

	getItem(key: string): string | null {
		return this.#map.get(key) ?? null;
	}

	key(index: number): string | null {
		return [...this.#map.keys()][index] ?? null;
	}

	removeItem(key: string): void {
		this.#map.delete(key);
	}

	setItem(key: string, value: string): void {
		this.#map.set(key, value);
	}
}

for (const name of ["localStorage", "sessionStorage"] as const) {
	Object.defineProperty(globalThis, name, {
		value: new MemoryStorage(),
		configurable: true,
		writable: true,
	});
}

// happy-domの既定の画面の幅(1024px)はPC向けの外枠(LAT-14)の幅に当たる。画面の単体試験は
// スマホの見た目を確かめるものなので、iPhoneの大きさにそろえる(PCの幅はweb E2Eで確かめる)。
// nodeの環境(push-sw.test.tsなど)にはwindowが無い
if (typeof window !== "undefined") {
	(
		window as unknown as {
			happyDOM?: { setViewport(size: { width: number; height: number }): void };
		}
	).happyDOM?.setViewport({ width: 390, height: 844 });
}
