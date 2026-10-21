// Web Pushの受信(設計書 §3.2・08 §3)。vite-plugin-pwaが生成するsw.jsへ
// workbox.importScriptsで読み込ませる。ビルドを通さないため素のJSで書く。
// ペイロードは{type, body}だけ。通知は題名「LATCH」と本文だけを出し・IDや内容を載せない
(() => {
	const TITLE = "LATCH";
	const DEFAULT_BODY = "提案が届いています。詳細はアプリでご確認ください。";
	const NOTICES_PATH = "/notices";

	/** ペイロードから通知の題名と本文を作る。読めなければ既定の汎用文 */
	const notificationFrom = (data) => {
		const body =
			data !== null && typeof data === "object" ? data.body : undefined;
		return {
			title: TITLE,
			body: typeof body === "string" && body.length > 0 ? body : DEFAULT_BODY,
		};
	};

	/** 開いているLATCHの窓があればそこで/noticesへ・無ければ新しく開く */
	const openNotices = async (clients) => {
		const windows = await clients.matchAll({
			type: "window",
			includeUncontrolled: true,
		});
		const client = windows[0];
		if (client) {
			await client.navigate(NOTICES_PATH);
			await client.focus();
			return;
		}
		await clients.openWindow(NOTICES_PATH);
	};

	self.latchPush = { notificationFrom, openNotices };

	self.addEventListener("push", (event) => {
		let data;
		try {
			data = event.data ? event.data.json() : undefined;
		} catch {
			data = undefined;
		}
		const { title, body } = notificationFrom(data);
		event.waitUntil(self.registration.showNotification(title, { body }));
	});

	self.addEventListener("notificationclick", (event) => {
		event.notification.close();
		event.waitUntil(openNotices(self.clients));
	});
})();
