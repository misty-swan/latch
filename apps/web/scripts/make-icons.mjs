// public/icon.svg からホーム画面追加用のPNGを生成する(pnpm --filter web icons)
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const publicDir = resolve(dirname(fileURLToPath(import.meta.url)), "../public");
const svg = readFileSync(resolve(publicDir, "icon.svg"), "utf8");

function render(source, size) {
	return new Resvg(source, { fitTo: { mode: "width", value: size } })
		.render()
		.asPng();
}

// 背景の角丸を外した図柄(四隅まで背景色で埋まる)。
// icon.svgの背景の書き方が変わって外せなかったときは、透明な角のPNGを黙って作らないよう止める
const CORNER = / rx="112"/;
if (!CORNER.test(svg)) {
	throw new Error(
		'icon.svgに背景の角丸(rx="112")が見つかりません。make-icons.mjsを直してください',
	);
}
const svgNoCorner = svg.replace(CORNER, "");

// 通常のアイコン(Android・Chrome向けのpurpose "any"。角丸の図柄そのまま・角は透明)
for (const [name, size] of [
	["icon-192.png", 192],
	["icon-512.png", 512],
]) {
	writeFileSync(resolve(publicDir, name), render(svg, size));
}

// apple-touch-icon: iOSは透明な部分を黒で埋めてから自分の角丸で切り抜くので、
// 角丸を付けずに四隅まで背景色で埋めた正方形にする
writeFileSync(
	resolve(publicDir, "apple-touch-icon.png"),
	render(svgNoCorner, 180),
);

// maskable: 512pxの背景色の中央に図柄を80%(安全域)で置く。
// 端末側が円や角丸で切り抜いても図柄が欠けないよう、角丸は外側の背景に任せる
const innerNoCorner = svgNoCorner
	.replace(/<svg[^>]*>/, "")
	.replace("</svg>", "");
const scale = 0.8;
const offset = (512 * (1 - scale)) / 2;
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
<rect width="512" height="512" fill="#EEF0F2"/>
<g transform="translate(${offset} ${offset}) scale(${scale})">${innerNoCorner}</g>
</svg>`;
writeFileSync(
	resolve(publicDir, "icon-maskable-512.png"),
	render(maskable, 512),
);
