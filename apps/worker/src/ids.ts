/**
 * ID採番(docs/05 §2.2: users等の主キー)。ULIDを一元生成するラッパー。
 * ランダム部はWeb標準のcrypto.getRandomValuesを使用する(Workersランタイムで完結)
 */
import { ulid } from "ulid";

/** ULID(26文字・Crockford Base32・時刻順にソート可能)を生成する */
export const newUlid = (): string => ulid();
