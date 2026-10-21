/** 試験でオフラインを再現する補助。afterEachでrestoreOnlineを呼んで戻す */

const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "onLine");

/** navigator.onLineを上書きし、online/offlineイベントを送る */
export const setOnline = (value: boolean): void => {
	Object.defineProperty(navigator, "onLine", { value, configurable: true });
	window.dispatchEvent(new Event(value ? "online" : "offline"));
};

/** 上書きを外して元の値に戻す */
export const restoreOnline = (): void => {
	Reflect.deleteProperty(navigator, "onLine");
	if (original) Object.defineProperty(Navigator.prototype, "onLine", original);
};
