/**
 * 試験用: D1の往復の「直列の待ちの段数」を数える包み(#36)。
 * D1Databaseのprepare/batchを包み、文の実行(first・run・all・raw)とbatchを1回の往復として数える。
 * 実行中の往復が0件のときに始まった往復を新しい段(wave)とし、他の往復の実行中に始まった往復
 * (Promise.allで同時に投げたもの)は同じ段に数える。drizzleはprepare→bind→実行の順に呼ぶため、
 * bindの戻り値も包み、batchへ渡すときは包む前の文へ戻す。
 */

interface RealStatement {
	bind(...values: unknown[]): RealStatement;
	first(...args: unknown[]): Promise<unknown>;
	run(...args: unknown[]): Promise<unknown>;
	all(...args: unknown[]): Promise<unknown>;
	raw(...args: unknown[]): Promise<unknown>;
}

export interface RoundTripCounter {
	/** 包んだD1Database(envのDBへ差し替えて使う) */
	db: D1Database;
	/** 直列の待ちの段数 */
	waves(): number;
	/** 往復の総数(同時に投げたものも1件ずつ) */
	calls(): number;
	/** 数を0へ戻す */
	reset(): void;
}

export const countD1RoundTrips = (real: D1Database): RoundTripCounter => {
	let inflight = 0;
	let waves = 0;
	let calls = 0;
	const realOf = new WeakMap<object, RealStatement>();

	const track = async <T>(fn: () => Promise<T>): Promise<T> => {
		calls += 1;
		if (inflight === 0) {
			waves += 1;
		}
		inflight += 1;
		try {
			return await fn();
		} finally {
			inflight -= 1;
		}
	};

	const wrap = (stmt: RealStatement): RealStatement => {
		const wrapped: RealStatement = {
			bind: (...values) => wrap(stmt.bind(...values)),
			first: (...args) => track(() => stmt.first(...args)),
			run: (...args) => track(() => stmt.run(...args)),
			all: (...args) => track(() => stmt.all(...args)),
			raw: (...args) => track(() => stmt.raw(...args)),
		};
		realOf.set(wrapped, stmt);
		return wrapped;
	};

	const db = {
		prepare: (query: string) =>
			wrap(real.prepare(query) as unknown as RealStatement),
		batch: (statements: unknown[]) =>
			track(() =>
				real.batch(
					statements.map(
						(s) => (realOf.get(s as object) ?? s) as D1PreparedStatement,
					),
				),
			),
		exec: (query: string) => track(() => real.exec(query)),
		dump: () => real.dump(),
		withSession: (...args: Parameters<D1Database["withSession"]>) =>
			real.withSession(...args),
	} as unknown as D1Database;

	return {
		db,
		waves: () => waves,
		calls: () => calls,
		reset: () => {
			waves = 0;
			calls = 0;
		},
	};
};
