import { createRoot } from "react-dom/client";
import { App } from "./App";
// デザイン定義の正本(latch.css)を先に読み・apps/web側の追加分(app.css・screens.css)で上書きする
import "./styles/latch.css";
import "./styles/app.css";
import "./styles/screens.css";

const container = document.getElementById("root");
if (!container) {
	throw new Error("#root が見つかりません");
}

createRoot(container).render(<App />);
