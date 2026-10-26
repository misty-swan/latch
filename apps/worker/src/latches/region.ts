/**
 * 地名の逆引き(F4a設計 §3.6・docs/08 §4)。
 * 中心座標を約1km(0.01度)グリッドに丸め、そのセルの代表点に最も近い
 * geofeaturesの地名を返す。データ取り込みはF7。
 */

import { inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { geofeatures } from "../db/schema";

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** ハバーシン距離(m)。式はpipeline/layer1.tsのhaversineMと同一 */
const haversineM = (
	a: { lat: number; lng: number },
	b: { lat: number; lng: number },
): number => {
	const dLat = toRad(b.lat - a.lat);
	const dLng = toRad(b.lng - a.lng);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
	return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};

/** geofeatures.grid_keyの規則(約1km=0.01度グリッド) */
export const gridKeyOf = (lat: number, lng: number): string =>
	`${Math.floor(lat * 100)}_${Math.floor(lng * 100)}`;

/** 中心座標に最も近い地物(lookupRegionNameと市区町村の逆引きで共有) */
const nearestFeature = async (
	db: DrizzleD1Database,
	center: { lat: number; lng: number },
): Promise<{ name: string; municipality: string } | null> => {
	const cy = Math.floor(center.lat * 100);
	const cx = Math.floor(center.lng * 100);
	// 代表点=丸めたセルの中心
	const rep = { lat: (cy + 0.5) / 100, lng: (cx + 0.5) / 100 };
	const keys: string[] = [];
	for (let dy = -1; dy <= 1; dy++) {
		for (let dx = -1; dx <= 1; dx++) {
			keys.push(`${cy + dy}_${cx + dx}`);
		}
	}
	const rows = await db
		.select()
		.from(geofeatures)
		.where(inArray(geofeatures.gridKey, keys));
	let best: (typeof rows)[number] | null = null;
	let bestD = 0;
	for (const r of rows) {
		const d = haversineM(rep, { lat: r.lat, lng: r.lng });
		if (best === null || d < bestD || (d === bestD && r.id < best.id)) {
			best = r;
			bestD = d;
		}
	}
	return best === null
		? null
		: { name: best.name, municipality: best.municipality };
};

export const lookupRegionName = async (
	db: DrizzleD1Database,
	center: { lat: number; lng: number },
): Promise<string | null> => (await nearestFeature(db, center))?.name ?? null;

/** 地名と同じ逆引きで市区町村を返す(正解データの地域の粒度・docs/08 §7) */
export const lookupMunicipality = async (
	db: DrizzleD1Database,
	center: { lat: number; lng: number },
): Promise<string | null> =>
	(await nearestFeature(db, center))?.municipality ?? null;
