/**
 * オフラインの帯(prototype/project/Offline.dc.htmlのp.bannerの移植)。
 * 表示するかどうかは呼び出し側が決める(オフライン中は通知オフの帯より優先する)
 */

export function OfflineBanner() {
	return (
		<p className="banner" style={{ marginBottom: 12 }}>
			<svg className="ic" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M4 4l16 16" />
				<path d="M8.6 15.9a4.8 4.8 0 0 1 5.6-.6" />
				<path d="M5.2 12.4a9.6 9.6 0 0 1 3.6-2.3M12.4 9.3a9.6 9.6 0 0 1 6.4 3.1" />
				<path d="M2.4 9.2a14 14 0 0 1 3.1-2.3M10 5.6a14 14 0 0 1 11.6 3.6" />
				<circle cx="12" cy="19" r=".9" fill="currentColor" stroke="none" />
			</svg>
			<span>オフラインです。最後に確かめた内容を表示しています。</span>
		</p>
	);
}
