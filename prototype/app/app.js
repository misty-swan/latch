/* LATCH プロトタイプ — 画面・状態・動きの試作。
   データはすべてこの端末の中だけの作りものです(外部への送信はありません)。 */
(() => {
  'use strict';

  /* ---------- 0. 基本 ---------- */
  const app = document.getElementById('app');
  const osLayer = document.getElementById('os-layer');
  const params = new URLSearchParams(location.search);
  const SHOT = params.has('shot');
  if (SHOT) document.documentElement.classList.add('shot');
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = !SHOT && !reduceMotion;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ic = (n, cls = '') => `<svg class="ic ${cls}" aria-hidden="true" focusable="false"><use href="#i-${n}"/></svg>`;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- 1. 時計(物語の中の「いま」= 2026年10月16日 金曜 18:20) ---------- */
  const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
  const T0 = Date.parse('2026-10-16T18:20:00+09:00');
  const bootAt = Date.now();
  const now = () => T0 + (SHOT ? 0 : Date.now() - bootAt);
  const at = (h, m = 0, dayOffset = 0) => Date.parse(`2026-10-16T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`) + dayOffset * DAY;
  const parts = (t) => { const d = new Date(t + 9 * HOUR); return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() }; };
  const dayIndex = (t) => { const p = parts(t); return Date.UTC(p.y, p.mo - 1, p.d) / DAY; };
  const hm = (t) => { const p = parts(t); return `${p.h}:${String(p.mi).padStart(2, '0')}`; };
  const md = (t) => { const p = parts(t); return `${p.mo}月${p.d}日`; };
  const dayWord = (t) => { const d = dayIndex(t) - dayIndex(now()); return d === 0 ? '今日' : d === 1 ? '明日' : d === -1 ? '昨日' : md(t); };
  const when = (t) => `${dayWord(t)} ${hm(t)}`;
  const left = (t) => {
    const ms = t - now();
    if (ms <= 0) return '期限を過ぎました';
    const h = Math.floor(ms / HOUR), m = Math.floor((ms % HOUR) / MIN);
    if (h >= 48) return `あと${Math.ceil(ms / DAY)}日`;
    if (h >= 1) return `あと${h}時間${m ? `${m}分` : ''}`;
    return `あと${Math.max(1, m)}分`;
  };
  const ago = (t) => {
    const ms = now() - t;
    if (ms < MIN) return 'いま';
    if (ms < HOUR) return `${Math.floor(ms / MIN)}分前`;
    const dd = dayIndex(now()) - dayIndex(t);
    if (dd === 0) return hm(t);
    if (dd === 1) return '昨日';
    if (dd < 7) return `${dd}日前`;
    return md(t);
  };
  const daysSince = (t) => Math.max(0, Math.floor((now() - t) / DAY));
  const daysUntil = (t) => Math.max(0, Math.ceil((t - now()) / DAY));

  /* ---------- 2. データ ---------- */
  const AV = { a: '#3F4D69', b: '#6B4E2E', c: '#2F5A55', d: '#5B3F5E', e: '#48552F' };
  const EXAMPLES = [
    '例: イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。',
    '例: 子育て中の親と、子どもが寝たあとに少しだけ話せる関係が欲しい。',
    '例: 今夜20時以降、天文館あたりで2〜4人、軽く飲みに行きたい。',
  ];
  const SAMPLE = 'イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しい。初心者です。';
  const FULL_TEXT = 'イラストを描く人と、月1くらいで雑に絵を見せ合える関係になれたら嬉しいです。初心者です。週末は水彩、平日の夜はiPadで落書きをしています。うまく描けなくても気にしない人だと嬉しいです。SNSに載せるほどではない絵を、こっそり見せ合える関係が理想です。感想は一言でも短い返事でも大丈夫。お互いのペースで、月に一度くらい「今月はこれを描いた」と送り合えたら、それだけで続けられる気がしています。年齢や上手さは問いません。描いている道具の話や、好きな画家の話もできたら嬉しいです。最近は、窓から見える木や、夜の商店街を描くのが好きです。いつか一緒に、近所の公園へスケッチに出かけられたらとも思っています。';
  const OCC_SAMPLE = '今夜20時以降、天文館あたりで2〜4人、5,000円以内で軽く飲みに行きたい。';
  const STATE = { draft: '下書き', active: '預けている', paused: '一時停止中', expired: '期限切れ', cancelled: '取り下げ', proposed: '回答を待っています', partial: '相手の回答待ち', matched: 'つながった', completed: '終了', ended: '終了' };
  const FORM = { connection: 'つながり', occasion: '機会' };

  function seed(kind = 'lived') {
    const base = {
      v: 7, kind, theme: 'auto', push: 'default', net: 'online',
      onboarded: false, consent: false, surveyPending: false,
      seenNote: { connection: false, occasion: false },
      me: { name: 'みなと', bio: '夜に散歩しながら、写真を撮っています。', av: 'a', age: 29 },
      draft: '', parsed: null, lastPlaced: null,
      intents: [], proposals: [], connections: [], notices: [],
    };
    if (kind === 'fresh') return base;
    const i1Created = T0 - 12 * DAY - 3 * HOUR;
    return Object.assign(base, {
      intents: [
        { id: 'i1', form: 'connection', status: 'active', text: SAMPLE, topic: 'イラスト仲間', conds: ['初心者歓迎', '月1回くらい', '絵を見せ合う'], region: null, size: 2, days: 30, createdAt: i1Created, expiresAt: i1Created + 30 * DAY, matches: 2, notify: true },
        { id: 'i2', form: 'occasion', status: 'active', text: '今夜20時以降、天文館あたりで2〜4人、5,000円以内で軽く飲みに行きたい。', topic: '軽く飲みに行く', conds: ['気軽に'], start: at(20), place: '天文館周辺', people: '2〜4人', budget: '5,000円以内', alcohol: true, createdAt: T0 - 75 * MIN, expiresAt: at(23), matches: 0, notify: true },
        { id: 'i3', form: 'connection', status: 'paused', text: '子育て中の親と、子どもが寝たあとに少しだけ話せる関係が欲しい。', topic: '子育て中の親', conds: ['夜に少しだけ', '気軽に話す'], region: null, size: 2, days: 90, createdAt: T0 - 31 * DAY, expiresAt: T0 + 59 * DAY, matches: 1, notify: true },
        { id: 'i4', form: 'connection', status: 'draft', text: '英語を母語とする人と、ゆるくランゲージエクスチェンジ', savedAt: T0 - 2 * DAY - 5 * HOUR },
        { id: 'i5', form: 'connection', status: 'expired', text: '鹿児島でサイクリングする人と繋がりたい。週末に桜島をまわれたら。', topic: 'サイクリング仲間', conds: ['週末'], region: '鹿児島市', size: 2, days: 30, createdAt: T0 - 33 * DAY, expiresAt: T0 - 3 * DAY, matches: 0 },
      ],
      proposals: [
        { id: 'p1', intentId: 'i1', form: 'connection', size: 2, notifiedAt: T0 - 8 * MIN, status: 'proposed', partners: [{ name: 'ひなた', bio: '仕事帰りに、iPadで落書きしています。上手じゃなくても見せ合える人がいたら。', av: 'b' }] },
      ],
      connections: [
        {
          id: 'c1', form: 'connection', status: 'matched', topic: 'イラスト仲間', size: 2, region: null, matchedAt: T0 - 7 * DAY - 2 * HOUR, unread: 1, survey: 'pending',
          partners: [{ name: 'あお', bio: '週末に水彩を描いています。デジタルは練習中。のんびり見せ合えたら嬉しいです。', av: 'c' }],
          messages: [
            { by: 0, text: 'はじめまして、あおです。月1くらいで絵を見せ合える人がいたらいいなと思っていました。', at: T0 - 7 * DAY - 2 * HOUR + 3 * MIN },
            { by: 'me', text: 'はじめまして。わたしも同じです。最近は鉛筆でスケッチばかりしています。', at: T0 - 7 * DAY - 2 * HOUR + 9 * MIN },
            { by: 0, text: 'いいですね。わたしは水彩です。月末に、今月描いたものをお互い1枚ずつ送りませんか。', at: T0 - 7 * DAY - 1 * HOUR },
            { by: 'me', text: 'ぜひ。締め切りがあると描ける気がします。', at: T0 - 6 * DAY - 20 * HOUR },
            { by: 0, text: '今月は何を描きましたか?', at: T0 - 26 * MIN },
          ],
        },
        {
          id: 'c2', form: 'occasion', status: 'completed', topic: '軽く飲みに行く', size: 4, start: at(19, 0, -6), place: '天文館周辺', budget: '4,000円以内', matchedAt: at(17, 40, -6),
          partners: [{ name: 'ゆう', av: 'd', bio: '' }, { name: 'ちひろ', av: 'e', bio: '' }, { name: 'かえで', av: 'c', bio: '' }],
          messages: [
            { by: 0, text: '19時に、電停の前で集まりましょうか。', at: at(17, 46, -6) },
            { by: 1, text: '了解です。少し遅れるかもです。', at: at(17, 52, -6) },
            { by: 'me', text: 'わかりました。先に入っていますね。', at: at(17, 55, -6) },
            { by: 2, text: '今日はありがとうございました。たのしかったです。', at: at(22, 10, -6) },
          ],
        },
        {
          id: 'c3', form: 'connection', status: 'ended', topic: 'イラスト仲間', size: 2, region: null, matchedAt: T0 - 24 * DAY,
          partners: [{ name: 'そら', av: 'e', bio: '' }],
          messages: [
            { by: 0, text: 'はじめまして。よろしくお願いします。', at: T0 - 24 * DAY + 20 * MIN },
            { by: 'me', text: 'よろしくお願いします。どんな絵を描いていますか?', at: T0 - 24 * DAY + 40 * MIN },
          ],
        },
      ],
      notices: [
        { id: 'n1', type: 'proposal', ref: 'p1', at: T0 - 8 * MIN, read: false },
        { id: 'n2', type: 'matched', ref: 'c1', at: T0 - 7 * DAY - 2 * HOUR, read: true },
        { id: 'n3', type: 'closed', at: T0 - 4 * DAY - 3 * HOUR, read: true },
        { id: 'n4', type: 'expired', ref: 'i5', at: T0 - 3 * DAY, read: true },
      ],
      onboarded: true, consent: true,
    });
  }

  const KEY = 'latch-prototype';
  function load() {
    if (SHOT || params.has('fresh')) return seed(params.get('data') === 'fresh' ? 'fresh' : 'lived');
    try {
      const s = JSON.parse(localStorage.getItem(KEY));
      if (s && s.v === 7) return s;
    } catch (e) { /* 保存できない環境では毎回初期状態 */ }
    return seed('lived');
  }
  let S = load();
  if (SHOT) { S.onboarded = true; S.consent = true; }
  const save = () => { if (SHOT) return; try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { /* noop */ } };

  const intentById = (id) => S.intents.find((i) => i.id === id);
  const proposalById = (id) => S.proposals.find((p) => p.id === id);
  const connById = (id) => S.connections.find((c) => c.id === id);
  function deadlineOf(p) {
    const it = intentById(p.intentId);
    const n = p.notifiedAt;
    if (p.form === 'occasion') {
      const start = it ? it.start : n + 3 * HOUR;
      const d = Math.min(Math.max(n + 15 * MIN, Math.min(n + 2 * HOUR, start - 60 * MIN)), it ? it.expiresAt : Infinity);
      return d;
    }
    return Math.min(n + 24 * HOUR, it ? it.expiresAt : Infinity);
  }
  function intentState(it) {
    const p = S.proposals.find((x) => x.intentId === it.id && (x.status === 'proposed' || x.status === 'partial'));
    if (p && it.status === 'active') return p.status;
    return it.status;
  }

  /* ---------- 3. 部品 ---------- */
  const mark = (cls = '') => `<svg class="mark ${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="mark__mine" d="M11.1 3.2a8.8 8.8 0 0 0 0 17.6z"/><path class="mark__theirs" d="M12.9 3.2a8.8 8.8 0 0 1 0 17.6z"/></svg>`;
  const brandStatic = `<span class="brand">${mark()}<span class="brand__word">LATCH</span></span>`;
  const brand = `<a class="brand" href="#/home" aria-label="LATCH 預けている一覧へ">${mark()}<span class="brand__word">LATCH</span></a>`;
  const grain = `<svg class="grain" aria-hidden="true" focusable="false"><rect width="100%" height="100%" filter="url(#grain)"/></svg>`;
  const avatar = (av, size = '', label = '') => `<span class="avatar avatar--${av}${size ? ` avatar--${size}` : ''}" ${label ? `role="img" aria-label="${esc(label)}"` : 'aria-hidden="true"'}></span>`;

  function glyph(kind, cls = '') {
    const f = (n) => +n.toFixed(2);
    const L = (cx, r = 8.5) => `M${cx} ${f(10 - r)}A${r} ${r} 0 0 0 ${cx} ${f(10 + r)}Z`;
    const R = (cx, r = 8.5) => `M${cx} ${f(10 - r)}A${r} ${r} 0 0 1 ${cx} ${f(10 + r)}Z`;
    const Ro = (cx, r = 8.5) => `M${cx} ${f(10 - r)}A${r} ${r} 0 0 1 ${cx} ${f(10 + r)}`;
    const g = {
      active: `<path class="gt" d="${Ro(10.9)}"/><path class="gm" d="${L(9.1)}"/>`,
      draft: `<path class="gd" d="${L(9.4, 7.6)}"/>`,
      paused: `<path class="gt" d="${Ro(10.9)}"/><path class="gp" d="${L(9.1)}"/>`,
      expired: `<path class="go" d="${L(9.4, 7.6)}"/>`,
      proposed: `<path class="gl" d="${R(11.3)}"/><path class="gm" d="${L(8.7)}"/>`,
      partial: `<path class="gd" d="${R(10.8, 7.6)}"/><path class="gm" d="${L(9.6)}"/>`,
      matched: `<path class="gm" d="${L(10)}"/><path class="gf" d="${R(10)}"/>`,
      completed: `<circle class="go" cx="10" cy="10" r="7.6"/><path class="go" d="M10 2.4V17.6"/>`,
      ended: `<circle class="go" cx="10" cy="10" r="7.6"/><path class="go" d="M10 2.4V17.6"/>`,
      closed: `<path class="gp" d="${L(9.1)}"/>`,
    }[kind] || '';
    return `<svg class="glyph ${cls}" viewBox="0 0 20 20" aria-hidden="true" focusable="false">${g}</svg>`;
  }
  const status = (st, extra = '') => `<span class="status${st === 'proposed' ? ' status--lamp' : ''}${['expired', 'draft', 'completed', 'ended'].includes(st) ? ' status--quiet' : ''}"${extra}>${glyph(st)}${STATE[st]}</span>`;

  function latch(state, size, gap, style = '', extra = '') {
    return `<div class="latch is-${state}" style="--size:${size}px;--gap:${gap}px;${style}" aria-hidden="true">${extra}<span class="latch__light"></span><span class="latch__mine"></span><span class="latch__theirs"><span class="latch__ink"></span></span></div>`;
  }
  const dome = (size, style = '') => `<div class="dome-rest" style="--size:${size}px;${style}" aria-hidden="true"><span class="dome"></span><span class="shelf"></span></div>`;

  // グループ:円を人数で割り、自分のぶんだけ墨を入れる(左が自分)
  function groupDisc(n, size, opts = {}) {
    const { fills = null, light = false } = opts;
    const c = size / 2, r = size / 2 - 8, g = 3.4;
    let out = '';
    for (let i = 0; i < n; i++) {
      const mid = Math.PI + (i * 2 * Math.PI) / n;
      const a0 = mid - Math.PI / n, a1 = mid + Math.PI / n;
      const ox = Math.cos(mid) * g, oy = Math.sin(mid) * g;
      const p = (a) => `${(c + ox + r * Math.cos(a)).toFixed(2)} ${(c + oy + r * Math.sin(a)).toFixed(2)}`;
      const d = `M${(c + ox).toFixed(2)} ${(c + oy).toFixed(2)}L${p(a0)}A${r} ${r} 0 ${2 * Math.PI / n > Math.PI ? 1 : 0} 1 ${p(a1)}Z`;
      const fill = fills ? ` style="fill:${fills[i]}"` : '';
      out += `<path class="${i === 0 || fills ? 'g-mine' : 'g-blank'}" d="${d}"${fill}/>`;
    }
    const glow = light ? `<span class="group-light" style="--size:${size}px"></span>` : '';
    return `<div class="group-wrap" style="--size:${size}px" aria-hidden="true">${glow}<svg class="group-disc" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" focusable="false">${out}</svg></div>`;
  }

  const topbar = ({ l = '', c = '', r = '' } = {}) => `<header class="topbar"><div class="topbar__side">${l}</div>${c ? `<div class="topbar__title">${c}</div>` : '<span></span>'}<div class="topbar__side topbar__side--end">${r}</div></header>`;
  const back = (to, label = '戻る') => `<a class="icon-btn" href="#/${to}" aria-label="${label}">${ic('back')}</a>`;
  const close = (to, label = '閉じる') => `<a class="icon-btn" href="#/${to}" aria-label="${label}">${ic('close')}</a>`;
  const unread = () => S.notices.filter((n) => !n.read).length;
  const topRight = () => `<a class="icon-btn" href="#/notices" aria-label="お知らせ${unread() ? `(未読${unread()}件)` : ''}">${ic('bell')}${unread() ? '<span class="dot"></span>' : ''}</a><a class="icon-btn" href="#/me" aria-label="自分">${avatar(S.me.av, 's')}</a>`;
  const tabbar = (cur) => `<nav class="tabbar" aria-label="メイン">
      <a class="tab" href="#/home"${cur === 'home' ? ' aria-current="page"' : ''}>${ic('half')}<span>預けている</span></a>
      <a class="tab__put" href="#/compose">${ic('plus')}<span>置く</span></a>
      <a class="tab" href="#/connections"${cur === 'connections' ? ' aria-current="page"' : ''}>${ic('circle')}<span>つながり</span></a>
    </nav>`;
  const tategaki = (text, style = '', cls = '') => {
    const lines = text.split('\n');
    let k = 0;
    const html = lines.map((ln) => [...ln].map((ch) => `<span class="ch" style="--i:${k++}">${esc(ch)}</span>`).join('')).join('<br>');
    return `<p class="tategaki ${cls}" style="${style}" aria-label="${esc(text.replace(/\n/g, ''))}"><span aria-hidden="true">${html}</span></p>`;
  };
  const sheet = (inner, label) => `<div class="backdrop" data-act="sheet-close"></div><div class="sheet-layer" role="dialog" aria-modal="true" aria-label="${esc(label)}"><div class="sheet"><span class="sheet__grab" aria-hidden="true"></span>${inner}</div></div>`;

  /* ---------- 4. 読み解き(試作のための簡易版。実際はIntent Parserが担う) ---------- */
  function parse(text) {
    const t = text || '';
    const timey = /(今夜|今晩|今日|明日|あした|今週末|[0-9０-９]{1,2}時)/.test(t);
    const relation = /(関係|仲間|繋がり|つながり|話せる人|友だち|友達)/.test(t);
    if (/飲み|飲む|呑み|ご飯|ごはん|食事/.test(t) && timey && !relation) {
      return { form: 'occasion', topic: /飲/.test(t) ? '軽く飲みに行く' : '軽く食事に行く', conds: ['気軽に'], start: at(20), place: /天文館/.test(t) ? '天文館周辺' : null, people: /2[〜~ー-]4/.test(t) ? '2〜4人' : '2人', budget: /5,?000|5000|五千/.test(t) ? '5,000円以内' : null, alcohol: /飲|酒|ビール|ワイン|バー/.test(t) };
    }
    if (/イラスト|絵/.test(t)) return { form: 'connection', topic: 'イラスト仲間', conds: ['初心者歓迎', '月1回くらい', '絵を見せ合う'].filter((c, i) => i !== 0 || /初心者/.test(t)), region: null, size: 2, days: 30 };
    if (/子育て/.test(t)) return { form: 'connection', topic: '子育て中の親', conds: ['夜に少しだけ', '気軽に話す'], region: null, size: 2, days: 30 };
    if (/サイクリング|自転車/.test(t)) return { form: 'connection', topic: 'サイクリング仲間', conds: ['週末'], region: /鹿児島/.test(t) ? '鹿児島市' : null, size: 2, days: 30 };
    const head = t.replace(/^(例:)?\s*/, '').split(/[、。,.!?！？\n]/)[0].replace(/(と繋がりたい|とつながりたい|と話したい|が欲しい)$/, '');
    return { form: timey && !relation ? 'occasion' : 'connection', topic: head.slice(0, 16) || 'ゆるく話せる相手', conds: [], region: null, size: 2, days: 30, start: timey ? at(20) : null, place: null, people: '2人', budget: null, alcohol: false };
  }

  /* ---------- 5. 画面 ---------- */
  const screens = {};

  // 5-1. はじめる -------------------------------------------------------
  screens.welcome = () => ({
    cls: 'welcome',
    html: `
      ${topbar({ l: brandStatic })}
      <div class="screen__body" style="overflow:hidden">
        <div style="position:absolute;left:22px;top:128px">${latch('waiting', 252, 22)}</div>
        ${tategaki('繋がりたいことを、\n置いておけばいい。', 'position:absolute;right:30px;top:96px;font-size:27px;line-height:2.05', 'reveal')}
        <p class="t-eyebrow" style="position:absolute;left:24px;top:428px">置く · 待つ · 届く</p>
      </div>
      <div class="screen__foot">
        <p class="t-body" style="margin-bottom:10px">「こういう人と繋がりたい」を、ひとこと預けておく場所です。合う相手が現れたときだけ、提案が届きます。</p>
        <a class="btn btn--primary btn--block" href="#/intro?step=1">はじめる</a>
        <a class="btn btn--quiet" href="#/signin">アカウントをお持ちの方</a>
      </div>`,
  });

  const INTRO = [
    { k: '置く', n: '01', t: 'まだ誰にも言っていない「繋がりたい」を、ひとこと置いておく。', b: '思ったままの文章で大丈夫です。呼びかけることも、自分を売り込むこともいりません。' },
    { k: '待つ', n: '02', t: 'あとは、待つだけ。', b: '届かない日は、まだ時機ではないだけ。預けた意思は、期限まで静かに置かれています。' },
    { k: '届く', n: '03', t: '条件がかちっと合ったときだけ、届く。', b: 'お互いが「参加する」を選んだら、はじめて相手が見えて、話せるようになります。' },
  ];
  screens.intro = ({ q }) => {
    const step = Math.min(3, Math.max(1, Number(q.step) || 1));
    const s = INTRO[step - 1];
    const art = step === 1
      ? dome(168, 'margin-top:120px')
      : step === 2 ? latch('waiting', 200, 18) : latch('arrived', 200, 18);
    const dots = INTRO.map((_, i) => `<span class="dots__d${i + 1 === step ? ' is-on' : ''}"></span>`).join('');
    const next = step < 3 ? `#/intro?step=${step + 1}` : '#/signin';
    return {
      cls: `intro intro--${step}`,
      html: `
        ${topbar({ l: step > 1 ? back(`intro?step=${step - 1}`) : back('welcome'), r: step < 3 ? `<a class="btn btn--quiet btn--small" href="#/signin">スキップ</a>` : '' })}
        <div class="screen__body">
          <div class="intro__art" style="height:330px;display:grid;place-items:center">${art}</div>
          <div class="pad">
            <p class="t-eyebrow rise">${s.n} — ${s.k}</p>
            <h1 class="t-display t-display--s rise rise-1" style="margin-top:12px">${s.t}</h1>
            <p class="t-body rise rise-2" style="margin-top:14px">${s.b}</p>
          </div>
        </div>
        <div class="screen__foot">
          <div class="dots" aria-label="${step} / 3">${dots}</div>
          <a class="btn btn--primary btn--block" href="${next}">${step < 3 ? '次へ' : 'はじめる'}</a>
        </div>`,
    };
  };

  screens.signin = () => ({
    html: `
      ${topbar({ l: back('intro?step=3') })}
      <div class="screen__body pad" style="padding-top:20px">
        <h1 class="t-display t-display--s">はじめに、アカウントをつくります。</h1>
        <p class="t-body" style="margin-top:14px">ログインには、GoogleかAppleのアカウントを使います。LATCHでパスワードを作ることはありません。</p>
        <div class="stack" style="gap:10px;margin-top:36px">
          <a class="btn btn--secondary btn--block" href="#/register">${ic('google', 'ic--fill')}Googleで続ける</a>
          <a class="btn btn--secondary btn--block" href="#/register">${ic('apple', 'ic--fill')}Appleで続ける</a>
        </div>
      </div>
      <div class="screen__foot">
        <p class="t-caption">LATCHは18歳以上の方がご利用いただけます。続けると、<a class="link" href="#/signin">利用規約</a>と<a class="link" href="#/signin">プライバシーポリシー</a>に同意したことになります。</p>
      </div>`,
  });

  screens.register = ({ q }) => {
    if (q.error === 'underage') {
      return {
        html: `
          ${topbar({ l: back('register') })}
          <div class="screen__body pad" style="display:flex;flex-direction:column;justify-content:center;padding-bottom:40px">
            <div style="margin-bottom:40px">${latch('empty', 132, 12)}</div>
            <h1 class="t-display t-display--s">LATCHは、18歳以上の方のためのサービスです。</h1>
            <p class="t-body" style="margin-top:14px">入力された生年月日では、いまはご利用いただけません。18歳になったら、またお越しください。</p>
          </div>
          <div class="screen__foot"><a class="btn btn--secondary btn--block" href="#/welcome">閉じる</a></div>`,
      };
    }
    return {
      html: `
        ${topbar({ l: back('signin'), r: '<span class="t-meta" style="padding-right:14px">1 / 2</span>' })}
        <div class="screen__body pad" style="padding-top:12px">
          <h1 class="t-display t-display--s">あなたのことを、少しだけ。</h1>
          <div class="stack" style="gap:28px;margin-top:30px">
            <div class="field">
              <label class="field__label" for="r-name">表示名</label>
              <input class="input" id="r-name" maxlength="40" autocomplete="nickname" placeholder="例: みなと" value="${esc(S.me.name)}">
              <p class="field__help">つながった相手にだけ表示されます。あとから変えられます。</p>
            </div>
            <div class="field">
              <label class="field__label" for="r-birth">生年月日</label>
              <input class="input" id="r-birth" type="date" value="1997-05-14" max="2026-10-16">
              <p class="field__help">年齢の確認にだけ使います。誰にも表示されません。</p>
            </div>
          </div>
        </div>
        <div class="screen__foot"><button class="btn btn--primary btn--block" type="button" data-act="register">次へ</button></div>`,
    };
  };

  const CONSENT = [
    { k: '読み解き', ic: 'doc', d: '入力した文章を、意思の解析のためそのまま外部AI事業者(Anthropic)へ送信します(学習利用はありません)' },
    { k: '成立の判定', ic: 'people', d: '相手との成立判定のため、預けた意思から生成したテキストを外部AI事業者(TypeSafe・緊急時はAnthropic)へ送信します(入力原文は送りません・学習利用はありません)' },
    { k: '意味の近さの計算', ic: 'cloud', d: '意味検索の埋め込み計算はCloudflare内で行われ、外部送信はありません' },
  ];
  screens.consent = ({ q }) => {
    const viewOnly = q.view === '1';
    return {
      html: `
        ${topbar({ l: back(viewOnly ? 'me' : 'register'), r: viewOnly ? '' : '<span class="t-meta" style="padding-right:14px">2 / 2</span>' })}
        <div class="screen__body pad" style="padding-top:12px;padding-bottom:12px">
          <h1 class="t-display t-display--s">預けた言葉の、扱いについて。</h1>
          <p class="t-body" style="margin-top:12px">意思を読み解き、合う相手との成立を判定するために、次のように扱います。</p>
          <ol class="consent">
            ${CONSENT.map((c, i) => `<li class="consent__item"><span class="consent__n t-num">0${i + 1}</span><div><p class="consent__k">${c.k}</p><p class="consent__d">${c.d}</p></div></li>`).join('')}
          </ol>
          <p class="note" style="margin-top:20px">${ic('lock')}<span>預けた文章そのものが、<b>ほかの利用者に表示されることはありません。</b></span></p>
        </div>
        <div class="screen__foot">
          ${viewOnly
            ? '<p class="t-caption" style="text-align:center">2026年10月4日に同意しています。</p>'
            : `<button class="btn btn--primary btn--block" type="button" data-act="consent">同意して進む</button>
          <button class="btn btn--quiet" type="button" data-act="no-consent">同意しないで進む</button>
          <p class="t-caption" style="text-align:center;margin-top:-4px">同意しない場合、意思を預けることはできません。閲覧と設定はできます。</p>`}
        </div>`,
    };
  };

  // 5-2. 待つ(ホーム) -----------------------------------------------------
  function intentRow(it, k) {
    const st = intentState(it);
    const dim = ['draft', 'expired', 'paused'].includes(st);
    let time = '';
    if (st === 'draft') {
      time = `<span class="intent__time"><span class="t-meta">${ago(it.savedAt)}に保存</span></span>`;
    } else if (st === 'expired') {
      time = `<span class="intent__time"><span class="t-meta">${md(it.expiresAt)}に期限切れ</span></span>`;
    } else if (it.form === 'connection') {
      const total = it.expiresAt - it.createdAt;
      const done = Math.min(1, Math.max(0, (now() - it.createdAt) / total));
      time = `<span class="intent__time">
          <span class="timeline" aria-hidden="true"><span class="timeline__done" style="width:${(done * 100).toFixed(1)}%"></span><span class="timeline__now" style="left:${(done * 100).toFixed(1)}%"></span></span>
          <span class="timeline__labels t-meta"><span>預けて${daysSince(it.createdAt)}日</span><span>あと${daysUntil(it.expiresAt)}日${it.matches ? `<span class="sep">·</span>つながり ${it.matches}` : ''}</span></span>
        </span>`;
    } else {
      time = `<span class="intent__time"><span class="timeline__labels t-meta" style="margin-top:0"><span>${ic('calendar', 'ic--xs')} ${when(it.start)}〜</span><span>${it.start > now() ? `開始まで ${left(it.start).replace('あと', '')}` : '開始しています'}</span></span></span>`;
    }
    return `<li><a class="intent${dim ? ' is-dim' : ''} rise rise-${Math.min(5, k + 1)}" href="#/intent/${it.id}">
        <span class="intent__glyph">${glyph(st, 'glyph--l')}</span>
        <span class="stack">
          <span class="intent__words clamp-2">${esc(it.text)}</span>
          <span class="intent__meta"><span class="t-label">${FORM[it.form]}</span>${status(st)}</span>
          ${time}
        </span>
      </a></li>`;
  }
  function arrivalBlock(p, first) {
    const pressed = p.status === 'partial';
    const vt = first ? 'view-transition-name:latch-hero' : '';
    return `<a class="arrival${pressed ? ' is-pressed' : ''} rise" href="#/proposal/${p.id}">
        ${latch(pressed ? 'pressed' : 'arrived', 40, 5, vt)}
        <span class="stack" style="gap:2px">
          <span class="arrival__title">${pressed ? '相手の回答を待っています' : '提案が届いています'}</span>
          <span class="t-meta">回答期限 ${when(deadlineOf(p))} まで${p.size > 2 ? `<span class="sep">·</span>${p.size}人` : ''}</span>
        </span>
        ${ic('chev', 'ic--s')}
      </a>`;
  }
  screens.home = ({ q }) => {
    const variant = q.variant || '';
    const all = variant === 'empty' ? [] : S.intents.filter((i) => i.status !== 'cancelled');
    if (!all.length) return homeEmpty();
    const live = all.filter((i) => i.status === 'active' || i.status === 'paused');
    const shelf = all.filter((i) => i.status === 'draft' || i.status === 'expired');
    const arrivals = variant === 'quiet' ? [] : S.proposals.filter((p) => p.status === 'proposed' || p.status === 'partial');
    const activeN = all.filter((i) => i.status === 'active').length;
    const offline = S.net === 'offline' || variant === 'offline';
    const pushOff = S.push === 'denied' || variant === 'pushoff';
    const lit = arrivals.some((p) => p.status === 'proposed');
    let k = 0;
    return {
      cls: 'home',
      html: `
        <div class="vessel vessel--quiet${lit ? ' is-lit' : ''}" style="width:340px;height:340px;right:-176px;top:-128px" aria-hidden="true"></div>
        ${topbar({ l: brand, r: topRight() })}
        <div class="screen__body" style="padding-bottom:132px">
          <div class="pad" style="padding-top:6px;padding-bottom:18px">
            <h1 class="t-display rise">預けている</h1>
            <p class="t-caption rise rise-1">${activeN ? `いま、${activeN}つの意思を預けています。` : '預けている意思はありません。'}</p>
          </div>
          ${offline ? `<p class="banner" style="margin-bottom:12px">${ic('wifi-off')}<span>オフラインです。最後に確かめた内容を表示しています。</span></p>` : ''}
          ${pushOff && !offline ? `<p class="banner" style="margin-bottom:12px">${ic('bell-off')}<span>通知がオフです。提案はアプリ内のお知らせでお伝えします。</span><a class="link" href="#/settings" style="font-size:13px">設定</a></p>` : ''}
          ${S.surveyPending ? surveyCard() : ''}
          ${arrivals.map((p, i) => arrivalBlock(p, i === 0)).join('')}
          <ul>${live.map((it) => intentRow(it, k++)).join('')}</ul>
          ${shelf.length ? `<h2 class="list__head t-label">下書き・期限切れ</h2><ul>${shelf.map((it) => intentRow(it, k++)).join('')}</ul>` : ''}
          <p class="home__foot t-caption">${glyph('active')}合う相手が現れたときだけ、ここに届きます。</p>
        </div>
        ${tabbar('home')}`,
    };
  };
  function surveyCard() {
    return `<form class="survey rise" data-act-submit="survey">
        <p class="t-head">意思を預けるまでの流れ、いかがでしたか?</p>
        <div class="scale" role="radiogroup" aria-label="5段階">
          ${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="sv" value="${n}" data-act="survey-pick"><span>${n}</span></label>`).join('')}
        </div>
        <div class="row" style="justify-content:space-between"><span class="t-meta">1 よくなかった</span><span class="t-meta">5 よかった</span></div>
        <div class="row" style="justify-content:flex-end;gap:4px;margin-top:2px"><button class="btn btn--quiet btn--small" type="button" data-act="survey-skip">スキップ</button></div>
      </form>`;
  }
  function homeEmpty() {
    return {
      cls: 'home home--empty',
      html: `
        ${topbar({ l: brand, r: topRight() })}
        <div class="screen__body pad" style="display:flex;flex-direction:column;padding-bottom:140px">
          <div style="flex:1;min-height:40px"></div>
          <div class="rise" style="align-self:center">${latch('empty', 210, 18)}</div>
          <div style="flex:1;min-height:40px"></div>
          <h1 class="t-display t-display--s rise rise-1">まだ、何も置いていません。</h1>
          <p class="t-body rise rise-2" style="margin-top:12px">ふと浮かんだ「繋がりたい」を、ひとことだけ置いておけます。届くまでは、待つだけです。</p>
          <a class="btn btn--primary rise rise-3" style="margin-top:28px;align-self:flex-start" href="#/compose">${ic('plus')}ひとこと置く</a>
        </div>
        ${tabbar('home')}`,
    };
  }

  // 5-3. 置く ------------------------------------------------------------
  screens.compose = ({ q }) => {
    const full = q.state === 'full';
    const text = full ? FULL_TEXT : q.state === 'typing' ? SAMPLE : S.draft;
    const n = [...text].length;
    const cls = n >= 300 ? 'is-full' : n >= 270 ? 'is-near' : '';
    return {
      cls: 'compose-screen',
      html: `
        ${topbar({ l: close('home', '閉じる'), r: '<button class="btn btn--quiet btn--small" type="button" data-act="save-draft">下書きに残す</button>' })}
        <div class="screen__body pad compose-body" style="padding-top:4px">
          <p class="t-eyebrow">置く</p>
          <h1 class="t-display t-display--s" style="margin-top:10px">どんな人と、どんなふうに繋がりたいですか。</h1>
          <p class="t-caption" id="c-hint" style="margin-top:6px">${n >= 300 ? '300字まで書けます。' : '日時や場所が決まっているなら、そのまま書いてください。'}</p>
          <div class="compose">
            <label class="sr-only" for="c-text">繋がりたいこと(300字まで)</label>
            <textarea class="compose__area compose__rule" id="c-text" maxlength="300" placeholder="${esc(EXAMPLES[0])}">${esc(text)}</textarea>
          </div>
        </div>
        <div class="screen__foot">
          <div class="row" style="justify-content:space-between;gap:12px">
            <p class="privacy">${ic('lock')}ほかの人には表示されません。</p>
            <p class="counter ${cls}" id="c-count" aria-live="polite"><b>${n}</b> / 300</p>
          </div>
          <button class="btn btn--primary btn--block" type="button" data-act="parse" ${n ? '' : 'disabled'}>読み解く</button>
        </div>`,
      mount(el) {
        const ta = el.querySelector('#c-text');
        const cnt = el.querySelector('#c-count');
        const hint = el.querySelector('#c-hint');
        const btn = el.querySelector('[data-act="parse"]');
        let ex = 0;
        const timer = setInterval(() => { ex = (ex + 1) % EXAMPLES.length; ta.placeholder = EXAMPLES[ex]; }, 4200);
        cleanup.push(() => clearInterval(timer));
        ta.addEventListener('input', () => {
          const len = [...ta.value].length;
          cnt.innerHTML = `<b>${len}</b> / 300`;
          cnt.className = `counter ${len >= 300 ? 'is-full' : len >= 270 ? 'is-near' : ''}`;
          hint.textContent = len >= 300 ? '300字まで書けます。' : '日時や場所が決まっているなら、そのまま書いてください。';
          btn.disabled = !ta.value.trim();
          S.draft = ta.value; save();
        });
        if (!SHOT && !q.state) setTimeout(() => ta.focus({ preventScroll: true }), 420);
      },
    };
  };

  screens.reading = ({ q }) => {
    const text = S.draft || SAMPLE;
    if (q.state === 'failed') {
      return {
        html: `
          ${topbar({ l: back('compose') })}
          <div class="screen__body pad" style="display:flex;flex-direction:column;justify-content:center;padding-bottom:24px">
            <p class="quote clamp-2" style="margin-bottom:44px">${esc(text)}</p>
            <h1 class="t-display t-display--s">うまく読み解けませんでした。</h1>
            <p class="t-body" style="margin-top:12px">通信の状態を確かめて、もう一度お試しください。条件を自分で入れて預けることもできます。</p>
          </div>
          <div class="screen__foot">
            <button class="btn btn--primary btn--block" type="button" data-act="parse">${ic('refresh')}もう一度読み解く</button>
            <a class="btn btn--secondary btn--block" href="#/confirm?manual=1">自分で入力する</a>
          </div>`,
      };
    }
    return {
      cls: 'reading',
      html: `
        ${topbar({ l: close('compose', 'やめる') })}
        <div class="screen__body pad" style="display:flex;flex-direction:column;justify-content:center;padding-bottom:96px">
          <p class="t-words reading__text" style="font-size:21px;line-height:1.9">${esc(text)}</p>
          <p class="row t-label" style="gap:12px;margin-top:36px">読み解いています<span class="reading-dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
          <p class="t-caption" style="margin-top:4px">主題と、日時・場所などの条件を読み取っています。</p>
        </div>`,
      mount() {
        if (SHOT) return;
        const t = setTimeout(() => {
          if (/エラー|失敗/.test(text)) go('reading?state=failed', { replace: true });
          else { S.parsed = parse(text); save(); go('confirm', { replace: true }); }
        }, 2100);
        cleanup.push(() => clearTimeout(t));
      },
    };
  };

  function factRow(key, val, opts = {}) {
    const { muted = false, edit = true, html = false, req = false } = opts;
    return `<div class="fact"><dt class="fact__key">${key}</dt><dd class="fact__val${muted ? ' fact__val--muted' : ''}">${html ? val : esc(val)}${req ? ' <span class="t-lamp" style="font-size:12px">必須</span>' : ''}</dd>${edit ? `<button class="icon-btn" type="button" aria-label="${key}を直す" data-act="edit-fact">${ic('edit', 'ic--s')}</button>` : '<span></span>'}</div>`;
  }
  screens.confirm = ({ q }) => {
    const sampleText = q.sample === 'occasion' ? OCC_SAMPLE : null;
    const base = sampleText ? parse(sampleText) : (S.parsed || parse(S.draft || SAMPLE));
    const manual = q.manual === '1';
    const p = Object.assign({}, base, manual ? { topic: '', conds: [] } : {});
    const form = q.form || p.form;
    const text = sampleText || S.draft || SAMPLE;
    const alcoholBlocked = q.error === 'alcohol' || (form === 'occasion' && p.alcohol && S.me.age < 20);
    const days = Number(q.days) || p.days || 30;
    const startAt = p.start || at(20);
    const exp = form === 'occasion' ? startAt + 3 * HOUR : T0 + days * DAY;
    const chips = (p.conds || []).map((c) => `<button class="chip" type="button" aria-label="${esc(c)}を外す" data-act="drop-chip">${esc(c)}${ic('close')}</button>`).join('') + '<button class="chip chip--add" type="button" data-act="edit-fact">' + ic('plus') + '条件を足す</button>';
    let facts = '';
    if (form === 'connection') {
      facts = factRow('主題', p.topic || '入力してください', { muted: !p.topic, req: !p.topic })
        + `<div class="fact fact--chips"><dt class="fact__key">条件</dt><dd class="chips">${chips}</dd><span></span></div>`
        + factRow('地域', p.region || '指定なし(全国)', { muted: !p.region })
        + factRow('人数', '2人(あなたと相手)');
    } else {
      facts = factRow('主題', p.topic || '入力してください', { muted: !p.topic })
        + factRow('日時', `${when(startAt)}〜`)
        + factRow('場所', p.place || '指定なし', { muted: !p.place })
        + factRow('人数', p.people || '2人')
        + factRow('予算', p.budget || '指定なし', { muted: !p.budget })
        + `<div class="fact"><dt class="fact__key">お酒</dt><dd class="fact__val">${p.alcohol ? '含む' : '含まない'}<span class="fact__sub">${p.alcohol ? '20歳以上の方どうしでだけ届きます。' : ''}</span></dd><div class="switch"><input type="checkbox" aria-label="お酒を含む" ${p.alcohol ? 'checked' : ''} data-act="toggle-alcohol"><span></span></div></div>`;
    }
    const expiry = form === 'connection'
      ? `<div class="pills" role="radiogroup" aria-label="期限">
          ${[7, 30, 90].map((d) => `<label class="pill"><input type="radio" name="days" value="${d}" ${d === days ? 'checked' : ''} data-act="pick-days"><span><b>${d}</b>日</span></label>`).join('')}
        </div>
        <p class="t-caption" style="margin-top:10px">${md(exp)}まで預けます。期限が来たら、お知らせします。</p>`
      : `<p class="t-body" style="color:var(--ink)">開始から3時間後(${when(exp)})まで</p><p class="t-caption" style="margin-top:4px">機会の期限は、日時から自動で決まります。</p>`;
    const opt = (v, name, hint) => `<label class="choice__opt"><input type="radio" name="form" value="${v}" ${form === v ? 'checked' : ''} data-act="pick-form"><span class="choice__card">${glyph(v === 'connection' ? 'active' : 'proposed')}<span class="choice__name">${name}</span><span class="choice__hint">${hint}</span></span></label>`;
    const limitSheet = q.error === 'limit' ? sheet(`
        <h2 class="sheet__title">同時に預けておけるのは、5つまでです。</h2>
        <p class="t-body">いま預けている意思のどれかを一時停止するか、取り下げると、新しく預けられます。この内容は下書きに残せます。</p>
        <div class="sheet__actions">
          <button class="btn btn--primary btn--block" type="button" data-act="save-draft">下書きに残す</button>
          <a class="btn btn--secondary btn--block" href="#/home">預けている一覧へ</a>
        </div>`, '預けられる数の上限') : '';
    return {
      cls: 'confirm',
      html: `
        ${topbar({ l: back(manual ? 'reading?state=failed' : 'compose') })}
        <div class="screen__body pad" style="padding-top:4px;padding-bottom:24px">
          <h1 class="t-display t-display--s">${manual ? '条件を入れてください。' : 'こう読み解きました。'}</h1>
          <div class="row" style="gap:12px;margin-top:16px;align-items:flex-start">
            <p class="quote clamp-2" style="flex:1">${esc(text)}</p>
            <a class="btn btn--quiet btn--small" style="margin:-6px -12px 0 0" href="#/compose">文章を直す</a>
          </div>
          <section style="margin-top:28px">
            <h2 class="t-label">預け方</h2>
            <div class="choice" role="radiogroup" aria-label="預け方" style="margin-top:12px">
              ${opt('connection', 'つながりとして預ける', 'すぐ会う予定はない')}
              ${opt('occasion', '機会として預ける', '日時がある')}
            </div>
          </section>
          <section style="margin-top:30px">
            <h2 class="t-label">読み解いた条件</h2>
            <dl class="facts" style="margin-top:8px">${facts}</dl>
            ${alcoholBlocked ? `<p class="note note--lamp" style="margin-top:14px">${ic('info')}<span><b>お酒を含む機会は、20歳以上の方が預けられます。</b>「お酒」をオフにすると、このまま預けられます。</span></p>` : ''}
          </section>
          <section style="margin-top:30px">
            <h2 class="t-label">期限</h2>
            <div style="margin-top:12px">${expiry}</div>
          </section>
          <p class="privacy" style="margin-top:28px">${ic('lock')}文章そのものは、相手にも表示されません。</p>
        </div>
        <div class="screen__foot">
          ${alcoholBlocked ? `<p class="foot-reason">${ic('info', 'ic--xs')}お酒を含む機会は、20歳以上の方が預けられます。</p>` : ''}
          <button class="btn btn--primary btn--block" type="button" data-act="place" ${alcoholBlocked || !p.topic ? 'disabled' : ''}>預ける</button>
        </div>
        ${limitSheet}`,
    };
  };

  screens.placed = () => {
    const it = intentById(S.lastPlaced) || S.intents.find((i) => i.status === 'active') || { text: SAMPLE, form: 'connection' };
    const askPush = S.push === 'default';
    return {
      cls: 'placed',
      html: `
        <div class="screen__body" style="display:flex;flex-direction:column">
          <div style="position:relative;height:388px;flex:none">
            <p class="placed__words t-words" aria-hidden="true">${esc(it.text)}</p>
            <div class="placed__art" style="position:absolute;left:28px;top:118px">${latch('waiting', 196, 18)}</div>
            ${tategaki('預けました。', 'position:absolute;right:36px;top:92px;font-size:30px', 'reveal reveal--late')}
          </div>
          <div class="pad">
            <p class="t-title rise rise-4">あとは、待つだけ。</p>
            <p class="t-body rise rise-5" style="margin-top:8px">合う相手が現れたときだけ、お知らせします。届かない日も、意思はここに置かれています。</p>
          </div>
          ${askPush ? `<div class="push-ask rise rise-5">
              <p class="row t-head" style="gap:10px">${ic('bell')}届いたとき、通知でお知らせしましょうか。</p>
              <p class="t-caption" style="margin-top:4px">通知には、意思の内容も相手のことも表示されません。</p>
              <div class="row" style="gap:8px;margin-top:12px">
                <button class="btn btn--primary btn--small" type="button" data-act="push-allow">通知を受け取る</button>
                <button class="btn btn--quiet btn--small" type="button" data-act="push-later">あとで</button>
              </div>
            </div>` : ''}
        </div>
        <div class="screen__foot"><a class="btn btn--secondary btn--block" href="#/home">預けている一覧へ</a></div>`,
    };
  };

  // 5-4. 意思の詳細 --------------------------------------------------------
  screens.intent = ({ id }) => {
    const it = intentById(id) || S.intents[0];
    if (!it) return screens.home({ q: {} });
    const st = intentState(it);
    let stats = '', facts = '', actions = '', extra = '';
    if (it.status === 'draft') {
      actions = `<a class="btn btn--primary btn--block" href="#/compose" data-act="resume-draft" data-id="${it.id}">続きを書く</a><button class="btn btn--quiet" type="button" data-act="delete-intent" data-id="${it.id}">下書きを削除する</button>`;
      extra = `<p class="t-caption" style="margin-top:18px">${ago(it.savedAt)}に保存した下書きです。預けるまでは、提案は届きません。</p>`;
    } else {
      if (it.form === 'connection') {
        stats = `<div class="stats">
            <div><p class="stats__k">預けて</p><p class="stats__v"><b>${daysSince(it.createdAt)}</b>日</p></div>
            <div><p class="stats__k">期限まで</p><p class="stats__v"><b>${it.status === 'expired' ? 0 : daysUntil(it.expiresAt)}</b>日</p></div>
            <div><p class="stats__k">これまで</p><p class="stats__v"><b>${it.matches}</b>回つながった</p></div>
          </div>`;
        facts = factRow('主題', it.topic, { edit: false }) + `<div class="fact"><dt class="fact__key">条件</dt><dd class="fact__val">${(it.conds || []).map(esc).join('<span class="sep">·</span>') || 'なし'}</dd><span></span></div>` + factRow('地域', it.region || '指定なし(全国)', { edit: false, muted: !it.region }) + factRow('人数', '2人(あなたと相手)', { edit: false }) + factRow('期限', `${md(it.expiresAt)}まで(${it.days}日)`, { edit: false });
      } else {
        stats = `<div class="stats">
            <div><p class="stats__k">開始・${dayWord(it.start)}</p><p class="stats__v"><b>${hm(it.start)}</b></p></div>
            <div><p class="stats__k">期限・${dayWord(it.expiresAt)}</p><p class="stats__v"><b>${hm(it.expiresAt)}</b></p></div>
            <div><p class="stats__k">これまで</p><p class="stats__v"><b>${it.matches}</b>回つながった</p></div>
          </div>`;
        facts = factRow('主題', it.topic, { edit: false }) + factRow('日時', `${when(it.start)}〜`, { edit: false }) + factRow('場所', it.place || '指定なし', { edit: false }) + factRow('人数', it.people, { edit: false }) + factRow('予算', it.budget || '指定なし', { edit: false }) + factRow('お酒', it.alcohol ? '含む(20歳以上の方どうし)' : '含まない', { edit: false });
      }
      if (it.status === 'expired') {
        actions = `<button class="btn btn--primary btn--block" type="button" data-act="replace-intent" data-id="${it.id}">もう一度預ける</button><button class="btn btn--quiet" type="button" data-act="delete-intent" data-id="${it.id}">一覧から消す</button>`;
        extra = `<p class="t-caption" style="margin-top:18px">${md(it.expiresAt)}に期限が切れました。同じ内容で、もう一度預けられます。</p>`;
      } else {
        actions = `${it.status === 'paused'
          ? `<button class="btn btn--primary btn--block" type="button" data-act="toggle-pause" data-id="${it.id}">${ic('play')}再開する</button>`
          : `<button class="btn btn--secondary btn--block" type="button" data-act="toggle-pause" data-id="${it.id}">${ic('pause')}一時停止する</button>`}
          <button class="btn btn--secondary btn--block" type="button" data-act="edit-intent">${ic('edit')}内容を直す</button>
          <button class="btn btn--quiet t-danger" type="button" data-act="cancel-intent" data-id="${it.id}">取り下げる</button>`;
        extra = `<div class="setting-row" style="margin-top:26px">
            <div><p class="t-head">提案をお知らせする</p><p class="t-caption">オフにすると通知はしません。提案は、預けている一覧に届きます。</p></div>
            <div class="switch"><input type="checkbox" aria-label="この意思の提案をお知らせする" ${it.notify ? 'checked' : ''} data-act="toggle-notify" data-id="${it.id}"><span></span></div>
          </div>
          <p class="t-caption" style="margin-top:14px">${it.status === 'paused' ? '一時停止中は、提案が届きません。' : '一時停止しているあいだは、提案が届きません。'}いつでも再開できます。</p>`;
      }
    }
    return {
      cls: 'intent-detail',
      html: `
        ${topbar({ l: back('home') })}
        <div class="screen__body pad" style="padding-top:4px;padding-bottom:28px">
          <div class="row" style="gap:12px">${status(st)}<span class="t-label">${FORM[it.form]}</span></div>
          <p class="t-words" style="font-size:21px;line-height:1.85;margin-top:14px">${esc(it.text)}</p>
          ${stats}
          ${facts ? `<h2 class="t-label" style="margin-top:30px">読み解いた条件</h2><dl class="facts" style="margin-top:8px">${facts}</dl>` : ''}
          ${extra}
          <div class="stack" style="gap:8px;margin-top:26px">${actions}</div>
        </div>`,
    };
  };

  // 5-5. 届く ------------------------------------------------------------
  const osPushHTML = (time, body) => `<div class="os-push" role="img" aria-label="通知: ${esc(body)}"><span class="os-push__icon">${mark()}</span><span><span class="os-push__top"><span class="os-push__app">LATCH</span><span>${time}</span></span><span class="os-push__body">${body}</span></span></div>`;
  screens.push = () => ({
    theme: 'dark',
    cls: 'push-mock',
    html: `
      <div class="push-mock__wall" aria-hidden="true"><div style="position:absolute;left:50%;top:520px;transform:translateX(-50%)">${latch('arrived', 300, 26, 'filter:blur(1px);opacity:.9')}</div></div>
      <div class="screen__body" style="padding:96px 12px 0;display:flex;flex-direction:column;gap:10px">
        <p class="t-eyebrow" style="padding:0 12px 8px">通知の見え方</p>
        ${osPushHTML('いま', 'LATCH候補があります。詳細はアプリでご確認ください。')}
        ${osPushHTML('3日前', 'つながりが成立しました。詳細はアプリでご確認ください。')}
        <p class="t-caption" style="padding:18px 14px 0">通知の本文は、いつも同じ汎用文です。意思の内容や相手のことは、ロック画面にも通知の履歴にも載りません。</p>
      </div>`,
  });

  function ensureDemoProposal(id) {
    let p = proposalById(id);
    if (!p && id === 'p2') {
      const it = intentById('i2') || S.intents.find((i) => i.form === 'occasion');
      p = { id: 'p2', intentId: it ? it.id : 'i2', form: 'occasion', size: 4, notifiedAt: T0 - 4 * MIN, status: 'proposed', partners: [{ name: 'ゆう', av: 'd', bio: '天文館の近くで働いています。仕事終わりにさくっと。' }, { name: 'ちひろ', av: 'e', bio: '' }, { name: 'かえで', av: 'c', bio: '' }] };
      S.proposals.push(p);
    }
    if (!p) p = S.proposals[0];
    return p;
  }
  screens.proposal = ({ id, q, forcePressed }) => {
    const p = ensureDemoProposal(id);
    if (!p) return screens.closed({ id });
    if (p.status === 'matched') return screens.matched({ id: p.connId });
    if (p.status === 'closed') return screens.closed({ id: p.id });
    const pressed = forcePressed || p.status === 'partial';
    const group = p.size > 2;
    const dl = deadlineOf(p);
    const art = group
      ? groupDisc(p.size, 224, { light: !pressed })
      : latch(pressed ? 'pressed' : 'arrived', 212, 22, 'view-transition-name:latch-hero');
    const text = pressed
      ? `<h1 class="t-display" style="margin-top:2px">相手の回答を<br>待っています。</h1>`
      : `<p class="t-eyebrow">提案</p>
         <h1 class="t-display" style="margin-top:12px">条件が合う候補が<br>あります。</h1>
         ${group ? `<p class="group-need">${glyph('active')}あなたを含む${p.size}人で成立します</p>` : ''}`;
    const foot = pressed
      ? `<button class="btn btn--quiet btn--block" type="button" data-act="retract" data-id="${p.id}">回答を取り消す</button>`
      : `<button class="btn btn--primary btn--block" type="button" data-act="join" data-id="${p.id}">参加する</button>
         <button class="btn btn--secondary btn--block" type="button" data-act="defer" data-id="${p.id}">今回は見送る</button>
         <p class="t-caption" style="text-align:center">${group ? '全員' : 'お互い'}が参加すると、はじめて相手が見えます。</p>`;
    const menu = q && q.sheet === 'menu' ? sheet(`
        <h2 class="sheet__title" style="font-size:19px">この提案について</h2>
        <div class="list" style="margin:0 calc(var(--gutter) * -1)">
          <a class="list-row" href="#/report/${p.id}">${ic('flag')}<span>この提案を通報する</span>${ic('chev', 'list-row__chev')}</a>
        </div>
        <p class="t-caption">通報したことは、相手には通知されません。</p>
        <div class="sheet__actions"><button class="btn btn--quiet btn--block" type="button" data-act="sheet-close">閉じる</button></div>`, 'この提案について') : '';
    return {
      theme: 'dark',
      cls: `room proposal${pressed ? ' is-pressed' : ''}`,
      html: `
        ${topbar({ l: close('home', 'あとで回答する'), r: `<a class="icon-btn" href="#/proposal/${p.id}?sheet=menu" aria-label="この提案について">${ic('more')}</a>` })}
        <div class="screen__body">
          <div class="proposal__stage">${art}</div>
          <div class="pad proposal__text">
            ${text}
            <div class="deadline" style="margin-top:26px">
              <span class="t-label">回答期限</span>
              <div class="deadline__row"><span class="deadline__when">${when(dl)} まで</span><span class="deadline__left" data-left="${dl}">${left(dl)}</span></div>
            </div>
          </div>
        </div>
        <div class="screen__foot">${foot}</div>
        ${menu}`,
      mount(el) {
        const lt = el.querySelector('[data-left]');
        if (lt && !SHOT) {
          const t = setInterval(() => { lt.textContent = left(Number(lt.dataset.left)); }, 15000);
          cleanup.push(() => clearInterval(t));
        }
      },
    };
  };
  screens.awaiting = ({ id, q }) => screens.proposal({ id, q, forcePressed: true });

  screens.shelved = ({ id, q }) => {
    const p = proposalById(id) || S.proposals[0];
    const form = q.form || (p ? p.form : 'connection');
    const showNote = q.note !== '0';
    const note = form === 'occasion'
      ? `<p class="note" style="margin-top:22px">${ic('info')}<span>条件が変われば、また届くことがあります。</span></p>`
      : `<p class="note" style="margin-top:22px">${ic('info')}<span>この相手との提案は今後届きません。</span></p>`;
    const reason = q.sheet === 'reason' ? sheet(`
        <h2 class="sheet__title">見送った理由<span class="t-caption" style="font-family:var(--f-gothic);margin-left:8px">任意</span></h2>
        <p class="t-caption" style="margin-top:-8px">相手には伝わりません。これからの提案の参考にします。</p>
        <div>
          ${['いまは余裕がない', '日時や場所が合わない', 'なんとなく、今回は', 'その他'].map((r) => `<label class="radio-row"><input type="radio" name="reason" value="${r}"><span>${r}</span></label>`).join('')}
        </div>
        <div class="sheet__actions">
          <button class="btn btn--primary btn--block" type="button" data-act="reason-send">残す</button>
          <button class="btn btn--quiet btn--block" type="button" data-act="sheet-close">スキップ</button>
        </div>`, '見送った理由') : '';
    return {
      cls: 'shelved',
      html: `
        ${topbar({ l: close('home') })}
        <div class="screen__body">
          <div style="position:relative;height:350px">
            ${dome(150, 'position:absolute;left:40px;top:178px')}
            ${tategaki('そっと、\n棚に戻しました。', 'position:absolute;right:34px;top:40px;font-size:26px', 'reveal')}
          </div>
          <div class="pad">
            <p class="t-body rise rise-3" style="color:var(--ink)">今回の提案は見送りました。あなたの意思は、そのまま預けています。</p>
            ${showNote ? `<div class="rise rise-4">${note}</div>` : ''}
          </div>
        </div>
        <div class="screen__foot">
          <a class="btn btn--primary btn--block" href="#/home">閉じる</a>
          <a class="btn btn--quiet" href="#/shelved/${id}?form=${form}&sheet=reason${showNote ? '' : '&note=0'}">見送った理由を残す(任意)</a>
        </div>
        ${reason}`,
    };
  };
  screens.reason = ({ id, q }) => screens.shelved({ id, q: Object.assign({}, q, { sheet: 'reason' }) });

  screens.closed = () => ({
    cls: 'closed',
    html: `
      ${topbar({ l: close('home') })}
      <div class="screen__body">
        <div style="position:relative;height:330px">${dome(132, 'position:absolute;left:50%;top:170px;transform:translateX(-50%)')}</div>
        <div class="pad">
          <h1 class="t-display t-display--s rise">この提案は成立しませんでした。</h1>
          <p class="t-body rise rise-1" style="margin-top:12px">あなたの意思は、そのまま預けています。</p>
        </div>
      </div>
      <div class="screen__foot"><a class="btn btn--secondary btn--block" href="#/home">預けている一覧へ</a></div>`,
  });

  // 5-6. つながる ----------------------------------------------------------
  function ensureDemoConnection(id) {
    let c = connById(id);
    if (!c && id === 'c4') {
      c = { id: 'c4', form: 'connection', status: 'matched', topic: 'イラスト仲間', size: 2, region: null, matchedAt: now() - 1 * MIN, unread: 0, revealed: false, partners: [{ name: 'ひなた', bio: '仕事帰りに、iPadで落書きしています。上手じゃなくても見せ合える人がいたら。', av: 'b' }], messages: [] };
      S.connections.unshift(c);
    }
    return c || S.connections[0];
  }
  function summaryFacts(c) {
    if (c.form === 'occasion') {
      return factRow('主題', c.topic, { edit: false }) + factRow('日時', `${when(c.start)}〜`, { edit: false }) + factRow('場所', c.place || '指定なし', { edit: false }) + factRow('人数', `${c.size}人`, { edit: false }) + factRow('予算', c.budget || '指定なし', { edit: false });
    }
    return factRow('主題', c.topic, { edit: false }) + factRow('預け方', 'つながり', { edit: false }) + factRow('人数', `${c.size}人`, { edit: false }) + factRow('地域', c.region || '指定なし(全国)', { edit: false, muted: !c.region });
  }
  screens.matched = ({ id }) => {
    const c = ensureDemoConnection(id);
    const pt = c.partners[0];
    const group = c.partners.length > 1;
    const fresh = !c.revealed && animate;
    const art = group
      ? groupDisc(c.size, 200, { fills: ['var(--ink)', ...c.partners.map((x) => AV[x.av])] })
      : latch(fresh ? 'pressed' : 'latched', 184, 20, `--theirs-fill:${AV[pt.av]}`, '<span class="latch__ring"></span>');
    const people = group
      ? `<div class="stack" style="gap:14px;margin-top:22px">${c.partners.map((x) => `<div class="row" style="gap:14px">${avatar(x.av, 'm')}<p class="t-head">${esc(x.name)}</p></div>`).join('')}</div>`
      : `<div class="partner">${avatar(pt.av, 'l', `${pt.name}のアイコン`)}<div><p class="t-title">${esc(pt.name)}</p><p class="t-meta">${md(c.matchedAt)} ${hm(c.matchedAt)} につながりました</p></div></div>
         ${pt.bio ? `<p class="t-words partner__bio">${esc(pt.bio)}</p>` : ''}`;
    return {
      cls: `matched${fresh ? ' is-fresh' : ''}`,
      html: `
        <div class="dawn" aria-hidden="true"></div>
        ${topbar({ l: close('home') })}
        <div class="screen__body" style="padding-bottom:16px">
          <div class="matched__stage">${art}</div>
          <div class="pad">
            <p class="t-eyebrow m-rise">つながった</p>
            <h1 class="t-display m-rise m-rise-1" style="margin-top:10px">つながりました。</h1>
            <div class="m-rise m-rise-2">${people}</div>
            <h2 class="t-label m-rise m-rise-3" style="margin-top:28px">重なったところ</h2>
            <dl class="facts m-rise m-rise-3" style="margin-top:8px">${summaryFacts(c)}</dl>
          </div>
        </div>
        <div class="screen__foot m-rise m-rise-4">
          <a class="btn btn--primary btn--block" href="#/chat/${c.id}">メッセージを送る</a>
          <a class="btn btn--quiet" href="#/home">あとで</a>
        </div>`,
      async mount(el) {
        if (!fresh) return;
        c.revealed = true; save();
        const lt = el.querySelector('.latch');
        await wait(650);
        lt.classList.remove('is-pressed');
        lt.classList.add('is-latched', 'is-bleeding');
        if (navigator.vibrate) { try { navigator.vibrate(14); } catch (e) { /* noop */ } }
        await wait(1700);
        lt.classList.remove('is-bleeding');
      },
    };
  };

  function chatHead(c, ended) {
    const group = c.partners.length > 1;
    const name = c.status === 'ended' ? 'つながっていた相手' : group ? c.partners.map((x) => x.name).join('・') : c.partners[0].name;
    const av = c.status === 'ended' ? '<span class="avatar avatar--s avatar--gone" aria-hidden="true"></span>' : group ? `<span class="avatars">${c.partners.map((x) => avatar(x.av, 's')).join('')}</span>` : avatar(c.partners[0].av, 's');
    return `<div class="chat-head">${av}<div class="stack" style="min-width:0"><p class="chat-head__name">${esc(name)}</p><p class="chat-head__sub">${esc(c.topic)}<span class="sep">·</span>${FORM[c.form]}${ended ? '<span class="sep">·</span>終了' : ''}</p></div></div>`;
  }
  screens.chat = ({ id, q }) => {
    const c = connById(id) || ensureDemoConnection(id);
    const ended = c.status === 'ended' || c.status === 'completed';
    const failed = q.state === 'failed';
    const group = c.partners.length > 1;
    c.unread = 0;
    let lastDay = null;
    const msgs = c.messages.map((m, i) => {
      const day = dayIndex(m.at);
      const sep = day !== lastDay ? `<p class="chat__day t-meta">${dayWord(m.at) === '今日' ? '今日' : md(m.at)}</p>` : '';
      lastDay = day;
      const mine = m.by === 'me';
      const who = !mine && group ? `<span class="msg__who">${esc(c.partners[m.by].name)}</span>` : '';
      return `${sep}<div class="msg ${mine ? 'msg--mine' : 'msg--theirs'}">${who}<p class="msg__bubble">${esc(m.text)}</p><span class="msg__time">${hm(m.at)}</span></div>`;
    }).join('');
    const failMsg = failed ? `<div class="msg msg--mine is-failed"><p class="msg__bubble">今月は、窓から見える木を描きました。</p><span class="msg__fail">${ic('info', 'ic--xs')}送信できませんでした<button class="btn btn--quiet btn--small" type="button" style="min-height:44px;padding:0 10px;color:inherit;text-decoration:underline">もう一度送る</button></span></div>` : '';
    const empty = !c.messages.length ? `<p class="chat__hint t-caption">最初のひとことは、短くて大丈夫です。</p>` : '';
    const menu = q.sheet === 'menu' ? sheet(`
        <h2 class="sheet__title" style="font-size:19px">このつながりについて</h2>
        <div class="list" style="margin:0 calc(var(--gutter) * -1)">
          <a class="list-row" href="#/report/${c.id}">${ic('flag')}<span>通報する</span>${ic('chev', 'list-row__chev')}</a>
          ${group ? '' : `<a class="list-row" href="#/block/${c.id}">${ic('block')}<span>ブロックする</span>${ic('chev', 'list-row__chev')}</a>`}
          ${ended ? '' : `<button class="list-row" type="button" data-act="leave" data-id="${c.id}">${ic('exit')}<span class="stack"><span>参加を取り消す</span><span class="list-row__sub">このつながりを終えます。チャットはお互いに読み取り専用になります。</span></span><span></span></button>`}
          <button class="list-row" type="button" data-act="hide" data-id="${c.id}">${ic('undo')}<span class="stack"><span>表示から消す</span><span class="list-row__sub">自分の一覧から消します。相手の側には残ります。</span></span><span></span></button>
        </div>
        <div class="sheet__actions"><button class="btn btn--quiet btn--block" type="button" data-act="sheet-close">閉じる</button></div>`, 'このつながりについて') : '';
    return {
      cls: 'chat-screen',
      html: `
        ${topbar({ l: back('connections'), c: chatHead(c, ended), r: `<a class="icon-btn" href="#/chat/${c.id}?sheet=menu" aria-label="このつながりについて">${ic('more')}</a>` })}
        <div class="screen__body" id="chat-scroll">
          <div class="chat">
            <div class="chat__origin">
              ${latch(ended ? 'ended' : 'latched', 30, 0, c.partners.length === 1 ? `--theirs-fill:${AV[c.partners[0].av]}` : '')}
              <p class="t-meta">${md(c.matchedAt)} ${hm(c.matchedAt)} につながりました</p>
              <p class="t-caption">${esc(c.topic)}<span class="sep">·</span>${c.size}人${c.form === 'occasion' && c.place ? `<span class="sep">·</span>${esc(c.place)}` : ''}</p>
            </div>
            ${msgs}${failMsg}${empty}
          </div>
        </div>
        ${ended
          ? `<div class="ended-bar">${glyph('ended')}このつながりは終了しました</div>`
          : `<form class="composer" data-act-submit="send" data-id="${c.id}">
              <label class="sr-only" for="m-text">メッセージ</label>
              <textarea class="composer__field" id="m-text" rows="1" maxlength="1000" placeholder="メッセージ"></textarea>
              <button class="composer__send" type="submit" aria-label="送る" disabled>${ic('send')}</button>
            </form>`}
        ${menu}`,
      mount(el) {
        const sc = el.querySelector('#chat-scroll');
        const toEnd = () => { if (sc) sc.scrollTop = sc.scrollHeight; };
        toEnd();
        if (document.fonts && document.fonts.ready) document.fonts.ready.then(toEnd);
        [120, 400, 900].forEach((ms) => setTimeout(toEnd, ms));
        const ta = el.querySelector('#m-text');
        if (!ta) return;
        const btn = el.querySelector('.composer__send');
        const fit = () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(140, ta.scrollHeight)}px`; btn.disabled = !ta.value.trim(); };
        ta.addEventListener('input', fit);
        ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el.querySelector('.composer').requestSubmit(); } });
      },
    };
  };

  screens.connections = ({ q }) => {
    const list = q.variant === 'empty' ? [] : S.connections.filter((c) => !c.hidden);
    const row = (c) => {
      const ended = c.status === 'ended' || c.status === 'completed';
      const group = c.partners.length > 1;
      const name = c.status === 'ended' ? 'つながっていた相手' : group ? c.partners.map((x) => x.name).join('・') : c.partners[0].name;
      const av = c.status === 'ended' ? '<span class="avatar avatar--gone" aria-hidden="true"></span>' : group ? `<span class="avatars avatars--stack">${c.partners.slice(0, 2).map((x) => avatar(x.av, 'm')).join('')}</span>` : avatar(c.partners[0].av);
      const last = c.messages[c.messages.length - 1];
      return `<li><a class="conn${ended ? ' is-ended' : ''}" href="#/chat/${c.id}">
          ${av}
          <span class="stack" style="min-width:0">
            <span class="row" style="gap:8px;min-width:0"><span class="conn__name clamp-1">${esc(name)}</span></span>
            <span class="conn__topic">${esc(c.topic)}<span class="sep">·</span>${FORM[c.form]}${ended ? `<span class="sep">·</span>${STATE[c.status]}` : ''}</span>
            <span class="conn__last clamp-1">${last ? esc(last.text) : '最初のひとことを送ってみましょう'}</span>
          </span>
          <span class="conn__side"><span class="t-meta">${last ? ago(last.at) : ago(c.matchedAt)}</span>${c.unread ? `<span class="unread" aria-label="未読${c.unread}件">${c.unread}</span>` : ''}</span>
        </a></li>`;
    };
    const active = list.filter((c) => c.status === 'matched');
    const done = list.filter((c) => c.status !== 'matched');
    const sv = list.find((c) => c.survey === 'pending');
    if (!list.length) {
      return {
        cls: 'connections connections--empty',
        html: `
          ${topbar({ l: brand, r: topRight() })}
          <div class="screen__body pad" style="display:flex;flex-direction:column;padding-bottom:140px">
            <div class="pad-top" style="padding-top:6px"><h1 class="t-display">つながり</h1></div>
            <div style="flex:1"></div>
            <div style="align-self:center" class="rise">${latch('ended', 168, 0, '', '')}</div>
            <div style="flex:1"></div>
            <h2 class="t-display t-display--s rise rise-1">まだ、つながりはありません。</h2>
            <p class="t-body rise rise-2" style="margin-top:10px">提案にお互いが参加すると、ここに並びます。それまでは、預けて待つだけです。</p>
          </div>
          ${tabbar('connections')}`,
      };
    }
    return {
      cls: 'connections',
      html: `
        ${topbar({ l: brand, r: topRight() })}
        <div class="screen__body" style="padding-bottom:132px">
          <div class="pad" style="padding-top:6px;padding-bottom:6px">
            <h1 class="t-display rise">つながり</h1>
            <p class="t-caption rise rise-1">お互いが参加して、つながった相手です。</p>
          </div>
          ${sv ? `<form class="survey rise rise-1" style="margin-top:12px">
              <p class="t-head">${esc(sv.partners[0].name)}さんとのつながりは、どうでしたか。</p>
              <div class="scale" role="radiogroup" aria-label="5段階">${[1, 2, 3, 4, 5].map((n) => `<label><input type="radio" name="sv2" value="${n}" data-act="conn-survey" data-id="${sv.id}"><span>${n}</span></label>`).join('')}</div>
              <div class="row" style="justify-content:space-between"><span class="t-meta">1 いまひとつ</span><span class="t-meta">5 とてもよい</span></div>
              <div class="row" style="justify-content:flex-end"><button class="btn btn--quiet btn--small" type="button" data-act="conn-survey-skip" data-id="${sv.id}">スキップ</button></div>
            </form>` : ''}
          ${active.length ? `<h2 class="list__head t-label">つながっている</h2><ul>${active.map(row).join('')}</ul>` : ''}
          ${done.length ? `<h2 class="list__head t-label">終了</h2><ul>${done.map(row).join('')}</ul>` : ''}
        </div>
        ${tabbar('connections')}`,
    };
  };

  // 5-7. 自分・補助 --------------------------------------------------------
  screens.notices = ({ q }) => {
    const list = q.variant === 'empty' ? [] : [...S.notices].sort((a, b) => b.at - a.at);
    const row = (n) => {
      const unreadCls = n.read ? '' : ' is-unread';
      if (n.type === 'proposal') {
        const p = proposalById(n.ref);
        const live = p && (p.status === 'proposed' || p.status === 'partial');
        return `<li><a class="notice${unreadCls}" href="#/proposal/${n.ref}">${glyph(live ? 'proposed' : 'closed')}<span><span class="notice__text">提案が届いています</span><span class="notice__sub t-meta">${live ? `回答期限 ${when(deadlineOf(p))} まで<span class="sep">·</span>` : ''}${ago(n.at)}</span></span></a></li>`;
      }
      if (n.type === 'matched') {
        const c = connById(n.ref);
        return `<li><a class="notice${unreadCls}" href="#/chat/${n.ref}">${glyph('matched')}<span><span class="notice__text">${c && c.status !== 'ended' ? `${esc(c.partners.map((x) => x.name).join('・'))}さんと` : ''}つながりました</span><span class="notice__sub t-meta">${ago(n.at)}</span></span></a></li>`;
      }
      if (n.type === 'closed') {
        return `<li><div class="notice${unreadCls}">${glyph('closed')}<span><span class="notice__text">この提案は成立しませんでした</span><span class="notice__sub t-meta">${ago(n.at)}</span></span></div></li>`;
      }
      if (n.type === 'expired') {
        const it = intentById(n.ref);
        return `<li><div class="notice${unreadCls}">${glyph('expired')}<span><span class="notice__text">預けていた意思の期限が切れました</span>${it ? `<span class="notice__quote clamp-1">${esc(it.text)}</span>` : ''}<span class="notice__sub"><span class="t-meta">${ago(n.at)}</span>${it ? `<button class="btn btn--secondary btn--small" type="button" data-act="replace-intent" data-id="${it.id}" style="min-height:44px;padding:0 16px;font-size:13px">もう一度預ける</button>` : ''}</span></span></div></li>`;
      }
      return '';
    };
    return {
      cls: 'notices',
      html: `
        ${topbar({ l: back('home'), c: 'お知らせ' })}
        <div class="screen__body" style="padding-bottom:24px">
          ${list.length ? `<ul class="rise">${list.map(row).join('')}</ul>` : `<div class="pad" style="padding-top:150px;display:flex;flex-direction:column;align-items:flex-start">${latch('waiting', 96, 8, '--depth:.6')}<h1 class="t-display t-display--s" style="margin-top:36px">お知らせは、まだありません。</h1><p class="t-body" style="margin-top:10px">提案が届いたときや、期限が来たときに、ここでお伝えします。</p></div>`}
        </div>`,
      mount() {
        if (SHOT) return;
        setTimeout(() => { S.notices.forEach((n) => { n.read = true; }); save(); }, 1200);
      },
    };
  };

  screens.me = () => ({
    cls: 'me',
    html: `
      ${topbar({ l: back('home'), c: '自分' })}
      <div class="screen__body" style="padding-bottom:28px">
        <div class="pad me__card">
          ${avatar(S.me.av, 'xl', 'あなたのアイコン')}
          <div class="stack" style="gap:4px;min-width:0">
            <p class="t-title">${esc(S.me.name)}</p>
            <p class="t-words" style="font-size:15px">${esc(S.me.bio) || '<span style="color:var(--ink-3)">ひとことは未設定です</span>'}</p>
          </div>
        </div>
        <div class="pad" style="margin-top:16px">
          <p class="privacy">${ic('lock')}このプロフィールは、つながった相手にだけ表示されます。</p>
          <a class="btn btn--secondary btn--small" style="margin-top:16px" href="#/profile">${ic('edit')}プロフィールを編集</a>
        </div>
        <h2 class="list__head t-label" style="margin-top:20px">設定</h2>
        <div class="list">
          <a class="list-row" href="#/settings">${ic('bell')}<span>通知と表示</span>${ic('chev', 'list-row__chev')}</a>
          <a class="list-row" href="#/settings?section=blocked">${ic('block')}<span>ブロックしたユーザー</span>${ic('chev', 'list-row__chev')}</a>
          <a class="list-row" href="#/consent?view=1">${ic('lock')}<span>外部送信と同意</span>${ic('chev', 'list-row__chev')}</a>
        </div>
        <h2 class="list__head t-label">そのほか</h2>
        <div class="list">
          <a class="list-row" href="#/me">${ic('help')}<span>ヘルプ・お問い合わせ</span>${ic('chev', 'list-row__chev')}</a>
          <a class="list-row" href="#/me">${ic('doc')}<span>利用規約</span>${ic('chev', 'list-row__chev')}</a>
          <a class="list-row" href="#/me">${ic('doc')}<span>プライバシーポリシー</span>${ic('chev', 'list-row__chev')}</a>
          <button class="list-row" type="button" data-act="logout">${ic('exit')}<span>ログアウト</span><span></span></button>
          <a class="list-row list-row--danger" href="#/withdraw">${ic('close')}<span>退会する</span>${ic('chev', 'list-row__chev')}</a>
        </div>
      </div>`,
  });

  screens.profile = () => ({
    cls: 'profile',
    html: `
      ${topbar({ l: close('me', 'やめる'), c: 'プロフィール', r: '<button class="btn btn--quiet btn--small" type="button" data-act="profile-save" style="color:var(--ink)">保存</button>' })}
      <div class="screen__body pad" style="padding-top:12px;padding-bottom:28px">
        <div class="row" style="gap:18px">
          ${avatar(S.me.av, 'xl', 'あなたのアイコン')}
          <div class="stack" style="gap:6px">
            <button class="btn btn--secondary btn--small" type="button">${ic('image')}画像を選ぶ</button>
            <button class="btn btn--quiet btn--small" type="button" style="justify-content:flex-start;padding-left:4px">既定のアイコンに戻す</button>
          </div>
        </div>
        <p class="t-caption" style="margin-top:10px">PNG・JPEG・WebP、1MBまで。未設定のときは、この模様が表示されます。</p>
        <div class="stack" style="gap:28px;margin-top:30px">
          <div class="field">
            <div class="row" style="justify-content:space-between"><label class="field__label" for="p-name">表示名</label><span class="counter"><b>${[...S.me.name].length}</b> / 40</span></div>
            <input class="input" id="p-name" maxlength="40" value="${esc(S.me.name)}">
          </div>
          <div class="field">
            <div class="row" style="justify-content:space-between"><label class="field__label" for="p-bio">ひとこと<span style="font-weight:400;color:var(--ink-3);margin-left:6px">任意</span></label><span class="counter"><b>${[...S.me.bio].length}</b> / 200</span></div>
            <textarea class="input" id="p-bio" rows="4" maxlength="200" style="font-family:var(--f-mincho);font-weight:500;font-size:16px" placeholder="例: 夜に散歩しながら、写真を撮っています。">${esc(S.me.bio)}</textarea>
            <p class="field__help">つながった相手にだけ表示されます。年齢・性別・所在地を書く欄はありません。</p>
          </div>
        </div>
      </div>`,
  });

  screens.settings = ({ q }) => {
    const theme = S.theme;
    const blocked = q.section === 'blocked';
    if (blocked) {
      return {
        html: `
          ${topbar({ l: back('me'), c: 'ブロックしたユーザー' })}
          <div class="screen__body" style="padding-top:8px">
            <div class="list">
              <div class="list-row" style="cursor:default"><span class="avatar avatar--gone avatar--m" aria-hidden="true"></span><span class="stack"><span>ブロックしたユーザー</span><span class="list-row__sub">10月2日にブロック</span></span><button class="btn btn--secondary btn--small" type="button">解除</button></div>
            </div>
            <p class="t-caption pad" style="margin-top:16px">解除すると、また提案が届くことがあります。以前に提案された相手との提案は、解除後も届きません。</p>
          </div>`,
      };
    }
    return {
      cls: 'settings',
      html: `
        ${topbar({ l: back('me'), c: '通知と表示' })}
        <div class="screen__body" style="padding-bottom:28px">
          <h2 class="list__head t-label" style="padding-top:12px">通知</h2>
          <div class="pad">
            <div class="setting-row">
              <div><p class="t-head">プッシュ通知</p><p class="t-caption">提案と、つながったときだけ届きます。本文に内容は表示されません。</p></div>
              <div class="switch"><input type="checkbox" aria-label="プッシュ通知" ${S.push === 'granted' ? 'checked' : ''} data-act="toggle-push"><span></span></div>
            </div>
            ${S.push === 'denied' ? `<p class="note" style="margin-top:12px">${ic('bell-off')}<span>ブラウザの設定で通知がオフになっています。提案は、アプリ内のお知らせでお伝えします。</span></p>` : ''}
            <p class="t-caption" style="margin-top:14px">意思ごとのお知らせは、それぞれの意思の画面で切り替えられます。</p>
          </div>
          <h2 class="list__head t-label" style="margin-top:12px">表示</h2>
          <div class="pad">
            ${[['auto', '端末の設定に合わせる'], ['light', '昼(明るい紙)'], ['dark', '夜(暗い紙)']].map(([v, l]) => `<label class="radio-row"><input type="radio" name="theme" value="${v}" ${theme === v ? 'checked' : ''} data-act="pick-theme"><span>${l}</span></label>`).join('')}
          </div>
        </div>`,
    };
  };

  screens.report = ({ id }) => {
    const isProposal = id && id.startsWith('p');
    const targets = isProposal ? ['この提案'] : ['プロフィール(表示名・ひとこと)', 'アイコン', 'メッセージ'];
    return {
      cls: 'report',
      html: `
        ${topbar({ l: close(isProposal ? `proposal/${id}` : `chat/${id}`, 'やめる'), c: '通報する' })}
        <div class="screen__body pad" style="padding-top:8px;padding-bottom:24px">
          <p class="t-body">通報したことは、相手には通知されません。運営が内容を確かめ、5営業日以内に対応します。</p>
          <h2 class="t-label" style="margin-top:26px">対象</h2>
          <div style="margin-top:8px">${targets.map((t, i) => `<label class="radio-row"><input type="radio" name="target" ${i === 0 ? 'checked' : ''}><span>${t}</span></label>`).join('')}</div>
          <h2 class="t-label" style="margin-top:26px">理由</h2>
          <div style="margin-top:8px">${['スパム・勧誘', '嫌がらせ', '不適切な内容', 'その他'].map((t) => `<label class="radio-row"><input type="radio" name="why" data-act="report-pick"><span>${t}</span></label>`).join('')}</div>
          <div class="field" style="margin-top:26px">
            <label class="field__label" for="rp-more">くわしく<span style="font-weight:400;color:var(--ink-3);margin-left:6px">任意</span></label>
            <textarea class="input" id="rp-more" rows="3" maxlength="500"></textarea>
          </div>
        </div>
        <div class="screen__foot"><button class="btn btn--primary btn--block" type="button" data-act="report-send" data-id="${esc(id || '')}" disabled>通報する</button></div>`,
    };
  };

  screens.block = ({ id }) => {
    const c = connById(id) || S.connections[0];
    const base = screens.chat({ id: c.id, q: {} });
    const name = c.partners[0].name;
    return {
      cls: base.cls,
      html: base.html + sheet(`
          <h2 class="sheet__title">${esc(name)}さんを、ブロックしますか。</h2>
          <ul class="bullets">
            <li>${ic('check')}<span>このつながりのチャットは、読み取り専用になります。</span></li>
            <li>${ic('check')}<span>今後、この相手との提案は届きません。</span></li>
            <li>${ic('check')}<span>ブロックしたことは、相手に通知されません。</span></li>
          </ul>
          <div class="sheet__actions">
            <button class="btn btn--danger btn--block" type="button" data-act="block" data-id="${c.id}">ブロックする</button>
            <a class="btn btn--quiet btn--block" href="#/chat/${c.id}">やめる</a>
          </div>`, 'ブロックの確認'),
      mount: base.mount,
    };
  };

  screens.withdraw = () => ({
    cls: 'withdraw',
    html: `
      ${topbar({ l: back('me'), c: '退会' })}
      <div class="screen__body pad" style="padding-top:8px;padding-bottom:24px">
        <h1 class="t-display t-display--s">退会の前に。</h1>
        <p class="t-body" style="margin-top:12px">退会すると、次のものが削除されます。元には戻せません。</p>
        <ul class="bullets" style="margin-top:18px">
          <li>${ic('check')}<span>預けた意思と、その読み解き結果</span></li>
          <li>${ic('check')}<span>プロフィールとアイコン</span></li>
          <li>${ic('check')}<span>提案の履歴</span></li>
        </ul>
        <p class="note" style="margin-top:22px">${ic('info')}<span>つながりのメッセージは、相手の側に残ります。あなたの名前とアイコンは、相手の側にも表示されなくなります。</span></p>
        <p class="t-caption" style="margin-top:18px">退会の前に、もう一度ログインして本人であることを確かめます。</p>
      </div>
      <div class="screen__foot">
        <button class="btn btn--danger btn--block" type="button" data-act="withdraw">${ic('google', 'ic--fill')}Googleで確かめて退会する</button>
        <a class="btn btn--quiet" href="#/me">やめる</a>
      </div>`,
  });

  /* ---------- 6. 描画と遷移 ---------- */
  let cleanup = [];
  const parseHash = () => {
    const h = (location.hash || '').replace(/^#\/?/, '');
    const [path, qs] = h.split('?');
    const [name, id] = (path || '').split('/');
    return { name: name || '', id, q: Object.fromEntries(new URLSearchParams(qs || '')) };
  };
  const resolvedTheme = () => (S.theme === 'auto' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : S.theme);

  function render() {
    cleanup.forEach((f) => f()); cleanup = [];
    let { name, id, q } = parseHash();
    if (!name) name = S.onboarded ? 'home' : 'welcome';
    if (params.get('theme')) S.theme = params.get('theme');
    const def = screens[name] || screens.home;
    const out = def({ id, q });
    const theme = out.theme || resolvedTheme();
    const apply = () => {
      app.innerHTML = `<section class="screen ${out.cls || ''}" data-theme="${theme}" data-screen="${name}">${grain}${out.html}</section>`;
      const el = app.firstElementChild;
      document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0F1420' : '#EEF0F2');
      if (out.mount) out.mount(el);
      const focusT = el.querySelector('h1');
      if (focusT && !SHOT) { focusT.setAttribute('tabindex', '-1'); }
      syncDemo(name, id, q);
    };
    if (document.startViewTransition && animate && rendered) {
      document.startViewTransition(apply);
    } else apply();
    rendered = true;
    save();
  }
  let rendered = false;
  function go(route, { replace = false } = {}) {
    const h = `#/${route}`;
    if (replace) { history.replaceState(null, '', h); render(); } else if (location.hash === h) render(); else location.hash = h;
  }
  window.addEventListener('hashchange', render);

  function toast(msg) {
    const el = app.querySelector('.screen');
    if (!el) return;
    const t = document.createElement('p');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    t.textContent = msg;
    el.appendChild(t);
    setTimeout(() => t.classList.add('is-out'), 2600);
    setTimeout(() => t.remove(), 3100);
  }
  function osPush(body, onTap) {
    if (S.push !== 'granted') return;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'os-push';
    b.innerHTML = `<span class="os-push__icon">${mark()}</span><span><span class="os-push__top"><span class="os-push__app">LATCH</span><span>いま</span></span><span class="os-push__body">${esc(body)}</span></span>`;
    b.addEventListener('click', () => { b.remove(); onTap && onTap(); });
    osLayer.innerHTML = '';
    osLayer.appendChild(b);
    setTimeout(() => b.classList.add('is-out'), 4600);
    setTimeout(() => b.remove(), 5000);
  }

  /* ---------- 7. 操作 ---------- */
  const actions = {
    register() {
      const v = app.querySelector('#r-birth')?.value;
      const nm = app.querySelector('#r-name')?.value.trim();
      if (nm) S.me.name = nm;
      if (v) {
        const b = new Date(`${v}T00:00:00+09:00`); const n = new Date(now());
        let age = n.getFullYear() - b.getFullYear();
        if (n < new Date(n.getFullYear(), b.getMonth(), b.getDate())) age--;
        S.me.age = age;
        if (age < 18) return go('register?error=underage');
      }
      go('consent');
    },
    consent() { S.consent = true; S.onboarded = true; go('compose'); },
    'no-consent'() { S.consent = false; S.onboarded = true; go('home'); toast('意思を預けるには、外部送信への同意が必要です。'); },
    'save-draft'() {
      const text = (app.querySelector('#c-text')?.value ?? S.draft ?? '').trim();
      if (text) S.intents.unshift({ id: `i${Date.now()}`, form: 'connection', status: 'draft', text, savedAt: now() });
      S.draft = ''; go('home'); setTimeout(() => toast('下書きに残しました。'), 380);
    },
    parse() {
      if (!S.consent) { toast('意思を預けるには、外部送信への同意が必要です。'); return go('consent'); }
      if (S.net === 'offline') { toast('オフラインのため、いまは読み解けません。'); return; }
      const ta = app.querySelector('#c-text'); if (ta) S.draft = ta.value;
      go('reading');
    },
    'pick-form'(el) { const { q } = parseHash(); q.form = el.value; go(`confirm?${new URLSearchParams(q)}`, { replace: true }); },
    'pick-days'(el) { const { q } = parseHash(); q.days = el.value; go(`confirm?${new URLSearchParams(q)}`, { replace: true }); },
    'toggle-alcohol'(el) { S.parsed = Object.assign(parse(S.draft || SAMPLE), S.parsed || {}, { alcohol: el.checked }); const { q } = parseHash(); delete q.error; go(`confirm?${new URLSearchParams(q)}`, { replace: true }); },
    'drop-chip'(el) { el.remove(); },
    'edit-fact'() { toast('試作では、ここで条件を直せる想定です。'); },
    place() {
      const { q } = parseHash();
      if (S.intents.filter((i) => i.status === 'active').length >= 5) return go(`confirm?${new URLSearchParams(Object.assign(q, { error: 'limit' }))}`, { replace: true });
      const p = Object.assign({}, S.parsed || parse(S.draft || SAMPLE));
      const form = q.form || p.form;
      const days = Number(q.days) || p.days || 30;
      const id = `i${Date.now()}`;
      const it = form === 'occasion'
        ? { id, form, status: 'active', text: S.draft || SAMPLE, topic: p.topic, conds: p.conds || [], start: p.start || at(20), place: p.place, people: p.people || '2人', budget: p.budget, alcohol: !!p.alcohol, createdAt: now(), matches: 0, notify: true }
        : { id, form, status: 'active', text: S.draft || SAMPLE, topic: p.topic, conds: p.conds || [], region: p.region || null, size: 2, days, createdAt: now(), matches: 0, notify: true };
      it.expiresAt = form === 'occasion' ? it.start + 3 * HOUR : it.createdAt + days * DAY;
      S.intents.unshift(it);
      S.lastPlaced = id;
      if (S.kind === 'fresh' && S.intents.filter((i) => i.status !== 'draft').length === 1) S.surveyPending = true;
      S.draft = ''; S.parsed = null;
      go('placed');
    },
    'push-allow'() { S.push = 'granted'; toast('提案が届いたら、通知でお知らせします。'); app.querySelector('.push-ask')?.remove(); syncDemo(); save(); },
    'push-later'() { app.querySelector('.push-ask')?.remove(); },
    'toggle-push'(el) { S.push = el.checked ? 'granted' : 'default'; save(); syncDemo(); },
    'pick-theme'(el) { S.theme = el.value; render(); },
    'toggle-pause'(el) { const it = intentById(el.dataset.id); if (!it) return; it.status = it.status === 'paused' ? 'active' : 'paused'; render(); toast(it.status === 'paused' ? '一時停止しました。' : '再開しました。'); },
    'toggle-notify'(el) { const it = intentById(el.dataset.id); if (it) { it.notify = el.checked; save(); } },
    'cancel-intent'(el) { const it = intentById(el.dataset.id); if (!it) return; it.status = 'cancelled'; S.proposals.filter((p) => p.intentId === it.id && (p.status === 'proposed' || p.status === 'partial')).forEach((p) => { p.status = 'closed'; }); go('home'); setTimeout(() => toast('取り下げました。'), 380); },
    'delete-intent'(el) { S.intents = S.intents.filter((i) => i.id !== el.dataset.id); go('home'); },
    'replace-intent'(el) { const it = intentById(el.dataset.id); if (!it) return; S.draft = it.text; S.parsed = parse(it.text); go('confirm'); },
    'resume-draft'(el) { const it = intentById(el.dataset.id); if (it) { S.draft = it.text; S.intents = S.intents.filter((i) => i.id !== it.id); } go('compose'); },
    'edit-intent'() { toast('試作では、ここから内容を直せる想定です。'); },
    async join(el) {
      const p = proposalById(el.dataset.id); if (!p) return;
      const lt = app.querySelector('.proposal .latch');
      if (lt && animate) { lt.classList.remove('is-arrived'); lt.classList.add('is-pressed'); await wait(520); }
      p.status = 'partial';
      go(`proposal/${p.id}`, { replace: true });
      highlightSim('partner-yes');
    },
    retract(el) { const p = proposalById(el.dataset.id); if (!p) return; p.status = 'proposed'; go(`proposal/${p.id}`, { replace: true }); },
    async defer(el) {
      const p = proposalById(el.dataset.id); if (!p) return;
      const lt = app.querySelector('.proposal .latch, .proposal .group-wrap');
      if (lt && animate) { lt.classList.add('is-shelving'); await wait(760); }
      p.status = 'closed'; p.outcome = 'deferred';
      const first = !S.seenNote[p.form];
      S.seenNote[p.form] = true;
      go(`shelved/${p.id}?form=${p.form}${first ? '' : '&note=0'}`, { replace: true });
    },
    'reason-send'() { toast('ありがとうございます。相手には伝わりません。'); actions['sheet-close'](); },
    'sheet-close'() {
      const layer = app.querySelector('.sheet-layer'); const bd = app.querySelector('.backdrop');
      if (!layer) return;
      layer.classList.add('is-out'); bd && bd.classList.add('is-out');
      setTimeout(() => { const { name, id, q } = parseHash(); delete q.sheet; const qs = new URLSearchParams(q).toString(); const base = name === 'reason' ? `shelved/${id}` : name === 'block' ? `chat/${id}` : `${name}${id ? `/${id}` : ''}`; go(`${base}${qs ? `?${qs}` : ''}`, { replace: true }); }, 260);
    },
    leave(el) { const c = connById(el.dataset.id); if (!c) return; c.status = 'ended'; go(`chat/${c.id}`, { replace: true }); setTimeout(() => toast('参加を取り消しました。'), 380); },
    hide(el) { const c = connById(el.dataset.id); if (!c) return; c.hidden = true; go('connections'); setTimeout(() => toast('一覧から消しました。'), 380); },
    block(el) { const c = connById(el.dataset.id); if (!c) return; c.status = 'ended'; go(`chat/${c.id}`, { replace: true }); setTimeout(() => toast('ブロックしました。'), 380); },
    'report-pick'() { const b = app.querySelector('[data-act="report-send"]'); if (b) b.disabled = false; },
    'report-send'(el) { const id = el.dataset.id; go(id && id.startsWith('p') ? `proposal/${id}` : `chat/${id || 'c1'}`); setTimeout(() => toast('通報を受け付けました。'), 380); },
    'profile-save'() { const nm = app.querySelector('#p-name')?.value.trim(); const bio = app.querySelector('#p-bio')?.value.trim(); if (nm) S.me.name = nm; S.me.bio = bio || ''; go('me'); setTimeout(() => toast('保存しました。'), 380); },
    logout() { toast('試作では、ログアウトは行いません。'); },
    withdraw() { toast('試作では、退会は行いません。'); },
    'survey-pick'() { S.surveyPending = false; save(); setTimeout(() => { render(); toast('ありがとうございます。'); }, 280); },
    'survey-skip'() { S.surveyPending = false; render(); },
    'conn-survey'(el) { const c = connById(el.dataset.id); if (c) c.survey = 'done'; setTimeout(() => { render(); toast('ありがとうございます。'); }, 280); },
    'conn-survey-skip'(el) { const c = connById(el.dataset.id); if (c) c.survey = 'skipped'; render(); },
  };
  app.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || el.tagName === 'INPUT') return;
    const fn = actions[el.dataset.act];
    if (fn) { if (el.tagName === 'BUTTON' || el.classList.contains('backdrop')) e.preventDefault(); fn(el, e); }
  });
  app.addEventListener('change', (e) => {
    const el = e.target.closest('input[data-act]');
    if (el && actions[el.dataset.act]) actions[el.dataset.act](el, e);
  });
  app.addEventListener('submit', (e) => {
    const f = e.target.closest('form');
    if (!f) return;
    e.preventDefault();
    if (f.dataset.actSubmit === 'send') {
      const ta = f.querySelector('textarea'); const text = ta.value.trim(); if (!text) return;
      const c = connById(f.dataset.id); if (!c) return;
      if (S.net === 'offline') { toast('オフラインのため、送れませんでした。'); return; }
      c.messages.push({ by: 'me', text, at: now() });
      save(); render();
      scheduleReply(c);
    }
  });
  app.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.querySelector('.sheet-layer')) actions['sheet-close']();
  });

  const REPLIES = {
    c4: ['はじめまして、ひなたです。参加してくださってありがとうございます。', 'わたしも初心者なので、気軽に見せ合えたら嬉しいです。'],
    c1: ['いいですね、見てみたいです。わたしは窓辺の植物を描きました。'],
  };
  function scheduleReply(c) {
    const queue = REPLIES[c.id];
    if (!queue || !queue.length || c.status !== 'matched') return;
    const text = queue.shift();
    setTimeout(() => {
      c.messages.push({ by: 0, text, at: now() });
      save();
      const { name, id } = parseHash();
      if (name === 'chat' && id === c.id) render(); else { c.unread = (c.unread || 0) + 1; }
    }, 2600);
  }

  /* ---------- 8. 出来事を起こす(デモ) ---------- */
  function notify(type, ref) { S.notices.push({ id: `n${Date.now()}`, type, ref, at: now(), read: false }); }
  const sims = {
    'propose-connection'() {
      let it = S.intents.find((i) => i.form === 'connection' && i.status === 'active' && !S.proposals.some((p) => p.intentId === i.id && ['proposed', 'partial'].includes(p.status)));
      if (!it) { toast('つながりとして預けている意思がありません。'); return; }
      const id = `p${Date.now()}`;
      S.proposals.push({ id, intentId: it.id, form: 'connection', size: 2, notifiedAt: now(), status: 'proposed', partners: [{ name: 'ひなた', bio: '仕事帰りに、iPadで落書きしています。上手じゃなくても見せ合える人がいたら。', av: 'b' }] });
      notify('proposal', id);
      osPush('LATCH候補があります。詳細はアプリでご確認ください。', () => go(`proposal/${id}`));
      const { name } = parseHash(); if (name === 'home' || name === '' || name === 'notices') render(); else save();
      syncDemo();
    },
    'propose-group'() {
      const it = S.intents.find((i) => i.form === 'occasion' && i.status === 'active');
      if (!it) { toast('機会として預けている意思がありません。'); return; }
      if (!proposalById('p2')) {
        S.proposals.push({ id: 'p2', intentId: it.id, form: 'occasion', size: 4, notifiedAt: now(), status: 'proposed', partners: [{ name: 'ゆう', av: 'd', bio: '天文館の近くで働いています。仕事終わりにさくっと。' }, { name: 'ちひろ', av: 'e', bio: '' }, { name: 'かえで', av: 'c', bio: '' }] });
      } else { const p = proposalById('p2'); p.status = 'proposed'; p.notifiedAt = now(); }
      notify('proposal', 'p2');
      osPush('LATCH候補があります。詳細はアプリでご確認ください。', () => go('proposal/p2'));
      const { name } = parseHash(); if (name === 'home' || name === '' || name === 'notices') render(); else save();
      syncDemo();
    },
    'partner-yes'() {
      const p = S.proposals.find((x) => x.status === 'partial') || S.proposals.find((x) => x.status === 'proposed');
      if (!p) { toast('回答を待っている提案がありません。'); return; }
      if (p.status === 'proposed') { toast('先に「参加する」を選んでください(相手が先に参加しても、まだ成立しません)。'); return; }
      const it = intentById(p.intentId);
      const cid = `c${Date.now()}`;
      const c = p.form === 'occasion'
        ? { id: cid, form: 'occasion', status: 'matched', topic: it ? it.topic : '軽く飲みに行く', size: p.size, start: it ? it.start : at(20), place: it ? it.place : null, budget: it ? it.budget : null, matchedAt: now(), unread: 0, revealed: false, partners: p.partners, messages: [] }
        : { id: cid, form: 'connection', status: 'matched', topic: it ? it.topic : 'イラスト仲間', size: 2, region: it ? it.region : null, matchedAt: now(), unread: 0, revealed: false, partners: p.partners, messages: [] };
      REPLIES[cid] = p.form === 'occasion' ? ['こんばんは。20時に、電停の前でどうでしょう。'] : ['はじめまして、ひなたです。参加してくださってありがとうございます。', 'わたしも初心者なので、気軽に見せ合えたら嬉しいです。'];
      S.connections.unshift(c);
      p.status = 'matched'; p.connId = cid;
      if (it) { it.matches = (it.matches || 0) + 1; if (it.form === 'occasion') it.status = 'matched'; }
      notify('matched', cid);
      osPush('つながりが成立しました。詳細はアプリでご確認ください。', () => go(`matched/${cid}`));
      const { name, id } = parseHash();
      if ((name === 'proposal' || name === 'awaiting') && (id === p.id)) go(`matched/${cid}`, { replace: true }); else { save(); if (name === 'home') render(); }
      syncDemo();
    },
    'partner-defer'() {
      const p = S.proposals.find((x) => x.status === 'partial') || S.proposals.find((x) => x.status === 'proposed');
      if (!p) { toast('回答を待っている提案がありません。'); return; }
      p.status = 'closed'; p.outcome = 'other';
      notify('closed', p.id);
      const { name, id } = parseHash();
      if ((name === 'proposal' || name === 'awaiting') && id === p.id) go(`closed/${p.id}`, { replace: true }); else { save(); render(); }
      syncDemo();
    },
    'partner-leave'() {
      const c = S.connections.find((x) => x.status === 'matched' && x.partners.length === 1);
      if (!c) { toast('進行中のつながりがありません。'); return; }
      c.status = 'ended';
      const { name, id } = parseHash();
      if (name === 'chat' && id === c.id) render(); else { save(); render(); }
      toast('相手の操作で、つながりが終了しました(理由は表示されません)。');
    },
    'expire-intent'() {
      const it = S.intents.find((i) => i.status === 'active' && i.form === 'connection');
      if (!it) { toast('期限切れにできる意思がありません。'); return; }
      it.status = 'expired'; it.expiresAt = now();
      S.proposals.filter((p) => p.intentId === it.id && ['proposed', 'partial'].includes(p.status)).forEach((p) => { p.status = 'closed'; });
      notify('expired', it.id);
      save(); render();
    },
    reset() { try { localStorage.removeItem(KEY); } catch (e) { /* noop */ } S = seed('lived'); osLayer.innerHTML = ''; go('welcome'); syncDemo(); },
  };

  /* ---------- 9. デモ操作パネル ---------- */
  const NAV = [
    ['はじめる', [['welcome', 'ようこそ'], ['intro?step=1', '3つの流れ'], ['signin', 'ログイン'], ['register', '登録'], ['consent', '外部送信の同意']]],
    ['置く', [['compose', '預ける'], ['compose?state=typing', '入力中'], ['compose?state=full', '300字'], ['reading', '読み解き中'], ['confirm?form=connection', '確認・つながり'], ['confirm?sample=occasion', '確認・機会'], ['placed', '預けた']]],
    ['待つ', [['home', '預けている'], ['home?variant=empty', '空'], ['home?variant=quiet', '提案なし'], ['intent/i1', '意思の詳細'], ['intent/i2', '機会の詳細'], ['intent/i4', '下書き'], ['intent/i5', '期限切れ']]],
    ['届く', [['push', 'プッシュ通知'], ['proposal/p1', '提案・1対1'], ['proposal/p2', '提案・4人'], ['awaiting/p1', '相手の回答待ち'], ['shelved/p1?form=connection', '見送った'], ['shelved/p1?form=occasion', '見送った・機会'], ['reason/p1', '見送りの理由'], ['closed/p1', '成立しなかった']]],
    ['つながる', [['matched/c4', 'つながった'], ['chat/c1', 'チャット'], ['chat/c2', 'グループ(終了)'], ['chat/c3', '終了したつながり'], ['chat/c1?sheet=menu', 'チャットの操作'], ['connections', 'つながり一覧'], ['connections?variant=empty', 'つながり・空']]],
    ['自分', [['notices', 'お知らせ'], ['notices?variant=empty', 'お知らせ・空'], ['me', '自分'], ['profile', 'プロフィール'], ['settings', '通知と表示'], ['report/c1', '通報'], ['block/c1', 'ブロック'], ['withdraw', '退会']]],
    ['エラー', [['reading?state=failed', '読み解けない'], ['confirm?error=limit', '5つの上限'], ['confirm?sample=occasion&error=alcohol', 'お酒と年齢'], ['register?error=underage', '18歳未満'], ['home?variant=offline', 'オフライン'], ['home?variant=pushoff', '通知オフ'], ['chat/c1?state=failed', '送れない']]],
  ];
  const nav = document.getElementById('demo-nav');
  nav.innerHTML = NAV.map(([g, links]) => `<div class="demo__group"><p>${g}</p><div class="demo__links">${links.map(([r, l]) => `<a href="#/${r}" data-route="${r}">${l}</a>`).join('')}</div></div>`).join('');
  const demo = document.getElementById('demo');
  document.getElementById('demo-toggle').addEventListener('click', (e) => {
    const open = demo.classList.toggle('is-open');
    e.currentTarget.setAttribute('aria-expanded', String(open));
  });
  nav.addEventListener('click', (e) => { if (e.target.closest('a') && window.matchMedia('(max-width: 820px)').matches) demo.classList.remove('is-open'); });
  demo.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sim], button[data-env]');
    if (!b) return;
    if (b.dataset.sim) { sims[b.dataset.sim]?.(); b.classList.remove('is-hint'); }
    if (b.dataset.env) {
      const [k, v] = b.dataset.env.split(':');
      if (k === 'theme') S.theme = v;
      if (k === 'push') S.push = v;
      if (k === 'net') S.net = v;
      render();
    }
  });
  function highlightSim(name) {
    document.querySelectorAll('.demo [data-sim]').forEach((b) => b.classList.toggle('is-hint', b.dataset.sim === name));
  }
  function syncDemo(name, id, q) {
    const cur = (location.hash || '').replace(/^#\//, '');
    document.querySelectorAll('.demo__links a').forEach((a) => a.setAttribute('aria-current', String(a.dataset.route === cur)));
    document.querySelectorAll('.demo [data-env]').forEach((b) => {
      const [k, v] = b.dataset.env.split(':');
      b.classList.toggle('is-on', (k === 'theme' && S.theme === v) || (k === 'push' && S.push === v) || (k === 'net' && S.net === v));
    });
    const partial = S.proposals.some((p) => p.status === 'partial');
    if (!partial) document.querySelectorAll('.demo [data-sim="partner-yes"]').forEach((b) => b.classList.remove('is-hint'));
    else highlightSim('partner-yes');
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (S.theme === 'auto') render(); });

  render();
})();
