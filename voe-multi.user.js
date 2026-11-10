// ==UserScript==
// @name         VOE: мої адреси
// @namespace    voe-multi
// @version      1.0.1
// @description  Зведені графіки відключень для кількох адрес/рахунків + підсвітка змін з минулого перегляду
// @match        https://disconnection.voe.com.ua/*
// @updateURL    https://raw.githubusercontent.com/code-roman/voe_extended/main/voe-multi.user.js
// @downloadURL  https://raw.githubusercontent.com/code-roman/voe_extended/main/voe-multi.user.js
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORE_KEY = 'voeMulti.v1';
  const LEVEL_NAMES = {2: 'заплановано', 3: 'застосовано', 4: 'завершено'};
  const TYPE_NAMES = {account: 'рахунок', eic: 'EIC', address: 'адреса'};
  const WEEKDAYS = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  const form = document.getElementById('gpvForm');
  if (!form) return;

  // ---------- сховище ----------
  // store = {entries: [{id, name, type, value | city_id.., selected_eic}], snaps: {id: {curr, base, changedAt}}}
  // curr — останні завантажені дані; base — дані, з якими порівнюємо (є лише поки є непрочитані зміни).
  const store = (() => {
    const s = GM_getValue(STORE_KEY, null);
    return s && Array.isArray(s.entries) ? s : {entries: [], snaps: {}};
  })();
  const save = () => GM_setValue(STORE_KEY, store);

  // Стан поточного сеансу (не зберігається): id -> {loading, error, addresses}
  const runtime = {};

  // ---------- дрібні утиліти ----------
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    }
    return el;
  }
  const pad = n => String(n).padStart(2, '0');
  const hm = min => pad(Math.floor(min / 60)) + ':' + pad(min % 60);
  const ddmm = d => pad(d.getDate()) + '.' + pad(d.getMonth() + 1);
  function when(ts) {
    const d = new Date(ts);
    const t = pad(d.getHours()) + ':' + pad(d.getMinutes());
    return ddmm(d) === ddmm(new Date()) ? t : ddmm(d) + ' ' + t;
  }
  function dur(ms) {
    const m = Math.max(1, Math.ceil(ms / 60000));
    const hh = Math.floor(m / 60), mm = m % 60;
    return [hh && hh + ' год', mm && mm + ' хв'].filter(Boolean).join(' ');
  }
  // "03.11" + хвилини від початку доби -> timestamp (рік підбираємо найближчий до сьогодні; переходи на літній час враховує Date)
  function dayStart(date, min = 0) {
    const m = /^(\d{2})\.(\d{2})$/.exec(date);
    if (!m) return null;
    const now = new Date();
    const mon = +m[2] - 1;
    let y = now.getFullYear();
    if (mon - now.getMonth() > 6) y--;
    else if (now.getMonth() - mon > 6) y++;
    return new Date(y, mon, +m[1], 0, min).getTime();
  }
  const isPastDay = date => {
    const ds = dayStart(date);
    return ds != null && ds < new Date().setHours(0, 0, 0, 0);
  };

  // Злиття відрізків [start, end, level?]; сусідні зливаються, якщо рівень однаковий (або відсутній)
  function mergeRanges(list) {
    const out = [];
    for (const r of [...list].sort((a, b) => a[0] - b[0])) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] && r[2] === last[2]) last[1] = Math.max(last[1], r[1]);
      else out.push(r.slice());
    }
    return out;
  }
  function toMask(ranges) {
    const m = new Uint8Array(1440);
    ranges.forEach(([s, e]) => m.fill(1, s, Math.min(e, 1440)));
    return m;
  }
  // Відрізки хвилин, де m=1, а minus=0
  function maskRanges(m, minus) {
    const out = [];
    let s = -1;
    for (let i = 0; i <= 1440; i++) {
      const on = i < 1440 && m[i] && !minus[i];
      if (on && s < 0) s = i;
      else if (!on && s >= 0) { out.push([s, i]); s = -1; }
    }
    return out;
  }

  // ---------- API ----------
  async function fetchEntry(e) {
    const fd = new FormData();
    fd.set('csrf', form.querySelector('[name="csrf"]')?.value || '');
    fd.set('website', '');
    fd.set('selected_eic', e.selected_eic || '');
    fd.set('type', e.type);
    if (e.type === 'address') {
      fd.set('value', e.house_id);
      for (const k of ['city_id', 'city_label', 'street_id', 'street_label', 'house_id', 'house_label']) fd.set(k, e[k] || '');
    } else {
      fd.set('value', e.value);
    }
    const res = await fetch(location.origin + '/api/search.php', {
      method: 'POST',
      body: fd,
      credentials: 'same-origin',
      headers: {'X-Requested-With': 'XMLHttpRequest'},
    });
    if (!res.ok) throw Object.assign(new Error('HTTP ' + res.status), {status: res.status});
    const data = await res.json();
    if (!data.ok) {
      const m = data.message;
      throw new Error((m && typeof m === 'object' ? m.text || m.title : m) || 'Помилка');
    }
    return data;
  }

  // Відповідь API -> {at, tables: [{key, listnum, empty, message: {type, title, from, to}, days: [{date, label, ranges: [[startMin, endMin, level]]}]}]}
  function normalize(data) {
    return {
      at: Date.now(),
      tables: (data.tables || []).map((t, i) => ({
        key: t.listnum != null ? String(t.listnum) : '#' + i,
        listnum: t.listnum,
        empty: !!t.empty,
        // type: 3 — все гаразд, 1 — застосування ГПВ, 2 — аварійне. from/to («20:00 2026.11.03») поки лише зберігаємо.
        message: t.message && t.message.title
          ? {type: [1, 2].includes(Number(t.message.type)) ? Number(t.message.type) : 3, title: t.message.title, from: t.message.from || '', to: t.message.to || ''}
          : null,
        days: t.empty ? [] : (t.rows || []).map(row => ({
          date: (String(row.label).match(/\d{2}\.\d{2}/) || [String(row.label)])[0],
          label: String(row.label),
          ranges: mergeRanges((row.cells || []).flatMap((c, hr) => (c.segments || []).map(s => {
            const start = hr * 60 + Math.round(Number(s.start) * 0.6);
            return [start, start + Math.round(Number(s.size) * 0.6), Number(s.level)];
          }))),
        })),
      })),
    };
  }

  // ---------- зміни ----------
  // Порівнюємо лише покриття часу (рівень 2→3→4 — це не зміна графіка); минулі дні ігноруємо.
  // Дні, яких не було в попередніх даних, не вважаємо зміною: API зазвичай віддає лише сьогодні,
  // тож «новий день» з'являвся б щоранку. Новий день і так видно в таблиці.
  // Відрізки коротші за MIN_CHANGE_MIN хв — це шум даних (напр. 23:59–24:00), а не зміна графіка.
  const MIN_CHANGE_MIN = 5;
  function computeChanges(base, curr) {
    const significant = ranges => ranges.filter(([s, e]) => e - s >= MIN_CHANGE_MIN);
    const out = [];
    for (const t of curr.tables) {
      let bt = base.tables.find(x => x.key === t.key);
      if (!bt && base.tables.length === 1 && curr.tables.length === 1) {
        bt = base.tables[0];
        out.push({table: t.key, queue: [bt.key, t.key]});
      }
      if (!bt) continue;
      for (const d of t.days) {
        if (isPastDay(d.date)) continue;
        const bd = bt.days.find(x => x.date === d.date);
        if (!bd) continue;
        const a = toMask(bd.ranges), b = toMask(d.ranges);
        const added = significant(maskRanges(b, a)), removed = significant(maskRanges(a, b));
        if (added.length || removed.length) out.push({table: t.key, date: d.date, added, removed});
      }
    }
    return out;
  }

  function applySnapshot(e, snap) {
    const st = store.snaps[e.id] || (store.snaps[e.id] = {});
    if (st.base) {
      // Непрочитані зміни вже є — тримаємо стару базу, щоб зміни накопичувались
      if (!computeChanges(st.base, snap).length) {
        delete st.base;
        delete st.changedAt;
      } else if (computeChanges(st.curr, snap).length) {
        st.changedAt = snap.at;
      }
    } else if (st.curr && computeChanges(st.curr, snap).length) {
      st.base = st.curr;
      st.changedAt = snap.at;
    }
    st.curr = snap;
    save();
  }

  function acknowledge(e) {
    const st = store.snaps[e.id];
    if (!st) return;
    delete st.base;
    delete st.changedAt;
    save();
    render();
  }

  // ---------- аварійне відключення ----------
  // from/to приходять як «02:38 2026.11.04». Період накладається поверх графіка і не входить у порівняння змін.
  function parseVoeTime(str) {
    const m = /^(\d{2}):(\d{2}) (\d{4})\.(\d{2})\.(\d{2})$/.exec(String(str || '').trim());
    return m ? new Date(+m[3], +m[4] - 1, +m[5], +m[1], +m[2]).getTime() : null;
  }
  function emergencyPeriod(table) {
    const m = table.message;
    if (!m || m.type !== 2) return null;
    const from = parseVoeTime(m.from), to = parseVoeTime(m.to);
    return from != null && to != null && to > from ? {from, to, title: m.title} : null;
  }
  // Частина періоду в межах доби: [startMin, endMin] або null
  function emergencyOnDay(em, date) {
    const ds = dayStart(date), de = dayStart(date, 1440);
    if (!em || ds == null || em.to <= ds || em.from >= de) return null;
    const minOf = ts => { const d = new Date(ts); return d.getHours() * 60 + d.getMinutes(); };
    return [em.from <= ds ? 0 : minOf(em.from), em.to >= de ? 1440 : minOf(em.to)];
  }
  // Дні графіка + дні, на які припадає аварійне, але яких немає у відповіді API
  function daysWithEmergency(days, em) {
    if (!em) return days;
    const out = [...days];
    const d = new Date(em.from);
    d.setHours(0, 0, 0, 0);
    for (let i = 0; i < 7 && d.getTime() < em.to; i++, d.setDate(d.getDate() + 1)) {
      if (!out.some(x => x.date === ddmm(d))) {
        out.push({date: ddmm(d), label: WEEKDAYS[d.getDay()] + ' ' + ddmm(d), ranges: []});
      }
    }
    return out.sort((a, b) => dayStart(a.date) - dayStart(b.date));
  }

  // ---------- статус «до зміни стану» ----------
  function status(table) {
    const now = Date.now();
    const em = emergencyPeriod(table);
    let knownEnd = 0;
    const iv = mergeRanges(table.days.flatMap(d => {
      if (dayStart(d.date) == null) return [];
      knownEnd = Math.max(knownEnd, dayStart(d.date, 1440));
      return d.ranges.map(r => [dayStart(d.date, r[0]), dayStart(d.date, r[1])]);
    }).concat(em ? [[em.from, em.to]] : []));
    const cur = iv.find(([s, e]) => s <= now && now < e);
    if (cur) {
      // Відключення триває до кінця відомого графіка — точний час невідомий
      const more = cur[1] === knownEnd ? 'не раніше ніж ' : '';
      return {off: true, text: 'увімкнуть ' + more + 'через ' + dur(cur[1] - now)};
    }
    const next = iv.find(([s]) => s > now);
    if (next) return {off: false, text: 'вимкнуть через ' + dur(next[0] - now)};
    return null;
  }

  // ---------- додавання / керування ----------
  function captureCurrent() {
    const get = id => (document.getElementById(id)?.value || '').trim();
    const type = form.querySelector('input[name="type"]:checked')?.value || 'address';
    const e = {id: Date.now().toString(36), type, selected_eic: get('selectedEic')};
    if (type === 'address') {
      Object.assign(e, {
        city_id: get('cityId'), city_label: get('cityInput'),
        street_id: get('streetId'), street_label: get('streetInput'),
        house_id: get('houseId'), house_label: get('houseInput'),
      });
      if (!e.house_id) return null;
    } else {
      e.value = get('gpvValue');
      if (!e.value) return null;
    }
    return e;
  }
  const entryKey = e => e.type + ':' + (e.type === 'address' ? e.house_id : e.value) + ':' + (e.selected_eic || '');
  function describe(e) {
    if (e.type === 'address') return [e.city_label, e.street_label, e.house_label].filter(Boolean).join(', ');
    return TYPE_NAMES[e.type] + ' ' + e.value;
  }

  function addCurrent(nameInput, msg) {
    const e = captureCurrent();
    if (!e) {
      msg.textContent = 'Спершу заповни пошук на сайті: рахунок, EIC або адресу аж до будинку.';
      return;
    }
    if (store.entries.some(x => entryKey(x) === entryKey(e))) {
      msg.textContent = 'Цей пошук уже є у списку.';
      return;
    }
    e.name = nameInput.value.trim() || (e.type === 'address' ? e.street_label + ', ' + e.house_label : e.value);
    store.entries.push(e);
    save();
    nameInput.value = '';
    msg.textContent = 'Додано «' + e.name + '».';
    refreshOne(e);
  }

  function removeEntry(e) {
    store.entries = store.entries.filter(x => x !== e);
    delete store.snaps[e.id];
    delete runtime[e.id];
    save();
    render();
  }

  function moveUp(e) {
    const i = store.entries.indexOf(e);
    if (i > 0) {
      store.entries.splice(i, 1);
      store.entries.splice(i - 1, 0, e);
      save();
      render();
    }
  }

  const requestSeq = {};
  async function refreshOne(e) {
    const seq = requestSeq[e.id] = (requestSeq[e.id] || 0) + 1;
    runtime[e.id] = {...runtime[e.id], loading: true, error: null};
    render();
    let next;
    try {
      const data = await fetchEntry(e);
      // Відповідь застаріла (був новіший запит) або запис уже видалили
      if (seq !== requestSeq[e.id] || !store.entries.includes(e)) return;
      sessionExpired = false;
      next = {addresses: data.addresses && Object.keys(data.addresses).length > 1 ? data.addresses : null};
      applySnapshot(e, normalize(data));
    } catch (err) {
      if (seq !== requestSeq[e.id] || !store.entries.includes(e)) return;
      if (err.status === 403) {
        // Про це повідомляє окрема плашка над списком; збережені дані картки лишаємо як є
        sessionExpired = true;
        next = {addresses: runtime[e.id]?.addresses};
      } else {
        next = {error: err.message || String(err)};
      }
    }
    runtime[e.id] = next;
    render();
  }

  let refreshing = false;
  async function refreshAll() {
    if (refreshing) return;
    refreshing = true;
    sessionExpired = false;
    try {
      // По черзі, щоб не смикати сервер паралельно
      for (const e of [...store.entries]) {
        if (store.entries.includes(e)) await refreshOne(e);
        if (sessionExpired) break; // решта запитів теж отримає 403
      }
    } finally {
      refreshing = false;
      render();
    }
  }

  // ---------- застаріла сесія ----------
  // Коли сторінка довго відкрита, сайт починає відповідати 403, і допомагає лише перезавантаження.
  let sessionExpired = false;
  const RELOAD_KEY = 'voeMulti.reloadAt';
  function reloadPage() {
    try { sessionStorage.setItem(RELOAD_KEY, String(Date.now())); } catch (_) { /* без сховища просто перезавантажуємо */ }
    location.reload();
  }
  // Захист від циклу: якщо щойно перезавантажували, а 403 лишився, автоматично більше не перезавантажуємо
  function reloadedRecently() {
    try { return Date.now() - Number(sessionStorage.getItem(RELOAD_KEY) || 0) < 60000; } catch (_) { return true; }
  }
  async function onRefreshClick() {
    if (sessionExpired && !reloadedRecently()) return reloadPage();
    await refreshAll();
    if (sessionExpired && !reloadedRecently()) reloadPage();
  }

  // ---------- відмальовка ----------
  function renderTable(t, changes) {
    const em = emergencyPeriod(t);
    if (t.empty && !em) return h('div', {class: 'vm-desc'}, 'За цим запитом нічого не знайдено');
    const ch = changes.filter(c => c.table === t.key);
    const days = daysWithEmergency(t.days, em).filter(d => !isPastDay(d.date) &&
      (d.ranges.length || emergencyOnDay(em, d.date) || ch.some(c => c.date === d.date && c.removed?.length)));
    if (!days.length) return h('div', {class: 'vm-none'}, 'Відключень не заплановано');

    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    const todayKey = ddmm(now);
    const grid = h('div', {class: 'vm-grid'},
      h('div', {class: 'vm-hd'}),
      Array.from({length: 24}, (_, i) => h('div', {class: 'vm-hd'}, pad(i))));

    for (const d of days) {
      const c = ch.find(x => x.date === d.date) || {};
      const isToday = d.date === todayKey;
      const emDay = emergencyOnDay(em, d.date);
      grid.append(h('div', {class: 'vm-day' + (isToday ? ' today' : '')}, d.label));
      for (let hr = 0; hr < 24; hr++) {
        const h0 = hr * 60;
        const cell = h('div', {class: 'vm-cell' + (isToday && hr < Math.floor(nowMin / 60) ? ' past' : '')});
        const put = (s, e, cls, title) => {
          const a = Math.max(s, h0), b = Math.min(e, h0 + 60);
          if (b > a) cell.append(h('i', {class: cls, title, style: `left:${(a - h0) / 60 * 100}%;width:${(b - a) / 60 * 100}%`}));
        };
        d.ranges.forEach(([s, e, l]) => put(s, e, 'vm-off l' + l, `${hm(s)}–${hm(e)} ${LEVEL_NAMES[l] || ''}`));
        (c.added || []).forEach(([s, e]) => put(s, e, 'vm-added', `нове: ${hm(s)}–${hm(e)}`));
        (c.removed || []).forEach(([s, e]) => put(s, e, 'vm-removed', `скасовано: ${hm(s)}–${hm(e)}`));
        if (emDay) put(emDay[0], emDay[1], 'vm-emergency', `${em.title}: ${t.message.from} — ${t.message.to}`);
        if (isToday && Math.floor(nowMin / 60) === hr) cell.append(h('b', {class: 'vm-now', style: `left:${(nowMin % 60) / 60 * 100}%`}));
        grid.append(cell);
      }
    }
    return grid;
  }

  function renderChanges(e, st, changes, multiTable) {
    const fmt = rs => rs.map(([s, x]) => hm(s) + '–' + hm(x)).join(', ');
    return h('div', {class: 'vm-changes'},
      h('div', {class: 'vm-changes-head'},
        h('strong', null, 'Графік змінився'),
        h('span', {class: 'vm-desc'}, ` (помічено ${when(st.changedAt)}, порівняно з даними від ${when(st.base.at)})`),
        h('button', {class: 'vm-btn small', onclick: () => acknowledge(e)}, 'Бачу')),
      h('ul', null, changes.map(c => h('li', null,
        c.queue ? 'черга змінилась: ' + c.queue[0] + ' → ' + c.queue[1] : [
          h('b', null, (multiTable ? 'черга ' + c.table + ', ' : '') + c.date + ': '),
          c.added.length ? h('span', {class: 'vm-txt-add'}, 'нові відключення ' + fmt(c.added)) : null,
          c.added.length && c.removed.length ? '; ' : null,
          c.removed.length ? h('span', {class: 'vm-txt-rem'}, 'скасовано ' + fmt(c.removed)) : null,
        ]))));
  }

  function renderEntry(e) {
    const st = store.snaps[e.id] || {};
    const rt = runtime[e.id] || {};
    const snap = st.curr;
    const changes = st.base && snap ? computeChanges(st.base, snap) : [];
    const multiTable = snap && snap.tables.length > 1;

    const queues = snap ? snap.tables.filter(t => !t.empty && t.listnum != null).map(t => t.listnum) : [];
    const head = h('div', {class: 'vm-head'},
      h('span', {class: 'vm-name'}, e.name),
      queues.length ? h('span', {class: 'vm-queue'}, 'черга ' + queues.join(', ')) : null,
      h('span', {class: 'vm-desc'}, describe(e)),
      h('span', {class: 'vm-tools'},
        rt.loading ? h('span', {class: 'vm-desc'}, 'оновлення…') : null,
        snap && !rt.loading ? h('span', {class: 'vm-desc', title: 'Час останнього завантаження'}, when(snap.at)) : null,
        h('button', {class: 'vm-btn small', title: 'Вище', onclick: () => moveUp(e)}, '↑'),
        h('button', {class: 'vm-btn small', title: 'Видалити', onclick: () => removeEntry(e)}, '×')));

    const card = h('div', {class: 'vm-card'}, head);
    // Другий рядок: статус від VOE (зелений / жовтий ГПВ / червоний аварійне) + відлік до зміни стану
    if (snap) {
      snap.tables.forEach(t => {
        const s = status(t);
        const m = t.message;
        if (!m && !s) return;
        card.append(h('div', {class: 'vm-status'},
          multiTable ? h('span', {class: 'vm-desc'}, t.key + ':') : null,
          m ? h('span', {class: 'vm-chip m' + m.type}, m.title) : null,
          s ? h('span', {class: 'vm-chip ' + (s.off ? 'm3' : 'm1')}, s.text) : null));
      });
    }
    if (rt.error) card.append(h('div', {class: 'vm-err'}, 'Помилка: ' + rt.error));
    if (rt.addresses) {
      // Інша адреса — інший графік, тож старі дані для порівняння скидаємо
      const sel = h('select', {onchange: () => { e.selected_eic = sel.value; delete store.snaps[e.id]; save(); refreshOne(e); }},
        h('option', {value: ''}, '— вибери адресу —'),
        Object.entries(rt.addresses).map(([eic, label]) =>
          h('option', {value: eic, selected: eic === e.selected_eic ? '' : null}, label)));
      card.append(h('div', {class: 'vm-desc'}, 'За цим пошуком кілька адрес: ', sel));
    }
    if (changes.length) card.append(renderChanges(e, st, changes, multiTable));
    if (snap) {
      snap.tables.forEach(t => {
        if (multiTable) card.append(h('div', {class: 'vm-sub'}, 'Черга ' + t.key));
        card.append(renderTable(t, changes));
      });
      if (!snap.tables.length) card.append(h('div', {class: 'vm-none'}, 'Інформацію не знайдено'));
    } else if (!rt.error) {
      card.append(h('div', {class: 'vm-desc'}, 'Завантаження…'));
    }
    return card;
  }

  // ---------- каркас панелі ----------
  const list = h('div');
  const nameInput = h('input', {type: 'text', placeholder: 'Назва, напр. «Дім»', maxlength: '40'});
  const addMsg = h('span', {class: 'vm-desc'});
  nameInput.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.preventDefault(); addCurrent(nameInput, addMsg); } });
  const notice = h('div', {class: 'vm-alert', hidden: true},
    h('span', null, h('strong', null, 'Сайт перестав відповідати.'), ' Перезавантажте сторінку, щоб побачити свіжі графіки.'),
    h('button', {class: 'vm-btn primary', onclick: reloadPage}, 'Перезавантажити сторінку'));

  const panel = h('section', {id: 'vm-panel'},
    h('div', {class: 'vm-top'},
      h('h2', null, 'Мої адреси'),
      h('button', {class: 'vm-btn', onclick: onRefreshClick}, 'Оновити')),
    notice,
    list,
    h('div', {class: 'vm-legend'},
      h('span', null, h('i', {class: 'vm-off l2'}), 'заплановано'),
      h('span', null, h('i', {class: 'vm-off l3'}), 'застосовано'),
      h('span', null, h('i', {class: 'vm-off l4'}), 'завершено'),
      h('span', null, h('i', {class: 'vm-off l2 vm-added-demo'}), 'нове з минулого разу'),
      h('span', null, h('i', {class: 'vm-removed'}), 'скасовано'),
      h('span', null, h('i', {class: 'vm-emergency'}), 'аварійне')),
    h('div', {class: 'vm-add'},
      nameInput,
      h('button', {class: 'vm-btn primary', onclick: () => addCurrent(nameInput, addMsg)}, 'Додати поточний пошук'),
      addMsg));

  function render() {
    notice.hidden = !sessionExpired;
    list.replaceChildren(...(store.entries.length
      ? store.entries.map(renderEntry)
      : [h('div', {class: 'vm-desc vm-empty'}, 'Список порожній. Знайди рахунок, EIC або адресу у формі нижче, дай назву і натисни «Додати поточний пошук».')]));
  }

  const style = h('style', null, `
#vm-panel{background:#fff;border-radius:16px;padding:16px 18px;margin:0 0 16px;box-shadow:0 1px 4px rgba(16,24,40,.08);color:#1d2939;font-size:14px;line-height:1.4}
#vm-panel *{box-sizing:border-box}
.vm-top{display:flex;align-items:center;gap:8px;margin-bottom:10px}
.vm-top h2{margin:0;font-size:20px;flex:1}
.vm-btn{border:1px solid #d0d5dd;background:#fff;border-radius:8px;padding:5px 12px;cursor:pointer;font:inherit;color:inherit}
.vm-btn:hover{background:#f9fafb}
.vm-btn.small{padding:1px 8px;font-size:13px}
.vm-btn.primary{background:#f5b80b;border-color:#f5b80b;font-weight:600}
.vm-card{border:1px solid #eaecf0;border-radius:12px;padding:10px 12px;margin-bottom:10px}
.vm-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px 12px}
.vm-name{font-weight:700;font-size:17px}
.vm-queue{font-weight:600;font-size:14px;color:#475467}
.vm-status{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:6px}
.vm-desc{color:#667085;font-size:12px}
.vm-empty{padding:8px 0 12px}
.vm-sub{font-weight:600;font-size:13px;margin-top:8px}
.vm-chip{padding:2px 10px;border-radius:999px;font-weight:600;font-size:13px;border:1px solid transparent}
.vm-chip.m3{background:#ecfdf3;color:#067647;border-color:#abefc6}
.vm-chip.m1{background:#fffaeb;color:#93370d;border-color:#fedf89}
.vm-chip.m2{background:#fef3f2;color:#b42318;border-color:#fecdca}
.vm-tools{margin-left:auto;display:flex;align-items:center;gap:6px}
.vm-grid{display:grid;grid-template-columns:62px repeat(24,minmax(0,1fr));gap:2px;margin-top:8px;font-size:11px}
.vm-hd{text-align:center;color:#667085}
.vm-day{font-weight:600;white-space:nowrap;align-self:center;font-size:12px}
.vm-day.today{color:#175cd3}
.vm-cell{position:relative;height:22px;background:#f2f4f7;border-radius:3px;overflow:hidden}
.vm-cell.past{opacity:.5}
.vm-cell i{position:absolute;top:0;bottom:0}
.vm-off{background:#d92d20}
.vm-off.l2{background:#f79009}.vm-off.l3{background:#d92d20}.vm-off.l4{background:#98a2b3}
.vm-cell i.vm-added{box-shadow:inset 0 0 0 2px #7a0916}
.vm-removed{background:repeating-linear-gradient(45deg,#12b76a 0 3px,transparent 3px 6px)}
/* Прозорі смуги лишають видимим звичайний графік; multiply затемнює колір під лінією, тож її видно і на червоному */
.vm-emergency{background:repeating-linear-gradient(-45deg,#e5484d 0 1px,transparent 1px 4px);mix-blend-mode:multiply}
.vm-now{position:absolute;top:-2px;bottom:-2px;width:2px;margin-left:-1px;background:#101828;box-shadow:0 0 0 1px #fff}
.vm-changes{background:#fffaeb;border:1px solid #fedf89;border-radius:8px;padding:6px 10px;margin-top:8px;font-size:13px}
.vm-changes-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.vm-changes-head .vm-btn{margin-left:auto}
.vm-changes ul{margin:4px 0 0;padding-left:18px}
.vm-txt-add{color:#b42318}.vm-txt-rem{color:#067647}
.vm-none{color:#067647;margin-top:6px}
.vm-err{color:#b42318;font-size:13px;margin-top:4px}
.vm-alert{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;background:#fef3f2;border:1px solid #fecdca;color:#b42318;border-radius:12px;padding:10px 14px;margin-bottom:10px;font-size:15px}
.vm-alert[hidden]{display:none}
.vm-alert .vm-btn{margin-left:auto}
.vm-legend{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:12px;color:#667085;margin:4px 0 12px}
.vm-legend span{display:inline-flex;align-items:center;gap:5px}
.vm-legend i{display:inline-block;width:14px;height:12px;border-radius:2px}
.vm-legend i.vm-added-demo{box-shadow:inset 0 0 0 2px #7a0916}
.vm-add{display:flex;flex-wrap:wrap;gap:8px;align-items:center;border-top:1px dashed #d0d5dd;padding-top:12px}
#vm-panel .vm-add input{border:1px solid #d0d5dd;border-radius:8px;padding:5px 10px;font:inherit;width:auto;height:auto;flex:0 1 260px;min-width:160px;margin:0}
.vm-card select{font:inherit;margin-left:4px}
`);

  document.head.append(style);
  const card = form.closest('.voe-form-card') || form;
  card.parentElement.insertBefore(panel, card);

  render();       // спершу показуємо збережене
  refreshAll();   // потім підтягуємо свіже
  // Відлік «через N хв» і лінія «зараз»; не чіпаємо DOM, поки користувач у випадаючому списку
  setInterval(() => { if (!list.contains(document.activeElement)) render(); }, 30000);
  // Якщо вкладку таки лишили відкритою — раз на 30 хв перечитуємо дані
  setInterval(() => { if (!document.hidden) refreshAll(); }, 30 * 60000);
})();
