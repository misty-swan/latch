/**
 * 地名の逆引き(F4a設計 §3.6)の統合試験。geofeaturesをD1へ直接INSERTして検証する。
 */

import { env } from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { geofeatures } from "../src/db/schema";
import { gridKeyOf, lookupRegionName } from "../src/latches/region";

const db = drizzle(env.DB);

const feature = (id: string, name: string, lat: number, lng: number) => ({
	id,
	name,
	municipality: "テスト市",
	type: "station" as const,
	lat,
	lng,
	gridKey: gridKeyOf(lat, lng),
});

beforeEach(async () => {
	await db.delete(geofeatures);
});

describe("gridKeyOf", () => {
	it("0.01度で切り捨てたキー", () => {
		expect(gridKeyOf(35.6812, 139.7671)).toBe("3568_13976");
	});
});

describe("lookupRegionName", () => {
	it("データが空ならnull", async () => {
		expect(
			await lookupRegionName(db, { lat: 35.6812, lng: 139.7671 }),
		).toBeNull();
	});

	it("代表点(セル中心)に近い方の名前を返す", async () => {
		// 中心(35.6812,139.7671)のセル中心は(35.685,139.765)
		await db
			.insert(geofeatures)
			.values([
				feature("01NEAR", "近い駅", 35.6852, 139.7652),
				feature("01FAR", "遠い駅", 35.6905, 139.7701),
			]);
		expect(await lookupRegionName(db, { lat: 35.6812, lng: 139.7671 })).toBe(
			"近い駅",
		);
	});

	it("隣接セルの地物も対象にする", async () => {
		await db
			.insert(geofeatures)
			.values([feature("01ADJ", "隣のセル", 35.6905, 139.7701)]);
		expect(await lookupRegionName(db, { lat: 35.6812, lng: 139.7671 })).toBe(
			"隣のセル",
		);
	});

	it("周囲3x3セルの外はnull", async () => {
		await db
			.insert(geofeatures)
			.values([feature("01OUT", "遠すぎる", 35.7512, 139.7671)]);
		expect(
			await lookupRegionName(db, { lat: 35.6812, lng: 139.7671 }),
		).toBeNull();
	});

	it("同距離はid昇順", async () => {
		await db
			.insert(geofeatures)
			.values([
				feature("01B", "B", 35.685, 139.765),
				feature("01A", "A", 35.685, 139.765),
			]);
		expect(await lookupRegionName(db, { lat: 35.6812, lng: 139.7671 })).toBe(
			"A",
		);
	});
});
