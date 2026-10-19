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
