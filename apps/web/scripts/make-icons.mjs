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

// 通常のアイコン(角丸の図柄そのまま)
for (const [name, size] of [
	["apple-touch-icon.png", 180],
	["icon-192.png", 192],
	["icon-512.png", 512],
]) {
	writeFileSync(resolve(publicDir, name), render(svg, size));
}

// maskable: 512pxの背景色の中央に図柄を80%(安全域)で置く。
// 端末側が円や角丸で切り抜いても図柄が欠けないよう、角丸は外側の背景に任せる
const inner = svg.replace(/<svg[^>]*>/, "").replace("</svg>", "");
const innerNoCorner = inner.replace(/ rx="112"/, "");
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
