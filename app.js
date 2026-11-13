/* Rewind v0.4: bar-by-bar futures replay that works like a prop-firm trading station.
   - 1 to 8 synced charts (any timeframe each), canvas drawing layer (trend, ray, h-line, h-ray, v-line, zone, fib, long/short position, measure, text)
   - Long/Short position tool can be ARMED: it places the entry order with its own stop + target and fills automatically (FX Replay style)
   - Floating Scalp Pad (drag it anywhere, right-click for settings), DOM ladder with My Bid/My Ask, Order mode with draft order lines
   - Right-click menus on the chart, order lines, positions and drawings; drag stop / target / orders; PDLL / PDPT / lockouts; configurable hot keys
   Data: monthly gz CSVs (t,o,h,l,c UTC seconds) from the private 'bars' bucket; 1m always, 15s for NY mornings when a pane needs it.
   ?demo runs on made-up prices with nothing saved. */
"use strict";
const DEMO = new URLSearchParams(location.search).has("demo");
const sb = supabase.createClient(REWIND.url, REWIND.key);
const $ = (id) => document.getElementById(id);
const INST = { NQ: { data: "NQ", pt: 20, micro: false }, MNQ: { data: "NQ", pt: 2, micro: true }, ES: { data: "ES", pt: 50, micro: false }, MES: { data: "ES", pt: 5, micro: true } };
const TFS = [["15s", 15], ["30s", 30], ["1m", 60], ["2m", 120], ["3m", 180], ["5m", 300], ["15m", 900], ["30m", 1800], ["1h", 3600], ["4h", 14400], ["1D", 86400]];
const SEC = Object.fromEntries(TFS);
const TICK = 0.25;
const LAYOUTS = { "1": [1, 1], "2": [2, 1], "2h": [1, 2], "3": [3, 1], "4": [2, 2], "6": [3, 2], "8": [4, 2] };
const DEF_TFS = ["5m", "1m", "15m", "1h", "4h", "30m", "1D", "15s"];
const IND_DEF = { sbox: true, data: true, sess: false, pd: true, pw: false, eq: false, fvg: false, fvgTf: "1h", fvgTfs: ["1h"], ifvg: true, ob: false, h4: false, po3: false, htfc: ["4h", "1D"] };
const DEF_KEYS = { buy: "b", sell: "s", joinbid: "j", joinask: "a", reverse: "r", flatten: "f", cancel: "c", close: "x", be: "e", trend: "t", hline: "h", vline: "v", rect: "z", long: "l", short: "k", measure: "m" };
let user = null, isAdmin = false, features = {}, notionAuto = false;
let prefs = { bal: 50000, dll: 1000, ptg: 0, act: "block", mdd: 2000, fee: 4.5, mfee: 1.5, opens: true, sess: true, up: "#2bd4a0", dn: "#ff6b7a", sym: "NQ", layout: "1", tfs: DEF_TFS.slice(),
  lots: 1, lotset: [1, 2, 3, 5, 10], slPts: 15, tpPts: 45, autoBr: true, byRisk: false, riskp: 1, trail: 0, keys: { ...DEF_KEYS }, pad: { show: true, x: null, y: null }, magnet: false, dockClosed: true, side: false, ind: { ...IND_DEF }, dockH: 150, favs: ["trend", "hline", "rect", "long", "short"], favShow: true, favPos: null, toolsPos: null };

// KING_CS2 settings defaults (see the Chart settings block near the end)
const CS_DEF = { prevClr: false, body: true, bord: false, bu: "#2bd4a0", bd: "#ff6b7a", wick: true, wu: "", wd: "", prec: "def", title: true, titleK: "full", mstat: true, vals: true, chg: false, lbg: false, lbga: 40,
  cd: false, last: "vl", pdc: "h", pdcc: "#9aa4b2", hl: "h", hlc: "#c4b5fd", ba: "h", bidc: "#3b82f6", askc: "#ff6b7a", dow: false, df: "tv", hf: "24", keepC: true,
  bgk: "none", bg1: "#0b0e14", bg2: "#151a24", gridc: "#ffffff", brk: false, brkc: "#7f8a9c", xc: "#ffffff", xs: "2", wm: true, txc: "#7f8a9c", txs: "11", lnc: "#1c212b", mt: 10, mb: 10, mr: 12,
  oneClick: true, pos: true, rev: true, pnl: true, pnlp: "money", pnlb: "money", exm: true, exl: false, ext: true };
let csTmp = null, csSnap = null; const execs = [], profs = {};
const csG = () => Object.assign({}, CS_DEF, (prefs && prefs.cs) || {}, csTmp || {});
/* ---------------- time (shown in New York time) ---------------- */
const offCache = new Map();
function nyOffset(t) {
  const h = Math.floor(t / 3600); if (offCache.has(h)) return offCache.get(h);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  const o = Math.round((Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) / 1000 - t) / 60) * 60; offCache.set(h, o); return o;
}
const loc = (t) => t + nyOffset(t);
const fmt = (lt) => new Date(lt * 1000).toISOString().slice(0, 16).replace("T", " ");
// KING_PERF (Nov 12): lhm + sessDay were ~25% of replay CPU (a Date + toISOString per call); same output, plain math + a per-day cache
const _p2 = (n) => (n < 10 ? "0" : "") + n;
const lhm = (lt) => { const s = ((Math.floor(lt) % 86400) + 86400) % 86400; return _p2((s / 3600) | 0) + ":" + _p2(((s % 3600) / 60) | 0); };
const _sdC = new Map();
const sessDay = (t) => { const d = Math.floor((loc(t) + 6 * 3600) / 86400); let v = _sdC.get(d); if (v === undefined) { v = new Date(d * 86400000).toISOString().slice(0, 10); if (_sdC.size > 5000) _sdC.clear(); _sdC.set(d, v); } return v; };
function nyToUtc(s) { const g = Date.parse(s + ":00Z") / 1000; return g - nyOffset(g - nyOffset(g)); }
function hoverDate(t) { const d = new Date(t * 1000), n = d.getUTCDate(), sfx = n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th";   // fix 12: "Mon, Jan 1st 2025 09:30"
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + ", " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()] + " " + n + sfx + " " + d.getUTCFullYear() + "  " + String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0") + (d.getUTCSeconds() ? ":" + String(d.getUTCSeconds()).padStart(2, "0") : ""); }
function bucket(lt, sec) { if (sec >= 14400) { const b = 18 * 3600; return Math.floor((lt - b) / sec) * sec + b; } return Math.floor(lt / sec) * sec; }
const money = (x) => (x < 0 ? "-$" : "$") + Math.abs(x).toLocaleString(undefined, { maximumFractionDigits: 0 });
const px2 = (p) => (p == null ? "—" : (+p).toFixed(2));
const rnd = (p) => Math.round(p / TICK) * TICK;
function endOfTradingDay(t) { const lt = loc(t), d0 = Math.floor((lt + 6 * 3600) / 86400) * 86400 - 6 * 3600 + 23 * 3600; return d0 - nyOffset(t); }

/* ---------------- data ---------------- */
const monthCache = new Map();
async function loadMonth(sym, tf, ym) {
  const key = sym + "/" + tf + "/" + ym; if (monthCache.has(key)) return monthCache.get(key);
  const p = DEMO ? Promise.resolve(demoMonth(sym, tf, ym)) : (async () => {
    const { data, error } = await sb.storage.from("bars").download(key + ".csv.gz"); if (error || !data) return [];
    const txt = await new Response(data.stream().pipeThrough(new DecompressionStream("gzip"))).text(); const out = []; const L = txt.split("\n");
    for (let i = 1; i < L.length; i++) { const c = L[i].split(","); if (c.length >= 5) out.push({ t: +c[0], o: +c[1], h: +c[2], l: +c[3], c: +c[4] }); }
    return out;
  })();
  monthCache.set(key, p); return p;
}
function demoMonth(sym, tf, ym) {
  if (tf === "15s") { const out = []; for (const b of demoMonth(sym, "1m", ym)) { const h = new Date(loc(b.t) * 1000).getUTCHours(), mi = new Date(loc(b.t) * 1000).getUTCMinutes(); if (!((h === 9 && mi >= 20) || h === 10 || h === 11)) continue;
      const pts = [b.o, b.o + (b.h - b.o) * 0.6, b.l + (b.c - b.l) * 0.4, b.c]; for (let k = 0; k < 4; k++) { const o = k ? pts[k - 1] : b.o, c = pts[k]; out.push({ t: b.t + 15 * k, o: rnd(o), h: rnd(Math.max(o, c, k === 1 ? b.h : -1e9)), l: rnd(Math.min(o, c, k === 2 ? b.l : 1e9)), c: rnd(c) }); } } return out; }
  const [y, m] = ym.split("-").map(Number); const t0 = Date.UTC(y, m - 1, 1) / 1000, t1 = Date.UTC(y, m, 1) / 1000, step = tf === "15s" ? 15 : 60;
  let seed = y * 100 + m + (tf === "15s" ? 7 : 0), p = sym === "NQ" ? 21000 + (m * 137) % 900 : 5900 + (m * 31) % 200; const rr = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = []; let drift = 0;
  for (let t = t0; t < t1; t += step) {
    const lt = loc(t), d = new Date(lt * 1000), dow = d.getUTCDay(), hr = d.getUTCHours();
    if (dow === 6 || (dow === 0 && hr < 18) || (dow === 5 && hr >= 17) || hr === 17) continue;
    if (tf === "15s" && !((hr === 9 && d.getUTCMinutes() >= 20) || hr === 10 || hr === 11)) continue;
    if (rr() < 0.003) drift = (rr() - 0.5) * 0.6;
    const vol = (hr >= 9 && hr < 12 ? 3.2 : 1.2) * (sym === "NQ" ? 1 : 0.3) * Math.sqrt(step / 60);
    const o = p, c = rnd(p + drift + (rr() - 0.5) * vol * 2), h = rnd(Math.max(o, c) + rr() * vol), l = rnd(Math.min(o, c) - rr() * vol);
    out.push({ t, o, h, l, c }); p = c;
  }
  return out;
}
const ymOf = (t) => new Date(t * 1000).toISOString().slice(0, 7);
function addM(ym, n) { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7); }

/* ---------------- storage layer ---------------- */
const mem = { trades: [] };
const db = {
  async newSession(row) { if (DEMO) return { id: "s" + Date.now(), ...row }; const { data, error } = await sb.from("sessions").insert(row).select().single(); if (error) throw error; return data; },
  saveCursor(id, ts) { if (!DEMO) sb.from("sessions").update({ cursor_ts: ts, updated_at: new Date().toISOString() }).eq("id", id).then(() => {}); },
  async addTrade(row) { if (DEMO) { const r = { id: "t" + Math.random().toString(36).slice(2), ...row }; mem.trades.push(r); return r; } const { data, error } = await sb.from("trades").insert(row).select().single(); if (error) throw error; return data; },
  async trades(sym) { if (DEMO) return mem.trades.filter((t) => !sym || t.symbol === sym); let q = sb.from("trades").select("*").order("t_exit").limit(5000); if (sym) q = q.eq("symbol", sym); const { data } = await q; return data || []; },
  async accounts() { if (DEMO) return (mem.accounts || (mem.accounts = [])).slice(); const { data } = await sb.from("accounts").select("*").eq("archived", false).order("created_at"); return data || []; },
  async newAccount(row) { if (DEMO) { const r = { id: "a" + Date.now(), created_at: new Date().toISOString(), ...row }; (mem.accounts = mem.accounts || []).push(r); return r; } const { data, error } = await sb.from("accounts").insert(row).select().single(); if (error) throw error; return data; },
  async updAccount(id, ch) { if (DEMO) { Object.assign(mem.accounts.find((a) => a.id === id), ch); return; } const { error } = await sb.from("accounts").update(ch).eq("id", id); if (error) throw error; },
  async allTrades() { if (DEMO) return mem.trades; const { data } = await sb.from("trades").select("*").order("t_exit").limit(10000); return data || []; },
  review(id, ch) { if (DEMO) { const t = mem.trades.find((x) => x.id === id); if (t) Object.assign(t, ch); return; } sb.from("trades").update(ch).eq("id", id).then(() => {}); },
  note(id, v) { if (DEMO) { const t = mem.trades.find((x) => x.id === id); if (t) t.notes = v; return; } sb.from("trades").update({ notes: v }).eq("id", id).then(() => {}); },
};
async function notion(action, extra = {}) {
  if (DEMO) throw new Error("off in the demo");
  const { data, error } = await sb.functions.invoke("notion", { body: { action, ...extra } });
  if (error) { let m = error.message; try { m = (await error.context.json()).error || m; } catch (e) {} throw new Error(m); } return data;
}

/* ---------------- replay core: two bases (1m always, 15s when a pane needs it), one shared clock ---------------- */
const B = { "1m": { bars: [], i: -1 }, "15s": { bars: [], i: -1 } };
/* each chart can show its own symbol. Chart 1 is the symbol you trade (top bar); other charts can watch the other symbol (SMT) in lockstep */
const X = {};
const paneSym = (p) => { const i = typeof p === "number" ? p : p ? p.i : 0; return prefs.sync && prefs.sync.sym ? sym : (prefs.syms || [])[i] || sym; };
/* every chart is tradable: each symbol keeps its own position + orders. The chart you click becomes the active symbol (its data swaps into B);
   the others keep filling, stopping and targeting in the background via withSym() */
const CTX = {};
function swapTo(s) { if (!s || s === sym || !INST[s] || !X[s]) return false;
  CTX[sym] = { pos, orders, ST, SBC, draft }; X[sym] = { "1m": B["1m"], "15s": B["15s"] }; B["1m"] = X[s]["1m"]; B["15s"] = X[s]["15s"]; delete X[s];
  const c = CTX[s] || {}; delete CTX[s]; pos = c.pos || flat(); orders = c.orders || []; ST = c.ST || { key: null }; SBC = c.SBC || { key: null }; draft = c.draft || null; sym = s; inst = INST[s]; return true; }
function withSym(s, fn) { const prev = sym; if (s === prev) return fn(); if (!swapTo(s)) return undefined; try { return fn(); } finally { swapTo(prev); } }
const otherSyms = () => Object.keys(CTX);
const busyElsewhere = () => otherSyms().some((s) => CTX[s].pos.qty || CTX[s].orders.length);
const openPnlAll = () => { let v = openPnl(); for (const s of otherSyms()) v += withSym(s, openPnl) || 0; return v; };
const storeOf = (s) => (s === sym ? B : X[s] || B);
async function loadOthers() { for (const k of Object.keys(X)) delete X[k]; if (!months || !months.size) return;
  for (const s of [...new Set([...panes.map(paneSym), ...otherSyms().filter((k) => CTX[k].pos.qty || CTX[k].orders.length), ...(smtOn() ? [smtPartner(sym)] : [])])].filter((s) => s && s !== sym && INST[s])) { const st = (X[s] = { "1m": { bars: [], i: -1 }, "15s": { bars: [], i: -1 } });
    for (const tf of ["1m", "15s"]) { if (tf === "15s" && !need15) continue; st[tf].bars = (await Promise.all([...months].sort().map((m) => loadMonth(INST[s].data, tf, m)))).flat().sort((a, b) => a.t - b.t); } }
  advOthers(); }
function advOthers() { const out = {}; for (const s of Object.keys(X)) { out[s] = { "1m": [], "15s": [] }; for (const tf of ["1m", "15s"]) { const b = X[s][tf]; while (b.bars[b.i + 1] && b.bars[b.i + 1].t <= cursorT) { b.i++; out[s][tf].push(b.bars[b.i]); } while (b.i >= 0 && b.bars[b.i].t > cursorT) b.i--; } } return out; }
let need15 = false, lock15 = false, cursorT = 0, sym = "NQ", inst = INST.NQ, timer = null, months = new Set(), sess = null;
const paneSec = (i) => SEC[prefs.tfs[i] || "5m"];
function lastBar() { const a = B["1m"].bars[B["1m"].i], b = need15 ? B["15s"].bars[B["15s"].i] : null; if (!a) return b; if (!b) return a; return b.t >= a.t ? b : a; }
const last = () => (lastBar() ? lastBar().c : null);
const nowT = () => cursorT;
async function loadReplay() { try { execs.length = 0; } catch (e) {}
  pause(); if (pos.qty || orders.length || busyElsewhere()) return toast("Close positions and cancel orders first (on every chart)");
  for (const k of Object.keys(CTX)) delete CTX[k];
  sym = $("sym").value; prefs.syms = prefs.syms || []; if (!(prefs.sync && prefs.sync.sym)) { prefs.syms[active] = sym; panes.forEach((p) => { if (!prefs.syms[p.i]) prefs.syms[p.i] = sym; }); } inst = INST[sym]; need15 = lock15 || panes.some((p) => paneSec(p.i) < 60);
  const s = $("start").value; if (!s) return toast("Pick a start date and time"); if (!DEMO && !blind) { prefs.lastStart = s; prefs.lastSym = $("sym").value; savePrefs(); } const t0 = nyToUtc(s), ym = ymOf(t0);
  toast("Loading " + sym + "…"); months = new Set([addM(ym, -1), ym, addM(ym, 1)]);
  for (const tf of ["1m", "15s"]) { B[tf].bars = []; B[tf].i = -1; if (tf === "15s" && !need15) continue; B[tf].bars = (await Promise.all([...months].sort().map((m) => loadMonth(inst.data, tf, m)))).flat().sort((a, b) => a.t - b.t); }
  if (!B["1m"].bars.length) return toast("No data for that month");
  if (need15 && !B["15s"].bars.length) toast("No 15s data around that date (15s covers NY mornings). 15s and 30s panes will be empty.");
  cursorT = t0 - 1; for (const tf of ["1m", "15s"]) { const bs = B[tf].bars; let k = -1; for (let j = 0; j < bs.length && bs[j].t <= cursorT; j++) k = j; B[tf].i = k; }
  await loadOthers();
  await acctStart();
  try { sess = await db.newSession({ name: sym + " " + fmt(loc(t0)), symbol: sym, start_ts: t0, cursor_ts: t0, tf: prefs.tfs[0], account_start: startBal, risk_pct: prefs.riskp, rules: { dll: prefs.dll, mdd: prefs.mdd, ptg: prefs.ptg }, ...(acct ? { account_id: acct.id } : {}) }); }
  catch (e) { return toast("Could not start a session: " + e.message); }
  hist = []; lock = null; alerts = []; rebuildAll(); drawAlerts();
  { const ev = econOn(new Date(loc(t0) * 1000).toISOString().slice(0, 10)); if (ev.length) setTimeout(() => toast("📅 News today: " + ev.map((e) => `${e.name} ${e.hm} ET`).join(", ")), 900); } panes.forEach((p) => p.chart.timeScale().scrollToRealTime()); toast(""); prefs.sym = sym; savePrefs();
  try { buildFx(!builtOnce); builtOnce = true; } catch (e) {}   // KING_STARTFX
}
async function ensure15() {   // a pane switched to 15s/30s mid-session: load 15s data without resetting the session
  need15 = true; if (B["15s"].bars.length || !B["1m"].bars.length) return;
  toast("Loading 15s data…"); B["15s"].bars = (await Promise.all([...months].sort().map((m) => loadMonth(inst.data, "15s", m)))).flat().sort((a, b) => a.t - b.t);
  let k = -1; for (let j = 0; j < B["15s"].bars.length && B["15s"].bars[j].t <= cursorT; j++) k = j; B["15s"].i = k;
  for (const s of Object.keys(X)) { const f = X[s]["15s"]; if (!f.bars.length) { f.bars = (await Promise.all([...months].sort().map((m) => loadMonth(INST[s].data, "15s", m)))).flat().sort((a, b) => a.t - b.t); f.i = -1; } } advOthers();
  if (!B["15s"].bars.length) toast("No 15s data around this date (15s covers NY mornings)"); else toast("");
}
async function ensureAhead() {
  const b = B["1m"]; if (b.bars.length - b.i > 3000) return; const nx = addM([...months].sort().pop(), 1);
  if (months.has(nx) || nx > new Date().toISOString().slice(0, 7)) return; months.add(nx);
  for (const s of Object.keys(X)) for (const tf of ["1m", "15s"]) { if (tf === "15s" && !need15) continue; const more = await loadMonth(INST[s].data, tf, nx), xb = X[s][tf].bars, xl = xb.length ? xb[xb.length - 1].t : 0; for (const x of more) if (x.t > xl) xb.push(x); }
  for (const tf of ["1m", "15s"]) { if (tf === "15s" && !need15) continue; const more = await loadMonth(inst.data, tf, nx), lt = B[tf].bars.length ? B[tf].bars[B[tf].bars.length - 1].t : 0; for (const x of more) if (x.t > lt) B[tf].bars.push(x); }
}
async function stepFwd(ui = true) {
  if (!B["1m"].bars.length) return;
  const nxt = ["1m", "15s"].filter((tf) => tf === "1m" || need15).map((tf) => B[tf].bars[B[tf].i + 1]).filter(Boolean).map((b) => b.t);
  if (!nxt.length) { await ensureAhead(); if (!B["1m"].bars[B["1m"].i + 1]) { pause(); toast("End of data"); return false; } return stepFwd(ui); }
  const prevT = cursorT; cursorT = Math.min(...nxt); if (reese.length && prevT) reeseCheck(loc(prevT), loc(cursorT));
  const fresh = { "1m": [], "15s": [] };
  for (const tf of ["1m", "15s"]) { const b = B[tf]; while (b.bars[b.i + 1] && b.bars[b.i + 1].t <= cursorT) { b.i++; fresh[tf].push(b.bars[b.i]); } }
  const fx = advOthers();
  // fix 16: with 15s data on, 1m+ charts are built from the 15s bars inside the current minute, so no chart ever shows the rest of a minute that hasn't happened yet
  if (ui) panes.forEach((p) => { const ps = paneSym(p), F = ps === sym ? fresh : fx[ps] || { "1m": [], "15s": [] }, S = storeOf(ps);
    const src = paneSec(p.i) < 60 ? F["15s"] : need15 ? [...F["1m"].filter((x) => !hasFine(x.t, S)), ...F["15s"]].sort((u, v) => u.t - v.t) : F["1m"]; for (const x of src) p.series.update(pushBar(p, x)); if (src.length) indTick(p); });
  for (const x of fresh["15s"]) engineBar(x);                                   // fills use the finest bars available
  for (const x of fresh["1m"]) if (!(need15 && hasFine(x.t))) engineBar(x);
  for (const s of otherSyms()) { const c = CTX[s]; if (!c || !(c.pos.qty || c.orders.length) || !fx[s]) continue; withSym(s, () => { for (const x of fx[s]["15s"]) engineBar(x); for (const x of fx[s]["1m"]) if (!(need15 && hasFine(x.t))) engineBar(x); }); }
  checkAlerts(); try { fxTick(); } catch (e) {}
  if (B["1m"].i % 500 === 0) await ensureAhead(); if (B["1m"].i % 60 === 0 && sess) db.saveCursor(sess.id, cursorT);
  if (!ui) return fresh["1m"];
  if (fresh["1m"].some((x) => ["00:00", "09:30", "10:00", "18:00"].includes(lhm(loc(x.t))))) drawOpens();
  if (extT.length) panes.forEach(extMarkers); refresh(); repaintAll(); return fresh["1m"];
}
// Skip ahead to the next NY open (09:30) or Asia open (20:00), New York time. Orders and stops still fill on the way.
async function skipTo(hm, name) {
  pause(); if (!B["1m"].bars.length) return toast("Load a chart first"); toast("Skipping to the " + name + "…");
  for (let n = 0; n < 6000; n++) { const got = await stepFwd(false); if (got === false || got === undefined) break; if (n > 0 && got.some((x) => lhm(loc(x.t)) === hm)) break; }
  rebuildAll(); panes.forEach((p) => p.chart.timeScale().scrollToRealTime()); toast("");
}
function hasFine(t, S = B) { const b = S["15s"].bars; let lo = 0, hi = b.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b[m].t < t) lo = m + 1; else if (b[m].t >= t + 60) hi = m - 1; else return true; } return false; }
function stepBack() {
  if (pos.qty || orders.length) return toast("Close positions and cancel orders before stepping back");
  const b = B["1m"]; if (b.i <= 0) return; b.i--; cursorT = b.bars[b.i].t; const f = B["15s"]; while (f.i >= 0 && f.bars[f.i].t > cursorT) f.i--; advOthers(); rebuildAll();
}
function play() { if (timer) return pause(); $("play").textContent = "⏸"; const tick = async () => { await stepFwd(); if (timer) timer = setTimeout(tick, +$("speed").value); }; timer = setTimeout(tick, 0); }
function pause() { clearTimeout(timer); timer = null; $("play").textContent = "▶"; }

/* ---------------- panes (1-8 charts) ---------------- */
let panes = [], active = 0;
function pushBar(p, b) {
  const k = bucket(loc(b.t), p.sec), lc = p.candles[p.candles.length - 1];
  if (lc && lc.time === k) { lc.high = Math.max(lc.high, b.h); lc.low = Math.min(lc.low, b.l); lc.close = b.c; return lc; }
  const c = { time: k, open: b.o, high: b.h, low: b.l, close: b.c }; if (lc && prefs.cs && prefs.cs.prevClr) { const u = c.close >= lc.close; c.color = u ? prefs.up : prefs.dn; c.wickColor = c.color; c.borderColor = c.color; } p.candles.push(c); return c;
}
function makePane(i) {
  const el = document.createElement("div"); el.className = "pane"; el.innerHTML = `<div class="wmark"></div><div class="legend"><span class="lname"></span><i></i><span class="ohlc"></span><span class="ivals"></span></div><div class="chart"></div><canvas class="overlay"></canvas>`;
  $("charts").appendChild(el);
  const chart = LightweightCharts.createChart(el.querySelector(".chart"), { layout: { background: { type: "solid", color: "transparent" }, textColor: "#7f8a9c", fontSize: 11, fontFamily: "Inter, -apple-system, Segoe UI, sans-serif" },
    localization: { timeFormatter: hoverDate },
    grid: gridOpts(), rightPriceScale: { borderColor: "rgba(255,255,255,.06)" },
    timeScale: { borderColor: "rgba(255,255,255,.06)", timeVisible: true, secondsVisible: true, rightOffset: 12 }, crosshair: { mode: 0, vertLine: { color: "rgba(255,255,255,.25)", labelBackgroundColor: "#1d2430" }, horzLine: { color: "rgba(255,255,255,.25)", labelBackgroundColor: "#1d2430" } }, autoSize: true });
  const series = chart.addCandlestickSeries({ upColor: prefs.up, downColor: prefs.dn, borderVisible: false, wickUpColor: prefs.up, wickDownColor: prefs.dn, priceFormat: { type: "price", precision: 2, minMove: TICK } });
  const p = { i, el, chart, series, sec: paneSec(i), candles: [], lines: [], opens: [], cv: el.querySelector("canvas.overlay") };
  p.mode = 0; p.auto = true;
  el.addEventListener("pointerdown", () => setActive(i), true);
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => { syncTime(p); paint(p); clearTimeout(p.hrT); p.hrT = setTimeout(() => htfRoom(p), 120); }); new ResizeObserver(() => paint(p)).observe(el);
  chart.subscribeCrosshairMove((pr) => { syncCross(p, pr); if (pr.point) p.hover = { point: pr.point }; const d = pr.seriesData && pr.seriesData.get(series);
    el.querySelector(".ohlc").innerHTML = d ? `O <b>${px2(d.open)}</b> H <b>${px2(d.high)}</b> L <b>${px2(d.low)}</b> C <b class="${d.close >= d.open ? "pos-up" : "pos-dn"}">${px2(d.close)}</b>` : ""; });
  initPointer(p); setTimeout(() => { try { csApply(p); } catch (e) {} }, 0);
  return p;
}
function setActive(i) { active = i; const ps = paneSym(i); if (ps !== sym && X[ps] && swapTo(ps)) { $("sym").value = sym; drawOrders(); try { refresh(); } catch (e) {} panes.forEach(label); } panes.forEach((p) => p.el.classList.toggle("active", p.i === i && panes.length > 1)); tfUI(); scaleUI(); }
function label(p) { const tf = prefs.tfs[p.i] || "5m", s = paneSym(p); p.el.querySelector(".lname").textContent = `${s} · ${tf} · CME`; p.el.classList.toggle("tradesym", s === sym && panes.length > 1 && new Set(panes.map(paneSym)).size > 1); p.el.querySelector(".wmark").textContent = `CME ${s} ${tf}`; }
function tfUI() { const cur = prefs.tfs[active]; $("tfbar").innerHTML = TFS.filter(([n]) => features.sec15 !== false || !n.endsWith("s")).map(([n]) => `<button class="tf ${n === cur ? "on" : ""}" data-tf="${n}">${n === "1D" ? "D" : n}</button>`).join(""); }
// KING_TFCENTER (Josh, Nov 13): changing interval keeps your place. The moment in the middle of the chart stays in the
// middle (same width in bars), like TradingView. If you were parked at the live edge you stay there. Settings toggle: keepC.
function tfAnchor(p) { try { const n = p.candles.length, r = p.chart.timeScale().getVisibleLogicalRange(); if (!n || !r) return null; const w = r.to - r.from;
  if (r.to >= n - 1) return { live: true, w, off: r.to - (n - 1) };   // newest bar on screen: stay pinned to it
  const c = (r.from + r.to) / 2, k = Math.max(0, Math.min(n - 1, Math.round(c))); return { t: p.candles[k].time + p.sec / 2, w }; } catch (e) { return null; } }
function tfRestore(p, a) { if (!a || p.dead || !p.candles.length) return; try { const ts = p.chart.timeScale(), n = p.candles.length;
  if (a.live) { const to = n - 1 + Math.max(0, a.off); ts.setVisibleLogicalRange({ from: to - a.w, to }); return; }
  let lo = 0, hi = n - 1, k = 0; while (lo <= hi) { const m = (lo + hi) >> 1; if (p.candles[m].time <= a.t) { k = m; lo = m + 1; } else hi = m - 1; }   // the new candle covering that time
  ts.setVisibleLogicalRange({ from: k - a.w / 2, to: k + a.w / 2 }); } catch (e) {} }
async function setPaneTf(i, tf, noSync) { const p = panes[i]; if (!p) return; const keep = csG().keepC !== false;
  const qs = [p].concat(!noSync && prefs.sync && prefs.sync.int ? panes.filter((q) => q.i !== i) : []), anc = new Map(qs.map((q) => [q, keep ? tfAnchor(q) : null]));
  for (const q of qs) { prefs.tfs[q.i] = tf; label(q); } savePrefs(); tfUI();
  if (lock15 || panes.some((q) => paneSec(q.i) < 60)) await ensure15(); else need15 = false;
  for (const q of qs) if (!q.dead) rebuildPane(q); drawOrders(); drawOpens(); csApply(p);
  // re-centre after the bars are built (not on a timer); other charts first so the active one's time sync wins
  const put = () => { for (const q of qs.slice(1).concat(p)) tfRestore(q, anc.get(q)); }; put(); requestAnimationFrame(put); }
const livAuto = (p) => { try { return p.chart.priceScale("right").options().autoScale !== false; } catch (e) { return p.auto !== false; } };   // a manual drag on the price axis turns auto-fit off; respect it
function scaleUI() { const p = panes[active]; if (!p) return; p.auto = livAuto(p); $("sc-pct").classList.toggle("on", p.mode === 2); $("sc-log").classList.toggle("on", p.mode === 1); $("sc-auto").classList.toggle("on", p.auto); }
function setScale(k) { const p = panes[active]; if (!p) return; p.auto = livAuto(p); if (k === "auto") p.auto = !p.auto; else { const m = k === "pct" ? 2 : 1; p.mode = p.mode === m ? 0 : m; } p.chart.priceScale("right").applyOptions({ mode: p.mode, autoScale: p.auto }); scaleUI(); paint(p); }
function showRange(days) { const S = prefs.sync || {}; for (const p of (S.range !== false ? panes : [panes[active]])) { if (!p || !p.candles.length) continue; const to = p.candles[p.candles.length - 1].time, from = Math.max(p.candles[0].time, to - days * 86400); p.chart.timeScale().setVisibleRange({ from, to: to + p.sec * 6 }); } }
function saveShot() { const p = panes[active]; if (!p) return; const c = p.chart.takeScreenshot(), g = c.getContext("2d"); try { g.drawImage(p.cv, 0, 0, c.width, c.height); } catch (e) {}
  const a = document.createElement("a"); a.download = `rewind-${sym}-${prefs.tfs[active]}-${nowT() ? fmt(loc(nowT())).replace(/[: ]/g, "-") : "chart"}.png`; a.href = c.toDataURL("image/png"); a.click(); }
function indMenu(re) { if (re !== true && ctxJust === "ind") { ctxJust = null; return; }   /* fix 14: second click closes it */ const r = $("indbtn").getBoundingClientRect(), I = prefs.ind, ck = (v) => (v ? "✓ " : "\u2003 "), flip = (k) => () => { I[k] = !I[k]; savePrefs(); repaintAll(); };
  menu([{ h: "Indicators" }, { t: ck(prefs.opens) + "Key opens (18:00, midnight, 9:30, 10:00)", f: () => { prefs.opens = !prefs.opens; savePrefs(); fillSettings(); drawOpens(); } },
  { t: ck(prefs.sess) + "Shade the NY session", f: () => { prefs.sess = !prefs.sess; savePrefs(); fillSettings(); repaintAll(); } },
  { t: ck(I.sbox) + "Trading sessions (Tokyo / London / New York boxes)", f: flip("sbox") }, { t: "\u2003 Sessions settings…", f: sessDlg }, { t: ck(I.data) + "Data highs / lows (news candles: 8:30, 10:00, 2:00)", f: flip("data") }, { t: ck(I.sess) + "Session high / low lines only (Asia, London, NY AM)", f: flip("sess") }, { t: ck(I.pd) + "Previous day high / low", f: flip("pd") }, { t: ck(I.pw) + "Week + previous week high / low", f: flip("pw") }, { t: ck(I.eq) + "Equal highs / lows (resting liquidity)", f: flip("eq") },
  { t: ck(I.fvg) + "Fair value gaps (FVG)", f: flip("fvg") }, { t: ck(I.ob) + "Order blocks (OB) on the same timeframes", f: flip("ob") }, ...(I.fvg || I.ob ? ["5m", "15m", "1h", "4h", "1D"].map((tf) => ({ t: "\u2003 " + ck((I.fvgTfs || []).includes(tf)) + tf + " gaps", f: () => { const s = new Set(I.fvgTfs || []); s.has(tf) ? s.delete(tf) : s.add(tf); I.fvgTfs = [...s]; savePrefs(); repaintAll(); } })).concat([{ t: "\u2003 " + ck(I.ifvg) + "Show inversions (IFVG)", f: flip("ifvg") }]) : []),
  { t: ck(I.econ !== false) + "News events (CPI + NFP 8:30, FOMC 2:00)", f: () => { I.econ = I.econ === false; savePrefs(); repaintAll(); } },
  { h: "SMT divergence (NQ vs ES)" }, ...SMT_TFS.map(([tf]) => ({ t: ck(smtCfg()[tf]) + `SMT on ${tf} swings`, f: () => { const C = smtCfg(), was = smtOn(); C[tf] = !C[tf]; savePrefs(); if (!was && smtOn() && B["1m"].bars.length) loadOthers().then(repaintAll); else repaintAll(); } })),
  { h: "Library" }, ...indCfg().ma.map((m) => ({ t: ck(m.on) + `${m.type.toUpperCase()} ${m.len}`, f: () => { m.on = !m.on; savePrefs(); panes.forEach(indFull); } })),
  { t: ck(indCfg().bb.on) + `Bollinger Bands ${indCfg().bb.len}, ${indCfg().bb.mult}`, f: () => { indCfg().bb.on = !indCfg().bb.on; savePrefs(); panes.forEach(indFull); } },
  { t: ck(indCfg().rsi.on) + `RSI ${indCfg().rsi.len} (in the chart legend)`, f: () => { indCfg().rsi.on = !indCfg().rsi.on; savePrefs(); panes.forEach(indFull); } },
  { t: ck(indCfg().atr.on) + `ATR ${indCfg().atr.len} (in the chart legend)`, f: () => { indCfg().atr.on = !indCfg().atr.on; savePrefs(); panes.forEach(indFull); } },
  { t: "\u2003 Lengths, colors, bands…", f: maDlg },
  { h: "Higher-timeframe candles on the right (PO3)" }, ...["15m", "1h", "4h", "1D", "1W"].map((tf) => ({ t: ck((I.htfc || []).includes(tf)) + "Current " + tf + " candle", f: () => { const s = new Set(I.htfc || []); s.has(tf) ? s.delete(tf) : s.add(tf); I.htfc = ["15m", "1h", "4h", "1D", "1W"].filter((x) => s.has(x)); savePrefs(); repaintAll(); } })), { t: ck(I.h4) + "Past 4H candle outlines on the chart", f: flip("h4") }], r.left, r.bottom + 6, indMenu); $("ctx").dataset.from = "ind"; }
const TOOLNAMES = { pitchfork: "Pitchfork", arrow: "Arrow", channel: "Parallel channel", fibext: "Fib extension", prange: "Price range", drange: "Date range", ellipse: "Ellipse", cursor: "Cursor", cross: "Crosshair", trend: "Trend line", ray: "Ray", hline: "Horizontal line", hray: "Horizontal ray", vline: "Vertical line", rect: "Rectangle", fib: "Fib", long: "Long position", short: "Short position", measure: "Measure", text: "Text" };
function favUI() {
  const fb = $("favbar"), wide = innerWidth > 900; replayHome(); fb.classList.toggle("hidden", !(prefs.favShow || wide)); fb.classList.toggle("nofav", !prefs.favShow); $("favbtn").classList.toggle("on", !!prefs.favShow);
  fb.querySelector(".fbtools").innerHTML = prefs.favs.map((t) => { const src = document.querySelector('#tools .tfly [data-tool="' + t + '"]') || document.querySelector('#tools [data-tool="' + t + '"]'); return src ? `<button data-tool="${t}" class="tool ${src.className.replace(/\btool\b|\bon\b|\bfi\b|\btgm\b/g, "").trim()} ${t === tool ? "on" : ""}" title="${src.title}">${(src.querySelector(".ti") || src).innerHTML}</button>` : ""; }).join("") || '<span class="tiny muted" style="padding:0 8px">Right-click a tool to add it here</span>';
  if (prefs.favPos) { fb.style.left = Math.min(prefs.favPos.x, innerWidth - 80) + "px"; fb.style.top = Math.min(prefs.favPos.y, innerHeight - 40) + "px"; fb.style.transform = "none"; }
}
// KING_FAVREPLAY (Nov 12 walkthrough): play/pause, bar/candle and speed live on the tool favorites bar on desktop
// (the bar stays up even with tool favorites off). On a phone they stay in the top bar, where the favorites bar is hidden.
function replayHome() { const wide = innerWidth > 900, fr = document.querySelector("#favbar .fbreplay"), top = document.querySelector(".grp.replay"), seg = $("play").parentElement, skips = top.querySelector(".skips");
  if (!fr || !top) return; const want = wide ? fr : top; if (seg.parentElement === want) return;
  const box = (id) => $(id).closest(".dd") || $(id);   // selects are wrapped in the custom dropdown; move the wrapper
  if (wide) { fr.append(seg, box("stepsz"), box("speed")); } else { top.insertBefore(seg, skips); top.appendChild(box("stepsz")); top.appendChild(box("speed")); } }
addEventListener("resize", () => { try { const w = innerWidth > 900; if (w !== replayHome.w) { replayHome.w = w; favUI(); } } catch (e) {} });
function toolsUI() { const t = $("tools"), f = prefs.toolsPos; t.classList.toggle("float", !!f); if (f) { t.style.left = Math.min(f.x, innerWidth - 50) + "px"; t.style.top = Math.min(f.y, innerHeight - 120) + "px"; } else { t.style.left = t.style.top = ""; } panes.forEach(paint); }
function dockH() { const b = document.querySelector("#dock .bbody"); b.style.height = prefs.dockClosed ? "0px" : (prefs.dockH || 150) + "px"; if (prefs.pad.x == null) setTimeout(padUI, 240); }
function grip(el, onMove, onEnd) {   // pointer drag helper
  el.addEventListener("pointerdown", (e) => { if (e.button !== 0 || (e.target !== el && e.target.closest("button,input,select,a,label,iframe,textarea"))) return; e.preventDefault(); el.setPointerCapture(e.pointerId); const st = { x: e.clientX, y: e.clientY };   // fix 5: buttons inside a drag bar stay clickable. KING_GRIPFIX (Nov 11): this line used to sit inside the comment, so st was undefined and EVERY drag (bottom panel, media window, toolbar, sidebar) threw
    const mv = (ev) => onMove(ev, st), up = (ev) => { el.removeEventListener("pointermove", mv); el.removeEventListener("pointerup", up); onEnd && onEnd(ev, st); };
    el.addEventListener("pointermove", mv); el.addEventListener("pointerup", up); });
}
function sideUI() { $("side").classList.toggle("hidden", !prefs.side); $("sidebtn").classList.toggle("on", !!prefs.side); }
function dockUI() { $("dock").classList.toggle("closed", !!prefs.dockClosed); dockH(); }
function buildPanes() {
  panes.forEach((p) => { p.dead = true; try { if (p.prim) p.series.detachPrimitive(p.prim); } catch (e) {} p.chart.remove(); }); $("charts").innerHTML = ""; panes = [];
  const [c, r] = LAYOUTS[prefs.layout] || [1, 1], n = c * r; $("charts").style.gridTemplateColumns = `repeat(${c},minmax(0,1fr))`; $("charts").style.gridTemplateRows = `repeat(${r},minmax(0,1fr))`;
  while (prefs.tfs.length < 8) prefs.tfs.push(DEF_TFS[prefs.tfs.length]);
  for (let i = 0; i < n; i++) { const p = makePane(i); panes.push(p); label(p); } setActive(Math.min(active, n - 1)); need15 = lock15 || panes.some((p) => paneSec(p.i) < 60);
}
function rebuildPane(p) {
  p.sec = paneSec(p.i); p.candles = []; const S = storeOf(paneSym(p)), src = p.sec < 60 ? S["15s"] : S["1m"];
  const f = S["15s"], lastM = p.sec >= 60 && need15 && src.i >= 0 && f.i >= 0 && hasFine(src.bars[src.i].t, S) ? src.bars[src.i].t : null;   // fix 16: current minute from 15s only
  for (let j = 0; j <= src.i && j < src.bars.length; j++) { if (lastM != null && src.bars[j].t === lastM) break; pushBar(p, src.bars[j]); }
  if (lastM != null) { let k = f.i; while (k > 0 && f.bars[k - 1].t >= lastM) k--; for (; k <= f.i; k++) if (f.bars[k].t >= lastM) pushBar(p, f.bars[k]); }
  p.series.setData(p.candles); label(p); indFull(p); extMarkers(p); paint(p);
}
function watchScales() {
  for (const p of panes) { if (!p.candles.length) continue; const ref = p.candles[p.candles.length - 1].close, ts = p.chart.timeScale();
    const sig = (p.series.priceToCoordinate(ref) || 0).toFixed(1) + "|" + (p.series.priceToCoordinate(ref + 10) || 0).toFixed(1) + "|" + (ts.logicalToCoordinate(p.candles.length - 1) || 0).toFixed(1) + "|" + ts.width();
    if (sig !== p.sig) { p.sig = sig; paint(p); } }
  requestAnimationFrame(watchScales);
}
function rebuildAll() { if (blind) panes.forEach((p) => p.chart.applyOptions({ timeScale: { tickMarkFormatter: (t) => new Date(t * 1000).toISOString().slice(11, 16) }, localization: { timeFormatter: (t) => new Date(t * 1000).toISOString().slice(11, 16) } })); panes.forEach(rebuildPane); drawOpens(); drawOrders(); refresh(); }
function setLayout(k) {
  prefs.layout = k; savePrefs(); $("laymenu").classList.add("hidden");
  const had = B["1m"].bars.length; buildPanes(); if (had) (need15 ? ensure15() : Promise.resolve()).then(loadOthers).then(() => { rebuildAll(); panes.forEach((p) => p.chart.timeScale().scrollToRealTime()); });
}

/* ---------------- coordinates for the canvas layer ---------------- */
function idxOf(p, lt) { const c = p.candles; if (!c.length) return 0; const k = bucket(lt, p.sec); let lo = 0, hi = c.length - 1;
  if (k >= c[hi].time) return hi + (lt - c[hi].time) / p.sec; if (k <= c[0].time) return (lt - c[0].time) / p.sec;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (c[m].time <= k) lo = m; else hi = m - 1; } return lo + (lt - c[lo].time) / p.sec; }
function xOf(p, lt) { const ts = p.chart.timeScale(), l = idxOf(p, lt), k = Math.floor(l), a = ts.logicalToCoordinate(k), b = ts.logicalToCoordinate(k + 1);   // logicalToCoordinate wants whole bar indexes
  if (a == null || b == null) return null; return a + (l - k) * (b - a); }
const yOf = (p, pr) => p.series.priceToCoordinate(pr);
function tOf(p, x) { const l = p.chart.timeScale().coordinateToLogical(x), c = p.candles; if (l == null || !c.length) return null; const n = c.length - 1;
  if (l >= n) return c[n].time + (l - n) * p.sec; if (l <= 0) return c[0].time + l * p.sec; const k = Math.floor(l); return c[k].time + (l - k) * p.sec; }
function pOf(p, y, x) { let pr = p.series.coordinateToPrice(y); if (pr == null) return null;
  if (prefs.magnet && x != null) { const l = Math.round(p.chart.timeScale().coordinateToLogical(x)), c = p.candles[l]; if (c) { const best = [c.open, c.high, c.low, c.close].reduce((a, b) => (Math.abs(yOf(p, b) - y) < Math.abs(yOf(p, a) - y) ? b : a)); if (prefs.magMode === "strong" || Math.abs(yOf(p, best) - y) < 24) pr = best; } }   // KING_MAGNET: weak = within 24 px (was 14, King: a little stronger), strong = always snap
  return rnd(pr); }

/* ---------------- drawings (canvas layer) ---------------- */
let tool = "cursor", drawings = [], pend = null, sel = null, hov = null, did = 1;
const FIBX = [[0, "0"], [0.618, "0.618"], [1, "1"], [1.272, "1.272"], [1.414, "1.414"], [1.618, "1.618"], [2, "2"], [2.618, "2.618"]];
const chOff = (d) => d.off ?? (Math.abs(d.b.p - d.a.p) * 0.5 || 20 * (TICK || 0.25));
const lineAt = (d, t) => (d.b.t === d.a.t ? d.a.p : d.a.p + ((d.b.p - d.a.p) * (t - d.a.t)) / (d.b.t - d.a.t));
const FIB_DEF = [0, 0.5, 0.62, 0.705, 0.79, 1, -0.27, -0.62], FIB_OPTS = [0, 0.236, 0.382, 0.5, 0.618, 0.62, 0.705, 0.786, 0.79, 1, -0.27, -0.62, -1, -2, 1.272, 1.618];
// KING_FIBLV (Nov 12 walkthrough): pick the fib levels (Fib settings). Same placement as before: "0" sits on point A, "1" on point B.
function fibList() { const L = (prefs && Array.isArray(prefs.fibLv) && prefs.fibLv.length ? prefs.fibLv : FIB_DEF); return L.map((l) => [l === 0 ? 1 : l === 1 ? 0 : l, String(l)]); }
const SHARED = ["hline"];   // horizontal lines show on every chart; everything else stays on the chart it was drawn on
function setTool(t) { tool = t; pend = null; document.querySelectorAll("[data-tool]").forEach((b) => b.classList.toggle("on", b.dataset.tool === t)); try { tgSync(t); } catch (e) {} panes.forEach((p) => { p.el.style.cursor = t === "cursor" ? "" : "crosshair"; p.chart.applyOptions({ crosshair: { mode: t === "cross" ? 0 : 1 } }); paint(p); }); }
function newDrawing(type, p, a, b) {
  const d = { id: did++, type, pane: p.i, a: { ...a }, b: b ? { ...b } : { ...a } };
  if (type === "long" || type === "short") { const s = type === "long" ? 1 : -1; d.b = { t: a.t + p.sec * 30, p: a.p }; d.entry = a.p; d.sl = rnd(a.p - s * prefs.slPts); d.tp = rnd(a.p + s * prefs.tpPts); d.side = s; d.state = "idle"; d.qty = null; }
  if (type === "text") d.text = prompt("Note text") || "Note";
  if (type === "channel") d.off = chOff(d);
  if (type === "pitchfork") d.c = { t: d.b.t + Math.max(p.sec, (d.b.t - d.a.t) * 0.4), p: d.a.p - (d.b.p - d.a.p) * 0.6 };
  const pd = (prefs.presetDef || {})[type]; if (pd != null && prefs.presets && prefs.presets[type] && prefs.presets[type][pd]) applyPreset(d, prefs.presets[type][pd]);
  drawings.push(d); sel = d; return d;
}
/* ---------------- indicators (session highs/lows, previous day, HTF gaps, 4H candles, daily PO3) ---------------- */
let ST = { key: null };
const SESS = [["Asia", "20:00", "24:00", "rgba(255,198,92,.75)"], ["London", "02:00", "05:00", "rgba(122,167,255,.8)"], ["NY AM", "09:30", "11:00", "rgba(94,230,184,.8)"]];
function studies() {
  const b1 = B["1m"], key = b1.i + ":" + JSON.stringify(prefs.ind); if (ST.key === key) return ST; const bars = b1.bars, i = b1.i, out = { key, levels: [], gaps: [], h4: [], po3: null }; ST = out; if (i < 0) return out;
  const I = prefs.ind, t = bars[i].t, today = sessDay(t), hm = (x) => lhm(loc(x.t));
  let j = i; const lim = Math.max(0, i - 15 * 1440); const days = {};
  for (let k = i; k >= lim; k--) { const d = sessDay(bars[k].t); (days[d] = days[d] || []).push(bars[k]); if (Object.keys(days).length > 3) { delete days[d]; break; } }
  const order = Object.keys(days).sort(), prev = order[order.length - 2], cur = days[today] || [];
  if (I.pw) {   // previous week high/low (week opens Sunday 18:00 New York)
    const wk = (lt) => { const d = new Date((lt + 6 * 3600) * 1000); return Math.floor((lt + 6 * 3600) / 86400) - d.getUTCDay(); }, cw = wk(loc(t)); let hi = null, lo = null;
    for (let k = i; k >= Math.max(0, i - 15 * 1440); k--) { const x = bars[k], w = wk(loc(x.t)); if (w === cw) continue; if (w < cw - 7) break; if (!hi || x.h > hi.h) hi = x; if (!lo || x.l < lo.l) lo = x; }
    if (hi) out.levels.push({ price: hi.h, t0: loc(hi.t), label: "PWH", col: "rgba(196,181,253,.8)" }, { price: lo.l, t0: loc(lo.t), label: "PWL", col: "rgba(196,181,253,.8)" });
    let wh = null, wl = null; for (let k = i; k >= Math.max(0, i - 8 * 1440); k--) { const x = bars[k]; if (wk(loc(x.t)) !== cw) break; if (!wh || x.h > wh.h) wh = x; if (!wl || x.l < wl.l) wl = x; }
    if (wh) out.levels.push({ price: wh.h, t0: loc(wh.t), label: "Week H", col: "rgba(196,181,253,.55)" }, { price: wl.l, t0: loc(wl.t), label: "Week L", col: "rgba(196,181,253,.55)" }); }
  if (I.eq) {   // equal highs / lows: two 15m swing points within a hair of each other that price hasn't run yet = resting liquidity
    const cs = []; for (let k = Math.max(0, i - 3 * 1440); k <= i; k++) { const x = bars[k], bt = bucket(loc(x.t), 900), c = cs[cs.length - 1];
      if (c && c.t === bt) { c.h = Math.max(c.h, x.h); c.l = Math.min(c.l, x.l); c.c = x.c; } else cs.push({ t: bt, o: x.o, h: x.h, l: x.l, c: x.c }); }
    const tol = bars[i].c * 0.00012, sw = { h: [], l: [] };
    for (let k = 2; k < cs.length - 2; k++) { const c = cs[k];
      if (c.h >= cs[k - 1].h && c.h >= cs[k - 2].h && c.h > cs[k + 1].h && c.h > cs[k + 2].h) sw.h.push(k);
      if (c.l <= cs[k - 1].l && c.l <= cs[k - 2].l && c.l < cs[k + 1].l && c.l < cs[k + 2].l) sw.l.push(k); }
    const after = (k, f) => cs.slice(k + 1).some(f), seen = new Set();
    for (const [side, key] of [["h", "EQH"], ["l", "EQL"]]) { const xs = sw[side];
      for (let a1 = xs.length - 1; a1 > 0; a1--) for (let a2 = a1 - 1; a2 >= 0 && a1 - a2 <= 6; a2--) { const p1 = cs[xs[a1]][side], p2 = cs[xs[a2]][side]; if (Math.abs(p1 - p2) > tol) continue;
        const lvl = side === "h" ? Math.max(p1, p2) : Math.min(p1, p2); if (after(xs[a1], (z) => (side === "h" ? z.h > lvl : z.l < lvl))) continue; const kk = key + Math.round(lvl); if (seen.has(kk)) continue; seen.add(kk);
        out.levels.push({ price: lvl, t0: cs[xs[a2]].t, label: key, col: "rgba(255,214,102,.85)" }); } } }
  if (I.data) {   // data highs/lows: the high + low of a news candle (8:30, 10:00, 14:00 FOMC) that blew out the range. They act as draws until price trades through.
    const NEWS = ["08:30", "10:00", "14:00"], dl = [];
    for (const dd of order) { const xs = days[dd] || []; xs.sort((a, b) => a.t - b.t);
      for (let k = 0; k < xs.length; k++) { const x = xs[k], h = hm(x); if (!NEWS.includes(h)) continue; const prior = xs.slice(Math.max(0, k - 30), k).map((y) => y.h - y.l).sort((p, q) => p - q);
        if (prior.length < 10) continue; const med = prior[prior.length >> 1] || 0.25, rg = x.h - x.l; if (rg < 4 * med || rg < x.c * 0.0004) continue;
        let tH = false, tL = false; for (let m = bars.indexOf(x) + 1; m <= i && m > 0; m++) { if (bars[m].h > x.h) tH = true; if (bars[m].l < x.l) tL = true; if (tH && tL) break; }
        const lb = h.replace(/^0/, "") + (dd === today ? "" : " " + dd.slice(5));
        dl.push({ price: x.h, t0: loc(x.t), label: "Data H " + lb + (tH ? " ✓" : ""), col: tH ? "rgba(255,159,67,.35)" : "rgba(255,159,67,.95)" }, { price: x.l, t0: loc(x.t), label: "Data L " + lb + (tL ? " ✓" : ""), col: tL ? "rgba(255,159,67,.35)" : "rgba(255,159,67,.95)" }); } }
    out.levels.push(...dl.slice(-12)); out.data = dl; }
  if (I.sess) for (const [nm, a, z, col] of SESS) { for (const dd of [today, prev]) { const xs = (days[dd] || []).filter((x) => { const h = hm(x); return z === "24:00" ? h >= a : h >= a && h < z; }); if (!xs.length) continue;
      const hi = xs.reduce((m, x) => (x.h > m.h ? x : m)), lo = xs.reduce((m, x) => (x.l < m.l ? x : m)), tag = dd === today ? "" : " (prev)";
      out.levels.push({ price: hi.h, t0: loc(hi.t), label: nm + " H" + tag, col }, { price: lo.l, t0: loc(lo.t), label: nm + " L" + tag, col }); if (dd === today) break; } }
  if (I.pd && prev) { const rth = (days[prev] || []).filter((x) => hm(x) >= "09:30" && hm(x) < "16:00"); if (rth.length) { const hi = rth.reduce((m, x) => (x.h > m.h ? x : m)), lo = rth.reduce((m, x) => (x.l < m.l ? x : m));
      out.levels.push({ price: hi.h, t0: loc(hi.t), label: "PDH", col: "rgba(230,234,240,.7)" }, { price: lo.l, t0: loc(lo.t), label: "PDL", col: "rgba(230,234,240,.7)" }); } }
  if (I.fvg || I.ob) {   // fix 8: FVGs, inversion gaps and order blocks per chosen timeframe. Each zone has a start AND an end: an FVG box stops where it got inverted, the IFVG starts there and stops when it's invalidated. Only the unfilled part of a gap is shown.
    const lp = bars[i].c, act = [], ended = [];
    for (const tf of (I.fvgTfs && I.fvgTfs.length ? I.fvgTfs : [I.fvgTf])) { const sec = SEC[tf] || 3600, cs = [];
      for (let k = Math.max(0, i - (sec >= 14400 ? 15 : 10) * 1440); k <= i; k++) { const x = bars[k], bt = bucket(loc(x.t), sec), c = cs[cs.length - 1];
        if (c && c.t === bt) { c.h = Math.max(c.h, x.h); c.l = Math.min(c.l, x.l); c.c = x.c; } else cs.push({ t: bt, o: x.o, h: x.h, l: x.l, c: x.c }); }
      const done = cs.slice(0, -1), end = (m) => cs[m].t + sec;
      for (let k = 2; k < done.length; k++) { const a0 = done[k - 2], c0 = done[k]; let dir = 0, top, bot;
        if (c0.l > a0.h) { dir = 1; top = c0.l; bot = a0.h; } else if (c0.h < a0.l) { dir = -1; top = a0.l; bot = c0.h; } if (!dir) continue;
        if (I.fvg) { let g = { top, bot, dir, t0: done[k - 1].t, t1: null, label: tf + " FVG", tf }, inv = null;
          for (let m = k + 1; m < cs.length; m++) { const z = cs[m], fin = m < cs.length - 1;
            if (!inv) { if (dir > 0) { if (z.l < g.top) g.top = Math.max(g.bot, z.l); } else if (z.h > g.bot) g.bot = Math.min(g.top, z.h);
              if (fin && (dir > 0 ? z.c < bot : z.c > top)) { g.t1 = end(m); if (I.ifvg) inv = { top, bot, dir: -dir, t0: end(m), t1: null, label: tf + " IFVG", tf, inv: true }; else break; }
              else if (g.top - g.bot <= 0) { g.t1 = end(m); g.filled = true; break; } }
            else if (fin && (inv.dir > 0 ? z.c < inv.bot : z.c > inv.top)) { inv.t1 = end(m); break; } }
          (g.t1 ? ended : act).push(g); if (inv) (inv.t1 ? ended : act).push(inv); }
        if (I.ob) { let j = k - 2; while (j >= Math.max(0, k - 6) && (dir > 0 ? !(done[j].c < done[j].o) : !(done[j].c > done[j].o))) j--; if (j < Math.max(0, k - 6)) continue;
          const oc = done[j], ob = { top: oc.h, bot: oc.l, dir, t0: oc.t, t1: null, label: tf + " OB", tf, ob: true };
          for (let m = k + 1; m < cs.length - 1; m++) if (dir > 0 ? cs[m].c < ob.bot : cs[m].c > ob.top) { ob.t1 = end(m); break; }
          (ob.t1 ? ended : act).push(ob); } } }
    const near = (z) => Math.abs((z.top + z.bot) / 2 - lp), seen = new Set(), uniq = (z) => { const k = z.label + z.top + z.bot; if (seen.has(k)) return false; seen.add(k); return true; };
    const live = act.filter((z) => z.top - z.bot > 0 && uniq(z)).sort((a, b) => near(a) - near(b));
    out.gaps = live.filter((z) => !z.ob).slice(0, 6).concat(live.filter((z) => z.ob).slice(0, 3), ended.filter((z) => !z.filled && z.top - z.bot > 0 && uniq(z)).sort((a, b) => b.t1 - a.t1).slice(0, 4)); }
  if (I.h4) { const cs = []; for (let k = Math.max(0, i - 3 * 1440); k <= i; k++) { const x = bars[k], bt = bucket(loc(x.t), 14400), c = cs[cs.length - 1];
      if (c && c.t === bt) { c.h = Math.max(c.h, x.h); c.l = Math.min(c.l, x.l); c.c = x.c; } else cs.push({ t: bt, o: x.o, h: x.h, l: x.l, c: x.c }); } out.h4 = cs.slice(-8); }
  // fix 9 + 11: the CURRENT candle of each chosen higher timeframe, drawn side by side on the right (PO3 view). Built only from bars up to the replay cursor.
  out.htf = []; for (const tf of (I.htfc || [])) { const lt0 = loc(t); let start;
    if (tf === "1D") start = (() => { let k = i; while (k > 0 && sessDay(bars[k - 1].t) === today) k--; return k; })();
    else if (tf === "1W") { const wk = (lt) => Math.floor((lt + 6 * 3600) / 86400) - new Date((lt + 6 * 3600) * 1000).getUTCDay(), cw = wk(lt0); let k = i; while (k > 0 && wk(loc(bars[k - 1].t)) === cw && i - k < 8 * 1440) k--; start = k; }
    else { const sec = SEC[tf], b0 = bucket(lt0, sec); let k = i; while (k > 0 && bucket(loc(bars[k - 1].t), sec) === b0) k--; start = k; }
    let h = -Infinity, l = Infinity; for (let k = start; k <= i; k++) { if (bars[k].h > h) h = bars[k].h; if (bars[k].l < l) l = bars[k].l; }
    out.htf.push({ tf, o: bars[start].o, h, l, c: bars[i].c }); }
  if (I.po3 && cur.length && !(I.htfc || []).length) { const xs = cur.slice().reverse(); out.po3 = { o: xs[0].o, h: Math.max(...xs.map((x) => x.h)), l: Math.min(...xs.map((x) => x.l)), c: bars[i].c }; }
  return out;
}

/* ---------------- Trading sessions (TradeSea-style): a box per session with open/high/low/close/avg, range in points + ticks, project high/low forward ---------------- */
const SB_DEF = { sessions: [{ name: "Tokyo", start: "20:00", end: "00:00", color: "#ffc65c", on: true }, { name: "London", start: "02:00", end: "05:00", color: "#7aa7ff", on: true }, { name: "New York", start: "09:30", end: "16:00", color: "#5ee6b8", on: true }],
  lookback: 2, border: true, labels: true, values: true, ticks: true, project: true, lOpen: false, lClose: false, lAvg: true, stats: true };
const sbCfg = () => ({ ...SB_DEF, ...(prefs.sbCfg || {}), sessions: (prefs.sbCfg && prefs.sbCfg.sessions) || SB_DEF.sessions });
let SBC = { key: null };
function sessBoxes() { const b1 = B["1m"], C = sbCfg(), key = b1.i + JSON.stringify(C); if (SBC.key === key) return SBC.out; const out = []; SBC = { key, out }; if (b1.i < 0) return out;
  const bars = b1.bars, i = b1.i, groups = {}, order = [];
  for (let k = i; k >= Math.max(0, i - (C.lookback + 2) * 1440); k--) { const d = sessDay(bars[k].t); if (!groups[d]) { if (order.length > C.lookback) break; groups[d] = []; order.push(d); } groups[d].push(bars[k]); }
  for (const d of order.slice(0, C.lookback + 1)) { const xs = groups[d].slice().reverse();
    for (const s of C.sessions) { if (!s.on) continue; const cross = s.start > s.end && s.end !== "00:00", inS = (h) => (s.end === "00:00" ? h >= s.start : cross ? h >= s.start || h < s.end : h >= s.start && h < s.end);
      const ys = xs.filter((x) => inS(lhm(loc(x.t)))); if (!ys.length) continue;
      const hi = Math.max(...ys.map((y) => y.h)), lo = Math.min(...ys.map((y) => y.l)), live = ys[ys.length - 1] === bars[i];
      let tH = false, tL = false; const endT = ys[ys.length - 1].t; for (let k = bars.indexOf(ys[ys.length - 1]) + 1; k > 0 && k <= i; k++) { if (bars[k].h > hi) tH = true; if (bars[k].l < lo) tL = true; if (tH && tL) break; }
      out.push({ ...s, day: d, t0: loc(ys[0].t), t1: loc(endT) + 60, open: ys[0].o, close: ys[ys.length - 1].c, hi, lo, avg: (hi + lo) / 2, live, tH, tL }); } }
  return out; }
function paintSessBoxes(p, g, W0, H) { if (!prefs.ind || !prefs.ind.sbox || p.sec >= 14400) return; const hN = ((prefs.ind && prefs.ind.htfc) || []).length, W = hN ? W0 - (43 + (hN - 1) * 34) : W0; /* KING_SESSLBL: labels stop before the 4h / 1D candles on the right */ const C = sbCfg(), tick = TICK || 0.25, X = (lt) => xOf(p, lt);
  for (const s of sessBoxes()) { const x1 = X(s.t0), x2 = X(s.t1), yh = yOf(p, s.hi), yl = yOf(p, s.lo); if (x1 == null || x2 == null || yh == null || yl == null || x2 < 0 || x1 > W) continue;
    const a = Math.max(0, x1), b = Math.min(W, x2), col = s.color; g.fillStyle = col + "14"; g.fillRect(a, yh, b - a, yl - yh); if (C.border) { g.strokeStyle = col + "99"; g.lineWidth = 1; g.strokeRect(a, yh, b - a, yl - yh); }
    const ln = (price, dash, lab) => { const y = yOf(p, price); if (y == null) return; g.strokeStyle = col + "aa"; g.setLineDash(dash); g.beginPath(); g.moveTo(a, y); g.lineTo(b, y); g.stroke(); g.setLineDash([]); if (C.labels) { g.fillStyle = col; g.fillText(lab + (C.values ? " " + px2(price) : ""), a + 3, y - 3); } };
    if (C.lOpen) ln(s.open, [2, 3], "O"); if (C.lClose && !s.live) ln(s.close, [2, 3], "C"); if (C.lAvg) ln(s.avg, [6, 4], "Avg");
    if (C.project && !s.live) for (const [pr, taken, lab] of [[s.hi, s.tH, "H"], [s.lo, s.tL, "L"]]) { const y = yOf(p, pr); if (y == null || x2 > W) continue; g.strokeStyle = col + (taken ? "40" : "b0"); g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x2, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]);
      if (C.labels) { const t = s.name + " " + lab + (taken ? " ✓" : "") + (C.values ? " " + px2(pr) : ""); g.fillStyle = col + (taken ? "70" : "ee"); g.fillText(t, W - g.measureText(t).width - 6, y - 4); } }
    if (C.stats) { const r = s.hi - s.lo, t = s.name + "  " + r.toFixed(2) + " pts" + (C.ticks ? " · " + Math.round(r / tick) + " ticks" : ""); g.fillStyle = col; g.fillText(t, Math.max(2, Math.min(a + 3, W - g.measureText(t).width - 4)), yh - 4); } } }
function sessDlg() { const C = sbCfg();
  dlg(`<h3>Trading sessions</h3><div class="tiny muted">Times are New York time. A session ending at 00:00 runs to midnight; start after end crosses midnight.</div>
    ${C.sessions.map((s, k) => `<div class="row2 sbrow"><label class="ck"><input type="checkbox" id="sb-on${k}" ${s.on ? "checked" : ""}> <input id="sb-n${k}" value="${esc(s.name)}" maxlength="14" style="width:90px"></label><label>From<input id="sb-a${k}" type="time" value="${s.start}"></label><label>To<input id="sb-z${k}" type="time" value="${s.end}"></label><label>Color<input id="sb-c${k}" type="color" value="${s.color}"></label></div>`).join("")}
    <div class="chips">${[["border", "Box border"], ["stats", "Stats label (range)"], ["ticks", "Range in ticks"], ["project", "Project high / low forward"], ["lOpen", "Open line"], ["lClose", "Close line"], ["lAvg", "Average line"], ["labels", "Level labels"], ["values", "Level values"]].map(([k, n]) => `<label class="ck"><input type="checkbox" id="sb-${k}" ${C[k] ? "checked" : ""}> ${n}</label>`).join("")}</div>
    <label>Lookback (days)<input id="sb-lb" type="number" min="0" max="10" value="${C.lookback}"></label>`, () => {
    const n = { sessions: C.sessions.map((s, k) => ({ name: $("sb-n" + k).value || s.name, start: $("sb-a" + k).value, end: $("sb-z" + k).value, color: $("sb-c" + k).value, on: $("sb-on" + k).checked })), lookback: Math.max(0, Math.min(10, +$("sb-lb").value || 0)) };
    for (const k of ["border", "stats", "ticks", "project", "lOpen", "lClose", "lAvg", "labels", "values"]) n[k] = $("sb-" + k).checked; prefs.sbCfg = n; prefs.ind.sbox = true; savePrefs(); repaintAll(); }); }
/* ---------------- news events (official sources): FOMC decisions 2:00 PM ET (federalreserve.gov), CPI + NFP (jobs report) 8:30 AM ET (BLS archives). ---------------- */
const ECON_CPI = new Set(["2020-10-13", "2020-11-12", "2020-12-10", "2021-01-13", "2021-02-10", "2021-03-10", "2021-04-13", "2021-05-12", "2021-06-10", "2021-07-13", "2021-08-11", "2021-09-14", "2021-10-13", "2021-11-10", "2021-12-10", "2022-01-12", "2022-02-10", "2022-03-10", "2022-04-12", "2022-05-11", "2022-06-10", "2022-07-13", "2022-08-10", "2022-09-13", "2022-10-13", "2022-11-10", "2022-12-13", "2023-01-12", "2023-02-14", "2023-03-14", "2023-04-12", "2023-05-10", "2023-06-13", "2023-07-12", "2023-08-10", "2023-09-13", "2023-10-12", "2023-11-14", "2023-12-12", "2024-01-11", "2024-02-13", "2024-03-12", "2024-04-10", "2024-05-15", "2024-06-12", "2024-07-11", "2024-08-14", "2024-09-11", "2024-10-10", "2024-11-13", "2024-12-11", "2025-01-15", "2025-02-12", "2025-03-12", "2025-04-10", "2025-05-13", "2025-06-11", "2025-07-15", "2025-08-12", "2025-09-11", "2025-10-24", "2025-12-18", "2026-01-13", "2026-02-13", "2026-03-11", "2026-04-10", "2026-05-12", "2026-06-10", "2026-07-14", "2026-08-12", "2026-09-11", "2026-10-14", "2026-11-10"]);
const ECON_NFP = new Set(["2020-10-02", "2020-11-06", "2020-12-04", "2021-01-08", "2021-02-05", "2021-03-05", "2021-04-02", "2021-05-07", "2021-06-04", "2021-07-02", "2021-08-06", "2021-09-03", "2021-10-08", "2021-11-05", "2021-12-03", "2022-01-07", "2022-02-04", "2022-03-04", "2022-04-01", "2022-05-06", "2022-06-03", "2022-07-08", "2022-08-05", "2022-09-02", "2022-10-07", "2022-11-04", "2022-12-02", "2023-01-06", "2023-02-03", "2023-03-10", "2023-04-07", "2023-05-05", "2023-06-02", "2023-07-07", "2023-08-04", "2023-09-01", "2023-10-06", "2023-11-03", "2023-12-08", "2024-01-05", "2024-02-02", "2024-03-08", "2024-04-05", "2024-05-03", "2024-06-07", "2024-07-05", "2024-08-02", "2024-09-06", "2024-10-04", "2024-11-01", "2024-12-06", "2025-01-10", "2025-02-07", "2025-03-07", "2025-04-04", "2025-05-02", "2025-06-06", "2025-07-03", "2025-08-01", "2025-09-05", "2025-11-20", "2025-12-16", "2026-01-09", "2026-02-11", "2026-03-06", "2026-04-03", "2026-05-08", "2026-06-05", "2026-07-02", "2026-08-07", "2026-09-04", "2026-10-02", "2026-11-06"]);
const ECON_FOMC = new Set(["2021-01-27", "2021-03-17", "2021-04-28", "2021-06-16", "2021-07-28", "2021-09-22", "2021-11-03", "2021-12-15", "2022-01-26", "2022-03-16", "2022-05-04", "2022-06-15", "2022-07-27", "2022-09-21", "2022-11-02", "2022-12-14", "2023-02-01", "2023-03-22", "2023-05-03", "2023-06-14", "2023-07-26", "2023-09-20", "2023-11-01", "2023-12-13", "2024-01-31", "2024-03-20", "2024-05-01", "2024-06-12", "2024-07-31", "2024-09-18", "2024-11-07", "2024-12-18", "2025-01-29", "2025-03-19", "2025-05-07", "2025-06-18", "2025-07-30", "2025-09-17", "2025-10-29", "2025-12-10", "2026-01-28", "2026-03-18", "2026-04-29", "2026-06-17", "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09"]);
function econOn(dayStr) { const out = []; if (ECON_CPI.has(dayStr)) out.push({ hm: "08:30", name: "CPI" }); if (ECON_NFP.has(dayStr)) out.push({ hm: "08:30", name: "NFP" }); if (ECON_FOMC.has(dayStr)) out.push({ hm: "14:00", name: "FOMC" }); return out; }
/* ---------------- SMT divergence (NQ vs ES), each timeframe on its own toggle ----------------
   Swing highs/lows on closed candles only (2 left, 2 right). Bearish SMT: one symbol makes a higher high while the other makes a lower/equal high.
   Bullish SMT: one makes a lower low while the other holds a higher/equal low. Drawn on each chart in its own prices. */
const SMT_TFS = [["1m", 60], ["5m", 300], ["15m", 900], ["1h", 3600], ["4h", 14400], ["1D", 86400]];
const smtCfg = () => { const I = prefs.ind || (prefs.ind = {}); if (!I.smt) I.smt = { "1m": false, "5m": false, "15m": false, "1h": false, "4h": false, "1D": false }; return I.smt; };
const smtOn = () => Object.values(smtCfg()).some(Boolean);
const smtPartner = (s) => ((INST[s] || INST.NQ).data === "NQ" ? "ES" : "NQ");
function smtAgg(S, sec, tEnd) { const b = S["1m"], N = sec >= 86400 ? 45 : 140, from = tEnd - N * sec * (sec >= 86400 ? 1.6 : 1.5); let lo = 0, hi = b.i;
  while (lo < hi) { const m = (lo + hi) >> 1; if (b.bars[m].t < from) lo = m + 1; else hi = m; }
  const out = []; let cur = null; for (let j = lo; j <= b.i; j++) { const x = b.bars[j], k = bucket(loc(x.t), sec); if (!cur || cur.time !== k) { cur = { time: k, h: x.h, l: x.l }; out.push(cur); } else { cur.h = Math.max(cur.h, x.h); cur.l = Math.min(cur.l, x.l); } }
  out.pop(); return out; }   // drop the forming candle: no lookahead
const SMTC = {};
function smtFind(tf, sec) { const P = X[smtPartner(sym)]; if (!P || B["1m"].i < 0) return []; const key = sym + tf + B["1m"].i + ":" + P["1m"].i; if (SMTC[sym + tf] && SMTC[sym + tf].key === key) return SMTC[sym + tf].out;
  const tEnd = B["1m"].bars[B["1m"].i].t, A = smtAgg(B, sec, tEnd), Q = smtAgg(P, sec, tEnd), qm = new Map(Q.map((c, k) => [c.time, k])), out = [];
  const near = (t, f) => { const k = qm.get(t); if (k == null) return null; let v = Q[k][f]; for (const d of [-1, 1]) { const z = Q[k + d]; if (z) v = f === "h" ? Math.max(v, z.h) : Math.min(v, z.l); } return v; };
  for (const [f, cmp] of [["h", (a, b) => a > b], ["l", (a, b) => a < b]]) { const piv = [];
    for (let k = 2; k < A.length - 2; k++) { const v = A[k][f]; if (cmp(v, A[k - 1][f]) && cmp(v, A[k - 2][f]) && !cmp(A[k + 1][f], v) && !cmp(A[k + 2][f], v)) piv.push(k); }
    for (let n = Math.max(1, piv.length - 6); n < piv.length; n++) { const k1 = piv[n - 1], k2 = piv[n]; if (k2 - k1 > 40) continue;
      const a1 = A[k1][f], a2 = A[k2][f], p1 = near(A[k1].time, f), p2 = near(A[k2].time, f); if (p1 == null || p2 == null) continue;
      const aExt = cmp(a2, a1), pExt = cmp(p2, p1); if (aExt !== pExt) out.push({ f, t1: A[k1].time, v1: a1, t2: A[k2].time, v2: a2, bear: f === "h", leader: aExt ? sym : smtPartner(sym) }); } }
  SMTC[sym + tf] = { key, out }; return out; }
function paintSmt(p, g, W, H) { if (!smtOn()) return; const C = smtCfg();
  for (const [tf, sec] of SMT_TFS) { if (!C[tf] || sec < p.sec) continue;
    for (const z of smtFind(tf, sec)) { const x1 = xOf(p, z.t1), x2 = xOf(p, z.t2 + Math.max(0, sec - p.sec)), y1 = yOf(p, z.v1), y2 = yOf(p, z.v2); if (x1 == null || x2 == null || y1 == null || y2 == null || x2 < 0) continue;
      const col = z.bear ? "#ff6b7a" : "#2bd4a0"; g.save(); g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 1.6; g.setLineDash([]); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke();
      for (const [x, y] of [[x1, y1], [x2, y2]]) { g.beginPath(); g.arc(x, y, 2.6, 0, 7); g.fill(); }
      g.font = "600 10.5px Inter, sans-serif"; const tx = `SMT ${tf}`, tw = g.measureText(tx).width, lx = (x1 + x2) / 2 - tw / 2 - 5, ly = (y1 + y2) / 2 + (z.bear ? -18 : 6);
      g.fillStyle = "rgba(11,11,16,.85)"; g.fillRect(lx, ly, tw + 10, 15); g.fillStyle = col; g.fillText(tx, lx + 5, ly + 11); g.restore(); } } }
function paintEcon(p, g, W, H) { if (prefs.ind && prefs.ind.econ === false) return; const c = p.candles; if (c.length < 2 || p.sec >= 86400) return; const ts = p.chart.timeScale();
  const d0 = Math.floor(c[0].time / 86400), d1 = Math.floor(c[c.length - 1].time / 86400) + 1, last = c[c.length - 1].time;
  for (let d = d0; d <= d1; d++) { const ds = new Date(d * 86400000).toISOString().slice(0, 10); const evs = econOn(ds); for (const [ei, e] of evs.entries()) { const [h, m] = e.hm.split(":").map(Number), lt = d * 86400 + h * 3600 + m * 60;
      let x = xOf(p, lt); if (x == null && lt > last) x = ts.logicalToCoordinate(c.length - 1 + (lt - last) / p.sec); if (x == null || x < 0 || x > W) continue;
      const col = e.name === "FOMC" ? "rgba(248,113,113,.75)" : e.name === "NFP" ? "rgba(96,165,250,.85)" : "rgba(245,197,66,.8)"; g.save(); g.strokeStyle = col; g.setLineDash([3, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(x, 18); g.lineTo(x, H); g.stroke(); g.setLineDash([]);
      g.font = "600 10.5px Inter, sans-serif"; const tw = g.measureText(e.name).width, oy = evs.slice(0, ei).filter((z) => z.hm === e.hm).length * 18; g.fillStyle = col; g.beginPath(); g.roundRect(x - tw / 2 - 6, 2 + oy, tw + 12, 16, 4); g.fill(); g.fillStyle = "#0b0b10"; g.fillText(e.name, x - tw / 2, 14 + oy); g.restore(); } } }
function paintStudies(p, g, W, H) { const ps = paneSym(p); if (ps !== sym) return withSym(ps, () => paintStudies(p, g, W, H)); try { paintEcon(p, g, W, H); } catch (e) {} try { paintSmt(p, g, W, H); } catch (e) {}
  if (!prefs.ind || p.sec >= 86400 || !p.candles.length) return; const S = studies(), ts = p.chart.timeScale();
  const X = (lt) => { const x = xOf(p, lt); return x == null ? 0 : Math.max(0, x); };
  g.save(); g.font = "500 10.5px Inter, sans-serif"; paintSessBoxes(p, g, W, H);
  for (const z of S.h4) { if (p.sec >= 14400) break; const x1 = X(z.t), x2 = Math.min(W, X(z.t + 14400) || W), y1 = yOf(p, z.h), y2 = yOf(p, z.l); if (y1 == null || y2 == null || x2 <= x1) continue;
    g.strokeStyle = z.c >= z.o ? "rgba(43,212,160,.35)" : "rgba(255,107,122,.35)"; g.lineWidth = 1; g.setLineDash([]); g.strokeRect(x1, y1, x2 - x1, y2 - y1);
    const yo = yOf(p, z.o), yc = yOf(p, z.c); if (yo != null && yc != null) { g.fillStyle = z.c >= z.o ? "rgba(43,212,160,.06)" : "rgba(255,107,122,.06)"; g.fillRect(x1, Math.min(yo, yc), x2 - x1, Math.abs(yo - yc)); } }
  for (const z of S.gaps) { const y1 = yOf(p, z.top), y2 = yOf(p, z.bot); if (y1 == null || y2 == null) continue; const x1 = X(z.t0), x2 = z.t1 ? Math.min(W, X(z.t1)) : W; if (x2 <= x1) continue;
    const up = z.dir > 0, a1 = z.t1 ? 0.045 : z.ob ? 0.07 : 0.09; g.fillStyle = up ? `rgba(43,212,160,${a1})` : `rgba(255,107,122,${a1})`; g.fillRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1));
    if (z.inv || z.ob) { g.strokeStyle = up ? "rgba(43,212,160,.5)" : "rgba(255,107,122,.5)"; g.setLineDash(z.ob ? [] : [4, 3]); g.strokeRect(x1, Math.min(y1, y2), x2 - x1, Math.abs(y2 - y1)); g.setLineDash([]); }
    g.fillStyle = z.t1 ? "rgba(200,210,225,.3)" : "rgba(200,210,225,.6)"; g.fillText(z.label, x1 + 4, Math.min(y1, y2) + 11); }
  for (const l of S.levels) { const y = yOf(p, l.price); if (y == null || y < 0 || y > H) continue; const x1 = X(l.t0);
    g.strokeStyle = l.col; g.lineWidth = 1; g.setLineDash([5, 4]); g.beginPath(); g.moveTo(x1, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]); g.fillStyle = l.col; g.fillText(l.label, W - g.measureText(l.label).width - 6, y - 4); }
  // contract roll marker: data switches contracts on the session after quarterly expiry (3rd Friday of Mar/Jun/Sep/Dec), so a price gap there is the roll, not a move
  if (p.sec < 86400) { const vr = ts.getVisibleLogicalRange(); if (vr && p.candles.length) { const a0 = p.candles[Math.max(0, Math.floor(vr.from))], a1 = p.candles[Math.min(p.candles.length - 1, Math.ceil(vr.to))];
    if (a0 && a1) for (let y = new Date(a0.time * 1000).getUTCFullYear(); y <= new Date(a1.time * 1000).getUTCFullYear(); y++) for (const m of [2, 5, 8, 11]) { const f = new Date(Date.UTC(y, m, 1)), fri = 1 + ((5 - f.getUTCDay() + 7) % 7) + 14, rt = Date.UTC(y, m, fri) / 1000 + 2 * 86400 + 18 * 3600;
      if (rt < a0.time || rt > a1.time + p.sec) continue; const x = xOf(p, rt); if (x == null) continue; g.strokeStyle = "rgba(255,198,92,.45)"; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H); g.stroke(); g.setLineDash([]); g.fillStyle = "rgba(255,198,92,.8)"; g.fillText("contract roll", x + 4, 14); g.fillText("expiry (thin data)", X(rt - 2 * 86400 - 18 * 3600 + 9.5 * 3600) + 4, 26); } } }
  (S.htf || []).forEach((P, k) => { const n = S.htf.length, x = W - 22 - (n - 1 - k) * 34, yh = yOf(p, P.h), yl = yOf(p, P.l), yo = yOf(p, P.o), yc = yOf(p, P.c); if ([yh, yl, yo, yc].some((v) => v == null)) return;
    const up = P.c >= P.o; g.fillStyle = "rgba(8,10,14,.55)"; g.fillRect(x - 15, Math.min(yh, yl) - 18, 30, Math.abs(yl - yh) + 22);
    g.strokeStyle = up ? prefs.up : prefs.dn; g.lineWidth = 1.2; g.beginPath(); g.moveTo(x, yh); g.lineTo(x, yl); g.stroke();
    g.fillStyle = up ? prefs.up + "55" : prefs.dn + "55"; const top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yo - yc)); g.fillRect(x - 8, top, 16, hh); g.strokeRect(x - 8, top, 16, hh);
    g.strokeStyle = "rgba(200,210,225,.35)"; g.setLineDash([2, 3]); g.beginPath(); g.moveTo(x - 14, yo); g.lineTo(x + 14, yo); g.stroke(); g.setLineDash([]);
    g.fillStyle = "rgba(220,228,240,.85)"; g.fillText(P.tf, x - g.measureText(P.tf).width / 2, Math.min(yh, yl) - 6); });
  if (S.po3) { const P = S.po3, x = W - 26, yh = yOf(p, P.h), yl = yOf(p, P.l), yo = yOf(p, P.o), yc = yOf(p, P.c); if ([yh, yl, yo, yc].every((v) => v != null)) {
      const up = P.c >= P.o; g.strokeStyle = up ? "rgba(43,212,160,.8)" : "rgba(255,107,122,.8)"; g.fillStyle = up ? "rgba(43,212,160,.22)" : "rgba(255,107,122,.22)";
      g.beginPath(); g.moveTo(x, yh); g.lineTo(x, yl); g.stroke(); g.fillRect(x - 7, Math.min(yo, yc), 14, Math.max(1, Math.abs(yo - yc))); g.strokeRect(x - 7, Math.min(yo, yc), 14, Math.max(1, Math.abs(yo - yc)));
      g.fillStyle = "rgba(200,210,225,.6)"; g.fillText("D", x - 3, yh - 5); } }
  g.restore();
}
/* fix 6: everything we draw lives INSIDE the chart's own render pass (series primitives), so shading, studies and drawings move with the candles on every drag/zoom frame instead of trailing behind. */
function drawShade(p, g, W, H) {
    { const C = csG(); if (C.brk && p.sec < 86400 && p.candles.length) { const ts = p.chart.timeScale(), vr = ts.getVisibleLogicalRange(); if (vr) { g.save(); g.strokeStyle = _rgba(C.brkc, 0.55); g.setLineDash([4, 4]); g.lineWidth = 1;   // KING_CS2: session breaks at 18:00 NY
      const from = Math.max(1, Math.floor(vr.from)), to = Math.min(p.candles.length - 1, Math.ceil(vr.to)), dn = (t) => Math.floor((t - 18 * 3600) / 86400);
      for (let k = from; k <= to; k++) if (dn(p.candles[k].time) !== dn(p.candles[k - 1].time)) { const x = ts.logicalToCoordinate(k); if (x != null) { g.beginPath(); g.moveTo(Math.round(x - (ts.options().barSpacing || 6) / 2) + 0.5, 0); g.lineTo(Math.round(x - (ts.options().barSpacing || 6) / 2) + 0.5, H); g.stroke(); } }
      g.restore(); } } }
    if (prefs.sess && p.sec < 14400 && p.candles.length) {
      const ts = p.chart.timeScale(), vr = ts.getVisibleLogicalRange(); if (vr) { let s0 = null; const from = Math.max(0, Math.floor(vr.from)), to = Math.min(p.candles.length - 1, Math.ceil(vr.to));
        g.fillStyle = "rgba(122,167,255,.04)";
        for (let k = from; k <= to + 1; k++) { const c = p.candles[k], inS = c && lhm(c.time) >= "09:30" && lhm(c.time) < "16:00";
          if (inS && s0 == null) s0 = k; if ((!inS || k === to + 1) && s0 != null) { const x1 = ts.logicalToCoordinate(s0) - 0.5 * (ts.logicalToCoordinate(s0 + 1) - ts.logicalToCoordinate(s0)), x2 = ts.logicalToCoordinate(k) - 0.5 * (ts.logicalToCoordinate(k + 1) - ts.logicalToCoordinate(k)); if (x1 != null && x2 != null) g.fillRect(x1, 0, x2 - x1, H); s0 = null; } } } }
}
function drawOverlay(p, g, W, H) {
    try { paintStudies(p, g, W, H); } catch (e) {}
    const all = prefs.hideDraw ? [] : drawings.filter((d) => d.pane === p.i || (SHARED.includes(d.type) && paneSym(d.pane) === paneSym(p)));
    if (pend && pend.pane === p.i && pend.b) all.push({ ...pend.d, b: pend.b, preview: true });
    p._ax = null; for (const d of all) { try { drawOne(p, g, d, W, H); } catch (e) {} }
    const k = p._ax ? p._ax.join(",") : ""; if (k !== (p._axK || "")) { p._axK = k; setTimeout(() => axisSync(p), 0); }
}
class OverlayPrim {
  constructor(p) { const view = (z, fn) => ({ zOrder: () => z, renderer: () => ({ draw: (t) => t.useMediaCoordinateSpace(({ context, mediaSize }) => { try { context.save(); fn(p, context, mediaSize.width, mediaSize.height); context.restore(); } catch (e) {} }) }) });
    this.views = [view("bottom", drawShade), view("top", drawOverlay)]; }
  attached({ requestUpdate }) { this.req = requestUpdate; } detached() { this.req = null; } paneViews() { return this.views; } updateAllViews() {}
}
function paint(p) {   // data speed: Fast = every frame, Balanced ~30 fps, Lite ~10 fps
  if (p && !p.dead && !p._csT) p._csT = setTimeout(() => { p._csT = 0; try { csLines(p); } catch (e) {} }, 250);
  if (!p || p.dead) return; const gap = { balanced: 33, lite: 100 }[prefs.speed] || 0; if (gap) { const w = gap - (performance.now() - (p.lastPaint || 0)); if (w > 0) { if (!p.pt) p.pt = setTimeout(() => { p.pt = 0; paint(p); }, w); return; } p.lastPaint = performance.now(); }
  if (!p.prim) { p.prim = new OverlayPrim(p); p.series.attachPrimitive(p.prim); if (p.cv) { const g = p.cv.getContext("2d"); g.clearRect(0, 0, p.cv.width, p.cv.height); } }
  if (p.dead) return; try { p.prim.req && p.prim.req(); } catch (e) {}
}
function drawOne(p, g, d, W, H) {
  const on = (sel && sel.id === d.id) || (hov && hov.id === d.id); g.lineWidth = (d.w || 1.4) + (on ? 0.6 : 0); g.font = "11px Inter, sans-serif"; g.setLineDash([]);
  const gold = d.color || "#2962ff", blue = "rgba(122,167,255,.95)"; g.strokeStyle = gold; g.fillStyle = gold;
  const DASH = { dash: [7, 5], dot: [2, 4] }; if (DASH[d.dash] && !["long", "short", "measure"].includes(d.type)) g.setLineDash(DASH[d.dash]);
  if (d.label && !["long", "short", "measure", "text"].includes(d.type)) { const lx = d.type === "hline" ? 8 : Math.min(xOf(p, d.a.t) ?? 0, xOf(p, d.b.t) ?? W), ly = Math.min(yOf(p, d.a.p) ?? 0, yOf(p, d.b.p) ?? yOf(p, d.a.p) ?? 0); g.save(); g.setLineDash([]); g.font = "600 11px Inter, sans-serif"; const lw = g.measureText(d.label).width + 12, bx = lx + 4, by = ly - 22; g.fillStyle = gold; g.globalAlpha = 0.92; g.beginPath(); (g.roundRect ? g.roundRect(bx, by, lw, 17, 4) : g.rect(bx, by, lw, 17)); g.fill(); g.globalAlpha = 1; g.fillStyle = "#fff"; g.fillText(d.label, bx + 6, by + 12.5); g.restore(); }   // KING_TOOLRAIL: label as a pill
  const x1 = xOf(p, d.a.t), y1 = yOf(p, d.a.p), x2 = xOf(p, d.b.t), y2 = yOf(p, d.b.p); if (y1 == null) return;
  if (on && !d.preview && !["long", "short", "measure", "text", "vline"].includes(d.type)) p._ax = d.type === "hline" || d.type === "hray" ? [d.a.p] : [d.a.p, d.b.p];   // KING_AXISLBL
  if (sel && sel.id === d.id && !d.label && ["trend", "ray", "arrow"].includes(d.type) && x2 != null && y2 != null && Math.hypot(x2 - x1, y2 - y1) > 60) { const mx = (x1 + x2) / 2, my = (y1 + y2) / 2; let an = Math.atan2(y2 - y1, x2 - x1); if (an > Math.PI / 2) an -= Math.PI; if (an < -Math.PI / 2) an += Math.PI;
    g.save(); g.translate(mx, my); g.rotate(an); g.font = "500 11.5px Inter, sans-serif"; g.fillStyle = /^#|^rgb/.test(d.color || "") ? d.color : "#2962ff"; g.globalAlpha = 0.85; g.textAlign = "center"; g.fillText("+ Add text", 0, -7); g.restore(); d._addAt = [mx, my]; } else d._addAt = null;   // KING_ADDTEXT
  const dot = (x, y) => { if (on && x != null && y != null) { g.save(); g.setLineDash([]); g.beginPath(); g.arc(x, y, 5, 0, 7); g.fillStyle = "#ffffff"; g.fill(); g.strokeStyle = /^#|^rgb/.test(gold) ? gold : "#2962ff"; g.lineWidth = 1.6; g.stroke(); g.restore(); g.strokeStyle = gold; g.fillStyle = gold; } };
  if (d.type === "measure") { if (x1 == null || x2 == null || y2 == null) return; const up = d.b.p >= d.a.p; g.fillStyle = up ? "rgba(43,212,160,.13)" : "rgba(255,107,122,.13)";
    g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); const pts = d.b.p - d.a.p, bars = Math.round((d.b.t - d.a.t) / p.sec);
    g.fillStyle = "#e6eaf0"; g.fillText(`${pts >= 0 ? "+" : ""}${pts.toFixed(2)} pts · ${money(Math.abs(pts) * inst.pt)}/lot · ${(Math.abs(pts) / (prefs.slPts || 1)).toFixed(2)}R · ${bars} bars`, Math.min(x1, x2) + 4, Math.min(y1, y2) - 6); return; }
  if (d.type === "trend" || d.type === "ray") { if (x1 == null || x2 == null || y2 == null) return; let ex = x2, ey = y2;
    if (d.type === "ray" && x2 !== x1) { const k = ((x2 > x1 ? W : 0) - x1) / (x2 - x1); if (k > 1) { ex = x1 + (x2 - x1) * k; ey = y1 + (y2 - y1) * k; } }
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(ex, ey); g.stroke(); dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "arrow") { if (x1 == null || x2 == null || y2 == null) return; const an = Math.atan2(y2 - y1, x2 - x1), L = 11;
    g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); g.beginPath(); g.moveTo(x2, y2); g.lineTo(x2 - L * Math.cos(an - 0.45), y2 - L * Math.sin(an - 0.45)); g.lineTo(x2 - L * Math.cos(an + 0.45), y2 - L * Math.sin(an + 0.45)); g.closePath(); g.fill(); dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "channel") { if (x1 == null || x2 == null || y2 == null) return; const o = chOff(d), u1 = yOf(p, d.a.p + o), u2 = yOf(p, d.b.p + o), m1 = yOf(p, d.a.p + o / 2), m2 = yOf(p, d.b.p + o / 2); if (u1 == null || u2 == null) return;
    const rc = /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#7aa7ff"; g.fillStyle = rc + Math.round(((d.fill ?? 8) / 100) * 255).toString(16).padStart(2, "0"); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.lineTo(x2, u2); g.lineTo(x1, u1); g.closePath(); g.fill();
    g.strokeStyle = gold; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.moveTo(x1, u1); g.lineTo(x2, u2); g.stroke(); g.save(); g.setLineDash([4, 4]); g.globalAlpha = 0.6; g.beginPath(); g.moveTo(x1, m1); g.lineTo(x2, m2); g.stroke(); g.restore();
    dot(x1, y1); dot(x2, y2); dot((x1 + x2) / 2, (u1 + u2) / 2); return; }
  if (d.type === "pitchfork") { const c = d.c || { t: d.b.t + p.sec * 10, p: d.a.p - (d.b.p - d.a.p) * 0.6 }, x3 = xOf(p, c.t), y3 = yOf(p, c.p); if (x1 == null || x2 == null || y2 == null || x3 == null || y3 == null) return;
    const mx = (x2 + x3) / 2, my = (y2 + y3) / 2, dx = mx - x1, dy = my - y1; if (Math.abs(dx) < 1) return; const k = dy / dx, ext = (x0, y0) => [W, y0 + k * (W - x0)];
    const rc = /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#7aa7ff", [ex2, ey2] = ext(x2, y2), [ex3, ey3] = ext(x3, y3), [emx, emy] = ext(x1, y1);
    g.fillStyle = rc + Math.round(((d.fill ?? 8) / 100) * 255).toString(16).padStart(2, "0"); g.beginPath(); g.moveTo(x2, y2); g.lineTo(ex2, ey2); g.lineTo(ex3, ey3); g.lineTo(x3, y3); g.closePath(); g.fill();
    g.strokeStyle = gold; g.beginPath(); g.moveTo(x1, y1); g.lineTo(emx, emy); g.moveTo(x2, y2); g.lineTo(ex2, ey2); g.moveTo(x3, y3); g.lineTo(ex3, ey3); g.stroke();
    g.save(); g.setLineDash([3, 4]); g.globalAlpha = 0.6; g.beginPath(); g.moveTo(x2, y2); g.lineTo(x3, y3); g.stroke(); g.restore(); dot(x1, y1); dot(x2, y2); dot(x3, y3); return; }
  if (d.type === "fibext") { if (x1 == null || y2 == null) return; const xa = Math.min(x1, x2 ?? x1);
    g.save(); g.setLineDash([3, 4]); g.globalAlpha = 0.6; g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2 ?? x1, y2); g.stroke(); g.restore();
    for (const [f, lab] of FIBX) { const pr = d.a.p + (d.b.p - d.a.p) * f, y = yOf(p, pr); if (y == null) continue; g.strokeStyle = f === 1.618 || f === 1.272 ? blue : f === 1 || f === 0 ? "rgba(255,255,255,.6)" : "rgba(255,206,120,.55)"; g.setLineDash(f === 0 || f === 1 ? [] : [4, 4]);
      g.beginPath(); g.moveTo(xa, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]); g.fillStyle = g.strokeStyle; g.fillText(`${lab}  ${px2(pr)}`, xa + 4, y - 3); }
    g.strokeStyle = gold; dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "prange" || d.type === "drange") { if (x1 == null || x2 == null || y2 == null) return; const v = d.type === "prange", up = d.b.p >= d.a.p;
    g.fillStyle = v ? (up ? "rgba(43,212,160,.10)" : "rgba(255,107,122,.10)") : "rgba(122,167,255,.10)"; g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
    g.strokeStyle = v ? (up ? "#2bd4a0" : "#ff6b7a") : "#7aa7ff"; g.beginPath(); if (v) { const xm = (x1 + x2) / 2; g.moveTo(xm, y1); g.lineTo(xm, y2); } else { const ym = (y1 + y2) / 2; g.moveTo(x1, ym); g.lineTo(x2, ym); } g.stroke();
    const pts = d.b.p - d.a.p, secs = Math.abs(d.b.t - d.a.t), bars = Math.round(secs / p.sec), dur = secs >= 86400 ? (secs / 86400).toFixed(1) + "d" : secs >= 3600 ? Math.floor(secs / 3600) + "h " + Math.round((secs % 3600) / 60) + "m" : Math.round(secs / 60) + "m";
    const txt = v ? `${pts >= 0 ? "+" : ""}${pts.toFixed(2)} pts · ${((pts / d.a.p) * 100).toFixed(2)}% · ${money(Math.abs(pts) * inst.pt)}/lot` : `${bars} bars · ${dur}`;
    g.font = "600 11px Inter, sans-serif"; const tw = g.measureText(txt).width, tx = (x1 + x2) / 2 - tw / 2 - 6, ty = (v ? Math.min(y1, y2) : Math.max(y1, y2)) + (v ? -22 : 6);
    g.fillStyle = "rgba(12,16,22,.88)"; g.fillRect(tx, ty, tw + 12, 17); g.fillStyle = "#e6eaf0"; g.fillText(txt, tx + 6, ty + 12); dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "ellipse") { if (x1 == null || x2 == null || y2 == null) return; const rc = /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#7aa7ff";
    g.beginPath(); g.ellipse((x1 + x2) / 2, (y1 + y2) / 2, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2, 0, 0, 7); g.fillStyle = rc + Math.round(((d.fill ?? 10) / 100) * 255).toString(16).padStart(2, "0"); g.fill(); g.strokeStyle = d.color || rc; g.stroke(); dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "hline") { g.beginPath(); g.moveTo(0, y1); g.lineTo(W, y1); g.stroke(); g.fillText(px2(d.a.p), W - 60, y1 - 4); return; }
  if (d.type === "hray") { if (x1 == null) return; g.beginPath(); g.moveTo(x1, y1); g.lineTo(W, y1); g.stroke(); dot(x1, y1); return; }
  if (d.type === "vline") { if (x1 == null) return; g.beginPath(); g.moveTo(x1, 0); g.lineTo(x1, H); g.stroke(); return; }
  if (d.type === "text") { if (x1 == null) return; g.font = "600 12px Geist, sans-serif"; g.fillStyle = "#e6eaf0"; g.fillText(d.text, x1, y1); return; }
  if (d.type === "rect") { if (x1 == null || x2 == null || y2 == null) return; const rc = /^#[0-9a-f]{6}$/i.test(d.color || "") ? d.color : "#7aa7ff"; g.fillStyle = rc + Math.round(((d.fill ?? 10) / 100) * 255).toString(16).padStart(2, "0"); g.strokeStyle = d.color ? rc : blue;
    g.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); g.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "fib") { if (y2 == null) return; const xa = Math.min(x1 ?? 0, x2 ?? W);
    for (const [f, lab] of fibList()) { const pr = d.b.p + (d.a.p - d.b.p) * f, y = yOf(p, pr); if (y == null) continue;
      g.strokeStyle = [0.79, 0.62, 0.705].includes(f) ? blue : f === 0.5 ? "rgba(255,255,255,.6)" : "rgba(255,206,120,.55)"; g.setLineDash(f === 0 || f === 1 ? [] : [4, 4]);
      g.beginPath(); g.moveTo(xa, y); g.lineTo(W, y); g.stroke(); g.setLineDash([]); g.fillStyle = g.strokeStyle; g.fillText(`${lab}  ${px2(pr)}`, xa + 4, y - 3); }
    g.strokeStyle = gold; dot(x1, y1); dot(x2, y2); return; }
  if (d.type === "long" || d.type === "short") {
    const xa = x1 ?? 0, xb = x2 ?? W, ye = yOf(p, d.entry), ys = yOf(p, d.sl), yt = yOf(p, d.tp); if (ye == null || ys == null || yt == null) return;
    const live = d.state === "armed" || d.state === "filled", done = d.state === "done";
    g.fillStyle = `rgba(43,212,160,${done ? 0.06 : live ? 0.22 : 0.14})`; g.fillRect(xa, Math.min(ye, yt), xb - xa, Math.abs(yt - ye));
    g.fillStyle = `rgba(255,107,122,${done ? 0.06 : live ? 0.22 : 0.14})`; g.fillRect(xa, Math.min(ye, ys), xb - xa, Math.abs(ys - ye));
    g.strokeStyle = live ? "#fff" : "rgba(255,255,255,.6)"; g.setLineDash(d.state === "armed" ? [6, 4] : []); g.beginPath(); g.moveTo(xa, ye); g.lineTo(xb, ye); g.stroke(); g.setLineDash([]);
    const risk = Math.abs(d.entry - d.sl), q = posQty(d), rr = Math.abs(d.tp - d.entry) / (risk || 1);
    const tag = d.state === "armed" ? "ARMED · auto-entry" : d.state === "filled" ? "IN TRADE" : d.state === "done" ? "DONE" : "right-click → Arm";
    const label = `${d.side > 0 ? "LONG" : "SHORT"} ${q} @ ${px2(d.entry)} · ${rr.toFixed(2)}R · risk ${money(risk * q * inst.pt)} · ${tag}`;
    // KING_POSSTYLE (Nov 11): position labels styled like the trade panel (Inter, rounded pills, solid green / red like the Buy / Sell buttons)
    const pill = (txt, x, y, bg, fg, bold) => { g.font = (bold ? "700" : "600") + " 11.5px Inter, sans-serif"; const w = g.measureText(txt).width + 16, h = 20; g.fillStyle = bg; g.beginPath(); (g.roundRect ? g.roundRect(x, y, w, h, 6) : g.rect(x, y, w, h)); g.fill(); g.fillStyle = fg; g.fillText(txt, x + 8, y + 14); return w; };
    const head = `${d.side > 0 ? "Long" : "Short"} ${q} @ ${px2(d.entry)}`, sub = `${rr.toFixed(2)}R · risk ${money(risk * q * inst.pt)} · ${tag}`;
    if (!on) return;   // KING_POSHOVER (Nov 12 walkthrough): the text pills only show while you hover or select the position
    const hw = pill(head, xa + 6, ye - 24, d.side > 0 ? "#2bd4a0" : "#ff5d6c", "#06110c", true); pill(sub, xa + 10 + hw, ye - 24, "rgba(16,20,28,.92)", "#dfe5ee");
    const tpTxt = `Target ${px2(d.tp)} · +${money(Math.abs(d.tp - d.entry) * q * inst.pt)}`, slTxt = `Stop ${px2(d.sl)} · -${money(risk * q * inst.pt)}`;
    pill(tpTxt, xa + 6, d.side > 0 ? yt + 4 : yt - 24, "rgba(43,212,160,.9)", "#06110c", true);
    pill(slTxt, xa + 6, d.side > 0 ? ys - 24 : ys + 4, "rgba(255,93,108,.9)", "#1a0508", true);
    [[xb, ye], [xb, ys], [xb, yt], [xa, ye]].forEach(([x, y]) => dot(x, y));
  }
}
function posQty(d) { if (d.qty) return d.qty; const risk = Math.abs(d.entry - d.sl) || 1; if (prefs.byRisk) return Math.max(1, Math.floor((balance() * prefs.riskp / 100) / (risk * inst.pt))); return lotsNow(); }
function hitDrawing(p, x, y) {
  const near = (ax, ay, bx, by) => { if (ax == null || bx == null || ay == null || by == null) return 1e9; const l2 = (bx - ax) ** 2 + (by - ay) ** 2; let t = l2 ? ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / l2 : 0; t = Math.max(0, Math.min(1, t)); return Math.hypot(x - (ax + t * (bx - ax)), y - (ay + t * (by - ay))); };
  for (const d of drawings.slice().reverse()) {
    if (!(d.pane === p.i || (SHARED.includes(d.type) && paneSym(d.pane) === paneSym(p)))) continue; const x1 = xOf(p, d.a.t), y1 = yOf(p, d.a.p), x2 = xOf(p, d.b.t), y2 = yOf(p, d.b.p);
    if (d.type === "long" || d.type === "short") { const ye = yOf(p, d.entry), ys = yOf(p, d.sl), yt = yOf(p, d.tp), xa = x1 ?? 0, xb = x2 ?? 9999;
      if (x >= xa - 6 && x <= xb + 8) { if (Math.abs(y - ys) < 7) return { d, h: "sl" }; if (Math.abs(y - yt) < 7) return { d, h: "tp" }; if (Math.abs(y - ye) < 7) return { d, h: Math.abs(x - xb) < 10 ? "w" : "entry" };
        if (y > Math.min(ys, yt) && y < Math.max(ys, yt)) return { d, h: "move" }; } continue; }
    if (d.type === "hline") { if (Math.abs(y - y1) < 6) return { d, h: "a" }; continue; }
    if (d.type === "vline") { if (x1 != null && Math.abs(x - x1) < 6) return { d, h: "a" }; continue; }
    if (x1 != null && Math.hypot(x - x1, y - y1) < 8) return { d, h: "a" }; if (x2 != null && y2 != null && Math.hypot(x - x2, y - y2) < 8) return { d, h: "b" };
    if (d.type === "pitchfork" && d.c) { const x3 = xOf(p, d.c.t), y3 = yOf(p, d.c.p); if (x3 != null && y3 != null && Math.hypot(x - x3, y - y3) < 8) return { d, h: "pc" }; if (x1 != null && x2 != null && y2 != null && x3 != null && y3 != null && near(x1, y1, (x2 + x3) / 2, (y2 + y3) / 2) < 6) return { d, h: "move" }; }
    if (d.type === "channel" && x1 != null && x2 != null) { const o = chOff(d), u1 = yOf(p, d.a.p + o), u2 = yOf(p, d.b.p + o); if (u1 != null && u2 != null) { if (Math.hypot(x - (x1 + x2) / 2, y - (u1 + u2) / 2) < 8) return { d, h: "c" }; if (near(x1, y1, x2, y2) < 6 || near(x1, u1, x2, u2) < 6) return { d, h: "move" }; } }
    if (["trend", "ray", "arrow"].includes(d.type) && near(x1, y1, x2, y2) < 6) return { d, h: "move" };
    if (["prange", "drange", "ellipse"].includes(d.type) && x1 != null && x2 != null && x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return { d, h: "move" };
    if (d.type === "fibext" && y2 != null) for (const [f] of FIBX) { const yy = yOf(p, d.a.p + (d.b.p - d.a.p) * f); if (yy != null && Math.abs(y - yy) < 5 && x >= Math.min(x1 ?? 0, x2 ?? 0)) return { d, h: "move" }; }
    if (d.type === "hray" && x1 != null && Math.abs(y - y1) < 6 && x >= x1) return { d, h: "move" };
    if ((d.type === "rect" || d.type === "measure") && x1 != null && x2 != null && x >= Math.min(x1, x2) && x <= Math.max(x1, x2) && y >= Math.min(y1, y2) && y <= Math.max(y1, y2)) return { d, h: "move" };
    if (d.type === "fib" && y2 != null) for (const [f] of fibList()) { const yy = yOf(p, d.b.p + (d.a.p - d.b.p) * f); if (yy != null && Math.abs(y - yy) < 5 && x >= Math.min(x1 ?? 0, x2 ?? 0)) return { d, h: "move" }; }
    if (d.type === "text" && x1 != null && x >= x1 - 4 && x <= x1 + 140 && Math.abs(y - y1 + 4) < 10) return { d, h: "move" };
  }
  return null;
}
function hitLine(p, y) { for (const l of p.lines) { if (l.kind === "pos") continue; const ly = yOf(p, l.price); if (ly != null && Math.abs(ly - y) < 7) return l; } return null; }
function initPointer(p) {
  let drag = null;
  const pt = (e) => { const r = p.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const hold = (on) => p.chart.applyOptions({ handleScroll: !on, handleScale: !on });
  p.el.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.target.closest(".ptitle,.lname")) return; const { x, y } = pt(e); hideCtx();
    if (tool !== "cursor" && tool !== "cross") {
      const a = { t: tOf(p, x), p: pOf(p, y, x) }; if (a.t == null || a.p == null) return;
      if (["hline", "vline", "hray", "text", "long", "short"].includes(tool)) { newDrawing(tool, p, a); if (!e.shiftKey) setTool("cursor"); repaintAll(); e.stopPropagation(); e.preventDefault(); return; }
      pend = { pane: p.i, d: { id: 0, type: tool, pane: p.i, a }, b: a }; hold(true); p.el.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); return;
    }
    const l = hitLine(p, y); if (l) { drag = { kind: "line", l }; hold(true); p.el.setPointerCapture(e.pointerId); e.stopPropagation(); e.preventDefault(); return; }
    const h = hitDrawing(p, x, y); if (h && h.d.locked) { sel = h.d; repaintAll(); dtbShow(p); e.stopPropagation(); e.preventDefault(); return; }
    if (h) { sel = h.d; dtbShow(p); drag = { kind: "draw", h, a0: { t: tOf(p, x), p: pOf(p, y) }, snap: JSON.parse(JSON.stringify(h.d)) }; hold(true); p.el.setPointerCapture(e.pointerId); repaintAll(); e.stopPropagation(); e.preventDefault(); return; }
    if (sel) { sel = null; repaintAll(); }
  }, true);
  p.el.addEventListener("pointermove", (e) => {
    const { x, y } = pt(e);
    if (pend && pend.pane === p.i) { const t = tOf(p, x), pr = pOf(p, y, x); if (t != null && pr != null) pend.b = { t, p: pr }; paint(p); return; }
    if (!drag) { if (tool === "cursor") { const l = hitLine(p, y), h = !l && hitDrawing(p, x, y); p.el.style.cursor = l ? "ns-resize" : h ? (h.d.locked ? "pointer" : h.h === "move" ? "move" : h.h === "w" ? "ew-resize" : "pointer") : ""; const nh = h ? h.d : null; if (nh !== hov) { hov = nh; repaintAll(); dtbShow(p); } } return; }
    const pr = pOf(p, y, x), tt = tOf(p, x); if (pr == null || tt == null) return;
    if (drag.kind === "line") { const l = drag.l; l.price = pr; l.ref.applyOptions({ price: pr }); if (l.kind === "sl") pos.sl = pr; else if (l.kind === "tp") pos.tp = pr; else if (l.obj) l.obj.price = pr; if (l.kind === "draft") $("o-px").value = pr; return; }
    const { h, snap, a0 } = drag, d = h.d, dp = pr - a0.p, dt = tt - a0.t;
    if (d.type === "long" || d.type === "short") {
      if (h.h === "sl") d.sl = pr; else if (h.h === "tp") d.tp = pr; else if (h.h === "entry") d.entry = pr; else if (h.h === "w") d.b.t = Math.max(d.a.t + p.sec, tt);
      else { d.entry = rnd(snap.entry + dp); d.sl = rnd(snap.sl + dp); d.tp = rnd(snap.tp + dp); d.a.t = snap.a.t + dt; d.b.t = snap.b.t + dt; }
      syncTool(d);
    } else if (h.h === "pc") d.c = { t: tt, p: pr }; else if (h.h === "c") d.off = pr - lineAt(d, (d.a.t + d.b.t) / 2); else if (h.h === "a") d.a = { t: tt, p: pr }; else if (h.h === "b") d.b = { t: tt, p: pr };
    else { d.a = { t: snap.a.t + dt, p: rnd(snap.a.p + dp) }; d.b = { t: snap.b.t + dt, p: rnd(snap.b.p + dp) }; if (snap.c) d.c = { t: snap.c.t + dt, p: rnd(snap.c.p + dp) }; }
    repaintAll();
  });
  const up = (e) => {
    if (pend && pend.pane === p.i) { const d = pend.d, b = pend.b; pend = null; hold(false);
      if (b && (b.p !== d.a.p || Math.abs(b.t - d.a.t) >= p.sec)) { const n = newDrawing(d.type, p, d.a, b); if (n.type === "measure") setTimeout(() => { drawings = drawings.filter((z) => z !== n); repaintAll(); }, 8000); }
      if (!e.shiftKey) setTool("cursor"); repaintAll(); return; }
    if (!drag) return; hold(false);
    if (drag.kind === "line") { const l = drag.l; if (l.kind === "sl" && pos.qty) pos.risk = Math.abs(pos.avg - pos.sl) || pos.risk; if (l.kind === "ord" && l.obj.tool) { const d = drawings.find((z) => z.id === l.obj.tool); if (d) d.entry = l.obj.price; } drawOrders(); refresh(); }
    drag = null; repaintAll();
  };
  p.el.addEventListener("pointerup", up); p.el.addEventListener("pointercancel", up);
  p.el.addEventListener("contextmenu", (e) => { e.preventDefault(); const { x, y } = pt(e); setActive(p.i); chartMenu(p, x, y, e.clientX, e.clientY); });
}
function repaintAll() { panes.forEach(htfRoom); panes.forEach(paint); }
function htfRoom(p) {   // keep empty space on the right for the HTF candles so they never sit on top of live candles
  if (p.dead || p.sec >= 86400) return; const n = prefs.ind && !p.noHtf ? (prefs.ind.htfc || []).length : 0, ts = p.chart.timeScale(), sp = ts.options().barSpacing || 6, want = n ? Math.ceil((n * 34 + 26) / sp) + 3 : +((prefs.cs && prefs.cs.mr) ?? 12);
  // KING_NOSNAP (Nov 12): rightOffset only applies while you're parked at the live edge. Setting it scrolls the chart,
  // so after a mouse-anchored zoom (barSpacing changed -> new want) it used to snap the newest price back to the right.
  if (p.rOff !== want) { const sp0 = ts.scrollPosition(); if (p.rOff == null || Math.abs(sp0 - p.rOff) < 1.5) { p.rOff = want; ts.applyOptions({ rightOffset: want }); } } }

/* ---------------- indicator library (price-only: our data has no volume, so no VWAP) ---------------- */
const MA_DEF = [{ k: "e9", type: "ema", len: 9, color: "#f5c542" }, { k: "e21", type: "ema", len: 21, color: "#7aa7ff" }, { k: "e50", type: "ema", len: 50, color: "#c084fc" }, { k: "s200", type: "sma", len: 200, color: "#e5e7eb" }];
const indCfg = () => { const I = prefs.ind || (prefs.ind = {}); if (!I.ma) I.ma = MA_DEF.map((m) => ({ ...m, on: false })); if (!I.bb) I.bb = { on: false, len: 20, mult: 2 }; if (!I.rsi) I.rsi = { on: false, len: 14 }; if (!I.atr) I.atr = { on: false, len: 14 }; return I; };
function indSeries(p) { const I = indCfg(); p.ind = p.ind || {}; const want = {};
  for (const m of I.ma) if (m.on) want[m.k] = { color: m.color, w: 1.5 };
  if (I.bb.on) { want.bbu = { color: "rgba(122,167,255,.75)", w: 1 }; want.bbm = { color: "rgba(122,167,255,.45)", w: 1, dash: 2 }; want.bbl = { color: "rgba(122,167,255,.75)", w: 1 }; }
  for (const k of Object.keys(p.ind)) if (!want[k] || p.ind[k].color !== want[k].color) { try { p.chart.removeSeries(p.ind[k].s); } catch (e) {} delete p.ind[k]; }
  for (const [k, o] of Object.entries(want)) if (!p.ind[k]) p.ind[k] = { color: o.color, v: [], s: p.chart.addLineSeries({ color: o.color, lineWidth: o.w, lineStyle: o.dash || 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }) }; }
function indVal(p, k, i) { const I = indCfg(), c = p.candles, cl = (j) => c[j].close;
  const m = I.ma.find((z) => z.k === k);
  if (m) { if (i < m.len - 1) return null; if (m.type === "ema") { const prev = p.ind[k].v[i - 1]; if (prev == null) { let s = 0; for (let j = i - m.len + 1; j <= i; j++) s += cl(j); return s / m.len; } const a = 2 / (m.len + 1); return a * cl(i) + (1 - a) * prev; }
    let s = 0; for (let j = i - m.len + 1; j <= i; j++) s += cl(j); return s / m.len; }
  if (k.startsWith("bb")) { const n = I.bb.len; if (i < n - 1) return null; let s = 0; for (let j = i - n + 1; j <= i; j++) s += cl(j); const mu = s / n; if (k === "bbm") return mu; let v = 0; for (let j = i - n + 1; j <= i; j++) v += (cl(j) - mu) ** 2; const sd = Math.sqrt(v / n); return k === "bbu" ? mu + I.bb.mult * sd : mu - I.bb.mult * sd; }
  return null; }
function oscAt(p, i) {   // Wilder RSI + ATR, kept as running state so each replay step is cheap
  const I = indCfg(), c = p.candles, o = (p.osc = p.osc || { g: [], l: [], tr: [] }), n = I.rsi.len, na = I.atr.len;
  if (i === 0) { o.g[0] = o.l[0] = 0; o.tr[0] = c[0].high - c[0].low; return; }
  const ch = c[i].close - c[i - 1].close, tr = Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
  o.g[i] = i < n ? (o.g[i - 1] * (i - 1) + Math.max(ch, 0)) / i : (o.g[i - 1] * (n - 1) + Math.max(ch, 0)) / n;
  o.l[i] = i < n ? (o.l[i - 1] * (i - 1) + Math.max(-ch, 0)) / i : (o.l[i - 1] * (n - 1) + Math.max(-ch, 0)) / n;
  o.tr[i] = i < na ? (o.tr[i - 1] * i + tr) / (i + 1) : (o.tr[i - 1] * (na - 1) + tr) / na; }
function oscLegend(p) { const I = indCfg(), el = p.el.querySelector(".ivals"); if (!el) return; const i = p.candles.length - 1, o = p.osc; if (i < 1 || !o) { el.innerHTML = ""; return; }
  const parts = []; if (I.rsi.on) { const rs = o.l[i] ? o.g[i] / o.l[i] : 100, r = o.l[i] ? 100 - 100 / (1 + rs) : 100; parts.push(`RSI ${I.rsi.len} <b class="${r >= 70 ? "pos-dn" : r <= 30 ? "pos-up" : ""}">${r.toFixed(1)}</b>`); }
  if (I.atr.on) parts.push(`ATR ${I.atr.len} <b>${o.tr[i].toFixed(2)}</b>`);
  for (const m of I.ma) if (m.on && p.ind && p.ind[m.k]) { const v = p.ind[m.k].v[i]; if (v != null) parts.push(`<span style="color:${m.color}">${m.type.toUpperCase()} ${m.len}</span> <b>${px2(v)}</b>`); }
  el.innerHTML = parts.join(" · "); }
function indFull(p) { if (!p || p.dead) return; indSeries(p); const I = indCfg(), n = p.candles.length; p.osc = null;
  for (const [k, z] of Object.entries(p.ind)) { z.v = []; const out = []; for (let i = 0; i < n; i++) { const v = indVal(p, k, i); z.v[i] = v; if (v != null) out.push({ time: p.candles[i].time, value: v }); } z.s.setData(out); }
  if (I.rsi.on || I.atr.on) for (let i = 0; i < n; i++) oscAt(p, i); oscLegend(p); }
function indTick(p) { if (!p || p.dead || !p.ind) return; const I = indCfg(), n = p.candles.length, i = n - 1; if (i < 0) return;
  for (const [k, z] of Object.entries(p.ind)) { if (z.v.length < i) { indFull(p); return; } const v = indVal(p, k, i); z.v[i] = v; z.v.length = n; if (v != null) z.s.update({ time: p.candles[i].time, value: v }); }
  if (I.rsi.on || I.atr.on) { if (!p.osc || p.osc.g.length < i) { p.osc = null; for (let j = 0; j < n; j++) oscAt(p, j); } else oscAt(p, i); } oscLegend(p); }
function maDlg() { const I = indCfg();
  dlg(`<h3>Moving averages, bands &amp; oscillators</h3><div class="tiny muted">Price-only. Our replay data has no volume, so VWAP and volume indicators aren't available.</div>
    ${I.ma.map((m, k) => `<div class="row2"><label class="ck"><input type="checkbox" id="ma-on${k}" ${m.on ? "checked" : ""}> <select id="ma-t${k}"><option value="ema" ${m.type === "ema" ? "selected" : ""}>EMA</option><option value="sma" ${m.type === "sma" ? "selected" : ""}>SMA</option></select></label><label>Length<input id="ma-l${k}" type="number" min="2" max="500" value="${m.len}"></label><label>Color<input id="ma-c${k}" type="color" value="${m.color}"></label></div>`).join("")}
    <div class="row2"><label class="ck"><input type="checkbox" id="bb-on" ${I.bb.on ? "checked" : ""}> Bollinger Bands</label><label>Length<input id="bb-l" type="number" min="2" max="200" value="${I.bb.len}"></label><label>Std dev<input id="bb-m" type="number" step="0.1" min="0.5" max="5" value="${I.bb.mult}"></label></div>
    <div class="row2"><label class="ck"><input type="checkbox" id="rsi-on" ${I.rsi.on ? "checked" : ""}> RSI (legend)</label><label>Length<input id="rsi-l" type="number" min="2" max="100" value="${I.rsi.len}"></label></div>
    <div class="row2"><label class="ck"><input type="checkbox" id="atr-on" ${I.atr.on ? "checked" : ""}> ATR (legend)</label><label>Length<input id="atr-l" type="number" min="2" max="100" value="${I.atr.len}"></label></div>`, () => {
    I.ma = I.ma.map((m, k) => ({ ...m, on: $("ma-on" + k).checked, type: $("ma-t" + k).value, len: Math.max(2, Math.min(500, +$("ma-l" + k).value || m.len)), color: $("ma-c" + k).value }));
    I.bb = { on: $("bb-on").checked, len: Math.max(2, +$("bb-l").value || 20), mult: Math.max(0.5, +$("bb-m").value || 2) }; I.rsi = { on: $("rsi-on").checked, len: Math.max(2, +$("rsi-l").value || 14) }; I.atr = { on: $("atr-on").checked, len: Math.max(2, +$("atr-l").value || 14) };
    savePrefs(); panes.forEach((p) => { if (p.ind) for (const z of Object.values(p.ind)) try { p.chart.removeSeries(z.s); } catch (e) {} p.ind = {}; indFull(p); }); }); }

/* ---------------- price alerts: fire once when the replay crosses the price ---------------- */
let alerts = [];
function addAlert(price, s = sym) { const a = { id: Date.now(), price: rnd(price), sym: s }; alerts.push(a); drawAlerts(); toast(`🔔 Alert set at ${px2(a.price)}`); }
function drawAlerts() { for (const p of panes) { (p.alines || []).forEach((l) => { try { p.series.removePriceLine(l); } catch (e) {} }); p.alines = [];
  for (const a of alerts) if (a.sym === paneSym(p)) p.alines.push(p.series.createPriceLine({ price: a.price, color: "#f5c542", lineWidth: 1, lineStyle: 1, title: "🔔", axisLabelVisible: true })); } }
function checkAlerts() { if (!alerts.length) return; const hit = alerts.filter((a) => { const S = storeOf(a.sym), b = S && S["1m"].bars[S["1m"].i], f = S && need15 ? S["15s"].bars[S["15s"].i] : null, x = f && (!b || f.t >= b.t) ? f : b; return x && x.l <= a.price && x.h >= a.price; });
  if (!hit.length) return; alerts = alerts.filter((a) => !hit.includes(a)); drawAlerts(); for (const a of hit) { toast(`🔔 Price hit ${px2(a.price)}`); try { tone("alert"); } catch (e) {} } if (prefs.alertPause !== false) pause(); }

/* ---------------- order engine ---------------- */
let hist = [], lock = null;     // lock = {why, until (replay epoch, or Infinity)}
const flat = () => ({ qty: 0, avg: 0, sl: null, tp: null, t: 0, risk: 0, trail: 0, hi: 0, tool: null, tags: [] });
let pos = flat(), orders = [], oid = 1, draft = null;
const fee = (q) => Math.abs(q) * (inst.micro ? prefs.mfee : prefs.fee);
const balance = () => (sess ? +sess.account_start : prefs.bal) + hist.reduce((s, t) => s + (+t.pnl || 0), 0);
const openPnl = () => (pos.qty && last() != null ? (last() - pos.avg) * pos.qty * inst.pt : 0);
const dayRpl = () => { const d = sessDay(nowT()); return hist.filter((t) => sessDay(t.t_exit) === d).reduce((s, t) => s + (+t.pnl || 0), 0); };
function lockedNow() { if (!lock) return false; if (nowT() >= lock.until) { lock = null; return false; } return true; }
function guard() {
  if (features.prop_rules === false || lockedNow() || !nowT()) return; if (guard.busy) return; const dp = dayRpl() + openPnlAll();
  let peak = sess ? +sess.account_start : prefs.bal, run = peak; for (const t of hist) { run += +t.pnl || 0; peak = Math.max(peak, run); }
  const hit = (why) => { const blk = prefs.act === "block" || why.startsWith("Max"); lock = { why, until: blk ? (why.startsWith("Max") ? Infinity : endOfTradingDay(nowT())) : nowT() + 1 }; guard.busy = true; try { if (pos.qty) closeAll(why); orders = []; for (const s of otherSyms()) withSym(s, () => { if (pos.qty) closeAll(why); orders = []; }); } finally { guard.busy = false; } drawOrders(); if (!blk) lock = null; toast("🔒 " + why); refresh(); };
  if (prefs.dll && dp <= -prefs.dll) hit("Personal daily loss limit hit"); else if (prefs.ptg && dp >= prefs.ptg) hit("Personal daily profit target reached");
  else if (prefs.mdd && peak - (balance() + openPnlAll()) >= prefs.mdd) hit("Max drawdown hit");
}
function canTrade() { if (prefs.lockUntil && Date.now() < prefs.lockUntil) { toast("🔒 Personal lockout until " + new Date(prefs.lockUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })); return false; } if (lockedNow()) { toast("🔒 " + lock.why); return false; } if (last() == null) { toast("Load a chart first"); return false; } if (prefs.aplus && !pos.qty && !aplusOk()) return false; return true; }
const lotsNow = () => Math.max(1, +prefs.lots || 1);
const autoBr = () => (prefs.autoBr ? { slPts: prefs.slPts, tpPts: prefs.tpPts } : null);
function market(side, qty) { if (!canTrade()) return; if (prefs.cs && prefs.cs.oneClick === false && !confirm(`${side > 0 ? "Buy" : "Sell"} ${qty || lotsNow()} at market?`)) return; qty = qty || (prefs.byRisk ? Math.max(1, Math.floor((balance() * prefs.riskp / 100) / (prefs.slPts * inst.pt))) : lotsNow()); fill(side, qty, last(), nowT(), autoBr()); }
function joinBid() { if (canTrade()) place(1, "limit", last() - TICK, lotsNow(), autoBr()); }
function joinAsk() { if (canTrade()) place(-1, "limit", last() + TICK, lotsNow(), autoBr()); }
function place(side, type, price, qty, br, extra = {}) { if (!canTrade()) return; const o = { id: oid++, side, type, price: rnd(price), qty, br, ...extra }; orders.push(o); snd("place"); drawOrders(); refresh(); return o; }
/* ---------------- strategy checklist: tick your rules before you enter; every trade gets tagged with the strategy and how many rules it met ---------------- */
const STRAT_SEED = [{ name: "Reese IFVG", rules: ["Liquidity swept first (session high/low, PDH/PDL or data high/low)", "Clear IFVG on the 1m/5m in the sweep's direction", "ES confirms (SMT or same structure)", "Inside my hours (8:30-11:00 NY)", "Stop beyond the sweep, target the next draw (1:1 or better)"] },
  { name: "10AM open (Powell)", rules: ["It's the 10:00 candle, not a Friday", "Direction set by the 9:30-10:00 range", "Fixed 4R target, stop at the range", "No red-folder news in the next 15 min"] }];
let chk = new Set();
const strats = () => (prefs.strats = prefs.strats && prefs.strats.length ? prefs.strats : STRAT_SEED.map((x) => ({ name: x.name, rules: x.rules.slice() })));
const curStrat = () => (prefs.stratOn != null ? strats()[prefs.stratOn] : null);
function stratTags() { const s = curStrat(); if (!s) return []; return ["strat:" + s.name, `rules:${[...chk].filter((i) => i < s.rules.length).length}/${s.rules.length}`]; }
function chkUI() { const el = $("chk"); el.classList.toggle("hidden", !prefs.chkShow); $("chkbtn").classList.toggle("on", !!prefs.chkShow); if (!prefs.chkShow) return; const S = strats(), s = curStrat(), n = s ? [...chk].filter((i) => i < s.rules.length).length : 0;
  el.innerHTML = `<div class="ah"><select id="chk-s"><option value="">No strategy</option>${S.map((x, i) => `<option value="${i}" ${prefs.stratOn === i ? "selected" : ""}>${esc(x.name)}</option>`).join("")}</select><label class="ck tiny aplus" title="A+ only: no new trade unless every rule of this strategy is ticked"><input type="checkbox" id="chk-ap" ${prefs.aplus ? "checked" : ""}> A+ only</label><button class="pb" id="chk-ed" title="Edit strategies">✎</button><button class="pb" id="chk-x" title="Close">×</button></div>
    ${s ? `<div class="chkl">${s.rules.map((r, i) => `<label class="ck ${chk.has(i) ? "on" : ""}"><input type="checkbox" data-r="${i}" ${chk.has(i) ? "checked" : ""}> ${esc(r)}</label>`).join("")}</div>
      <div class="chkf"><div class="mxbar"><i style="width:${Math.round((100 * n) / (s.rules.length || 1))}%"></i></div><span class="tiny ${n === s.rules.length ? "pos-up" : "muted"}">${n}/${s.rules.length}${n === s.rules.length ? " · good to go" : ""}</span></div>` : '<div class="tiny muted" style="padding:6px 2px">Pick a strategy to get its checklist. Each trade is tagged with it so Stats can show which rules actually pay.</div>'}`;
  $("chk-s").onchange = (e) => { prefs.stratOn = e.target.value === "" ? null : +e.target.value; chk = new Set(); savePrefs(); chkUI(); };
  $("chk-x").onclick = () => { prefs.chkShow = false; savePrefs(); chkUI(); }; $("chk-ed").onclick = stratDlg;
  el.querySelectorAll("[data-r]").forEach((c) => (c.onchange = () => { const i = +c.dataset.r; c.checked ? chk.add(i) : chk.delete(i); chkUI(); })); }
function stratDlg() { const S = strats();
  dlg(`<h3>Strategies</h3><div class="tiny muted">One rule per line. Rename, edit, or clear a box to delete that strategy.</div>${[...S, { name: "", rules: [] }].map((s, i) => `<label>${i < S.length ? "Strategy" : "New strategy"}<input id="sd-n${i}" value="${esc(s.name)}" placeholder="Name" maxlength="30"></label><textarea id="sd-r${i}" rows="${Math.max(3, s.rules.length + 1)}" placeholder="Rules, one per line">${esc(s.rules.join("\n"))}</textarea>`).join("")}`, () => {
    const out = []; for (let i = 0; i <= S.length; i++) { const n = $("sd-n" + i).value.trim(), r = $("sd-r" + i).value.split("\n").map((x) => x.trim()).filter(Boolean); if (n && r.length) out.push({ name: n, rules: r }); }
    prefs.strats = out; if (prefs.stratOn != null && !out[prefs.stratOn]) prefs.stratOn = null; chk = new Set(); savePrefs(); chkUI(); }); }
function fill(side, qty, price, t, br, toolId) {
  try { execs.push({ sym, side, qty, price, t }); } catch (e) {}
  if (!pos.qty || Math.sign(pos.qty) === side) { snd("fill"); buzz(25); }
  if (!pos.qty || Math.sign(pos.qty) === side) {
    const nq = pos.qty + side * qty; pos.avg = pos.qty ? (pos.avg * Math.abs(pos.qty) + price * qty) / Math.abs(nq) : price; if (!pos.qty) { pos.t = t; pos.hi = price; pos.tags = [...(pos.tags || []).filter((x) => !/^(strat|rules):/.test(x)), ...stratTags()]; } pos.qty = nq;
    if (br) { if (br.slPx != null) pos.sl = br.slPx; else if (br.slPts) pos.sl = rnd(pos.avg - side * br.slPts); if (br.tpPx != null) pos.tp = br.tpPx; else if (br.tpPts) pos.tp = rnd(pos.avg + side * br.tpPts); }
    pos.trail = (br && br.trail) || prefs.trail || 0; pos.risk = pos.sl != null ? Math.abs(pos.avg - pos.sl) : pos.risk || 0; if (toolId) { pos.tool = toolId; const td = drawings.find((z) => z.id === toolId); if (td && td.tags) pos.tags = td.tags.slice(); }
  } else { const cq = Math.min(Math.abs(pos.qty), qty); record(cq, price, t, "manual"); const rest = qty - cq; if (rest > 0) fill(side, rest, price, t, br, toolId); }
  drawOrders(); refresh(); repaintAll();
}
function record(cq, price, t, outcome) { setTimeout(() => { try { const h = hist[hist.length - 1]; if (!h) return; const k = outcome === "loss" ? "hit_sl" : (outcome === "win" || (outcome === "trail" && h.pnl > 0)) ? "hit_tp" : null; if (k) fxEvent(k, h.pnl); } catch (e) {} }, 0);
  const side = Math.sign(pos.qty), pnl = (price - pos.avg) * side * cq * inst.pt - fee(cq), r = pos.risk ? ((price - pos.avg) * side) / pos.risk : null;
  if (Math.abs(pos.qty) <= cq && prefs.chkShow) setTimeout(() => { chk = new Set(); chkUI(); }, 0);
  const row = { session_id: sess && sess.id, ...(acct ? { account_id: acct.id } : {}), tags: pos.tags || [], symbol: sym, dir: side, qty: cq, entry: +pos.avg.toFixed(2), stop: pos.sl, target: pos.tp, exit: price, t_entry: pos.t, t_exit: t, outcome, r: r == null ? null : +r.toFixed(2), pnl: +pnl.toFixed(2), fees: fee(cq) };
  hist.push(row); pos.qty -= side * cq; snd(outcome === "win" ? "target" : outcome === "loss" ? "stop" : "closed"); buzz(pnl > 0 ? [20, 40, 20] : 60);
  if (!pos.qty) { const tl = drawings.find((d) => d.id === pos.tool); if (tl) tl.state = "done"; pos = flat(); repaintAll(); }
  db.addTrade(row).then((d) => { Object.assign(row, d); reviewCard(row); shot(d.id); if (notionAuto) notion("sync", { ids: [d.id] }).catch(() => {}); }).catch((e) => toast("Trade not saved: " + e.message));
  guard();
}
function engineBar(b) {
  for (const o of orders.slice()) {
    const st = o.type === "stop" || o.type === "stoplimit", hit = !st ? (o.side > 0 ? b.l <= o.price : b.h >= o.price) : (o.side > 0 ? b.h >= o.price : b.l <= o.price); if (!hit) continue;
    const fp = !st ? (o.side > 0 ? Math.min(o.price, b.o) : Math.max(o.price, b.o)) : o.type === "stoplimit" ? o.price : (o.side > 0 ? Math.max(o.price, b.o) : Math.min(o.price, b.o));
    orders = orders.filter((x) => x !== o); if (lockedNow()) continue;
    if (o.tool) { const d = drawings.find((z) => z.id === o.tool); if (d) d.state = "filled"; }
    fill(o.side, o.qty, fp, b.t, o.br, o.tool);
  }
  if (pos.qty && b.t > pos.t) {
    const d = Math.sign(pos.qty);
    if (pos.trail && pos.sl != null) { pos.hi = d > 0 ? Math.max(pos.hi, b.h) : Math.min(pos.hi || b.l, b.l); const ns = rnd(pos.hi - d * pos.trail); if (d > 0 ? ns > pos.sl : ns < pos.sl) pos.sl = ns; }
    const hs = pos.sl != null && (d > 0 ? b.l <= pos.sl : b.h >= pos.sl), ht = pos.tp != null && (d > 0 ? b.h >= pos.tp : b.l <= pos.tp);
    if (hs) { const gp = d > 0 ? b.o < pos.sl : b.o > pos.sl; record(Math.abs(pos.qty), gp ? b.o : pos.sl, b.t, Math.abs(pos.sl - pos.avg) < 1e-9 ? "be" : (pos.sl - pos.avg) * d > 0 ? "trail" : "loss"); }
    else if (ht) record(Math.abs(pos.qty), pos.tp, b.t, "win");
  }
  guard(); drawOrders();
}
function closeAll(why) { if (pos.qty) record(Math.abs(pos.qty), last(), nowT(), why ? "rule" : "manual"); drawOrders(); refresh(); }
function reverse() { if (!pos.qty || !canTrade()) return; const q = Math.abs(pos.qty), s = -Math.sign(pos.qty); closeAll(); fill(s, q, last(), nowT(), autoBr()); }
function toBE() { if (pos.qty) { pos.sl = rnd(pos.avg); drawOrders(); refresh(); } }
function cancelAll() { orders.forEach((o) => { const d = drawings.find((z) => z.id === o.tool); if (d && d.state === "armed") d.state = "idle"; }); orders = []; draft = null; drawOrders(); refresh(); repaintAll(); }
function flatten() { cancelAll(); closeAll(); }
async function shot(id) {
  if (DEMO || features.journal === false) return;
  try { const cv = panes[active].chart.takeScreenshot(); const blob = await new Promise((r) => cv.toBlob(r, "image/png")); const path = `${user.id}/${id}.png`;
    const up = await sb.storage.from("shots").upload(path, blob, { contentType: "image/png", upsert: true }); if (!up.error) await sb.from("trades").update({ shots: [path] }).eq("id", id); } catch (e) {}
}
/* position tool → working order (FX Replay-style auto-entry) */
function armTool(d) { if (paneSym(d.pane) !== sym) { setActive(d.pane); if (paneSym(d.pane) !== sym) return toast("Load that chart's data first"); }
  if (!canTrade()) return; const lp = last(), s = d.side, q = posQty(d);
  if ((d.sl - d.entry) * s >= 0 || (d.tp - d.entry) * s <= 0) return toast("For a long the stop goes below entry and the target above it. A short is the reverse.");
  const br = { slPx: d.sl, tpPx: d.tp }; d.qty = q;
  if (Math.abs(d.entry - lp) < TICK / 2) { d.state = "filled"; fill(s, q, lp, nowT(), br, d.id); }
  else { const type = (s > 0 ? d.entry < lp : d.entry > lp) ? "limit" : "stop"; place(s, type, d.entry, q, br, { tool: d.id }); d.state = "armed"; }
  repaintAll(); toast(d.state === "armed" ? `Armed: ${s > 0 ? "buy" : "sell"} ${q} @ ${px2(d.entry)}, stop ${px2(d.sl)}, target ${px2(d.tp)}. It fills on its own.` : "Filled");
}
function disarmTool(d) { orders = orders.filter((o) => o.tool !== d.id); if (d.state === "armed") d.state = "idle"; drawOrders(); refresh(); repaintAll(); }
function syncTool(d) {
  const o = orders.find((x) => x.tool === d.id); if (o) { o.price = d.entry; o.br = { slPx: d.sl, tpPx: d.tp }; drawOrders(); }
  if (d.state === "filled" && pos.tool === d.id) { pos.sl = d.sl; pos.tp = d.tp; pos.risk = Math.abs(pos.avg - pos.sl); drawOrders(); refresh(); }
}

/* ---------------- price lines (orders, position, draft) on every pane ---------------- */
function drawOrders() {
  for (const p of panes) { p.lines.forEach((l) => p.series.removePriceLine(l.ref)); p.lines = []; }
  for (const s of new Set(panes.map(paneSym))) withSym(s, () => { for (const p of panes) if (paneSym(p) === sym) linesFor(p); });
}
function linesFor(p) {
  {
    const C = csG(); if (!C.pos) return;   // KING_CS2: Trading → positions and orders on/off, P&L as money / points / ticks / R, extended lines
    const L = (price, color, title, kind, obj, style = 2) => p.lines.push({ ref: p.series.createPriceLine({ price, color, lineWidth: 2, lineStyle: style, title, axisLabelVisible: true, lineVisible: C.ext !== false }), kind, price, obj });
    const pf = (pts, qty, k) => { if (!C.pnl) return ""; const mode = k === "pos" ? C.pnlp : C.pnlb; if (mode === "pts") return (pts >= 0 ? "+" : "") + pts.toFixed(2) + " pts"; if (mode === "ticks") return (pts >= 0 ? "+" : "") + Math.round(pts / TICK) + " ticks";
      if (mode === "r") return pos.risk ? (pts / pos.risk).toFixed(2) + "R" : "—R"; return money(pts * qty * inst.pt); };
    if (pos.qty) { const q = Math.abs(pos.qty), sd = Math.sign(pos.qty); L(pos.avg, "#c9d2df", `${pos.qty > 0 ? "LONG" : "SHORT"} ${q}  ${pf(openPnl() / (q * inst.pt), q, "pos")}`, "pos", null, 0);
      if (pos.sl != null) L(pos.sl, "#ff6b7a", (pos.trail ? "TRAIL " : "SL ") + pf((pos.sl - pos.avg) * sd, q, "br"), "sl");
      if (pos.tp != null) L(pos.tp, "#2bd4a0", "TP " + pf((pos.tp - pos.avg) * sd, q, "br"), "tp"); }
    for (const o of orders) L(o.price, "#7aa7ff", `${o.side > 0 ? "BUY" : "SELL"} ${o.type.toUpperCase()} ${o.qty}${o.tool ? " · auto" : ""}`, "ord", o);
    if (draft) L(draft.price, "#ffc65c", `DRAFT ${draft.side > 0 ? "BUY" : "SELL"} ${draft.type.toUpperCase()} · drag, then Submit`, "draft", draft);
  }
}
function drawOpens() {
  for (const p of panes) { p.opens.forEach((l) => p.series.removePriceLine(l)); p.opens = []; }
  for (const s of new Set(panes.map(paneSym))) withSym(s, () => { for (const p of panes) if (paneSym(p) === sym) opensFor(p); });
}
function opensFor(p) {
  { if (!prefs.opens || !nowT()) return;
    const day = sessDay(nowT()), marks = { "18:00": "Key open 18:00", "00:00": "Key open midnight", "09:30": "Key open 9:30", "10:00": "Key open 10:00" }, b1 = B["1m"];
    for (let i = b1.i; i >= 0 && i > b1.i - 1500; i--) { const b = b1.bars[i]; if (sessDay(b.t) !== day) break; const k = lhm(loc(b.t)); if (marks[k]) { p.opens.push(p.series.createPriceLine({ price: b.o, color: "rgba(140,155,180,.55)", lineWidth: 1, lineStyle: 1, axisLabelVisible: false, title: marks[k] })); delete marks[k]; } }
  }
}

/* ---------------- context menus + dialogs ---------------- */
function menu(items, cx, cy, again) {   // again: rebuild fn so toggles keep the menu open
  items = items.filter(Boolean); const m = $("ctx");
  m.innerHTML = items.map((it, i) => it === "-" ? '<div class="sepm"></div>' : it.h ? `<div class="mh">${it.h}</div>` : `<button class="mi ${it.c || ""}" data-i="${i}">${it.t}${it.k ? `<span>${it.k}</span>` : ""}</button>`).join("");
  m.dataset.from = ""; m.classList.remove("hidden"); m.style.maxHeight = ""; m.style.overflowY = ""; m.style.left = "0px"; m.style.top = "0px"; const r = m.getBoundingClientRect(), room = innerHeight - cy - 8;
  m.style.left = Math.min(cx, innerWidth - r.width - 8) + "px";
  if (r.height > room && room >= 240) { m.style.top = cy + "px"; m.style.maxHeight = room + "px"; m.style.overflowY = "auto"; }   // long menus scroll instead of sliding up over the button that opened them
  else m.style.top = Math.max(8, Math.min(cy, innerHeight - r.height - 8)) + "px";
  m.onclick = (e) => { const b = e.target.closest(".mi"); if (!b) return; const it = items[+b.dataset.i], keep = it.keep || (again && /^(✓ |\u2003 )/.test(it.t) && !/…$/.test(it.t));
    if (!keep) { hideCtx(); return it.f(); }
    it.f(); if (it.re) { b.firstChild.textContent = it.re(); return; }
    if (again) { const from = m.dataset.from, x = m.style.left, y = m.style.top; again(true); m.dataset.from = from; m.style.left = x; m.style.top = y; } };
}
const hideCtx = () => { $("ctx").classList.add("hidden"); $("ctx").dataset.from = ""; };
let ctxJust = null;
document.addEventListener("pointerdown", (e) => { ctxJust = null; if (!$("ctx").classList.contains("hidden") && $("ctx").dataset.from && e.target.closest("[data-menu-from=\"" + $("ctx").dataset.from + "\"]")) ctxJust = $("ctx").dataset.from; if (!e.target.closest("#ctx")) hideCtx(); if (!e.target.closest(".laywrap")) $("laymenu").classList.add("hidden"); });
function chartMenu(p, x, y, cx, cy) {
  const l = hitLine(p, y), h = !l && hitDrawing(p, x, y), pr = pOf(p, y, x), lp = last();
  if (l && l.kind === "ord") { const o = l.obj; return menu([{ h: `${o.side > 0 ? "Buy" : "Sell"} ${o.type} ${o.qty} @ ${px2(o.price)}` },
      { t: "Change quantity…", f: () => { const q = +prompt("Quantity", o.qty); if (q > 0) { o.qty = q; drawOrders(); refresh(); } } }, o.tool ? null : { t: "Change bracket…", f: () => bracketDlg(o) },
      { t: "Cancel order", c: "s", f: () => { orders = orders.filter((z) => z !== o); const d = drawings.find((z) => z.id === o.tool); if (d) d.state = "idle"; drawOrders(); refresh(); repaintAll(); } }], cx, cy); }
  if (l && (l.kind === "sl" || l.kind === "tp")) return menu([{ h: l.kind === "sl" ? "Stop loss" : "Take profit" }, { t: "Move stop to breakeven", f: toBE },
      { t: pos.trail ? "Turn trailing off" : "Trail the stop…", f: () => { if (pos.trail) pos.trail = 0; else { const v = +prompt("Trail by points", prefs.slPts); if (v > 0) { pos.trail = v; pos.hi = last(); } } drawOrders(); } },
      { t: "Remove " + (l.kind === "sl" ? "stop" : "target"), c: "s", f: () => { if (l.kind === "sl") pos.sl = null; else pos.tp = null; drawOrders(); refresh(); } }, "-", { t: "Close position", k: prefs.keys.close.toUpperCase(), f: () => closeAll() }], cx, cy);
  if (h) { const d = h.d; sel = d; repaintAll();
    if (d.type === "long" || d.type === "short") return menu([{ h: `${d.side > 0 ? "Long" : "Short"} position · ${d.state}` },
        d.state === "armed" ? { t: "Disarm (cancel the auto-entry)", f: () => disarmTool(d) } : d.state === "idle" ? { t: "Arm: auto-enter when price reaches entry", c: d.side > 0 ? "b" : "s", f: () => armTool(d) } : null,
        d.state === "idle" ? { t: "Enter now at market", f: () => { const q = posQty(d); d.qty = q; d.state = "filled"; fill(d.side, q, last(), nowT(), { slPx: d.sl, tpPx: d.tp }, d.id); } } : null,
        { t: "Confluences…" + (d.tags && d.tags.length ? " (" + d.tags.length + ")" : ""), f: () => confDlg(d) },
        ...RISK_PRESETS.map((pr) => ({ t: "\u2003 Risk preset " + pr[0], f: () => { if (d.state === "filled") return toast("Already filled"); applyRisk(d, pr); } })),
        { t: "Settings…", f: () => toolDlg(d) }, { t: "Flip to " + (d.side > 0 ? "short" : "long"), f: () => { if (d.state !== "idle") return toast("Disarm it first"); d.side = -d.side; d.type = d.side > 0 ? "long" : "short"; [d.sl, d.tp] = [rnd(2 * d.entry - d.sl), rnd(2 * d.entry - d.tp)]; repaintAll(); } },
        "-", { t: "Delete", c: "s", k: "Del", f: () => { disarmTool(d); drawings = drawings.filter((z) => z !== d); sel = null; repaintAll(); } }], cx, cy);
    return menu([{ h: d.type }, d.type === "text" ? { t: "Edit text…", f: () => { d.text = prompt("Note", d.text) || d.text; repaintAll(); } } : null,
      { t: "Clone", f: () => { const c = JSON.parse(JSON.stringify(d)); c.id = did++; drawings.push(c); repaintAll(); } }, { t: "Delete", c: "s", k: "Del", f: () => { drawings = drawings.filter((z) => z !== d); sel = null; repaintAll(); } }], cx, cy); }
  if (pr == null || lp == null) return menu([{ h: "Chart" }, { t: "Load a replay first", f: () => {} }], cx, cy);
  const above = pr > lp, q = lotsNow(), br = autoBr(), t = tOf(p, x);
  menu([{ h: `${sym} @ ${px2(pr)} · ${q} lot${q > 1 ? "s" : ""}` },
    { t: above ? `Sell limit @ ${px2(pr)}` : `Buy limit @ ${px2(pr)}`, c: above ? "s" : "b", f: () => place(above ? -1 : 1, "limit", pr, q, br) },
    { t: above ? `Buy stop @ ${px2(pr)}` : `Sell stop @ ${px2(pr)}`, c: above ? "b" : "s", f: () => place(above ? 1 : -1, "stop", pr, q, br) },
    { t: "Start the replay from this candle", f: () => { if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); $("start").value = fmt(t + 60).replace(" ", "T"); loadReplay(); } },
    "-", { t: "Long position here", c: "b", k: prefs.keys.long.toUpperCase(), f: () => { newDrawing("long", p, { t, p: pr }); repaintAll(); } },
    { t: "Short position here", c: "s", k: prefs.keys.short.toUpperCase(), f: () => { newDrawing("short", p, { t, p: pr }); repaintAll(); } },
    { t: "Horizontal line here", k: prefs.keys.hline.toUpperCase(), f: () => { newDrawing("hline", p, { t, p: pr }); repaintAll(); } },
    { t: `🔔 Alert at ${px2(pr)}`, f: () => addAlert(pr) }, alerts.length ? { t: `Clear ${alerts.length} alert${alerts.length > 1 ? "s" : ""}`, f: () => { alerts = []; drawAlerts(); } } : null,
    "-", { t: "Chart settings…", f: () => $("chartsetbtn").click() }, { t: "Magnet: " + (prefs.magnet ? "on" : "off"), f: toggleMagnet, keep: true, re: () => "Magnet: " + (prefs.magnet ? "on" : "off") },
    { t: (prefs.hideDraw ? "Show" : "Hide") + " all drawings", keep: true, re: () => (prefs.hideDraw ? "Show" : "Hide") + " all drawings", f: () => { prefs.hideDraw = !prefs.hideDraw; savePrefs(); repaintAll(); } },
    { t: (drawings.length && drawings.every((d) => d.locked) ? "Unlock" : "Lock") + " all drawings", f: () => { const all = drawings.length && drawings.every((d) => d.locked); drawings.forEach((d) => (d.locked = !all)); repaintAll(); toast(all ? "Drawings unlocked" : "🔒 All drawings locked"); } },
    { t: "Remove all drawings", f: () => { drawings.filter((d) => d.state === "armed").forEach(disarmTool); drawings = []; sel = null; repaintAll(); } }], cx, cy);
}
function dlg(html, onOk) { $("dlgbox").innerHTML = html + '<div class="row" style="margin-top:12px"><button id="dl-x">Cancel</button><button id="dl-ok" class="primary">Save</button></div>'; $("dlg").classList.remove("hidden");
  $("dl-x").onclick = () => $("dlg").classList.add("hidden"); $("dl-ok").onclick = () => { onOk(); $("dlg").classList.add("hidden"); }; }
function toolDlg(d) { dlg(`<h3>${d.side > 0 ? "Long" : "Short"} position</h3><div class="row2"><label>Entry<input id="tdE" type="number" step="0.25" value="${d.entry}"></label><label>Quantity (blank = auto)<input id="tdQ" type="number" value="${d.qty || ""}"></label></div><div class="row2"><label>Stop<input id="tdS" type="number" step="0.25" value="${d.sl}"></label><label>Target<input id="tdT" type="number" step="0.25" value="${d.tp}"></label></div>`,
  () => { d.entry = rnd(+$("tdE").value); d.sl = rnd(+$("tdS").value); d.tp = rnd(+$("tdT").value); d.qty = +$("tdQ").value || null; syncTool(d); repaintAll(); }); }
function bracketDlg(o) { dlg(`<h3>Order bracket</h3><div class="row2"><label>Stop (pts)<input id="bS" type="number" step="0.25" value="${(o.br && o.br.slPts) || prefs.slPts}"></label><label>Target (pts)<input id="bT" type="number" step="0.25" value="${(o.br && o.br.tpPts) || prefs.tpPts}"></label></div>`, () => { o.br = { slPts: +$("bS").value, tpPts: +$("bT").value }; refresh(); }); }
function padDlg() { dlg(`<h3>Scalp Pad settings</h3><label>Lot buttons (comma separated)<input id="pdL" value="${prefs.lotset.join(",")}"></label>
  <label class="ck"><input id="pdB" type="checkbox" ${prefs.autoBr ? "checked" : ""}> Auto position bracket on every entry</label><div class="row2"><label>Stop (pts)<input id="pdS" type="number" step="0.25" value="${prefs.slPts}"></label><label>Target (pts)<input id="pdT" type="number" step="0.25" value="${prefs.tpPts}"></label></div>
  <label>Trailing stop (pts, 0 = off)<input id="pdTr" type="number" step="0.25" value="${prefs.trail}"></label><label class="ck"><input id="pdR" type="checkbox" ${prefs.byRisk ? "checked" : ""}> Size by risk instead of lots</label><label>Risk % of balance<input id="pdRp" type="number" step="0.1" value="${prefs.riskp}"></label>`,
  () => { prefs.lotset = $("pdL").value.split(",").map((x) => +x.trim()).filter((x) => x > 0).slice(0, 6); if (!prefs.lotset.length) prefs.lotset = [1]; prefs.autoBr = $("pdB").checked; prefs.slPts = +$("pdS").value; prefs.tpPts = +$("pdT").value; prefs.trail = +$("pdTr").value || 0; prefs.byRisk = $("pdR").checked; prefs.riskp = +$("pdRp").value; savePrefs(); lotsUI(); refresh(); }); }
function lockDlg() { dlg(`<h3>Personal lockout</h3><p class="small muted">Flattens you and blocks new orders. It runs on replay time.</p><label>Lock for<select id="lkS"><option value="day">Rest of this trading day</option><option value="1">1 hour</option><option value="2">2 hours</option><option value="4">4 hours</option><option value="c">Custom hours</option></select></label><label>Custom hours<input id="lkH" type="number" value="3"></label>`,
  () => { if (!nowT()) return toast("Load a replay first"); const v = $("lkS").value, hrs = v === "day" ? null : v === "c" ? +$("lkH").value : +v; flatten(); lock = { why: "Personal lockout", until: hrs == null ? endOfTradingDay(nowT()) : nowT() + hrs * 3600 }; refresh(); }); }
function toggleMagnet() { prefs.magnet = !prefs.magnet; $("magnet").classList.toggle("on", prefs.magnet); savePrefs(); toast("Magnet " + (prefs.magnet ? "on" : "off")); }

/* ---------------- scalp pad (floating) ---------------- */
function padUI() {
  const pd = $("pad"); pd.classList.toggle("hidden", !prefs.pad.show); $("padshow").textContent = prefs.pad.show ? "Hide Scalp Pad" : "Show Scalp Pad";
  $("padx2").classList.toggle("hidden", !prefs.pad.more); $("padmore").classList.toggle("on", !!prefs.pad.more);
  if (prefs.pad.x != null) { pd.style.bottom = "auto"; pd.style.left = Math.max(0, Math.min(prefs.pad.x, innerWidth - 300)) + "px"; pd.style.top = Math.max(0, Math.min(prefs.pad.y, innerHeight - 130)) + "px"; }
  else { const r = $("charts").getBoundingClientRect(); if (r.width) { pd.style.top = "auto"; pd.style.left = Math.round(r.left + r.width / 2 - 150) + "px"; pd.style.bottom = Math.round(innerHeight - r.bottom + 16) + "px"; } }   // default: bottom-centre of the charts
}
(() => { const bar = $("padbar"), pd = $("pad"); let d0 = null;
  bar.addEventListener("pointerdown", (e) => { if (e.target.closest(".pb")) return; const r = pd.getBoundingClientRect(); d0 = { dx: e.clientX - r.left, dy: e.clientY - r.top }; bar.setPointerCapture(e.pointerId); bar.style.cursor = "grabbing"; });
  bar.addEventListener("pointermove", (e) => { if (!d0) return; pd.style.left = Math.max(0, Math.min(innerWidth - 300, e.clientX - d0.dx)) + "px"; pd.style.top = Math.max(0, Math.min(innerHeight - 120, e.clientY - d0.dy)) + "px"; });
  bar.addEventListener("pointerup", () => { if (!d0) return; d0 = null; bar.style.cursor = ""; const r = pd.getBoundingClientRect(); prefs.pad.x = r.left; prefs.pad.y = r.top; savePrefs(); });
  pd.addEventListener("contextmenu", (e) => { e.preventDefault(); menu([{ h: "Scalp Pad" }, { t: "Pad settings…", f: padDlg }, { t: "Auto bracket: " + (prefs.autoBr ? "on" : "off"), f: () => { prefs.autoBr = !prefs.autoBr; savePrefs(); refresh(); } }, { t: "Dock (hide)", f: () => { prefs.pad.show = false; savePrefs(); padUI(); } }], e.clientX, e.clientY); });
})();
function setLots(n) {   // fix 3: contract count syncs to every unfilled long/short tool (and its working order) right away
  prefs.lots = Math.max(1, n); lotsUI(); savePrefs();
  if (!prefs.byRisk) for (const d of drawings) if ((d.type === "long" || d.type === "short") && d.state !== "filled" && d.state !== "done") { d.qty = d.state === "armed" ? prefs.lots : null; const o = orders.find((x) => x.tool === d.id); if (o) o.qty = prefs.lots; }
  drawOrders(); refresh(); repaintAll(); }
function lotsUI() { $("qn").textContent = prefs.lots; $("lots").innerHTML = prefs.lotset.map((n) => `<button data-lot="${n}" class="${n === prefs.lots ? "on" : ""}">${n}</button>`).join(""); }

/* ---------------- DOM ladder ---------------- */
let domDrag = null;
function renderDom() {
  if ($("md-dom").classList.contains("hidden") || last() == null) return; const lp = rnd(last()), rows = [];
  for (let i = 20; i >= -20; i--) { const p = +(lp + i * TICK).toFixed(2), my = orders.filter((o) => o.price === p), mb = my.filter((o) => o.side > 0), ma = my.filter((o) => o.side < 0);
    const tag = (pos.qty && pos.sl === p ? '<span class="tag sl">SL</span>' : "") + (pos.qty && pos.tp === p ? '<span class="tag tp">TP</span>' : "");
    rows.push(`<div class="r${i === 0 ? " last" : ""}${pos.qty && Math.abs(pos.avg - p) < TICK / 2 ? " avg" : ""}"><span class="mb" data-o="${mb.map((o) => o.id).join(",")}">${mb.reduce((s, o) => s + o.qty, 0) || ""}</span><span class="b" data-p="${p}">${p < lp ? "lmt" : p > lp ? "stp" : "mkt"}</span><span class="p">${px2(p)}${tag}</span><span class="s" data-p="${p}">${p > lp ? "lmt" : p < lp ? "stp" : "mkt"}</span><span class="ma" data-o="${ma.map((o) => o.id).join(",")}">${ma.reduce((s, o) => s + o.qty, 0) || ""}</span></div>`); }
  $("dom").innerHTML = rows.join("");
}
$("dom").addEventListener("pointerdown", (e) => { const ids = e.target.dataset.o; if (ids) domDrag = ids.split(",").map(Number); });
$("dom").addEventListener("pointerup", (e) => {
  const row = e.target.closest(".r"); if (!row) { domDrag = null; return; } const p = +row.querySelector(".b").dataset.p;
  if (domDrag) { orders.filter((o) => domDrag.includes(o.id)).forEach((o) => (o.price = p)); domDrag = null; drawOrders(); refresh(); return; }
  if (!e.target.classList.contains("b") && !e.target.classList.contains("s")) return; const lp = rnd(last()), buy = e.target.classList.contains("b"), side = buy ? 1 : -1;
  if (p === lp) return market(side); place(side, (buy ? p < lp : p > lp) ? "limit" : "stop", p, lotsNow(), autoBr());
});

/* ---------------- panels ---------------- */
function refresh() {
  const bal = balance(), op = openPnlAll(), rp = dayRpl(), cls = (v) => (v >= 0 ? "pos-up" : "pos-dn");
  flashNum("bal", Math.round(bal)); flashNum("rpl", Math.round(rp)); $("bal").textContent = money(bal); $("rpl").textContent = money(rp); $("rpl").className = cls(rp); $("upl").textContent = money(op); $("upl").className = cls(op);
  let run = sess ? +sess.account_start : prefs.bal, peak = Math.max(run, acctPeak || 0); for (const t of hist) { run += +t.pnl || 0; peak = Math.max(peak, run); }
  $("ddl").textContent = prefs.mdd ? money(prefs.mdd - (peak - (bal + op))) : "off";
  const L = lockedNow(); $("status").textContent = L ? (lock.until === Infinity ? "Locked" : "Locked · " + Math.max(0, Math.ceil((lock.until - nowT()) / 60)) + "m") : "Active"; $("status").classList.toggle("locked", L); $("status").title = L ? lock.why : "";
  const lp = last(); $("acctname").textContent = acct ? acct.name : `Replay · ${money(sess ? +sess.account_start : prefs.bal).replace(/\.00$/, "")}`;
  $("b-acct").innerHTML = `<table class="bt"><tr><th>Account</th><th>Start</th><th>Balance</th><th>RP&amp;L today</th><th>UP&amp;L</th><th>Drawdown left</th><th>Daily loss limit</th><th>Status</th></tr><tr><td>${$("acctname").textContent}</td><td>${money(sess ? +sess.account_start : prefs.bal)}</td><td>${money(bal)}</td><td class="${cls(rp)}">${money(rp)}</td><td class="${cls(op)}">${money(op)}</td><td>${$("ddl").textContent}</td><td>${prefs.dll ? money(prefs.dll) : "off"}</td><td>${$("status").textContent}</td></tr></table>`;
  $("pbid").textContent = lp != null ? px2(lp) : "—"; $("pask").textContent = lp != null ? px2(lp + TICK) : "—"; $("padsym").textContent = sym;
  $("padpos").innerHTML = pos.qty ? `<span class="${cls(pos.qty)}">${pos.qty > 0 ? "LONG" : "SHORT"} ${Math.abs(pos.qty)}</span> @ ${px2(pos.avg)} · <span class="${cls(openPnl())}">${money(openPnl())}</span>` : "Flat";
  $("clock").textContent = nowT() ? (blind ? "Mystery day · " + fmt(loc(nowT())).slice(11) : fmt(loc(nowT()))) + " NY" : "—";
  $("sb-br").textContent = prefs.autoBr ? `SL ${prefs.slPts} / TP ${prefs.tpPts} pts` : "off"; $("sb-sz").textContent = prefs.byRisk ? prefs.riskp + "% risk" : prefs.lots + " lot(s)"; $("sb-tr").textContent = prefs.trail ? prefs.trail + " pts" : "off";
  const bgPos = otherSyms().filter((k) => CTX[k].pos.qty).map((k) => withSym(k, () => `<tr><td>${sym}</td><td class="${cls(pos.qty)}">${pos.qty > 0 ? "Long" : "Short"}</td><td>${Math.abs(pos.qty)}</td><td>${px2(pos.avg)}</td><td>${px2(last())}</td><td>${px2(pos.sl)}</td><td>${px2(pos.tp)}</td><td class="${cls(openPnl())}">${money(openPnl())}</td><td class="tiny muted">click its chart to manage</td></tr>`)).join("");
  const opA = openPnl();
  $("b-pos").innerHTML = pos.qty || bgPos ? `<table class="bt"><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg</th><th>Last</th><th>Stop</th><th>Target</th><th>UPL</th><th></th></tr>${pos.qty ? `<tr><td>${sym}</td><td class="${cls(pos.qty)}">${pos.qty > 0 ? "Long" : "Short"}</td><td>${Math.abs(pos.qty)}</td><td>${px2(pos.avg)}</td><td>${px2(lp)}</td><td>${px2(pos.sl)}</td><td>${px2(pos.tp)}</td><td class="${cls(opA)}">${money(opA)}</td><td><button data-a="close">Close</button> <button data-a="rev">Reverse</button> <button data-a="be">BE</button></td></tr>` : ""}${bgPos}</table>` : '<div class="empty">Flat</div>';
  $("b-ord").innerHTML = orders.length ? `<table class="bt"><tr><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Bracket</th><th></th></tr>${orders.map((o) => `<tr><td class="${cls(o.side)}">${o.side > 0 ? "Buy" : "Sell"}</td><td>${o.type}${o.tool ? " (position tool)" : ""}</td><td>${o.qty}</td><td>${px2(o.price)}</td><td>${o.br ? (o.br.slPx != null ? `SL ${px2(o.br.slPx)} / TP ${px2(o.br.tpPx)}` : `SL ${o.br.slPts} / TP ${o.br.tpPts} pts`) : "—"}</td><td><button data-c="${o.id}">Cancel</button></td></tr>`).join("")}</table>` : '<div class="empty">No working orders</div>';
  $("ordn").textContent = orders.length ? "(" + orders.length + ")" : "";
  $("b-hist").innerHTML = hist.length ? `<table class="bt"><tr><th>Time (NY)</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>Result</th><th>R</th><th>P&L</th></tr>${hist.slice().reverse().map((t) => `<tr><td>${fmt(loc(t.t_entry)).slice(5)}</td><td>${t.symbol || ""}</td><td>${t.dir > 0 ? "Long" : "Short"}</td><td>${t.qty}</td><td>${px2(t.entry)}</td><td>${px2(t.exit)}</td><td>${t.outcome}</td><td>${t.r ?? "—"}</td><td class="${cls(t.pnl)}">${money(t.pnl)}</td></tr>`).join("")}</table>` : '<div class="empty">No trades this session</div>';
  const w = hist.filter((t) => t.pnl > 0).length; $("bstat").textContent = hist.length ? `${hist.length} trades · ${Math.round((100 * w) / hist.length)}% win · net ${money(hist.reduce((s, t) => s + t.pnl, 0))}` : "";
  const sl = +$("o-sl").value, q = +$("o-qty").value, tp = +$("o-tp").value || 0; $("o-risk").innerHTML = sl && q ? `Risk <b>${money(sl * q * inst.pt + fee(q))}</b> · reward <b>${money(tp * q * inst.pt)}</b> · <b>${(tp / sl).toFixed(2)}R</b>` : "";
  renderDom();
}

/* ---------------- feel: sounds (made here with Web Audio, no files), haptics, number flashes ---------------- */
let AC = null;
function sfx(kind) {
  if (prefs.sound === false) return; try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; } const t0 = AC.currentTime, vol = (prefs.vol ?? 60) / 100 * 0.18;
  const note = (f, at, dur, type = "sine", v = vol) => { const o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.setValueAtTime(f, t0 + at); g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(v, t0 + at + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur); o.connect(g).connect(AC.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.02); };
  if (kind === "fill") { note(880, 0, 0.09, "triangle"); note(1320, 0.05, 0.12, "sine", vol * 0.7); }
  else if (kind === "win") { [660, 880, 1320].forEach((f, i) => note(f, i * 0.07, 0.22, "sine")); }
  else if (kind === "loss") { note(330, 0, 0.18, "triangle"); note(247, 0.1, 0.3, "triangle", vol * 0.8); }
  else if (kind === "click") note(1600, 0, 0.03, "square", vol * 0.25);
  else if (kind === "lock") { note(220, 0, 0.35, "sawtooth", vol * 0.5); }
}
function buzz(ms) { if (prefs.haptics !== false && navigator.vibrate) try { navigator.vibrate(ms); } catch (e) {} }
const lastShown = {};
function flashNum(id, v) { const el = $(id); if (lastShown[id] != null && v !== lastShown[id]) { el.classList.remove("fl-up", "fl-dn"); void el.offsetWidth; el.classList.add(v > lastShown[id] ? "fl-up" : "fl-dn"); } lastShown[id] = v; }

/* ---------------- accounts (portfolio) ---------------- */
let accts = [], acct = null, startBal = 50000, acctPeak = 0;
// LucidFlex eval numbers (public summaries, Nov 2026): EOD trailing max loss, no daily limit, 50% consistency, max loss locks at start - $100 once the close passes start + target
const LUCID = { lf25: ["LucidFlex 25K eval", 25000, { mdd: 1000, dll: 0, ptg: 1250, eod: true, cons: 50, lock: true, maxMini: 2 }, 95], lf50: ["LucidFlex 50K eval", 50000, { mdd: 2000, dll: 0, ptg: 3000, eod: true, cons: 50, lock: true, maxMini: 4 }, 130],
  lf100: ["LucidFlex 100K eval", 100000, { mdd: 3000, dll: 0, ptg: 6000, eod: true, cons: 50, lock: true, maxMini: 6 }, 200], lf150: ["LucidFlex 150K eval", 150000, { mdd: 4500, dll: 0, ptg: 9000, eod: true, cons: 50, lock: true, maxMini: 10 }, 260] };
const ACCT_PRESETS = { practice: ["Practice", 50000, { mdd: 2000, dll: 1000, ptg: 0 }], ...Object.fromEntries(Object.entries(LUCID).map(([k, v]) => [k, v.slice(0, 3)])) };
async function loadAccts() { accts = await db.accounts(); acct = accts.find((a) => a.id === prefs.acct) || null; applyAcctRules(); }
function applyAcctRules() { if (!acct) return; const r = acct.rules || {}; ["mdd", "dll", "ptg"].forEach((k) => { if (r[k] != null) prefs[k] = +r[k]; }); fillSettings(); }
async function acctStart() {   // balance and high-water mark for the selected account (from its saved trades)
  if (!acct) { startBal = prefs.bal; acctPeak = 0; return; } const S = acctState(acct, await db.allTrades()); startBal = S.run; acctPeak = S.pk;
  if (S.blown) toast(acct.name + " is blown. Earn a new eval on the Learn page, or pick another account.");
}
function acctMenu() { const r = $("acctpill").getBoundingClientRect();
  menu([{ h: "Account" }, { t: (acct ? "\u2003 " : "✓ ") + "Replay (no account)", f: () => pickAcct(null) }, ...accts.map((a) => ({ t: (acct && acct.id === a.id ? "✓ " : "\u2003 ") + a.name, k: money(+a.start_bal).replace(/\.00$/, ""), f: () => pickAcct(a.id) })), "-", { t: "Manage accounts…", f: () => view("accounts") }], r.left, r.bottom + 6); }
function pickAcct(id) { if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); prefs.acct = id; acct = accts.find((a) => a.id === id) || null; applyAcctRules(); savePrefs(); refresh(); toast(acct ? "Trading on " + acct.name + ". Load a replay to start a session on it." : "Trading without an account"); }
function acctState(a, all) {   // balance, max-loss line (intraday or end-of-day trailing, with Lucid-style lock), consistency, status
  const R = a.rules || {}, tr = all.filter((t) => t.account_id === a.id).sort((x, y) => x.t_exit - y.t_exit), start = +a.start_bal; let run = start, pk = start, floor = R.mdd ? start - R.mdd : -Infinity, blown = false; const byDay = {};
  for (const t of tr) { run += +t.pnl || 0; const d = sessDay(t.t_exit); byDay[d] = (byDay[d] || 0) + (+t.pnl || 0);
    if (!R.eod) { pk = Math.max(pk, run); if (R.mdd) floor = Math.max(floor, pk - R.mdd); } if (run <= floor) blown = true; }
  if (R.eod && R.mdd) { let bal = start; for (const d of Object.keys(byDay).sort()) { bal += byDay[d]; pk = Math.max(pk, bal); floor = Math.max(floor, pk - R.mdd); if (R.lock && R.ptg && pk >= start + R.ptg) floor = Math.max(floor, start - 100); } }
  if (R.lock && R.ptg && pk >= start + R.ptg) floor = Math.min(floor, start - 100) === floor ? floor : Math.max(floor, start - 100);
  const pnl = run - start, best = Math.max(0, ...Object.values(byDay)), consOk = !R.cons || pnl <= 0 || (100 * best) / pnl <= R.cons;
  const passed = R.ptg && pnl >= R.ptg && consOk, ddLeft = R.mdd ? run - floor : null; if (ddLeft != null && ddLeft <= 0) blown = true;
  return { tr, run, pk, floor, pnl, best, consOk, passed, blown, ddLeft, w: tr.filter((t) => t.pnl > 0).length };
}
async function renderAccts() {
  const all = await db.allTrades(), rows = await Promise.all(accts.map(async (a) => { const S = acctState(a, all), tr = S.tr, run = S.run, R = a.rules || {}, ddLeft = S.ddLeft, w = S.w, pnl = S.pnl;
    const st = S.blown ? ["Blown", "dn"] : S.passed ? ["Passed", "up"] : R.ptg && pnl >= R.ptg ? ["Target hit, consistency " + Math.round((100 * S.best) / pnl) + "%", ""] : ["Active", ""];
    return `<div class="acard ${acct && acct.id === a.id ? "on" : ""}" data-id="${a.id}"><div class="ah"><b>${a.name}</b><span class="pill ${st[1]}">${st[0]}</span></div>
      <div class="abig ${pnl >= 0 ? "pos-up" : "pos-dn"}">${money(run)}</div><div class="muted small">${pnl >= 0 ? "+" : ""}${money(pnl)} since start · ${tr.length} trades · ${tr.length ? Math.round((100 * w) / tr.length) : 0}% win</div>
      ${R.ptg ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, (100 * pnl) / R.ptg))}%"></i></div><div class="tiny muted">Profit target ${money(R.ptg)}</div>` : ""}
      <div class="kvs"><div><span>Drawdown left${R.eod ? " (end of day)" : ""}</span><b>${ddLeft == null ? "off" : money(ddLeft)}</b></div><div><span>Daily loss limit</span><b>${R.dll ? money(R.dll) : "none"}</b></div>${R.cons ? `<div><span>Best day vs total (max ${R.cons}%)</span><b>${pnl > 0 ? Math.round((100 * S.best) / pnl) + "%" : "—"}</b></div>` : ""}${R.maxMini ? `<div><span>Max size</span><b>${R.maxMini} minis / ${R.maxMini * 10} micros</b></div>` : ""}</div>
      <div class="row"><button data-use="${a.id}" class="small">${acct && acct.id === a.id ? "Selected" : "Use"}</button><button data-edit="${a.id}" class="ghost small">Edit</button><button data-arch="${a.id}" class="ghost small">Archive</button></div></div>`; }));
  $("ac-list").innerHTML = rows.join("") || '<div class="empty">No accounts yet. Make one to track an eval or a funded account separately.</div>';
}
function acctDlg(a) { const r = (a && a.rules) || {}; dlg(`<h3>${a ? "Edit account" : "New account"}</h3>${a ? "" : `<label>Start from<select id="acP">${Object.entries(ACCT_PRESETS).map(([k, v]) => `<option value="${k}">${v[0]}</option>`).join("")}</select></label>`}
    <label>Name<input id="acN" value="${a ? a.name : "Practice"}"></label><label>Starting balance ($)<input id="acB" type="number" value="${a ? a.start_bal : 50000}"></label>
    <div class="row2"><label>Max drawdown, trailing ($)<input id="acM" type="number" value="${r.mdd ?? 2000}"></label><label>Daily loss limit ($)<input id="acD" type="number" value="${r.dll ?? 1000}"></label></div><label>Profit target ($, 0 = none)<input id="acT" type="number" value="${r.ptg ?? 0}"></label><p class="tiny muted">Presets are examples. Set the numbers to match your firm's current rules.</p>`,
  async () => { const row = { name: $("acN").value.trim() || "Account", start_bal: +$("acB").value || 50000, rules: { mdd: +$("acM").value || 0, dll: +$("acD").value || 0, ptg: +$("acT").value || 0 } };
    try { if (a) { await db.updAccount(a.id, row); Object.assign(a, row); } else { const n = await db.newAccount(row); accts.push(n); } if (acct && a && acct.id === a.id) applyAcctRules(); renderAccts(); } catch (e) { toast(e.message); } });
  if (!a) $("acP").onchange = () => { const v = ACCT_PRESETS[$("acP").value]; $("acN").value = v[0]; $("acB").value = v[1]; $("acM").value = v[2].mdd; $("acD").value = v[2].dll; $("acT").value = v[2].ptg; };
}

/* ---------------- themes (original palettes; candle colours stay yours) ---------------- */
const THEMES = { kairos: ["Kairos", { "--bg": "#0a0a0d", "--panel": "#111116", "--acc": "#a78bfa", "--acc2": "#7c3aed", "--txt": "#ecebf3", "--mut": "#8b8a99", "--line": "rgba(167,139,250,.10)" }], midnight: ["Midnight", { "--bg": "#08090c", "--panel": "#0e1116", "--acc": "#5ee6b8", "--acc2": "#7aa7ff", "--txt": "#e6eaf0", "--mut": "#8590a2", "--line": "rgba(255,255,255,.07)" }],
  grid: ["Neon grid", { "--bg": "#05070d", "--panel": "#0a0f1a", "--acc": "#38e8ff", "--acc2": "#ff3dce", "--txt": "#e9f4ff", "--mut": "#7f93ad", "--line": "rgba(56,232,255,.12)" }],
  ember: ["Ember", { "--bg": "#0d0907", "--panel": "#15100c", "--acc": "#ffb23d", "--acc2": "#ff6b4a", "--txt": "#f5ece4", "--mut": "#a8968a", "--line": "rgba(255,178,61,.10)" }],
  glacier: ["Glacier", { "--bg": "#070b10", "--panel": "#0d141c", "--acc": "#9fd8ff", "--acc2": "#c3b5ff", "--txt": "#e8f2fb", "--mut": "#8aa0b5", "--line": "rgba(159,216,255,.10)" }],
  mono: ["Mono", { "--bg": "#0a0a0a", "--panel": "#121212", "--acc": "#f2f2f2", "--acc2": "#9a9a9a", "--txt": "#ededed", "--mut": "#8a8a8a", "--line": "rgba(255,255,255,.08)" }] };
function applyTheme(k) { for (const [id, v] of Object.entries(prefs.myThemes || {})) THEMES[id] = v; const t = THEMES[k] || THEMES.kairos; for (const [v, c] of Object.entries(t[1])) document.documentElement.style.setProperty(v, c); prefs.theme = k in THEMES ? k : "kairos";
  if ($("s-themes")) $("s-themes").innerHTML = Object.entries(THEMES).map(([id, [nm, c]]) => `<button class="th ${id === prefs.theme ? "on" : ""}" data-th="${id}"><i style="background:${c["--bg"]};box-shadow:inset 0 0 0 1px ${c["--line"]}"><b style="background:${c["--acc"]}"></b><b style="background:${c["--acc2"]}"></b></i>${esc(nm)}</button>`).join(""); }

/* ---------------- quick trade review (rules followed? mistakes) ---------------- */
const MISTAKES = ["No setup", "Chased", "FOMO", "Early exit", "Moved stop", "Too big", "Revenge", "Fought the trend", "Ignored ES", "Off my hours"];
let revQ = [];
function reviewCard(t) { if (prefs.review === false || !t || !t.id) return; revQ.push(t); if (revQ.length === 1) showReview(); }
function showReview() { const t = revQ[0], el = $("review"); if (!t) return el.classList.add("hidden");
  el.innerHTML = `<div class="ah"><b>Rate that ${t.dir > 0 ? "long" : "short"} <span class="${t.pnl >= 0 ? "pos-up" : "pos-dn"}">${money(+t.pnl)}</span></b><button class="pb" id="rv-x" title="Skip">×</button></div>
    ${mfeLine(t)}<div class="small">Did you follow your rules?</div><div class="row"><button data-ok="1" class="small">✅ Yes</button><button data-ok="0" class="small">❌ No</button></div>
    <div class="chips">${MISTAKES.map((m) => `<button class="chip" data-mk="${m}">${m}</button>`).join("")}</div><div class="row"><button id="rv-save" class="primary small">Save</button><button id="rv-card" class="small ghost" title="Make a share card image of this trade">🖼 Card</button></div>`;
  el.classList.remove("hidden"); el.dataset.ok = ""; el.onclick = (e) => { const b = e.target.closest("button"); if (!b) return;
    if (b.id === "rv-x") { revQ.shift(); return showReview(); } if (b.id === "rv-card") return shareCard(t, true); if (b.dataset.ok != null) { el.dataset.ok = b.dataset.ok; el.querySelectorAll("[data-ok]").forEach((x) => x.classList.toggle("on", x === b)); }
    if (b.dataset.mk) b.classList.toggle("on");
    if (b.id === "rv-save") { const ch = { rules_ok: el.dataset.ok === "" ? null : el.dataset.ok === "1", mistakes: [...el.querySelectorAll(".chip.on")].map((x) => x.dataset.mk) }; Object.assign(t, ch); db.review(t.id, ch); if (ch.rules_ok) addXp(5); revQ.shift(); showReview(); } }; }

/* ---------------- mystery day (blind, random) + candle stepping ---------------- */
let blind = null;
async function mysteryDay() { if (pos.qty || orders.length) return toast("Close positions and cancel orders first");
  const a = Date.UTC(2021, 1, 1), z = Date.UTC(2026, 9, 30); let d; for (let i = 0; i < 50; i++) { d = new Date(a + Math.random() * (z - a)); const wd = d.getUTCDay(); if (wd >= 1 && wd <= 5 && !(d.getUTCMonth() === 11 && d.getUTCDate() >= 24) && !(d.getUTCMonth() === 0 && d.getUTCDate() <= 2)) break; }
  const day = d.toISOString().slice(0, 10); blind = { day }; $("start").value = day + "T08:30"; await loadReplay(); blindUI(); toast("🎲 Mystery day loaded. The date stays hidden until you press Reveal.");
}
function blindUI() { const on = !!blind; document.body.classList.toggle("blind", on); $("blindbtn").textContent = on ? "Reveal" : "🎲"; $("blindbtn").title = on ? "Show the date" : "Mystery day: a random day with the date hidden until you finish";
  panes.forEach((p) => p.chart.applyOptions({ timeScale: { tickMarkFormatter: on ? (t) => new Date(t * 1000).toISOString().slice(11, 16) : undefined }, localization: { timeFormatter: on ? (t) => new Date(t * 1000).toISOString().slice(11, 16) : undefined } })); refresh(); }
async function stepCandle() {   // play out one whole candle of the selected chart: stop when the next bar would start a new candle
  const p = panes[active]; if (!p || !p.candles.length) return stepFwd(); const base = p.sec < 60 ? B["15s"] : B["1m"];
  for (let n = 0; n < 3000; n++) { const g = await stepFwd(false); if (g === false) break; const nx = base.bars[base.i + 1]; if (!nx || bucket(loc(nx.t), p.sec) !== bucket(loc(nowT()), p.sec)) break; }
  rebuildAll(); }

/* ---------------- first-run tour + help ---------------- */
function helpDlg() { const K = prefs.keys, rows = [["Play / pause", "Space"], ["Step forward / back", "→ / ←"], ["Buy / sell market", (K.buy + " / " + K.sell).toUpperCase()], ["Join bid / ask", (K.joinbid + " / " + K.joinask).toUpperCase()], ["Close / reverse", (K.close + " / " + K.reverse).toUpperCase()], ["Flatten / cancel all", (K.flatten + " / " + K.cancel).toUpperCase()],
    ["Trend / h-line / v-line / zone", (K.trend + " / " + K.hline + " / " + K.vline + " / " + K.rect).toUpperCase()], ["Long / short box", (K.long + " / " + K.short).toUpperCase()], ["Measure", K.measure.toUpperCase()], ["Cancel tool / deselect", "Esc"], ["Delete drawing", "Del"]];
  dlg(`<h3>Help</h3><table class="bt">${rows.map(([a, b]) => `<tr><td>${a}</td><td><kbd>${b}</kbd></td></tr>`).join("")}</table><p class="tiny muted">Change hot keys in Settings. Right-click the chart, an order line, a drawing or the Scalp Pad for more options.</p>`, () => tour(0));
  const ok = $("dl-ok"); if (ok) ok.textContent = "Show the tour"; }

/* ---------------- Utah prop firm tax estimate (2026 figures; estimate only) ---------------- */
const TAX26 = { s: { sd: 16100, br: [[12400, .10], [50400, .12], [105700, .22], [201775, .24], [256225, .32], [640600, .35], [Infinity, .37]] }, mfj: { sd: 32200, br: [[24800, .10], [100800, .12], [211400, .22], [403550, .24], [512450, .32], [768700, .35], [Infinity, .37]] }, ssBase: 184500, ut: 0.0445 };
function fedTax(ti, st) { let t = 0, lo = 0; for (const [hi, r] of TAX26[st].br) { if (ti > lo) t += (Math.min(ti, hi) - lo) * r; lo = hi; } return t; }
function taxCalc() { const st = $("tx-st").value, pay = +$("tx-pay").value || 0, exp = +$("tx-exp").value || 0, w2 = +$("tx-w2").value || 0, wh = +$("tx-wh").value || 0;
  const prof = Math.max(0, pay - exp), se = prof * 0.9235, ss = Math.min(se, Math.max(0, TAX26.ssBase - w2)) * 0.124, med = se * 0.029, seTax = prof > 400 ? ss + med : 0;
  const agi = w2 + prof - seTax / 2, ti = Math.max(0, agi - TAX26[st].sd), fed = fedTax(ti, st), fedW2 = fedTax(Math.max(0, w2 - TAX26[st].sd), st), ut = agi * TAX26.ut;
  const total = fed + seTax + ut, fromTrading = total - fedW2 - w2 * TAX26.ut, setAside = prof ? fromTrading / prof : 0, owe = Math.max(0, total - wh);
  $("tx-out").innerHTML = [["Trading profit", money(prof)], ["Self-employment tax", money(seTax)], ["Federal income tax", money(fed)], ["Utah income tax (before credits)", money(ut)], ["Total tax", money(total)], ["Still to pay (after withholding)", money(owe)], ["Set aside from each payout", prof ? Math.round(setAside * 100) + "%" : "—"], ["Quarterly payment (Apr 15, Jun 15, Sep 15, Jan 15)", money(owe / 4)]]
    .map(([k, v]) => `<div><span class="muted small">${k}</span><b>${v}</b></div>`).join(""); }

/* ---------------- position presets + confluence checklist ---------------- */
const CONF_REESE = ["HTF bias agrees", "Liquidity swept", "Inversion FVG", "SMT with ES", "PO3 / manipulation", "Key open", "In the killzone", "5m / 15m FVG entry", "Clear draw on liquidity"];
const RISK_PRESETS = [["1:2", 0, 2], ["1:3 (Reese)", 0, 3], ["1:4", 0, 4], ["10 pt stop · 1:2", 10, 2], ["15 pt stop · 1:3", 15, 3], ["25 pt stop · 1:4", 25, 4]];
function applyRisk(d, [nm, stopPts, rr]) { const risk = stopPts || Math.abs(d.entry - d.sl) || 10; d.sl = rnd(d.entry - d.side * risk); d.tp = rnd(d.entry + d.side * risk * rr); syncTool(d); repaintAll(); toast(nm + " applied"); }
function confDlg(d) { const tags = prefs.tagset && prefs.tagset.length ? prefs.tagset : CONF_REESE, on = new Set(d.tags || []);
  dlg(`<h3>Confluences</h3><p class="tiny muted">Tick what's there before you arm it. The ticks are saved with the trade, and Stats shows which ones actually pay.</p><div class="cks">${tags.map((t, i) => `<label class="ck"><input type="checkbox" data-t="${i}" ${on.has(t) ? "checked" : ""}> ${t}</label>`).join("")}</div>
    <label>Add your own (comma separated)<input id="cfX" placeholder="e.g. NWOG, CISD"></label><div class="score" id="cfS"></div>`,
  () => { const pick = [...document.querySelectorAll("#dlgbox [data-t]")].filter((x) => x.checked).map((x) => tags[+x.dataset.t]); const extra = $("cfX").value.split(",").map((x) => x.trim()).filter(Boolean);
    if (extra.length) { prefs.tagset = [...new Set([...tags, ...extra])]; savePrefs(); } d.tags = [...pick, ...extra]; repaintAll(); toast(d.tags.length + " confluence" + (d.tags.length === 1 ? "" : "s") + " saved"); });
  const sc = () => { const n = [...document.querySelectorAll("#dlgbox [data-t]")].filter((x) => x.checked).length; $("cfS").innerHTML = `Score <b>${n}/${tags.length}</b>`; }; document.querySelectorAll("#dlgbox [data-t]").forEach((x) => (x.onchange = sc)); sc(); }

/* ---------------- stats ---------------- */
let stC = null;
/* ---------------- Monte Carlo: reshuffle your own trades thousands of times → odds of passing an eval vs blowing it ---------------- */
function mcRun(pnls, o) { const N = o.paths || 2000, T = o.max || 200, pass = [], fan = [], ends = []; let blown = 0, passed = 0, open = 0;
  let seed = 12345; const rr = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let k = 0; k < N; k++) { let eq = 0, pk = 0, path = k < 60 ? [0] : null, res = null;
    for (let i = 0; i < T; i++) { eq += pnls[(rr() * pnls.length) | 0]; pk = Math.max(pk, eq); if (path) path.push(eq);
      if (o.mdd && pk - eq >= o.mdd) { res = "blown"; break; } if (o.ptg && eq >= o.ptg) { res = "pass"; pass.push(i + 1); break; } }
    if (res === "blown") blown++; else if (res === "pass") passed++; else open++; ends.push(eq); if (path) { path.res = res; fan.push(path); } }
  pass.sort((a, b) => a - b); ends.sort((a, b) => a - b);
  return { N, passPct: (100 * passed) / N, blownPct: (100 * blown) / N, openPct: (100 * open) / N, medTrades: pass.length ? pass[pass.length >> 1] : null, p10: ends[(N * 0.1) | 0], p50: ends[N >> 1], p90: ends[(N * 0.9) | 0], fan }; }
function mcDraw(cv, r, o) { const W = (cv.width = cv.clientWidth * 2), H = (cv.height = cv.clientHeight * 2), g = cv.getContext("2d"); g.clearRect(0, 0, W, H);
  let lo = -(o.mdd || 1000), hi = o.ptg || 1000, len = 1; for (const p of r.fan) { len = Math.max(len, p.length); for (const v of p) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  const X = (i) => 8 + (i / (len - 1 || 1)) * (W - 16), Y = (v) => H - 10 - ((v - lo) / (hi - lo || 1)) * (H - 20);
  const ln = (v, c) => { g.strokeStyle = c; g.setLineDash([8, 6]); g.lineWidth = 2; g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(W, Y(v)); g.stroke(); g.setLineDash([]); };
  ln(0, "rgba(255,255,255,.18)"); if (o.ptg) ln(o.ptg, "rgba(74,222,128,.7)"); if (o.mdd) ln(-o.mdd, "rgba(248,113,113,.7)");
  for (const p of r.fan) { g.strokeStyle = p.res === "pass" ? "rgba(74,222,128,.28)" : p.res === "blown" ? "rgba(248,113,113,.38)" : "rgba(185,140,255,.25)"; g.lineWidth = 2; g.beginPath(); p.forEach((v, i) => (i ? g.lineTo(X(i), Y(v)) : g.moveTo(X(i), Y(v)))); g.stroke(); } }
function mcUI(tr) { const el = $("st-mc"); if (!el) return; const pnls = tr.map((t) => +t.pnl || 0); const a = accts.find((x) => x.id === $("st-acct").value), R = (a && a.rules) || {};
  const o = { ptg: +($("mc-ptg") && $("mc-ptg").value) || R.ptg || prefs.ptg || 3000, mdd: +($("mc-mdd") && $("mc-mdd").value) || R.mdd || prefs.mdd || 2000, max: 200, paths: 2000 };
  if (pnls.length < 10) { el.innerHTML = `<div class="small muted">Needs at least 10 trades in this filter (you have ${pnls.length}). It reshuffles your real results to estimate your odds.</div>`; return; }
  const r = mcRun(pnls, o);
  el.innerHTML = `<div class="mcin"><label>Profit target<input id="mc-ptg" type="number" value="${o.ptg}"></label><label>Max drawdown (trailing)<input id="mc-mdd" type="number" value="${o.mdd}"></label><button class="small" id="mc-go">Run again</button></div>
    <div class="mck"><div><span class="muted small">Pass</span><b class="pos-up">${r.passPct.toFixed(0)}%</b></div><div><span class="muted small">Blow the account</span><b class="pos-dn">${r.blownPct.toFixed(0)}%</b></div><div><span class="muted small">Still going after 200 trades</span><b>${r.openPct.toFixed(0)}%</b></div><div><span class="muted small">Trades to pass (median)</span><b>${r.medTrades ?? "—"}</b></div></div>
    <canvas id="mc-cv" class="mccv"></canvas><div class="tiny muted">${r.N.toLocaleString()} reshuffles of your ${pnls.length} trades in this filter. Green = hit the target, red = hit the drawdown. Past replay results, not a promise.</div>`;
  mcDraw($("mc-cv"), r, o); $("mc-go").onclick = () => mcUI(tr); }
async function renderStats() {
  $("st-acct").innerHTML = `<option value="">All accounts</option><option value="none">Replay (no account)</option>` + accts.map((a) => `<option value="${a.id}">${a.name}</option>`).join(""); $("st-acct").value = prefs.stAcct || "";
  let tr = (await db.allTrades()).slice().sort((a, b) => a.t_exit - b.t_exit); const A = $("st-acct").value, S = $("st-sym").value, D = +$("st-range").value;
  if (A === "none") tr = tr.filter((t) => !t.account_id); else if (A) tr = tr.filter((t) => t.account_id === A); if (S) tr = tr.filter((t) => t.symbol === S);
  if (D && tr.length) { const end = tr[tr.length - 1].t_exit; tr = tr.filter((t) => t.t_exit >= end - D * 86400); }
  const n = tr.length, W = tr.filter((t) => t.pnl > 0), L = tr.filter((t) => t.pnl <= 0), sum = (a) => a.reduce((s, t) => s + (+t.pnl || 0), 0), gw = sum(W), gl = -sum(L);
  let run = 0, pk = 0, dd = 0, cw = 0, cl = 0, bw = 0, bl = 0; const eq = [];
  for (const t of tr) { run += +t.pnl || 0; pk = Math.max(pk, run); dd = Math.max(dd, pk - run); if (t.pnl > 0) { cw++; cl = 0; } else { cl++; cw = 0; } bw = Math.max(bw, cw); bl = Math.max(bl, cl); eq.push({ time: t.t_exit, value: +run.toFixed(2) }); }
  const rs = tr.filter((t) => t.r != null), K = [["Trades", n], ["Win rate", n ? Math.round((100 * W.length) / n) + "%" : "—"], ["Net", money(run)], ["Expectancy / trade", n ? money(run / n) : "—"], ["Avg R", rs.length ? (rs.reduce((s, t) => s + +t.r, 0) / rs.length).toFixed(2) + "R" : "—"],
    ["Profit factor", gl ? (gw / gl).toFixed(2) : n ? "∞" : "—"], ["Avg win", W.length ? money(gw / W.length) : "—"], ["Avg loss", L.length ? money(-gl / L.length) : "—"], ["Worst drop", money(-dd)], ["Best streak", bw + " wins"], ["Worst streak", bl + " losses"]];
  $("st-kpi").innerHTML = K.map(([k, v]) => `<div><span class="muted small">${k}</span><b>${v}</b></div>`).join("");
  const grp = (key) => { const g = {}; for (const t of tr) for (const k of [].concat(key(t))) { (g[k] = g[k] || []).push(t); } return g; };
  const table = (g, order) => { const ks = order ? order.filter((k) => g[k]) : Object.keys(g).sort((a, b) => sum(g[b]) - sum(g[a])); if (!ks.length) return '<div class="empty">No trades yet</div>'; const mx = Math.max(...ks.map((k) => Math.abs(sum(g[k])))) || 1;
    return `<table class="bt"><tr><th></th><th>Trades</th><th>Win</th><th>Avg R</th><th>Net</th><th></th></tr>${ks.map((k) => { const v = sum(g[k]), w = g[k].filter((t) => t.pnl > 0).length, gr = g[k].filter((t) => t.r != null), ar = gr.length ? gr.reduce((q, t) => q + +t.r, 0) / gr.length : null; return `<tr><td>${k}</td><td>${g[k].length}</td><td>${Math.round((100 * w) / g[k].length)}%</td><td class="${ar == null ? "" : ar >= 0 ? "pos-up" : "pos-dn"}">${ar == null ? "—" : (ar >= 0 ? "+" : "") + ar.toFixed(2) + "R"}</td><td class="${v >= 0 ? "pos-up" : "pos-dn"}">${money(v)}</td><td><i class="hbar ${v >= 0 ? "up" : "dn"}" style="width:${Math.round((60 * Math.abs(v)) / mx)}px"></i></td></tr>`; }).join("")}</table>`; };
  $("st-hour").innerHTML = table(grp((t) => lhm(loc(t.t_entry)).slice(0, 2) + ":00"), [...Array(24).keys()].map((h) => String(h).padStart(2, "0") + ":00"));
  // KING_STATS (Nov 11): by trading session (New York time) next to by hour
  if ($("st-sess")) $("st-sess").innerHTML = table(grp((t) => { const m = lhm(loc(t.t_entry)); return m >= "20:00" || m < "02:00" ? "Asia (8 PM-2 AM)" : m < "07:00" ? "London (2-7 AM)" : m < "09:30" ? "NY pre-open (7-9:30)" : m < "12:00" ? "NY AM (9:30-12)" : m < "16:00" ? "NY PM (12-4)" : "After hours (4-8 PM)"; }), ["Asia (8 PM-2 AM)", "London (2-7 AM)", "NY pre-open (7-9:30)", "NY AM (9:30-12)", "NY PM (12-4)", "After hours (4-8 PM)"]);
  $("st-wd").innerHTML = table(grp((t) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(loc(t.t_entry) * 1000).getUTCDay()]), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sun"]);
  $("st-tag").innerHTML = table(grp((t) => { const g = (t.tags || []).filter((x) => !/^(strat|rules):/.test(x)); return g.length ? g : ["(no tags)"]; }));
  $("st-strat").innerHTML = table(grp((t) => { const s = (t.tags || []).find((x) => x.startsWith("strat:")); return s ? s.slice(6) : "(no strategy)"; }));
  $("st-chk").innerHTML = table(grp((t) => { const r = (t.tags || []).find((x) => x.startsWith("rules:")); if (!r) return "No checklist"; const [a, b] = r.slice(6).split("/").map(Number); return a >= b ? "Every rule ticked" : a >= b - 1 ? "Missed 1 rule" : "Missed 2+ rules"; }), ["Every rule ticked", "Missed 1 rule", "Missed 2+ rules", "No checklist"]);
  const rs2 = tr.filter((t) => t.r != null).map((t) => +t.r), bins = [[-9, -1.5], [-1.5, -0.75], [-0.75, -0.25], [-0.25, 0.25], [0.25, 1], [1, 2], [2, 3], [3, 99]], lab = ["≤-1.5R", "-1R", "-0.5R", "~0", "+0.5R", "+1.5R", "+2.5R", "3R+"];
  const cnt = bins.map(([a, b]) => rs2.filter((r) => r > a && r <= b).length), mxc = Math.max(1, ...cnt);
  $("st-rd").innerHTML = rs2.length ? `<div class="rbars">${cnt.map((c, i) => `<div><i style="height:${Math.round((80 * c) / mxc)}px" class="${i < 3 ? "dn" : i > 3 ? "up" : ""}"></i><b>${c}</b><span>${lab[i]}</span></div>`).join("")}</div>` : '<div class="empty">No trades with R yet</div>';
  mcUI(tr); try { lfUI(tr); } catch (e) {}
  $("st-rule").innerHTML = table(grp((t) => (t.rules_ok === true ? "Followed rules" : t.rules_ok === false ? "Broke rules" : "Not rated")), ["Followed rules", "Broke rules", "Not rated"]);
  const after = []; for (let i = 1; i < tr.length; i++) { const a = tr[i - 1], b = tr[i]; if (a.pnl < 0 && b.t_entry - a.t_exit < 600) after.push(b); }
  const sizeUp = tr.filter((t, i) => i && tr[i - 1].pnl < 0 && t.qty > tr[i - 1].qty).length, aw = after.filter((t) => t.pnl > 0).length;
  $("st-tilt").innerHTML = `<div class="kvs"><div><span>Re-entries within 10 min of a loss</span><b>${after.length}${after.length ? " · " + Math.round((100 * aw) / after.length) + "% win · " + money(sum(after)) : ""}</b></div><div><span>Size went up right after a loss</span><b>${sizeUp}</b></div></div>` + table(grp((t) => (t.mistakes && t.mistakes.length ? t.mistakes : [])));
  if (!stC) { stC = LightweightCharts.createChart($("st-eq"), { autoSize: true, layout: { background: { type: "solid", color: "transparent" }, textColor: "#7f8a9c", fontFamily: "Inter, sans-serif" }, grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,.04)" } }, rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false } }); stC.s = stC.addAreaSeries({ lineColor: "#5ee6b8", topColor: "rgba(94,230,184,.25)", bottomColor: "rgba(94,230,184,0)", lineWidth: 2, lineType: 2, pointMarkersVisible: false, crosshairMarkerRadius: 3 }); }
  const seen = new Set(); stC.s.setData(eq.filter((p) => (seen.has(p.time) ? false : seen.add(p.time)))); stC.timeScale().fitContent();
}

/* ---------------- learn: Reese log, quiz, course, earn an eval, time tracking ---------------- */
let reese = [], quizBank = [], QZ = null;
const RSES = { NY: ["08:30", "16:00", 0], Asia: ["19:30", "24:00", 0], London: ["02:00", "08:30", 0], Evening: ["17:30", "24:00", 0] };
async function loadReese() { if (DEMO) { reese = [{ id: "r1", day: "2026-10-15", session: "NY", symbol: "NQ", dir: 1, entry: 21420, exit: 21470, result: "win", summary: "Demo entry: 15s long after the 9:30 sweep, out at the 1h level.", quotes: ["ltf beating htf"] }]; return; }
  const { data } = await sb.from("reese_trades").select("*").order("day"); reese = data || []; }
const seen = () => new Set(prefs.seenSess || []);
function sessEnd(r) { const [, z] = RSES[r.session] || RSES.NY; const base = Date.parse(r.day + "T00:00:00Z") / 1000, [hh, mm] = z.split(":").map(Number); return base + hh * 3600 + mm * 60; }   // New York wall-clock as fake-UTC (same as loc())
function reeseCheck(prevLt, curLt) {   // called while stepping: a Reese session just ended on the replay clock
  for (const r of reese) { const e = sessEnd(r); if (prevLt < e && curLt >= e) { const k = r.day + "|" + r.session, sn = seen(); if (!sn.has(k)) { sn.add(k); prefs.seenSess = [...sn]; savePrefs(); } reesePop(r); } } }

/* Reese media: his Discord screenshots + what he said during that session (members-only bucket) */
function reeseMedia(r, open) { const sh = r.shots || [], nt = r.notes || []; if (!sh.length && !nt.length) return "";
  return `<details class="rmedia" ${open ? "open" : ""}><summary>📸 His screenshots${nt.length ? " + what he said live" : ""}</summary>
    ${sh.length ? `<div class="rshots">${sh.map((p) => `<a target="_blank" rel="noopener" data-rp="${esc(p)}"><img alt="Reese screenshot" data-rp="${esc(p)}"></a>`).join("")}</div>` : ""}
    ${nt.length ? `<div class="rnotes">${nt.map((n) => `<div><span class="muted">${esc(n.t)}</span> ${esc(n.x)}</div>`).join("")}</div>` : ""}</details>`; }
const rpCache = {};
async function fillReeseShots(root) { const els = [...root.querySelectorAll("[data-rp]")]; if (!els.length || DEMO) return; const need = [...new Set(els.map((e) => e.dataset.rp))].filter((p) => !rpCache[p]);
  if (need.length) { const { data } = await sb.storage.from("reese").createSignedUrls(need, 3600); (data || []).forEach((d, i) => { if (d.signedUrl) rpCache[need[i]] = d.signedUrl; }); }
  els.forEach((e) => { const u = rpCache[e.dataset.rp]; if (!u) return; if (e.tagName === "IMG") e.src = u; else e.href = u; }); }
function reesePop(r) {
  const st = sessEnd(r) - (r.session === "NY" ? 7.5 * 3600 : 4.5 * 3600), mine = hist.filter((t) => loc(t.t_entry) >= st && loc(t.t_entry) < sessEnd(r) && (t.symbol === r.symbol || t.symbol.replace("M", "") === r.symbol.replace("M", "")));
  let verdict = "", xp = 0; if (r.dir) { const same = mine.filter((t) => t.dir === r.dir), opp = mine.filter((t) => t.dir === -r.dir);
    if (same.length) { verdict = "✅ You took the same side as Reese."; xp = 50; } else if (opp.length) { verdict = "↔️ You traded the other way."; xp = 10; } else { verdict = r.result === "win" ? "👀 You sat out a session he won. Look at what he saw." : "🧘 You sat out. He " + (r.result === "loss" ? "took a loss here." : "didn't make much."); xp = r.result === "loss" ? 25 : 0; } }
  else if (r.result === "journal") verdict = "📸 Here's what Reese posted live this session. Compare it to what you saw.";
  else verdict = "📋 No trade from him here, just his plan. Did yours match?";
  if (xp) addXp(xp);
  dlg(`<h3>Reese ${r.dir ? "traded" : r.result === "journal" ? "posted" : "planned"} this session</h3><div class="muted small">${r.day} · ${r.session} · ${r.symbol}</div>
    ${r.dir ? `<div class="shrow"><span class="${r.dir > 0 ? "pos-up" : "pos-dn"}">${r.dir > 0 ? "Long" : "Short"}</span>${r.entry ? " @ " + px2(+r.entry) : ""}${r.exit ? " → " + px2(+r.exit) : ""} · <b>${r.result}</b></div>` : ""}
    <p class="small">${esc(r.summary)}</p>${(r.quotes || []).length ? `<div class="quotes">${r.quotes.slice(0, 4).map((q) => `<div>“${esc(q)}”</div>`).join("")}</div>` : ""}
    ${reeseMedia(r, true)}${r.video_url ? `<p><button class="small" data-vid="${esc((r.video_url.match(/([A-Za-z0-9_-]{11})/) || [])[1] || "")}" data-title="Reese · ${esc(r.day)} recap" onclick="playVid('${esc(r.video_url)}', 'Reese · ${esc(r.day)} ${r.video_start != null ? "· the trade" : "recap"}', ${+r.video_start || 0}, ${+r.video_end || 0})">▶ ${r.video_start != null ? "Watch this trade" : "Watch his recap"}</button>${r.video_start != null ? ` <button class="small ghost" onclick="playVid('${esc(r.video_url)}', 'Reese · ${esc(r.day)} recap')">Full video</button>` : ""}</p>` : ""}
    <div class="riskcard">${verdict}${xp ? ` <b>+${xp} XP</b>` : ""}<br>Your trades this session: ${mine.length ? mine.map((t) => `${t.dir > 0 ? "long" : "short"} ${money(+t.pnl)}`).join(", ") : "none"}</div>`, () => {
    if (r.entry && panes[0]) { const t0 = sessEnd(r) - 3 * 3600; drawings.push({ id: did++, type: "hline", pane: 0, a: { t: t0, p: +r.entry }, label: "Reese entry" }); if (r.exit) drawings.push({ id: did++, type: "hline", pane: 0, a: { t: t0, p: +r.exit }, label: "Reese exit" }); repaintAll(); } });
  const ok = $("dl-ok"); if (ok) ok.textContent = r.entry ? "Show his levels" : "OK"; fillReeseShots($("dlgbox")); }
function addXp(n) { prefs.xp = (prefs.xp || 0) + n; prefs.credits = (prefs.credits || 0) + Math.round(n / 5); savePrefs(); xpUI(); }
function xpUI() { const x = prefs.xp || 0, lv = Math.floor(Math.sqrt(x / 50)) + 1, nx = 50 * lv * lv, pv = 50 * (lv - 1) * (lv - 1); $("xpbar").innerHTML = `Level <b>${lv}</b> <i class="xpb"><i style="width:${Math.round((100 * (x - pv)) / (nx - pv))}%"></i></i> ${x} XP · ${prefs.credits || 0} credits`; }
/* ---------------- Fix my mistakes: daily practice built from the mistakes you tag (Duolingo-style) ---------------- */
const MX_TIPS = { "No setup": "Write the setup name before you click. No name, no trade.", "Chased": "If price left your level, let it come back or let it go. Missing is free.", "FOMO": "Count to 10 after a big candle. The next setup is always coming.",
  "Early exit": "Let the stop or the target close it. Only move the exit to breakeven, never to scratch.", "Moved stop": "The stop is the idea being wrong. Moving it is hoping.", "Too big": "Size from the stop distance, not the feeling. Use the risk-% sizing.",
  "Revenge": "After a loss, step back one full candle on your timeframe before the next entry.", "Fought the trend": "Check the 1h and 4h direction first. Trade with it until a clear shift.", "Ignored ES": "Glance at ES before every NQ entry. No confirmation, no trade (SMT).", "Off my hours": "Trade your window only. Outside it, replay but don't click." };
const todayKey = () => new Date().toLocaleDateString("en-CA");
function mxQuizTick() { const d = todayKey(); prefs.quizDay = prefs.quizDay && prefs.quizDay.d === d ? prefs.quizDay : { d, n: 0 }; prefs.quizDay.n++; }
async function renderMx() { const el = $("l-mx"); el.innerHTML = '<div class="muted small">Loading your trades…</div>'; const all = await db.allTrades().catch(() => []), now = Date.now() / 1000, d = todayKey();
  const rated = all.filter((t) => t.rules_ok != null), recent = all.filter((t) => new Date(t.created_at || t.t_exit * 1000) / 1000 > now - 30 * 86400), prev = all.filter((t) => { const c = new Date(t.created_at || t.t_exit * 1000) / 1000; return c <= now - 30 * 86400 && c > now - 60 * 86400; });
  const tally = (arr) => { const m = {}; for (const t of arr) for (const k of t.mistakes || []) m[k] = (m[k] || 0) + 1; return m; }, cur = tally(recent), old = tally(prev);
  const cost = {}; for (const t of recent) for (const k of t.mistakes || []) cost[k] = (cost[k] || 0) + (+t.pnl || 0);
  const top = Object.entries(cur).sort((a, b) => b[1] - a[1]), focus = top.length ? top[0][0] : null;
  let streak = 0; for (const t of rated.slice().sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))) { if (t.rules_ok && !(t.mistakes || []).length) streak++; else break; }
  const today = all.filter((t) => (t.created_at ? new Date(t.created_at).toLocaleDateString("en-CA") : "") === d), qd = prefs.quizDay && prefs.quizDay.d === d ? prefs.quizDay.n : 0;
  const tasks = [
    { id: "clean", n: 3, have: today.filter((t) => t.rules_ok && !(t.mistakes || []).includes(focus || "")).length, t: focus ? `Take 3 trades today with no “${focus}”` : "Take 3 trades today and follow your rules", sub: focus ? MX_TIPS[focus] || "" : "Rate each one after you close it.", xp: 30 },
    { id: "drill", n: 5, have: qd, t: "Answer 5 take-it-or-fade-it drills", sub: "Reading setups fast is what stops the chasing.", xp: 20, go: "qz" },
    { id: "rate", n: Math.max(1, today.length), have: today.filter((t) => t.rules_ok != null).length, t: today.length ? `Rate all ${today.length} of today's trades` : "Rate your trades after you take them", sub: "Honest tags are what this page learns from.", xp: 15, need: today.length > 0 } ];
  const done = (prefs.mxDone = prefs.mxDone && prefs.mxDone.d === d ? prefs.mxDone : { d, ids: [] }); let paid = 0;
  for (const k of tasks) if ((k.need !== false) && k.have >= k.n && !done.ids.includes(k.id)) { done.ids.push(k.id); paid += k.xp; } if (paid) { addXp(paid); toast(`🎯 Daily practice: +${paid} XP`); } else savePrefs();
  const allDone = tasks.every((k) => done.ids.includes(k.id)); if (allDone && prefs.mxStreakDay !== d) { const y = new Date(Date.now() - 864e5).toLocaleDateString("en-CA"); prefs.mxStreak = prefs.mxStreakDay === y ? (prefs.mxStreak || 0) + 1 : 1; prefs.mxStreakDay = d; savePrefs(); }
  const days = prefs.mxStreakDay === d || prefs.mxStreakDay === new Date(Date.now() - 864e5).toLocaleDateString("en-CA") ? prefs.mxStreak || 0 : 0;
  el.innerHTML = `<div class="mxtop"><div class="card mxs"><span class="muted small">Practice streak</span><b>🔥 ${days} day${days === 1 ? "" : "s"}</b></div><div class="card mxs"><span class="muted small">Clean trades in a row</span><b>${streak}</b></div><div class="card mxs"><span class="muted small">Rated trades</span><b>${rated.length}</b></div><div class="card mxs"><span class="muted small">Biggest leak (30 days)</span><b>${focus ? esc(focus) : "—"}</b></div></div>
    <h3 class="sub">Today</h3><div class="mxtasks">${tasks.map((k) => { const ok = done.ids.includes(k.id), pc = Math.min(100, Math.round((100 * k.have) / k.n)); return `<div class="card mxt ${ok ? "ok" : ""}"><div class="mxr"><span class="mxi">${ok ? "✓" : ""}</span><div><b>${esc(k.t)}</b><span class="muted small">${esc(k.sub)}</span></div><span class="mxxp">+${k.xp} XP</span></div><div class="mxbar"><i style="width:${pc}%"></i></div><div class="mxr2"><span class="tiny muted">${Math.min(k.have, k.n)} / ${k.n}</span>${k.go && !ok ? `<button class="small" data-mxgo="${k.go}">Start</button>` : ""}</div></div>`; }).join("")}</div>
    <h3 class="sub">Your mistakes, last 30 days</h3>${top.length ? `<div class="mxlist">${top.map(([k, n]) => { const was = old[k] || 0, tr = n < was ? `<span class="pos-up">↓ from ${was}</span>` : n > was ? `<span class="pos-dn">↑ from ${was}</span>` : ""; return `<div class="card mxm"><div class="mxr"><b>${esc(k)}</b><span>${n}× ${tr}</span><span class="${(cost[k] || 0) >= 0 ? "pos-up" : "pos-dn"}">${money(cost[k] || 0)}</span></div><div class="small muted">${esc(MX_TIPS[k] || "")}</div></div>`; }).join("")}</div>` : '<div class="card small muted">No tagged mistakes yet. After each trade, the rating card asks if you followed your rules. Tag what went wrong and this page turns it into daily practice.</div>'}`;
  el.onclick = (e) => { const g = e.target.closest("[data-mxgo]"); if (g) ltab(g.dataset.mxgo); }; }
function ltab(k) { document.querySelectorAll("#ltabs button").forEach((b) => b.classList.toggle("on", b.dataset.l === k)); ["mx", "rl", "qz", "co", "ev"].forEach((x) => $("l-" + x).classList.toggle("hidden", x !== k)); xpUI(); ({ mx: renderMx, rl: renderRL, qz: qzStats, co: renderCourse, ev: renderEv })[k](); }
async function renderRL() { if (!reese.length) await loadReese(); const sn = seen(), hide = $("rl-spoil").checked;
  $("rl-list").innerHTML = reese.slice().reverse().map((r) => { const done = sn.has(r.day + "|" + r.session), sp = hide && !done;   // everything (trades, plans, his screenshots) unlocks after you replay that session
    return `<div class="card rc"><div class="ah"><b>${r.day} · ${r.session}</b><span class="pill ${sp ? "" : r.result === "win" ? "up" : r.result === "loss" ? "dn" : ""}">${sp ? "hidden" : r.result}</span></div>
      ${sp ? '<p class="small muted">Replay this session first. The result unlocks when you finish it.</p>' : `${r.dir ? `<div class="shrow"><span class="${r.dir > 0 ? "pos-up" : "pos-dn"}">${r.dir > 0 ? "Long" : "Short"} ${r.symbol}</span>${r.entry ? " @ " + px2(+r.entry) : ""}${r.exit ? " → " + px2(+r.exit) : ""}</div>` : ""}<p class="small">${esc(r.summary)}</p>${(r.quotes || []).slice(0, 2).map((q) => `<div class="small rnote">“${esc(q)}”</div>`).join("")}${reeseMedia(r)}`}
      <div class="row" style="justify-content:flex-start"><button class="small primary" data-rday="${r.id}">Replay this session</button></div></div>`; }).join("") || '<div class="empty">No Reese trades loaded</div>'; $("rl-list").querySelectorAll("details.rmedia").forEach((d) => (d.ontoggle = () => d.open && fillReeseShots(d))); }
async function replayReese(r) { if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); const [a] = RSES[r.session] || RSES.NY; $("sym").value = r.symbol; $("start").value = r.day + "T" + a; view("trade"); await loadReplay(); }
// ---- quiz: "Taking dis? or fade it?"
async function loadQuiz() { if (quizBank.length) return; if (DEMO) { quizBank = []; return; } const { data } = await sb.from("quiz_setups").select("*").limit(2000); quizBank = data || [];
  if (!quizBank.length) try { quizBank = await (await fetch("quiz.json", { cache: "no-store" })).json(); } catch (e) {} }   // bank of real model setups (prices and times only), ships with the app
function qzStats() { const q = prefs.quiz || { n: 0, right: 0, streak: 0, best: 0 }; $("qz-stats").innerHTML = [["Answered", q.n], ["Right", q.n ? Math.round((100 * q.right) / q.n) + "%" : "—"], ["Streak", q.streak], ["Best streak", q.best]].map(([k, v]) => `<div><span class="muted small">${k}</span><b>${v}</b></div>`).join(""); }
async function quizNext() {
  if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); await loadQuiz();
  let it = quizBank.length ? quizBank[Math.floor(Math.random() * quizBank.length)] : null;
  if (!it && DEMO) { await loadReplay(); for (let i = 0; i < 40; i++) await stepFwd(); const lp = last(); it = { symbol: "NQ", t_entry: nowT() + 60, dir: 1, entry: rnd(lp - 4), stop: rnd(lp - 16), target: rnd(lp + 26), outcome: "win", why: ["10AM manipulation", "SWEPT LIQUIDITY", "5M CLOSE BACK"] }; }
  if (!it) return toast("No quiz setups yet");
  // fix 16: one chart on the 1m, replay locked to 15s so any higher timeframe you flip to only shows candles up to "now" (no peeking at finished candles)
  QZ = { it, answered: false }; view("trade"); lock15 = true; if (prefs.layout !== "1") setLayout("1"); prefs.tfs[active] = "1m"; tfUI(); label(panes[active]);
  $("sym").value = it.symbol; $("start").value = fmt(loc(it.t_entry)).replace(" ", "T"); if (!DEMO || !B["1m"].bars.length) await loadReplay(); else { await ensure15(); rebuildAll(); }
  // KING_QZALIGN (Nov 11): the position starts exactly on the newest candle on screen, and every new drill re-fits the price scale (a manual drag on the last drill used to leave the axis stuck at that drill's prices, e.g. 14,000)
  panes.forEach((p) => { p.auto = true; try { p.chart.priceScale("right").applyOptions({ autoScale: true }); } catch (e) {} });
  const qc = panes[active].candles, qa = qc && qc.length ? qc[qc.length - 1].time : loc(it.t_entry);
  drawings = drawings.filter((d) => !d.quiz); const d = { id: did++, type: it.dir > 0 ? "long" : "short", side: it.dir, pane: active, a: { t: qa, p: +it.entry }, b: { t: qa + 90 * 60, p: +it.entry }, entry: +it.entry, sl: +it.stop, tp: +it.target, state: "idle", quiz: true }; drawings.push(d);
  const rr = Math.abs(it.target - it.entry) / Math.abs(it.entry - it.stop);
  $("qz-desc").innerHTML = `${it.dir > 0 ? "Long" : "Short"} ${it.symbol} @ <b>${px2(+it.entry)}</b> · stop ${px2(+it.stop)} · target ${px2(+it.target)} · ${rr.toFixed(1)}R`; $("qzbar").classList.remove("hidden"); $("qz-res").classList.add("hidden"); $("qz-next").classList.add("hidden"); ["qz-take", "qz-fade"].forEach((k) => ($(k).disabled = false));
  panes.forEach((p) => { p.chart.timeScale().applyOptions({ barSpacing: 9 }); p.chart.timeScale().scrollToRealTime(); }); repaintAll(); }
async function quizAnswer(take) { if (!QZ || QZ.answered) return; QZ.answered = true; ["qz-take", "qz-fade"].forEach((k) => ($(k).disabled = true)); const it = QZ.it; let right = (it.outcome === "win") === take;
  mxQuizTick(); const q = prefs.quiz || { n: 0, right: 0, streak: 0, best: 0 }; q.n++; if (right) { q.right++; q.streak++; q.best = Math.max(q.best, q.streak); } else q.streak = 0; prefs.quiz = q; addXp(right ? 10 : 2); if (right) prefs.credits = (prefs.credits || 0) + 8; savePrefs();
  const end = it.t_exit || it.t_entry + 3600; for (let n = 0; n < 900 && nowT() < end + 600; n++) { const g = await stepFwd(false); if (g === false) break; } rebuildAll(); panes.forEach((p) => p.chart.timeScale().scrollToRealTime());
  // KING_QZTRUTH (Nov 12 walkthrough): grade on what actually played out on screen. In the demo (made-up prices) the bank's
  // stored result could say "hit the target" while the bars on screen hit the stop. Scan the replayed 1m bars for the first touch.
  { const seen = qzSeen(it); if (seen && seen !== it.outcome) { const was = right; it.outcome = seen; right = (seen === "win") === take;
      if (was !== right) { const q2 = prefs.quiz; if (was) { q2.right--; q2.streak = 0; } else { q2.right++; q2.streak++; q2.best = Math.max(q2.best, q2.streak); } savePrefs(); } } }
  // KING_QZDATE: show when the drill happened
  const qd = new Date(loc(it.t_entry) * 1000).toISOString().slice(0, 10);
  sfx(right ? "win" : "loss"); $("qz-res").innerHTML = `<b class="${right ? "pos-up" : "pos-dn"}">${right ? "Right!" : "Not this time."}</b> It ${it.outcome === "win" ? "hit the target" : "hit the stop"}${it.r != null ? " (" + it.r + "R)" : ""}.<div class="tiny muted">${qd} · ${esc(it.symbol || "")} · Why it set up: ${(it.why || []).map(esc).join(" · ")}</div>${right ? '<div class="tiny">+10 XP, +8 credits</div>' : ""}`;
  $("qz-res").classList.remove("hidden"); $("qz-next").classList.remove("hidden"); }
function qzSeen(it) { if (it.entry == null || it.stop == null || it.target == null) return null; const long = it.target > it.entry, bars = B["1m"].bars, end = B["1m"].i;
  for (let k = 0; k <= end; k++) { const b = bars[k]; if (!b || b.t <= it.t_entry) continue; const hitS = long ? b.l <= it.stop : b.h >= it.stop, hitT = long ? b.h >= it.target : b.l <= it.target;
    if (hitS) return "loss"; if (hitT) return "win"; } return null; }
function quizStop() { QZ = null; lock15 = false; $("qzbar").classList.add("hidden"); drawings = drawings.filter((d) => !d.quiz); repaintAll(); }
// ---- course
const LESSONS = [["Sessions and times", "Which windows he trades (NY 9:30, the 10:00 open, Asia 8pm) and when he stays out."], ["Bias", "How he picks a direction from the higher timeframe range: premium vs discount, conditions, draws on liquidity."], ["Setup checklist", "His order: condition → manipulation into a level → SMT → displacement → entry gap."],
  ["Entry", "Inversion and respected gaps on the 15s-1m, entering off displacement, OTE 0.705-0.79."], ["Stop and targets", "Stop past the manipulation leg, 1:1 marked, partials and break-even, trailing to the next level."], ["When he skips", "No obvious draw, fighting ES, low conviction, structure that trades into a range before inversion."]];
function renderCourse() { const done = new Set(prefs.lessons || []);
  $("co-lessons").innerHTML = LESSONS.map(([t, d], i) => `<div class="card lc ${done.has(i) ? "done" : ""}"><div class="ah"><b>${i + 1}. ${t}</b>${done.has(i) ? '<span class="pill up">done</span>' : ""}</div><p class="small muted">${d}</p><button class="small ${done.has(i) ? "ghost" : "primary"}" data-les="${i}">${done.has(i) ? "Read again" : "Read + mark done (+20 XP)"}</button></div>`).join("");
  const wk = {}; reese.filter((r) => r.dir).forEach((r) => { const d = new Date(r.day + "T12:00:00Z"), mon = new Date(d - ((d.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); (wk[mon] = wk[mon] || []).push(r); });
  $("co-weeks").innerHTML = Object.entries(wk).sort().reverse().map(([m, rs]) => `<div class="card"><div class="ah"><b>Week of ${m}</b><span class="muted tiny">${rs.length} Reese trade${rs.length > 1 ? "s" : ""}</span></div><p class="small muted">Trade it your way. After each session he traded, you'll see his trade next to yours and earn XP for matching his read.</p><button class="small primary" data-wk="${m}">Start this week</button></div>`).join(""); }
function lessonDlg(i) { dlg(`<h3>${LESSONS[i][0]}</h3><p class="small">${LESSONS[i][1]}</p><p class="tiny muted">The full write-up lives in your playbook notes. Finish this lesson, then try a guided week to practice it.</p>`, () => { const s = new Set(prefs.lessons || []); if (!s.has(i)) { s.add(i); prefs.lessons = [...s]; addXp(20); prefs.credits = (prefs.credits || 0) + 20; savePrefs(); } renderCourse(); }); const ok = $("dl-ok"); if (ok) ok.textContent = "Mark done"; }
// ---- earn an eval
function renderEv() { $("ev-cr").textContent = (prefs.credits || 0) + " credits";
  $("ev-list").innerHTML = Object.entries(LUCID).map(([k, [nm, bal, R, cost]]) => `<div class="card"><div class="ah"><b>${nm}</b><span class="pill">${cost} credits</span></div><div class="kvs"><div><span>Profit target</span><b>${money(R.ptg)}</b></div><div><span>Max loss (end of day, trailing)</span><b>${money(R.mdd)}</b></div><div><span>Consistency</span><b>best day ≤ ${R.cons}%</b></div><div><span>Max size</span><b>${R.maxMini} minis</b></div></div><button class="small ${(prefs.credits || 0) >= cost ? "primary" : "ghost"}" data-buy="${k}">${(prefs.credits || 0) >= cost ? "Get this eval" : "Need " + (cost - (prefs.credits || 0)) + " more"}</button></div>`).join(""); }
async function buyEval(k) { const [nm, bal, R, cost] = LUCID[k]; if ((prefs.credits || 0) < cost) { ltab("qz"); return toast("Answer quiz questions to earn " + (cost - (prefs.credits || 0)) + " more credits"); }
  prefs.credits -= cost; savePrefs(); const n = await db.newAccount({ name: nm + " #" + (accts.filter((a) => a.name.startsWith(nm)).length + 1), kind: "eval", start_bal: bal, rules: R }); accts.push(n); pickAcct(n.id); renderEv(); toast(nm + " ready and selected. Good luck."); sfx("win"); }
// ---- time tracking (active replay time, saved on the session)
let actSecs = 0, lastAct = Date.now();
["pointerdown", "keydown", "wheel"].forEach((ev) => addEventListener(ev, () => (lastAct = Date.now()), { passive: true }));
setInterval(() => { if (!sess || document.visibilityState !== "visible" || $("v-trade").classList.contains("hidden")) return; if (timer || Date.now() - lastAct < 90000) { actSecs++; sess.active_secs = (sess.active_secs || 0) + 1; if (actSecs % 60 === 0 && !DEMO) sb.from("sessions").update({ active_secs: sess.active_secs }).eq("id", sess.id).then(() => {}); } }, 1000);

/* ---------------- media: Spotify, see-through YouTube overlay, video library ---------------- */
/* ---------------- media dock: Spotify + YouTube sign-in (each person's own account), Reese video library ---------------- */
const MCFG = () => window.REWIND || {}, REDIR = location.origin + location.pathname.replace(/[^/]*$/, "") + "oauth.html";
function spEmbed(u) { const m = String(u).match(/open\.spotify\.com\/(?:intl-[a-z]+\/)?(playlist|album|track|episode|show|artist)\/([A-Za-z0-9]+)/); return m ? `https://open.spotify.com/embed/${m[1]}/${m[2]}?utm_source=generator&theme=0` : null; }
function ytEmbed(u, start, end) { const m = String(u).match(/(?:youtu\.be\/|v=|embed\/|shorts\/|live\/)([A-Za-z0-9_-]{11})/); return m ? `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1&rel=0&enablejsapi=1${start > 0 ? "&start=" + Math.floor(start) : ""}${end > start ? "&end=" + Math.ceil(end) : ""}` : null; }
/* KING_CLIPFULL: a clipped Reese video asks "watch the whole video?" when the clip ends; "Full video" is always one tap away */
let ytApiP = null; const ytIframeApi = () => ytApiP || (ytApiP = new Promise((res) => { if (window.YT && YT.Player) return res(YT); const t = setTimeout(() => res(null), 8000); window.onYouTubeIframeAPIReady = () => { clearTimeout(t); res(YT); }; const sc = document.createElement("script"); sc.src = "https://www.youtube.com/iframe_api"; sc.onerror = () => res(null); document.head.appendChild(sc); }));
function clipEnded(u, title) { const f = document.querySelector("#m-vid .vfr"); if (!f || f.querySelector(".vend")) return;
  f.insertAdjacentHTML("beforeend", `<div class="vend"><b>That's the trade.</b><span>Want the whole video? How it played out + his full breakdown.</span><div><button class="small" id="m-vfull">▶ Watch full video</button> <button class="small ghost" id="m-vdone">I'm good</button></div></div>`);
  $("m-vfull").onclick = () => playVid(u, String(title || "").replace(/ · the trade$/, "") + " · full video"); $("m-vdone").onclick = () => $("m-vx").click(); }
const jget = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } }, jset = (k, v) => { try { v ? localStorage.setItem(k, JSON.stringify(v)) : localStorage.removeItem(k); } catch (e) {} };
function mediaUI() { const M = prefs.media || (prefs.media = { show: false, tab: "lib", op: 100, ct: false }); if (!["sp", "yt", "lib"].includes(M.tab)) M.tab = "lib";
  $("media").classList.toggle("hidden", !M.show); $("mediabtn").classList.toggle("on", !!M.show); $("media").classList.toggle("big", !!M.big);
  document.querySelectorAll(".mt button").forEach((b) => b.classList.toggle("on", b.dataset.m === M.tab)); ["sp", "yt", "lib"].forEach((k) => $("m-" + k).classList.toggle("hidden", k !== M.tab));
  mediaLook(); $("m-ct").classList.toggle("on", !!M.ct); $("media").classList.toggle("thru", !!M.ct);
  if (M.x != null) { $("media").style.left = Math.min(M.x, innerWidth - 120) + "px"; $("media").style.top = Math.min(M.y, innerHeight - 60) + "px"; }
  if (!M.show) return; if (M.tab === "sp") spUI(); else if (M.tab === "yt") ytUI(); else libUI(); }
function playVid(u, title, start, end) { const e = ytEmbed(u, start, end); if (!e) return toast("Can't play that video"); prefs.media = prefs.media || {}; if (!prefs.media.show) { prefs.media.show = true; savePrefs(); mediaUI(); }
  const clipped = end > start;
  $("m-vid").innerHTML = `<div class="vh"><span>${esc(title || "")}</span>${clipped ? '<button class="pb vfb" id="m-vf" title="Watch the whole video">Full video</button>' : ""}<button class="pb" id="m-vx" title="Close video">×</button></div><div class="vfr"><iframe id="m-vif" src="${e}" frameborder="0" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen></iframe></div>`;
  $("m-vid").classList.remove("hidden"); setTimeout(fitVideo, 0); $("m-vx").onclick = () => { $("m-vid").innerHTML = ""; $("m-vid").classList.add("hidden"); };
  if (clipped) { $("m-vf").onclick = () => playVid(u, String(title || "").replace(/ · the trade$/, "") + " · full video");
    ytIframeApi().then((Y) => { const fr = $("m-vif"); if (!Y || !fr) return; try { new Y.Player(fr, { events: { onStateChange: (ev) => { if (ev.data === 0) clipEnded(u, title); } } }); } catch (er) {} }); } }
const setYt = (u) => playVid(u);
const thumb = (id) => `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, vAgo = (d) => { const s = (Date.now() - new Date(d)) / 1000; return s < 3600 ? Math.max(1, s / 60 | 0) + "m" : s < 86400 ? (s / 3600 | 0) + "h" : s < 2592e3 ? (s / 86400 | 0) + "d" : new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric" }); };
const mmss = (s) => (s ? `${(s / 60) | 0}:${String(s % 60 | 0).padStart(2, "0")}` : "");
const vcard = (id, title, sub, extra = "", cs = 0, ce = 0, lesson = "") => `<button class="vc" data-vid="${id}" data-title="${esc(title)}"${cs ? ` data-s="${cs}" data-e="${ce || 0}"` : ""}><span class="vt"><img loading="lazy" src="${thumb(id)}" alt="">${extra}</span><b>${esc(title)}</b><i>${esc(sub || "")}</i>${lesson ? `<small class="vlesson">💡 ${esc(lesson)}</small>` : ""}</button>`;   // KING_LESSON: 1-line lesson under each trade clip
function needSetup(which) { return `<div class="mempty"><b>${which} sign-in isn't switched on yet</b><span>King is finishing the one-time setup. It'll appear here on its own.</span></div>`; }

/* ---- Reese library ---- */
let RV = null, rvFilter = "videos", rvQ = "";
async function libUI() { const el = $("m-lib");
  if (!RV) { el.innerHTML = '<div class="mempty"><span>Loading Reese\'s videos…</span></div>'; if (DEMO) RV = [{ id: "DZEVxR7slnM", title: "Backtesting My 80%+ Winrate IFVG Strategy", published: "2026-11-06", dur: 3026, kind: "videos" }, { id: "Qm1fTcyysEw", title: "How I made $11,480 In 11 Minutes", published: "2026-11-01", dur: 747, kind: "videos", clip_start: 520, clip_end: 575, lesson: "Shorted the 10 AM reversal off NQ's 1H gap after the inversion, with ES's protected high guarding the stop." }];
    else { const { data } = await sb.from("reese_videos").select("*").order("published", { ascending: false }).limit(1000); RV = data || []; } }
  const n = { videos: RV.filter((v) => v.kind === "videos").length, shorts: RV.filter((v) => v.kind === "shorts").length };
  const list = RV.filter((v) => v.kind === rvFilter && (!rvQ || (v.title || "").toLowerCase().includes(rvQ)));
  el.innerHTML = `<div class="mtools"><span class="seg mini" id="rv-f"><button data-f="videos" class="${rvFilter === "videos" ? "on" : ""}">Videos ${n.videos}</button><button data-f="shorts" class="${rvFilter === "shorts" ? "on" : ""}">Shorts ${n.shorts}</button></span><input id="rv-q" placeholder="Search his videos" value="${esc(rvQ)}"></div>
    <div class="vgrid">${list.slice(0, 120).map((v) => vcard(v.id, v.title, (v.published ? new Date(v.published + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" }) : ""), (v.dur ? `<em>${mmss(v.dur)}</em>` : "") + (v.clip_start ? '<em class="cl">✂ trade</em>' : ""), v.clip_start, v.clip_end, v.lesson)).join("") || '<div class="mempty"><span>No videos match.</span></div>'}</div>`;
  $("rv-f").onclick = (e) => { const b = e.target.closest("[data-f]"); if (b) { rvFilter = b.dataset.f; libUI(); } };
  $("rv-q").oninput = (e) => { rvQ = e.target.value.toLowerCase(); clearTimeout(libUI.t); libUI.t = setTimeout(() => { const pos = e.target.selectionStart; libUI().then(() => { const q = $("rv-q"); q.focus(); q.setSelectionRange(pos, pos); }); }, 200); }; }

/* ---- Spotify (PKCE: no secret, each person signs into their own account) ---- */
const SP_SCOPES = "playlist-read-private playlist-read-collaborative user-read-playback-state user-modify-playback-state user-read-currently-playing user-read-recently-played user-library-read";
let spV = null, spMe = null, spPls = null;
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function spConnect() { const id = MCFG().spotify; if (!id) return toast("Spotify isn't set up yet");
  spV = b64u(crypto.getRandomValues(new Uint8Array(48))); const ch = b64u(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(spV))), st = b64u(crypto.getRandomValues(new Uint8Array(12))); spConnect.st = st;
  const u = "https://accounts.spotify.com/authorize?" + new URLSearchParams({ response_type: "code", client_id: id, scope: SP_SCOPES, redirect_uri: REDIR, code_challenge_method: "S256", code_challenge: ch, state: "sp." + st });
  window.open(u, "kz-oauth", "width=480,height=720"); }
async function spToken(body) { const r = await fetch("https://accounts.spotify.com/api/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: MCFG().spotify, ...body }) });
  const j = await r.json(); if (!r.ok) throw new Error(j.error_description || j.error || "Spotify sign-in failed"); const old = jget("kz-sp") || {};
  jset("kz-sp", { at: j.access_token, rt: j.refresh_token || old.rt, exp: Date.now() + (j.expires_in - 60) * 1000 }); }
async function spApi(path, opt = {}, retry = true) { let t = jget("kz-sp"); if (!t) throw new Error("not connected");
  if (Date.now() > t.exp) { await spToken({ grant_type: "refresh_token", refresh_token: t.rt }); t = jget("kz-sp"); }
  const r = await fetch("https://api.spotify.com/v1" + path, { ...opt, headers: { Authorization: "Bearer " + t.at, "Content-Type": "application/json", ...(opt.headers || {}) } });
  if (r.status === 401 && retry) { jset("kz-sp", { ...t, exp: 0 }); return spApi(path, opt, false); }
  if (r.status === 204 || r.status === 202) return null; const j = await r.json().catch(() => null); if (!r.ok) { const e = new Error((j && j.error && j.error.message) || "Spotify error " + r.status); e.status = r.status; throw e; } return j; }
function spPlay(kind, id) { $("sp-frame").innerHTML = `<iframe src="https://open.spotify.com/embed/${kind}/${id}?utm_source=generator&theme=0" width="100%" height="152" frameborder="0" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`; prefs.media.sp = `https://open.spotify.com/${kind}/${id}`; savePrefs(); }
async function spNow() { const box = $("sp-now"); if (!box) return; try { const p = await spApi("/me/player"); const it = p && p.item;
  box.innerHTML = it ? `<img src="${esc((it.album && it.album.images[2] || it.album.images[0] || {}).url || "")}" alt=""><div><b>${esc(it.name)}</b><i>${esc((it.artists || []).map((a) => a.name).join(", "))} · on ${esc(p.device ? p.device.name : "Spotify")}</i></div><span class="spc"><button class="pb" data-sp="previous">⏮</button><button class="pb" data-sp="${p.is_playing ? "pause" : "play"}">${p.is_playing ? "⏸" : "▶"}</button><button class="pb" data-sp="next">⏭</button></span>`
    : '<div><i>Nothing playing on your Spotify right now. Pick a playlist below, or press play in your Spotify app and the controls show up here.</i></div>'; } catch (e) { box.innerHTML = ""; } }
async function spUI() { const el = $("m-sp"); if (!el.querySelector("#sp-frame")) el.innerHTML = '<div id="sp-body"></div><div id="sp-frame"></div>';
  const body = $("sp-body"); if (!MCFG().spotify) { body.innerHTML = needSetup("Spotify"); return; }
  if (!jget("kz-sp")) { body.innerHTML = `<div class="mempty"><b>Your music, next to the chart</b><span>Sign in with your own Spotify to see your playlists and control what's playing.</span><button class="primary small" id="sp-in">Connect Spotify</button></div>`; $("sp-in").onclick = spConnect; return; }
  try { spMe = spMe || (await spApi("/me")); spPls = spPls || (await spApi("/me/playlists?limit=50")).items || []; } catch (e) { body.innerHTML = `<div class="mempty"><span>${esc(e.message)}</span><button class="small" id="sp-in">Reconnect Spotify</button></div>`; $("sp-in").onclick = () => { jset("kz-sp", null); spMe = spPls = null; spConnect(); }; return; }
  body.innerHTML = `<div class="mwho"><span>🎧 ${esc(spMe.display_name || spMe.id)}</span><button class="pb tiny" id="sp-out">Sign out</button></div><div class="spnow" id="sp-now"></div>
    <div class="plgrid">${spPls.filter(Boolean).map((p) => `<button class="pl" data-pl="${p.id}"><img loading="lazy" src="${esc((p.images && p.images[0] && p.images[0].url) || "")}" alt=""><b>${esc(p.name)}</b></button>`).join("")}</div>`;
  if (prefs.media.sp && !$("sp-frame").innerHTML) { const m = prefs.media.sp.match(/spotify\.com\/(\w+)\/(\w+)/); if (m) spPlay(m[1], m[2]); }
  $("sp-out").onclick = () => { jset("kz-sp", null); spMe = spPls = null; $("sp-frame").innerHTML = ""; spUI(); };
  body.onclick = async (e) => { const p = e.target.closest("[data-pl]"); if (p) return spPlay("playlist", p.dataset.pl); const c = e.target.closest("[data-sp]"); if (!c) return;
    try { await spApi("/me/player/" + c.dataset.sp, { method: c.dataset.sp === "play" || c.dataset.sp === "pause" ? "PUT" : "POST" }); setTimeout(spNow, 350); } catch (er) { toast(er.status === 403 ? "Spotify only allows remote controls with Premium. The player below still works." : er.message); } };
  spNow(); clearInterval(spUI.iv); spUI.iv = setInterval(() => { if (prefs.media.show && prefs.media.tab === "sp") spNow(); }, 8000); }

/* ---- YouTube (Google sign-in, read-only: subscriptions + liked + search) ---- */
let ytCl = null, ytMe = null, ytFeed = null, ytTab = "feed", ytQ = "";
function gsi() { return window.google && google.accounts && google.accounts.oauth2 ? Promise.resolve() : new Promise((ok, no) => { const s = document.createElement("script"); s.src = "https://accounts.google.com/gsi/client"; s.onload = ok; s.onerror = () => no(new Error("Couldn't load Google sign-in")); document.head.appendChild(s); }); }
async function ytConnect(silent) { const id = MCFG().google; if (!id) return toast("YouTube isn't set up yet"); await gsi();
  ytCl = ytCl || google.accounts.oauth2.initTokenClient({ client_id: id, scope: "https://www.googleapis.com/auth/youtube.readonly", callback: (r) => { if (r.error) return toast("YouTube sign-in: " + r.error); jset("kz-yt", { at: r.access_token, exp: Date.now() + (r.expires_in - 60) * 1000, ok: 1 }); ytUI(); } });
  ytCl.requestAccessToken({ prompt: silent ? "" : "consent" }); }
async function ytApi(path) { const t = jget("kz-yt"); if (!t || Date.now() > t.exp) { const e = new Error("expired"); e.exp = 1; throw e; }
  const r = await fetch("https://www.googleapis.com/youtube/v3/" + path, { headers: { Authorization: "Bearer " + t.at } }); const j = await r.json();
  if (r.status === 401) { jset("kz-yt", { ...t, exp: 0 }); const e = new Error("expired"); e.exp = 1; throw e; } if (!r.ok) throw new Error((j.error && j.error.message) || "YouTube error"); return j; }
async function ytLoadFeed() { const subs = await ytApi("subscriptions?part=snippet&mine=true&maxResults=50&order=relevance"); const ch = (subs.items || []).slice(0, 30).map((s) => s.snippet.resourceId.channelId);
  const per = await Promise.all(ch.map((c) => ytApi(`playlistItems?part=snippet,contentDetails&maxResults=4&playlistId=UU${c.slice(2)}`).then((j) => j.items || []).catch(() => [])));
  return per.flat().map((i) => ({ id: i.contentDetails.videoId, title: i.snippet.title, ch: i.snippet.videoOwnerChannelTitle || i.snippet.channelTitle, at: i.contentDetails.videoPublishedAt || i.snippet.publishedAt })).filter((v) => v.title !== "Private video").sort((a, b) => new Date(b.at) - new Date(a.at)); }
async function ytUI() { const el = $("m-yt"); if (!MCFG().google) { el.innerHTML = needSetup("YouTube"); return; } const t = jget("kz-yt");
  if (!t) { el.innerHTML = `<div class="mempty"><b>Your YouTube, next to the chart</b><span>Sign in with your own Google account to see the newest videos from your subscriptions, your liked videos, and search.</span><button class="primary small" id="yt-in">Connect YouTube</button></div>`; $("yt-in").onclick = () => ytConnect(false); return; }
  if (Date.now() > t.exp) { el.innerHTML = `<div class="mempty"><span>Google signs you out of YouTube every hour. One click to pick back up.</span><button class="primary small" id="yt-in">Continue with YouTube</button><button class="pb tiny" id="yt-out">Sign out</button></div>`; $("yt-in").onclick = () => ytConnect(true); $("yt-out").onclick = () => { jset("kz-yt", null); ytFeed = null; ytUI(); }; return; }
  el.innerHTML = `<div class="mtools"><span class="seg mini" id="yt-t"><button data-t="feed" class="${ytTab === "feed" ? "on" : ""}">Subscriptions</button><button data-t="liked" class="${ytTab === "liked" ? "on" : ""}">Liked</button></span><input id="yt-q" placeholder="Search YouTube" value="${esc(ytQ)}"><button class="pb tiny" id="yt-out" title="Sign out of YouTube">⎋</button></div><div class="vgrid" id="yt-g"><div class="mempty"><span>Loading…</span></div></div>`;
  $("yt-t").onclick = (e) => { const b = e.target.closest("[data-t]"); if (b) { ytTab = b.dataset.t; ytQ = ""; ytUI(); } };
  $("yt-out").onclick = () => { try { google.accounts.oauth2.revoke(t.at); } catch (e) {} jset("kz-yt", null); ytFeed = null; ytUI(); };
  $("yt-q").onkeydown = (e) => { if (e.key === "Enter") { ytQ = e.target.value.trim(); ytTab = ytQ ? "search" : "feed"; ytUI(); } };
  try { let list;
    if (ytTab === "search" && ytQ) list = ((await ytApi("search?part=snippet&type=video&maxResults=24&q=" + encodeURIComponent(ytQ))).items || []).map((i) => ({ id: i.id.videoId, title: i.snippet.title, ch: i.snippet.channelTitle, at: i.snippet.publishedAt }));
    else if (ytTab === "liked") list = ((await ytApi("videos?part=snippet&myRating=like&maxResults=40")).items || []).map((i) => ({ id: i.id, title: i.snippet.title, ch: i.snippet.channelTitle, at: i.snippet.publishedAt }));
    else { if (!ytFeed || Date.now() - ytFeed.t > 9e5) ytFeed = { t: Date.now(), v: await ytLoadFeed() }; list = ytFeed.v; }
    $("yt-g").innerHTML = list.slice(0, 80).map((v) => vcard(v.id, v.title, `${v.ch || ""} · ${vAgo(v.at)}`)).join("") || '<div class="mempty"><span>Nothing here yet.</span></div>';
  } catch (e) { if (e.exp) return ytUI(); $("yt-g").innerHTML = `<div class="mempty"><span>${esc(e.message)}</span></div>`; } }

addEventListener("message", async (e) => { if (e.origin !== location.origin || !e.data || e.data.type !== "kz-oauth") return; const q = new URLSearchParams(e.data.search || "");
  if ((q.get("state") || "").startsWith("sp.")) { if (q.get("error")) return toast("Spotify: " + q.get("error")); if (q.get("state") !== "sp." + spConnect.st || !spV) return toast("Spotify sign-in expired, try again");
    try { await spToken({ grant_type: "authorization_code", code: q.get("code"), redirect_uri: REDIR, code_verifier: spV }); spV = null; spMe = spPls = null; toast("✅ Spotify connected"); spUI(); } catch (er) { toast(er.message); } } });
$("media").addEventListener("click", (e) => { const v = e.target.closest("[data-vid]"); if (!v) return; const u = "https://youtu.be/" + v.dataset.vid, s = +v.dataset.s || 0, en = +v.dataset.e || 0;
  if (s && en > s) return askClip(v, u, v.dataset.title, s, en); playVid(u, v.dataset.title, s, en); });
// KING_ASKCLIP (Nov 11): a video with a trade cut asks "just the trade or the whole video?"
function askClip(anchor, u, title, s, en) { document.getElementById("askclip")?.remove(); const m = (x) => Math.floor(x / 60) + ":" + String(Math.floor(x % 60)).padStart(2, "0");
  const el = document.createElement("div"); el.id = "askclip"; el.className = "askclip";
  el.innerHTML = `<b>${esc(String(title || "Video").replace(/ · the trade$/, ""))}</b><button class="primary" id="ac-cut">✂ Just the trade <span>${m(s)}–${m(en)} · ${Math.max(1, Math.round((en - s) / 60))} min</span></button><button id="ac-full">▶ Whole video</button>`;
  document.body.appendChild(el); const r = anchor.getBoundingClientRect(); el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.left)) + "px"; el.style.top = Math.max(8, Math.min(innerHeight - el.offsetHeight - 8, r.bottom + 6)) + "px";
  const close = () => { el.remove(); removeEventListener("pointerdown", out, true); }, out = (ev) => { if (!el.contains(ev.target)) close(); };
  setTimeout(() => addEventListener("pointerdown", out, true), 0);
  $("ac-cut").onclick = () => { close(); playVid(u, title, s, en); }; $("ac-full").onclick = () => { close(); playVid(u, String(title || "").replace(/ · the trade$/, "") + " · full video"); }; }


/* ---------------- friends: leaderboard, challenges, shared trades, suggestions, chat ---------------- */
let me = null, names = {}, chatSub = null, chatSeen = +(localStorage.getItem("rw-chat-seen") || 0);
const esc = (x) => String(x ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const ago = (iso) => { const s = (Date.now() - Date.parse(iso)) / 1000; return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : Math.floor(s / 86400) + "d"; };
async function loadMe() {
  if (DEMO) { me = { user_id: "demo", name: "You", share_stats: true }; names = { demo: "You", b: "Ben", w: "Will" }; return; }
  const { data } = await sb.from("profiles").select("*"); (data || []).forEach((p) => { names[p.user_id] = p.name || "trader"; profs[p.user_id] = p; }); me = (data || []).find((p) => p.user_id === user.id); try { if (me && me.name) { localStorage.setItem("kz-name", String(me.name)); localStorage.setItem("kz-uid", user.id); } } catch (e) {}
  if (!me) { const nm = (user.email || "me").split("@")[0].replace(/[0-9_.]+$/, "") || "me"; const r = await sb.from("profiles").insert({ name: nm }).select().single(); me = r.data || { user_id: user.id, name: nm, share_stats: true }; names[user.id] = me.name; }
  else sb.from("profiles").update({ seen_at: new Date().toISOString() }).eq("user_id", user.id).then(() => {});
}
function ftab(k) { document.querySelectorAll("#ftabs button").forEach((b) => b.classList.toggle("on", b.dataset.f === k)); ["lv", "lb", "ch", "sh", "sg"].forEach((x) => $("f-" + x).classList.toggle("hidden", x !== k)); ({ lv: renderLive, lb: renderLB, ch: renderCh, sh: renderSh, sg: renderSg })[k](); }
// ---- live sessions (Realtime presence + invites), like a game lobby
let liveCh = null, live = {}, room = null, roomSub = null;
function myLive() { const dayP = dayRpl(); return { name: (me && me.name) || "me", room: room && room.id, sym, start: sess ? sess.start_ts : null, t: nowT() || null, pnl: Math.round(hist.reduce((a, t) => a + (+t.pnl || 0), 0)), day: Math.round(dayP), n: hist.length, playing: !!timer, done: !!(room && room.done), at: Date.now() }; }
function initLive() {
  if (DEMO) { live = { b: [{ name: "Ben", sym: "NQ", t: Date.parse("2026-10-14T14:20:00Z") / 1000, pnl: 340, n: 2, playing: true }], w: [{ name: "Will", sym: "ES", t: Date.parse("2026-09-02T13:55:00Z") / 1000, pnl: -120, n: 1, playing: false }] }; return; }
  liveCh = sb.channel("live", { config: { presence: { key: user.id }, broadcast: { self: false } } });
  liveCh.on("presence", { event: "sync" }, () => { live = liveCh.presenceState(); delete live[user.id]; livePill(); if (!$("f-lv").classList.contains("hidden") && !$("v-friends").classList.contains("hidden")) renderLive(); })
    .on("broadcast", { event: "invite" }, ({ payload: p }) => { if (p.to !== user.id) return; sfx("fill"); buzz(40);
      dlg(`<h3>${esc(p.fromName)} invited you</h3><p class="small">Replay <b>${esc(p.sym)}</b> from <b>${fmt(loc(p.start))} New York</b> together. You each trade at your own pace and compare at the end.</p>`, () => joinRoom({ id: p.room, host: p.from, sym: p.sym, start: p.start })); const ok = $("dl-ok"); if (ok) ok.textContent = "Join"; })
    .subscribe((st) => { if (st === "SUBSCRIBED") liveCh.track(myLive()); });
  setInterval(() => { if (liveCh) liveCh.track(myLive()); }, 15000);
}
function livePill() { if (!room) return $("livepill").classList.add("hidden"); const mates = Object.values(live).map((x) => x[0]).filter((x) => x.room === room.id), going = mates.filter((x) => !x.done);
  $("livepill").classList.remove("hidden"); $("livepill").innerHTML = `<i></i> ${mates.length ? going.length + " of " + mates.length + " still trading" : "waiting for friends"}`; }
async function renderLive() { const rows = Object.entries(live).map(([id, xs]) => ({ id, ...xs[0] })).filter((x) => x.at == null || Date.now() - x.at < 120000 || DEMO);
  $("lv-list").innerHTML = rows.map((x) => `<div class="card lvc"><div class="ah"><b><i class="ldot ${x.playing ? "on" : ""}"></i> ${nmFx(x.name, x.user_id)}</b><span class="muted tiny">${x.done ? "done for the day" : x.playing ? "playing" : x.t ? "paused" : "in the app"}</span></div>
    <div class="shrow">${x.t ? `${esc(x.sym)} · ${fmt(loc(x.t))} NY` : "no replay loaded"}</div>${x.t ? `<div class="small">${x.n} trade${x.n === 1 ? "" : "s"} · <b class="${x.pnl >= 0 ? "pos-up" : "pos-dn"}">${money(x.pnl)}</b>${x.room && room && x.room === room.id ? ' · <span class="pill up">in your session</span>' : ""}</div>` : ""}
    <div class="row" style="justify-content:flex-start"><button class="small primary" data-inv="${x.id}">Invite to my replay</button></div></div>`).join("") || '<div class="empty">Nobody else is in KAIROS right now.</div>';
  if (room) { const mates = rows.filter((x) => x.room === room.id); $("lv-room").classList.remove("hidden");
    $("lv-room").innerHTML = `<div class="ah"><b>Your live session · ${esc(room.sym)} from ${fmt(loc(room.start))} NY</b><span><button class="small ${room.done ? "ghost" : "primary"}" id="lv-done">${room.done ? "Back to trading" : "I'm done for the day"}</button> <button class="small ghost" id="lv-leave">Leave</button></span></div>
      <table class="bt"><tr><th>Trader</th><th>Status</th><th>Replay time</th><th>Trades</th><th>P&amp;L</th></tr>${[{ name: (me && me.name) || "me", ...myLive() }, ...mates].map((x) => `<tr><td>${nmFx(x.name, x.user_id)}</td><td>${x.done ? "done" : "trading"}</td><td>${x.t ? fmt(loc(x.t)).slice(5) : "—"}</td><td>${x.n}</td><td class="${x.pnl >= 0 ? "pos-up" : "pos-dn"}">${money(x.pnl)}</td></tr>`).join("")}</table>
      <div class="sub" style="margin:10px 0 4px">Shared notes</div><div class="fch-list roomnotes" id="rn-list"></div><div class="fch-in"><input id="rn-in" placeholder="What did you see? What would you do differently?"><button id="rn-send" class="primary small">Add</button></div>`;
    $("lv-done").onclick = () => { room.done = !room.done; if (liveCh) liveCh.track(myLive()); renderLive(); }; $("lv-leave").onclick = () => { room = null; if (roomSub) sb.removeChannel(roomSub), (roomSub = null); if (liveCh) liveCh.track(myLive()); livePill(); renderLive(); };
    $("rn-send").onclick = sendRoomNote; $("rn-in").onkeydown = (e) => { if (e.key === "Enter") sendRoomNote(); }; loadRoomNotes(); } else $("lv-room").classList.add("hidden"); }
async function loadRoomNotes() { if (!room || !$("rn-list")) return; let list = []; if (DEMO) list = mem.rn || []; else { const { data } = await sb.from("messages").select("*").eq("room", "room:" + room.id).order("created_at").limit(200); list = data || [];
    if (!roomSub) roomSub = sb.channel("rn:" + room.id).on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: "room=eq.room:" + room.id }, () => loadRoomNotes()).subscribe(); }
  $("rn-list").innerHTML = list.map(chatRow).join("") || '<div class="tiny muted">No notes yet.</div>'; }
async function sendRoomNote() { const b = $("rn-in").value.trim(); if (!b || !room) return; $("rn-in").value = ""; if (DEMO) { (mem.rn = mem.rn || []).push({ id: Date.now(), user_id: "demo", body: b, created_at: new Date().toISOString() }); return loadRoomNotes(); } await sb.from("messages").insert({ room: "room:" + room.id, body: b }); loadRoomNotes(); }
async function invite(uid) { if (!nowT() || !sess) return toast("Load a replay first, then invite");
  if (!room) room = { id: (me ? me.user_id.slice(0, 8) : "me") + "-" + sess.start_ts, host: me && me.user_id, sym, start: sess.start_ts };
  if (liveCh) { liveCh.send({ type: "broadcast", event: "invite", payload: { to: uid, from: user.id, fromName: (me && me.name) || "a friend", room: room.id, sym: room.sym, start: room.start } }); liveCh.track(myLive()); }
  toast("Invite sent to " + ((live[uid] && live[uid][0].name) || "your friend")); livePill(); renderLive(); }
async function joinRoom(r) { if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); room = r; $("sym").value = r.sym; $("start").value = fmt(loc(r.start) + 60).replace(" ", "T"); view("trade"); await loadReplay(); if (liveCh) liveCh.track(myLive()); livePill(); }
async function lbRows(t0, t1, sy) { if (DEMO) return [{ user_id: "demo", name: "You", trades: mem.trades.length, wins: mem.trades.filter((t) => t.pnl > 0).length, net: mem.trades.reduce((a, t) => a + t.pnl, 0), avg_r: 0.4, best: 406 }, { user_id: "b", name: "Ben", trades: 9, wins: 5, net: 820, avg_r: 0.6, best: 640 }];
  const { data, error } = await sb.rpc("leaderboard", { t0, t1, sym: sy || null }); if (error) toast(error.message); return data || []; }
function lbTable(rows) { if (!rows.length) return '<div class="empty">No trades in this range yet</div>'; const medal = ["🥇", "🥈", "🥉"];
  return `<table class="bt lb"><tr><th></th><th>Trader</th><th>Trades</th><th>Win</th><th>Avg R</th><th>Best trade</th><th>Net</th></tr>${rows.map((r, i) => `<tr class="${me && r.user_id === me.user_id ? "mine" : ""}"><td>${medal[i] || i + 1}</td><td>${nmFx(r.name, r.user_id)}</td><td>${r.trades}</td><td>${r.trades ? Math.round((100 * r.wins) / r.trades) : 0}%</td><td>${r.avg_r ?? "—"}</td><td>${money(+r.best || 0)}</td><td class="${+r.net >= 0 ? "pos-up" : "pos-dn"}">${money(+r.net)}</td></tr>`).join("")}</table>`; }
async function renderLB() { const D = +$("lb-range").value, now = Math.floor(Date.now() / 1000); let t0 = 0, t1 = 9999999999;
  if (D) { const all = await db.allTrades(); const end = all.length ? Math.max(...all.map((t) => t.t_entry)) : now; t0 = end - D * 86400; }
  $("lb-share").checked = !me || me.share_stats !== false; $("lb-list").innerHTML = lbTable(await lbRows(t0, t1, $("lb-sym").value)); }
async function renderCh() { let list = [];
  if (DEMO) list = mem.ch || []; else { const { data } = await sb.from("challenges").select("*").order("created_at", { ascending: false }).limit(30); list = data || []; }
  const cards = await Promise.all(list.map(async (c) => { const rows = await lbRows(c.start_ts, c.end_ts, c.symbol); const mine = me && rows.some((r) => r.user_id === me.user_id);
    return `<div class="card chc"><div class="ah"><b>${esc(c.title)}</b><span class="muted tiny">${who(c.user_id, "")} · ${ago(c.created_at)}</span></div><div class="muted small">${c.symbol} · ${fmt(loc(c.start_ts)).slice(0, 10)} → ${fmt(loc(c.end_ts)).slice(0, 10)} (New York)</div>
      <div class="row" style="justify-content:flex-start"><button class="small primary" data-take="${c.id}">${mine ? "Replay it again" : "Take this week"}</button>${me && c.user_id === me.user_id ? `<button class="small ghost" data-delch="${c.id}">Delete</button>` : ""}</div>
      ${mine ? lbTable(rows) : `<div class="tiny muted">${rows.length} friend${rows.length === 1 ? "" : "s"} done. Results unlock after you trade it, so nobody gets spoiled.</div>`}</div>`; }));
  $("ch-list").innerHTML = cards.join("") || '<div class="empty">No challenges yet. Load a week, then hit the button above.</div>'; $("ch-list").dataset.ids = JSON.stringify(list); }
async function newChallenge() { if (!nowT()) return toast("Load a replay first, then challenge from the week you're on");
  const lt = loc(nowT()), wd = new Date(lt * 1000).getUTCDay(), monLt = Math.floor(lt / 86400) * 86400 - ((wd + 6) % 7) * 86400, start = monLt - 6 * 3600 - (loc(nowT()) - nowT()), end = start + 5 * 86400;
  const title = prompt("Name the challenge", sym + " week of " + fmt(monLt).slice(0, 10)); if (!title) return; const row = { title, symbol: sym, start_ts: start, end_ts: end };
  if (DEMO) (mem.ch = mem.ch || []).unshift({ id: "c" + Date.now(), user_id: "demo", created_at: new Date().toISOString(), ...row }); else { const { error } = await sb.from("challenges").insert(row); if (error) return toast(error.message); }
  view("friends"); ftab("ch"); toast("Challenge posted"); }
async function takeChallenge(c) { if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); $("sym").value = c.symbol; $("start").value = fmt(loc(c.start_ts) + 60).replace(" ", "T"); view("trade"); await loadReplay(); }
/* share card: a KAIROS-branded image of a trade (P&L, R, side, times, the chart), to download or copy into a chat */
async function shareCard(t, withChart) { const W = 1200, H = 630, c = document.createElement("canvas"); c.width = W; c.height = H; const g = c.getContext("2d");
  const bg = g.createLinearGradient(0, 0, W, H); bg.addColorStop(0, "#0b0a12"); bg.addColorStop(1, "#05050a"); g.fillStyle = bg; g.fillRect(0, 0, W, H);
  const uv = g.createRadialGradient(W * 0.78, H * 0.3, 10, W * 0.78, H * 0.3, 520); uv.addColorStop(0, "rgba(139,92,246,.30)"); uv.addColorStop(1, "rgba(139,92,246,0)"); g.fillStyle = uv; g.fillRect(0, 0, W, H);
  const img = (src) => new Promise((ok) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src; });
  const lock = await img("brand/kairos-lockup.svg"); if (lock) g.drawImage(lock, 56, 50, 380, 380 * lock.height / lock.width || 80);
  if (withChart && panes[active]) { try { const sc = panes[active].chart.takeScreenshot(), cw = 560, ch = (sc.height / sc.width) * cw; g.save(); g.beginPath(); g.roundRect(W - cw - 56, 120, cw, Math.min(ch, 440), 18); g.clip(); g.drawImage(sc, W - cw - 56, 120, cw, ch); g.restore(); g.strokeStyle = "rgba(185,140,255,.35)"; g.lineWidth = 2; g.beginPath(); g.roundRect(W - cw - 56, 120, cw, Math.min(ch, 440), 18); g.stroke(); } catch (e) {} }
  const up = +t.pnl >= 0, side = t.dir > 0 ? "LONG" : "SHORT";
  g.font = "600 22px Inter, sans-serif"; g.fillStyle = "#a98bff"; g.fillText(`${side} · ${t.symbol} · ${t.qty} lot${t.qty > 1 ? "s" : ""}`, 60, 200);
  g.font = "300 104px Inter, sans-serif"; g.fillStyle = up ? "#4ade80" : "#f87171"; g.fillText((up ? "+" : "−") + money(Math.abs(+t.pnl)).replace("-", ""), 54, 312);
  g.font = "300 40px Inter, sans-serif"; g.fillStyle = "#efedf6"; if (t.r != null) g.fillText(`${t.r > 0 ? "+" : ""}${t.r}R`, 60, 372);
  g.font = "400 21px Inter, sans-serif"; g.fillStyle = "#8d8b9c"; g.fillText(`Entry ${px2(t.entry)}  →  Exit ${px2(t.exit)}`, 60, 430);
  g.fillText(blind && !blind.revealed ? "Mystery day" : `${fmt(loc(t.t_entry))} NY`, 60, 464);
  g.font = "500 15px Inter, sans-serif"; g.fillStyle = "#5f5d73"; g.fillText("Replayed bar by bar on KAIROS OS · not live trading", 60, H - 46);
  const blob = await new Promise((ok) => c.toBlob(ok, "image/png")); if (!blob) return toast("Couldn't make the card");
  const url = URL.createObjectURL(blob); let copied = false; try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch (e) {}
  dlg(`<h3>Share card</h3><img src="${url}" style="width:100%;border-radius:10px;border:1px solid rgba(255,255,255,.08)"><div class="tiny muted" style="margin-top:6px">${copied ? "Copied to your clipboard: paste it into Discord or a text." : "Save it, then drop it into Discord or a text."}</div>`, () => { const a = document.createElement("a"); a.href = url; a.download = `kairos-${t.symbol}-${(t.pnl >= 0 ? "win" : "loss")}.png`; a.click(); });
  setTimeout(() => { const ok = $("dl-ok"); if (ok) ok.textContent = "Download"; }, 0); window.__lastCard = c; }
async function shareTrade(t) { const note = prompt("Add a note for your friends (optional)", t.notes || ""); if (note === null) return;
  const snap = { symbol: t.symbol, dir: t.dir, qty: t.qty, entry: t.entry, stop: t.stop, target: t.target, exit: t.exit, r: t.r, pnl: t.pnl, outcome: t.outcome, t_entry: t.t_entry, t_exit: t.t_exit, tags: t.tags || [], shot: t.shots && t.shots[0] };
  if (DEMO) (mem.sh = mem.sh || []).unshift({ id: "s" + Date.now(), user_id: "demo", trade_id: t.id, snap, note, created_at: new Date().toISOString() }); else { const { error } = await sb.from("shared_trades").insert({ trade_id: t.id, snap, note }); if (error) return toast(error.message); }
  toast("Shared with the group"); }
async function renderSh() { let list = [], rt = [];
  if (DEMO) { list = mem.sh || []; rt = mem.rt || []; } else { const a = await sb.from("shared_trades").select("*").order("created_at", { ascending: false }).limit(40); list = a.data || []; const b = list.length ? await sb.from("ratings").select("*").in("share_id", list.map((x) => x.id)) : { data: [] }; rt = b.data || []; }
  $("sh-list").innerHTML = list.map((x) => { const t = x.snap, rs = rt.filter((r) => r.share_id === x.id), avg = rs.length ? rs.reduce((a, r) => a + r.stars, 0) / rs.length : 0, mine = rs.find((r) => me && r.user_id === me.user_id);
    return `<div class="card shc" data-id="${x.id}"><div class="ah"><b>${who(x.user_id, "trader")}</b><span class="muted tiny">${ago(x.created_at)}</span></div>
      <div class="shrow"><span class="${t.dir > 0 ? "pos-up" : "pos-dn"}">${t.dir > 0 ? "Long" : "Short"} ${t.qty} ${t.symbol}</span> @ ${px2(t.entry)} → ${px2(t.exit)} · <b class="${t.pnl >= 0 ? "pos-up" : "pos-dn"}">${money(+t.pnl)}</b>${t.r != null ? " · " + t.r + "R" : ""} · <span class="muted">${fmt(loc(t.t_entry))} NY</span></div>
      ${t.tags && t.tags.length ? `<div class="tags">${t.tags.map((g) => `<span class="pill">${esc(g)}</span>`).join("")}</div>` : ""}${x.note ? `<p class="small">"${esc(x.note)}"</p>` : ""}
      <div class="row" style="justify-content:flex-start;align-items:center"><span class="stars" data-share="${x.id}">${[1, 2, 3, 4, 5].map((n) => `<button class="star ${mine && n <= mine.stars ? "on" : ""}" data-n="${n}">★</button>`).join("")}</span><span class="muted small">${rs.length ? avg.toFixed(1) + " from " + rs.length : "not rated yet"}</span><button class="small ghost" data-replay="${x.id}">Replay this setup</button></div>
      ${rs.filter((r) => r.note).map((r) => `<div class="small rnote"><b>${who(r.user_id, "")}</b>: ${esc(r.note)}</div>`).join("")}</div>`; }).join("") || '<div class="empty">Nothing shared yet</div>';
  $("sh-list").dataset.list = JSON.stringify(list.map((x) => ({ id: x.id, snap: x.snap }))); }
async function rateShare(id, n) { const note = prompt("Leave a note with your " + n + "★ (optional)", "") ?? ""; const row = { share_id: id, stars: n, note };
  if (DEMO) { mem.rt = (mem.rt || []).filter((r) => !(r.share_id === id && r.user_id === "demo")); mem.rt.push({ ...row, user_id: "demo" }); } else { const { error } = await sb.from("ratings").upsert(row, { onConflict: "share_id,user_id" }); if (error) return toast(error.message); }
  renderSh(); }
async function renderSg() { let list = []; if (DEMO) list = mem.sg || []; else { const { data } = await sb.from("suggestions").select("*").limit(200); list = data || []; }
  list.sort((a, b) => (b.votes || []).length - (a.votes || []).length || Date.parse(b.created_at) - Date.parse(a.created_at)); const uid = me && me.user_id;
  const ST = { new: "📨 sent to Claude", planning: "🧠 Claude planning", waiting: "⏳ waiting on King", approved: "✅ approved", building: "🔨 building", done: "🚀 shipped", no: "✖ not doing", planned: "📋 planned" };
  $("sg-list").innerHTML = list.map((x) => `<div class="card sgc"><button class="vote ${(x.votes || []).includes(uid) ? "on" : ""}" data-vote="${x.id}">▲ ${(x.votes || []).length}</button><div class="sgb"><div>${x.kind === "fix" ? "🔧 " : "💡 "}${esc(x.body)}</div>${x.plan ? `<details class="tiny"><summary>Claude's plan</summary><div class="muted">${esc(x.plan)}</div></details>` : ""}${x.result ? `<div class="tiny up">${esc(x.result)}</div>` : ""}<div class="tiny muted">${who(x.user_id, "")} · ${ago(x.created_at)} · <span class="pill ${x.status === "done" ? "up" : ""}">${ST[x.status] || x.status}</span></div></div>
    ${isAdmin ? `<select data-st="${x.id}">${Object.keys(ST).map((s) => `<option value="${s}" ${s === x.status ? "selected" : ""}>${ST[s]}</option>`).join("")}</select>` : ""}</div>`).join("") || '<div class="empty">Nothing yet. Spot a bug or want something? Send it.</div>'; }
async function addSg() { const b = $("sg-text").value.trim(); if (b.length < 3) return; const kind = $("sg-kind").value; if (DEMO) (mem.sg = mem.sg || []).push({ id: "g" + Date.now(), user_id: "demo", body: b, kind, status: "new", votes: [], created_at: new Date().toISOString() }); else { const { error } = await sb.from("suggestions").insert({ body: b, kind }); if (error) return toast(error.message); } $("sg-text").value = ""; renderSg(); }
function chatRow(m) { const mine = me && m.user_id === me.user_id; return `<div class="cm ${mine ? "mine" : ""}"><span class="cn">${who(m.user_id, "trader")}</span><span class="cb">${esc(m.body)}</span><span class="ct">${new Date(m.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span></div>`; }
async function initChat() { let list = [];
  if (DEMO) list = mem.msgs || (mem.msgs = [{ id: 1, user_id: "b", body: "who's backtesting tonight", created_at: new Date(Date.now() - 6e5).toISOString() }]);
  else { const { data } = await sb.from("messages").select("id,cid,user_id,body,created_at").eq("room", "lobby").order("created_at", { ascending: false }).limit(150); list = (data || []).reverse();
    /* live chat rides Realtime broadcast: instant, no database round trip, nothing to clog */
    if (!chatSub) { chatSub = sb.channel("lobby-bc", { config: { broadcast: { self: false } } }).on("broadcast", { event: "msg" }, ({ payload }) => addChat(payload)).subscribe(); } }
  const box = $("chat"), f = document.createDocumentFragment(); box.innerHTML = "";
  list.forEach((m) => { const d = document.createElement("div"); d.innerHTML = chatRow(m); d.firstChild.dataset.mid = m.cid || m.id; f.appendChild(d.firstChild); });
  box.appendChild(f); box.scrollTop = 1e9; const lastT = list.length ? Date.parse(list[list.length - 1].created_at) : 0; $("chatdot").classList.toggle("hidden", !(lastT > chatSeen && list[list.length - 1].user_id !== (me && me.user_id))); }
let chatQ = [], chatT = 0;
function flushChat() { chatT = 0; const box = $("chat"), f = document.createDocumentFragment(); let other = false;
  chatQ.splice(0).forEach((m) => { const k = m.cid || m.id; if (box.querySelector(`[data-mid="${k}"]`)) return; const d = document.createElement("div"); d.innerHTML = chatRow(m); d.firstChild.dataset.mid = k; f.appendChild(d.firstChild); if (!me || m.user_id !== me.user_id) other = true; });
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80; box.appendChild(f); while (box.children.length > 400) box.firstChild.remove(); if (stick) box.scrollTop = 1e9;
  if (other) { const vis = !$("v-friends").classList.contains("hidden") || (prefs.side && !$("md-friends").classList.contains("hidden") && !$("v-trade").classList.contains("hidden")); if (!vis) { $("chatdot").classList.remove("hidden"); $("frdot").classList.remove("hidden"); } sfx("click"); } }
function addChat(m) { chatQ.push(m); if (!chatT) chatT = requestAnimationFrame(flushChat); }
async function sendChat() { const b = $("chat-in").value.trim().slice(0, 2000); if (!b) return; $("chat-in").value = "";
  const m = { cid: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random()), user_id: DEMO ? "demo" : me && me.user_id, body: b, created_at: new Date().toISOString() };
  addChat(m); if (DEMO) { mem.msgs.push(m); return; }
  chatSub && chatSub.send({ type: "broadcast", event: "msg", payload: m });
  sb.from("messages").insert({ body: b, cid: m.cid }).then(({ error }) => { if (error) console.warn("chat history save", error.message); }); }

/* ---------------- journal ---------------- */
let eqC, eqS, jT = [];
async function loadJournal() {
  jT = await db.trades($("j-sym").value); const n = jT.length, w = jT.filter((t) => t.pnl > 0), l = jT.filter((t) => t.pnl < 0);
  const gp = w.reduce((s, t) => s + +t.pnl, 0), gl = -l.reduce((s, t) => s + +t.pnl, 0); let run = 0, pk = 0, mdd = 0; const eq = [];
  jT.forEach((t, i) => { run += +t.pnl; pk = Math.max(pk, run); mdd = Math.max(mdd, pk - run); eq.push({ time: i + 1, value: run }); });
  const rs = jT.filter((t) => t.r != null), avgR = rs.length ? rs.reduce((s, t) => s + +t.r, 0) / rs.length : 0; const box = (k, v) => `<div><span class="muted small">${k}</span><b>${v}</b></div>`;
  $("stats").innerHTML = box("Trades", n) + box("Win rate", n ? Math.round((100 * w.length) / n) + "%" : "—") + box("Avg R", avgR.toFixed(2)) + box("Profit factor", gl ? (gp / gl).toFixed(2) : "—") + box("Net P&L", money(gp - gl)) + box("Max drawdown", money(-mdd)) + box("Avg win", w.length ? money(gp / w.length) : "—") + box("Avg loss", l.length ? money(-gl / l.length) : "—");
  if (!eqC) { eqC = LightweightCharts.createChart($("eqchart"), { layout: { background: { type: "solid", color: "transparent" }, textColor: "#7f8a9c" }, grid: { vertLines: { visible: false }, horzLines: { color: "rgba(255,255,255,.04)" } }, timeScale: { visible: false }, autoSize: true }); eqS = eqC.addAreaSeries({ lineColor: "#5ee6b8", topColor: "rgba(94,230,184,.25)", bottomColor: "rgba(94,230,184,0)", lineWidth: 2, lineType: 2, pointMarkersVisible: false, crosshairMarkerRadius: 3 }); }
  eqS.setData(eq); eqC.timeScale().fitContent();
  calUI(); const rowsT = jDay ? jT.filter((t) => sessDay(t.t_entry) === jDay) : jT;
  $("jrows").innerHTML = rowsT.slice().reverse().map((t) => `<tr data-id="${t.id}"><td>${fmt(loc(t.t_entry))}</td><td>${t.symbol}</td><td>${t.dir > 0 ? "Long" : "Short"}</td><td>${t.qty}</td><td>${px2(t.entry)}</td><td>${px2(t.exit)}</td><td>${t.r ?? "—"}</td><td class="${t.pnl >= 0 ? "pos-up" : "pos-dn"}">${money(+t.pnl)}</td><td><input class="note" value="${(t.notes || "").replace(/"/g, "&quot;")}" placeholder="add a note"></td><td>${t.shots && t.shots.length ? '<a href="#" class="shotlink">📷</a>' : ""}${t.notion_page ? " N" : ""} <button class="small ghost sharebtn" title="Share with friends">⤴</button><button class="small ghost cardbtn" title="Share card (image)">🖼</button></td></tr>`).join("");
}
function exportCsv() {
  const h = ["date_ny", "symbol", "side", "qty", "entry", "stop", "target", "exit", "r", "pnl", "fees", "outcome", "notes"];
  const rows = jT.map((t) => [fmt(loc(t.t_entry)), t.symbol, t.dir > 0 ? "long" : "short", t.qty, t.entry, t.stop, t.target, t.exit, t.r, t.pnl, t.fees, t.outcome, JSON.stringify(t.notes || "")].join(","));
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([h.join(",") + "\n" + rows.join("\n")], { type: "text/csv" })); a.download = "rewind-journal.csv"; a.click();
}

/* ---------------- Notion ---------------- */
async function notionUI() {
  const show = (id) => ["n-connect", "n-setup", "n-ready"].forEach((x) => $(x).classList.toggle("hidden", x !== id));
  try { const s = await notion("status"); $("n-oauth").classList.toggle("hidden", !s.oauth); $("n-tokenbox").open = !s.oauth;
    if (!s.connected) { $("n-state").textContent = "Not connected"; notionAuto = false; return show("n-connect"); }
    $("n-state").innerHTML = "Connected to <b>" + (s.workspace || "Notion") + "</b>";
    if (!s.db) { show("n-setup"); const r = await notion("pages"); $("n-pages").innerHTML = r.pages.length ? r.pages.map((p) => `<option value="${p.id}">${p.title}</option>`).join("") : "<option value=''>No pages shared yet. Add your integration to a page first</option>"; return; }
    show("n-ready"); $("n-open").href = s.db_url; $("n-auto").checked = s.auto_sync; notionAuto = s.auto_sync;
  } catch (e) { $("n-state").textContent = DEMO ? "Not connected (demo)" : "Notion: " + e.message; show("n-connect"); $("n-tokenbox").open = true; }
}
const nmsg = (m) => ($("n-msg").textContent = m);

/* ---------------- prefs / settings / admin ---------------- */
async function loadPrefs() { if (DEMO) return; const { data } = await sb.from("prefs").select("data").maybeSingle(); if (data && data.data) { const d = data.data; Object.assign(prefs, d); prefs.keys = { ...DEF_KEYS, ...(d.keys || {}) }; prefs.pad = { show: true, x: null, y: null, ...(d.pad || {}) }; if (!Array.isArray(prefs.tfs)) prefs.tfs = DEF_TFS.slice(); if (!LAYOUTS[prefs.layout]) prefs.layout = "1"; if (!Array.isArray(prefs.lotset)) prefs.lotset = [1, 2, 3, 5, 10]; if (!Array.isArray(prefs.favs)) prefs.favs = ["trend", "hline", "rect", "long", "short"]; if (prefs.favShow == null) prefs.favShow = true; prefs.ind = { ...IND_DEF, ...(d.ind || {}) }; } }
function savePrefs() { if (!DEMO && user) sb.from("prefs").upsert({ user_id: user.id, data: prefs, updated_at: new Date().toISOString() }).then(() => {}); }
const KEYNAMES = { buy: "Buy market", sell: "Sell market", joinbid: "Join bid", joinask: "Join ask", reverse: "Reverse", flatten: "Flatten all", cancel: "Cancel all", close: "Close all", be: "Stop to breakeven", trend: "Trend line", hline: "Horizontal line", vline: "Vertical line", rect: "Zone", long: "Long position", short: "Short position", measure: "Measure" };
function fillSettings() {
  if ($("s-name")) $("s-name").value = (me && me.name) || "";
  if ($("s-tips")) $("s-tips").checked = prefs.tips !== false;
  if ($("s-sound")) { $("s-sound").checked = prefs.sound !== false; $("s-vol").value = prefs.vol ?? 60; $("s-hap").checked = prefs.haptics !== false; $("s-splash").checked = prefs.splash !== false; if ($("s-chartfx")) $("s-chartfx").checked = prefs.chartfx !== false; if ($("s-glass")) $("s-glass").checked = prefs.glass !== false; $("s-review").checked = prefs.review !== false; }
  $("s-bal").value = prefs.bal; $("s-dll").value = prefs.dll; $("s-ptg").value = prefs.ptg; $("s-act").value = prefs.act; $("s-mdd").value = prefs.mdd; $("s-fee").value = prefs.fee; $("s-mfee").value = prefs.mfee;
  $("s-opens").checked = !!prefs.opens; $("s-sess").checked = !!prefs.sess; $("s-up").value = prefs.up; $("s-dn").value = prefs.dn; $("sym").value = prefs.sym; $("o-sl").value = prefs.slPts; $("o-tp").value = prefs.tpPts;
  $("s-keys").innerHTML = Object.entries(KEYNAMES).map(([k, n]) => `<div><span>${n}</span><input data-key="${k}" maxlength="1" value="${prefs.keys[k] || ""}"></div>`).join("");
  $("magnet").classList.toggle("on", prefs.magnet); tsSettingsUI();
}
function saveSettings() {
  Object.assign(prefs, { bal: +$("s-bal").value, dll: +$("s-dll").value, ptg: +$("s-ptg").value, act: $("s-act").value, mdd: +$("s-mdd").value, fee: +$("s-fee").value, mfee: +$("s-mfee").value, opens: $("s-opens").checked, sess: $("s-sess").checked, up: $("s-up").value, dn: $("s-dn").value });
  document.querySelectorAll("[data-key]").forEach((i) => (prefs.keys[i.dataset.key] = i.value.toLowerCase()));
  const nm = $("s-name").value.trim(); if (me && nm && nm !== me.name) { me.name = nm; names[me.user_id] = nm; if (!DEMO) sb.from("profiles").update({ name: nm }).eq("user_id", me.user_id).then(() => {}); }
  Object.assign(prefs, { sound: $("s-sound").checked, vol: +$("s-vol").value, haptics: $("s-hap").checked, splash: $("s-splash").checked, chartfx: $("s-chartfx") ? $("s-chartfx").checked : true, glass: $("s-glass") ? $("s-glass").checked : true, review: $("s-review").checked }); document.body.classList.toggle("glass", prefs.glass !== false); sfx("fill");
  if (acct) { acct.rules = { ...(acct.rules || {}), mdd: prefs.mdd, dll: prefs.dll, ptg: prefs.ptg }; db.updAccount(acct.id, { rules: acct.rules }).catch(() => {}); }
  panes.forEach((p) => p.series.applyOptions({ upColor: prefs.up, downColor: prefs.dn, wickUpColor: prefs.up, wickDownColor: prefs.dn })); try { csApplyAll(); } catch (e) {} savePrefs(); drawOpens(); repaintAll(); refresh(); $("s-msg").textContent = "Saved";
}
async function loadAdmin() {
  const { data: al } = await sb.from("allowlist").select("*").order("added_at");
  $("ad-list").innerHTML = (al || []).map((a) => `<div class="row"><span style="flex:3">${a.email} <span class="muted">(${a.role})</span></span>${a.role === "admin" ? "<span></span>" : `<button class="small ${a.role === "waitlist" ? "primary" : "ghost"}" data-role="${a.email}" data-to="${a.role === "waitlist" ? "member" : "waitlist"}">${a.role === "waitlist" ? "Let in" : "Back to waitlist"}</button><button class="ghost small" data-del="${a.email}">Remove</button>`}</div>`).join("") + ((al || []).some((a) => a.role === "waitlist") ? '<button class="primary small" id="ad-launch">🚀 Let everyone on the waitlist in</button>' : "");
  const { data: fs } = await sb.from("features").select("*").order("key"); $("ad-feat").innerHTML = (fs || []).map((f) => `<label class="ck"><input type="checkbox" data-feat="${f.key}" ${f.enabled ? "checked" : ""}> ${f.label}</label>`).join("");
  const { data: bf } = await sb.from("bar_files").select("symbol,tf,day").order("day"); const g = {}; (bf || []).forEach((r) => (g[r.symbol + " " + r.tf] = g[r.symbol + " " + r.tf] || []).push(r.day));
  $("ad-data").innerHTML = Object.entries(g).map(([k, d]) => `${k}: ${d.length} months (${d[0].slice(0, 7)} → ${d[d.length - 1].slice(0, 7)})`).join("<br>") || "No data yet";
}

/* ---------------- boot + wiring ---------------- */
let toastT; function toast(m) { const t = $("toast"); if (!m) return t.classList.add("hidden"); t.textContent = m; t.classList.remove("hidden"); t.style.animation = "none"; void t.offsetWidth; t.style.animation = ""; clearTimeout(toastT); toastT = setTimeout(() => t.classList.add("hidden"), 3600); }
function view(v) { try { document.body.classList.forEach((c) => c.startsWith("v-") && document.body.classList.remove(c)); document.body.classList.add("v-" + v); } catch (e) {} const el = $("v-" + v); if (el) { el.classList.remove("enter"); void el.offsetWidth; el.classList.add("enter"); } sfx("click"); document.querySelectorAll(".vtab[data-view]").forEach((b) => b.classList.toggle("on", b.dataset.view === v)); document.querySelectorAll(".view").forEach((x) => x.classList.toggle("hidden", x.id !== "v-" + v)); $("pad").style.visibility = $("favbar").style.visibility = v === "trade" ? "" : "hidden"; $("qzbar").style.visibility = v === "trade" ? "" : "hidden"; $("tools").style.visibility = v === "trade" ? "" : "hidden"; $("app").dataset.v = v; if (v === "journal") loadJournal(); if (v === "stats") renderStats(); if (v === "learn") ltab(document.querySelector("#ltabs .on").dataset.l); if (v === "friends") { frHome(); ftab(document.querySelector("#ftabs .on").dataset.f); chatSeen = Date.now(); localStorage.setItem("rw-chat-seen", chatSeen); $("chatdot").classList.add("hidden"); setTimeout(() => ($("chat").scrollTop = 1e9), 50); } if (v === "accounts") { renderAccts(); taxCalc(); } if (v === "admin") loadAdmin(); if (v === "settings") { notionUI(); tsSettingsUI(); } }
function layMenu() { const sv = prefs.saved || [];
  $("laymenu").innerHTML = Object.entries(LAYOUTS).map(([k, [c, r]]) => `<button class="lay ${k === prefs.layout ? "on" : ""}" data-lay="${k}"><i style="grid-template-columns:repeat(${c},1fr);grid-template-rows:repeat(${r},1fr)">${"<b></b>".repeat(c * r)}</i>${c * r} chart${c * r > 1 ? "s" : ""}${k === "2h" ? " ↕" : ""}</button>`).join("")
    + `<div class="slay"><div class="mh">Saved layouts</div>${sv.map((x, i) => `<div class="slrow"><button class="sl" data-sl="${i}">${esc(x.name)}<i>${x.layout === "1" ? "1 chart" : (LAYOUTS[x.layout] ? LAYOUTS[x.layout][0] * LAYOUTS[x.layout][1] : "?") + " charts"} · ${esc((x.tfs || []).slice(0, LAYOUTS[x.layout] ? LAYOUTS[x.layout][0] * LAYOUTS[x.layout][1] : 1).join(" / "))}</i></button><button class="pb" data-sldel="${i}" title="Delete">×</button></div>`).join("") || '<div class="tiny muted" style="padding:2px 6px">None yet.</div>'}<button class="small ghost" id="sl-save">+ Save this layout…</button></div>`; }
function saveLayout() { const name = (prompt("Name this layout (e.g. NQ/ES SMT, 1m + 15m)") || "").trim().slice(0, 30); if (!name) return;
  const I = JSON.parse(JSON.stringify(prefs.ind || {})); (prefs.saved = prefs.saved || []).push({ name, layout: prefs.layout, tfs: prefs.tfs.slice(), syms: (prefs.syms || []).slice(), sync: { ...(prefs.sync || {}) }, ind: I }); savePrefs(); layMenu(); toast(`Saved layout "${name}"`); }
function loadLayout(i) { const x = (prefs.saved || [])[i]; if (!x) return; prefs.tfs = x.tfs.slice(); prefs.syms = (x.syms || []).slice(); prefs.sync = { ...(x.sync || {}) }; if (x.ind) prefs.ind = JSON.parse(JSON.stringify(x.ind)); setLayout(x.layout); tfUI(); layMenu(); toast(`Layout "${x.name}"`); }
function kChime(ac) {   // KAIROS intro: rising notes + soft low swell (matches the invite page)
  try { const M = ac.createGain(); M.gain.value = ((prefs.vol ?? 60) / 100) * 0.9; M.connect(ac.destination); const t = ac.currentTime + 0.05;
    [220, 261.63, 329.63, 392, 440, 523.25, 659.25, 783.99].forEach((f, k) => { const o = ac.createOscillator(), g = ac.createGain(), t0 = t + k * 0.07; o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(0.06, t0 + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 1.2); o.connect(g); g.connect(M); o.start(t0); o.stop(t0 + 1.3); });
    const b = ac.createOscillator(), bg = ac.createGain(); b.frequency.setValueAtTime(110, t + 0.6); b.frequency.exponentialRampToValueAtTime(40, t + 1.6); bg.gain.setValueAtTime(0, t + 0.6); bg.gain.linearRampToValueAtTime(0.35, t + 0.65); bg.gain.exponentialRampToValueAtTime(0.001, t + 2.2); b.connect(bg); bg.connect(M); b.start(t + 0.6); b.stop(t + 2.3);
  } catch (e) {} }
function splashSound() { if (prefs.sound === false || DEMO) return; try { const ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.state === "running") return kChime(ac);
  ac.resume().then(() => (ac.state === "running" ? kChime(ac) : null)).catch(() => {}); setTimeout(() => { if (ac.state !== "running") ac.close(); }, 600); } catch (e) {} }   // browsers only allow this on refresh once you've used the site a bit; sign-in always plays it
/* KING_TIPS (Nov 11): rotating feature tips, on the loading screen and next to the fix bubble */
const KTIPS = ["Hold the corner triangle on any tool button to see every tool in that group.", "Right-click a drawing tool to add it to your favorites bar.",
  "Select a drawing and tap Aa to label it: Entry, Stop, FVG, Liquidity, or your own words.", "Save a drawing's style as a preset (★) and use it for every new one.",
  "Place a long or short position, then right-click it and Arm it to auto-enter.", "B buys, S sells, X closes, F flattens. Arrow keys step the replay.",
  "Learn → Reese's real trades are open from day one. Click a ✂ video to watch just the trade.", "Take-or-fade drills build your read on setups fast. Try 5 a day.",
  "The Scalp Pad floats: drag it anywhere and right-click it for settings.", "Turn on SMT in Indicators to see NQ vs ES divergence, closed candles only.",
  "News lines (CPI, jobs report, FOMC) show right on the chart.", "Settings → Trade sounds: upload your own clips for take profit and stop out.",
  "Your journal fills itself from your replay trades. Add mistakes so the drills can target them.", "Pop out the Spotify / YouTube window onto a side screen.",
  "Drag the bottom panel up for more room, or the sidebar edge to widen it.", "Found a bug or have an idea? Tap the 🔧 bubble in the corner. It goes straight to Claude.",
  "Friends → Leaderboard shows who backtested the most this week.", "Double-click the toolbar grip to dock it again after floating it."];
/* KING_STARTFX (Nov 12): every launch / reload plays a short take on the welcome cinematic (no tap gate, a random opening line),
   then the charts get "built" by swimming cursors. Lines from Codex; {name} = your first name (cached from the last visit). */
const KLINES = ["THE SESSION RETURNS", "BACK TO THE SCREEN", "TIME TO REPLAY", "THE MARKETS AWAIT", "FOCUS RESETS", "PICK UP THE THREAD", "ANOTHER SESSION", "REPLAY BEGINS",
  "THE CLOCK RESUMES", "MARKETS IN MOTION", "TIME, REVISITED", "THE TAPE IS LIVE", "BACK IN SEQUENCE", "A NEW SESSION", "THE CHARTS ARE READY", "RETURN TO THE TAPE",
  "HISTORY, IN MOTION", "THE NEXT MOVE", "ON THE CLOCK", "SESSION RELOADED", "BACK TO THE BARS", "THE SIGNAL RETURNS",
  "{name}, BACK TO THE CHARTS", "{name}, TIME TO REPLAY", "{name}, PICK UP THE THREAD", "{name}, THE SESSION RESUMES"];
let introOn = false; const introWait = [];
function afterIntro(f) { if (introOn) introWait.push(f); else f(); }
function introLine() { let nm = ""; try { nm = (localStorage.getItem("kz-name") || "").split(" ")[0].slice(0, 14); const uid = localStorage.getItem("kz-uid"), tok = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k)); if (uid && tok && !(localStorage.getItem(tok) || "").includes(uid)) nm = ""; } catch (e) {}
  let last = ""; try { last = localStorage.getItem("kz-line") || ""; } catch (e) {}
  const pool = KLINES.filter((l) => (nm || !l.includes("{name}")) && l !== last), l = pool[Math.floor(Math.random() * pool.length)] || KLINES[0];
  try { localStorage.setItem("kz-line", l); } catch (e) {} return l.replace("{name}", nm.toUpperCase()); }
function kScore(A, D) { const ac = A.ac, t = ac.currentTime + 0.05; D = Math.max(0.6, D);
  [329.63, 392, 440].forEach((f, k) => wTone(A, f, t + 0.08 + k * 0.22, 1.2, 0.04, "triangle"));
  const n = ac.createBufferSource(), nb = ac.createBuffer(1, Math.ceil(ac.sampleRate * (D + 0.4)), ac.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1; n.buffer = nb;
  const r0 = t + Math.max(0, D - 1.4), bp = ac.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 6; bp.frequency.setValueAtTime(300, r0); bp.frequency.exponentialRampToValueAtTime(5000, t + D - 0.05);
  const ng = ac.createGain(); ng.gain.setValueAtTime(0, r0); ng.gain.linearRampToValueAtTime(0.12, t + D - 0.08); ng.gain.linearRampToValueAtTime(0, t + D); n.connect(bp); bp.connect(ng); ng.connect(A.M); n.start(r0); n.stop(t + D + 0.2);
  const T = t + D, b = ac.createOscillator(), bg = ac.createGain(); b.frequency.setValueAtTime(130, T); b.frequency.exponentialRampToValueAtTime(34, T + 1.2); bg.gain.setValueAtTime(0, T); bg.gain.linearRampToValueAtTime(0.6, T + 0.02); bg.gain.exponentialRampToValueAtTime(0.001, T + 2.1); b.connect(bg); bg.connect(A.M); b.start(T); b.stop(T + 2.2);
  [110, 164.81, 220, 277.18, 329.63, 440].forEach((f, k) => { const o = ac.createOscillator(), g = ac.createGain(), lp = ac.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = k % 2 ? 8 : -8;
    lp.type = "lowpass"; lp.frequency.setValueAtTime(400, T); lp.frequency.linearRampToValueAtTime(2400, T + 1.2); lp.frequency.linearRampToValueAtTime(600, T + 3.2);
    g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(0.032, T + 0.08); g.gain.exponentialRampToValueAtTime(0.0008, T + 3.4); o.connect(lp); lp.connect(g); g.connect(A.M); g.connect(A.V); o.start(T); o.stop(T + 3.5); });
  [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => wTone(A, f, T + 0.9 + k * 0.08, 1.2, 0.028)); }
function splash(force) {   // launch intro (Settings → "Intro animation when the app opens")
  try { if (!force && sessionStorage.getItem("kz-nointro")) { sessionStorage.removeItem("kz-nointro"); return; } } catch (e) {}
  if (document.getElementById("kintro") || (!force && (navigator.webdriver || prefs.splash === false))) return;
  introOn = true; const line = introLine(), chars = [...line], n = chars.length, D = Math.max(1.9, 0.55 + n * 0.042 + 0.55), t0 = performance.now();
  const el = document.createElement("div"); el.id = "kintro";
  el.innerHTML = `<canvas class="wfield"></canvas><div class="wwel${n > 18 ? " long" : ""}">${chars.map((c, i) => `<span style="--d:${(i * 0.042).toFixed(3)}s">${c === " " ? "&nbsp;" : esc(c)}</span>`).join("")}<em style="--e:${(0.2 + n * 0.042).toFixed(2)}s">…</em></div><img class="wlock" alt="KAIROS OS Beta"><div class="ktip"><b>Tip</b>${esc(KTIPS[Math.floor(Math.random() * KTIPS.length)])}</div>`;
  document.body.appendChild(el); try { wField(el.querySelector(".wfield")); } catch (e) {}
  if (prefs.sound !== false && !DEMO) { const A = wAudio(); if (A) A.ac.resume().then(() => { if (A.ac.state === "running") kScore(A, D - (performance.now() - t0) / 1000); else A.ac.close(); }).catch(() => {}); }
  const tm = [setTimeout(() => { el.classList.add("drop"); el.querySelector(".wlock").src = "brand/kairos-intro.svg?d=" + Date.now(); }, D * 1000), setTimeout(() => end(), (D + 2.5) * 1000)];
  let ended = false; const end = () => { if (ended) return; ended = true; tm.forEach(clearTimeout); el.classList.add("out"); setTimeout(() => el.remove(), 750);
    setTimeout(() => { introOn = false; introWait.splice(0).forEach((f) => { try { f(); } catch (e) {} }); }, 250); };
  el.addEventListener("pointerdown", end); addEventListener("keydown", function k(e) { if (e.key === "Escape" || e.key === " " || e.key === "Enter") { removeEventListener("keydown", k); end(); } }); }
splash();
/* chart build: colored cursors swim in, draw every pane's frame, axes, grid, candles and price label as glowing wireframes, then the real chart fades up */
let builtOnce = false;
function buildFx(full) { if (prefs.chartfx === false || (navigator.webdriver && full !== "test")) return; const host = $("charts"); if (!host) return;
  host.style.transition = "none"; host.style.opacity = "0"; afterIntro(() => requestAnimationFrame(() => runBuild(full !== false))); }
function runBuild(full) { const host = $("charts"); if (!host || document.getElementById("kbuild")) return; const R = host.getBoundingClientRect(); if (!R.width) { host.style.opacity = ""; return; }
  const D = Math.min(devicePixelRatio || 1, 2), cv = document.createElement("canvas"); cv.id = "kbuild"; Object.assign(cv.style, { left: R.left + "px", top: R.top + "px", width: R.width + "px", height: R.height + "px" });
  cv.width = R.width * D; cv.height = R.height * D; document.body.appendChild(cv); const g = cv.getContext("2d"); g.scale(D, D);
  const L = [], np = panes.length || 1, perPane = Math.max(12, Math.floor((full ? 200 : 110) / np));
  panes.forEach((p) => { const r = p.el.getBoundingClientRect(), ox = r.left - R.left, oy = r.top - R.top, w = r.width, h = r.height; if (w < 40) return;
    let aw = 62; try { aw = p.chart.priceScale("right").width() || 62; } catch (e) {} const th = 26;
    L.push({ k: "rect", x: ox + 2, y: oy + 2, w: w - 4, h: h - 4, z: 0 }, { k: "line", x: ox + w - aw, y: oy + 2, w: 0, h: h - 4, z: 1 }, { k: "line", x: ox + 2, y: oy + h - th, w: w - 4, h: 0, z: 1 });
    for (let i = 1; i <= 4; i++) L.push({ k: "line", x: ox + 4, y: oy + (h - th) * i / 5, w: w - aw - 8, h: 0, z: 2, dash: 1 });
    let cs = []; try { const data = p.series.data ? p.series.data() : [], ts = p.chart.timeScale(), lr = ts.getVisibleLogicalRange(); if (data.length && lr) { const a = Math.max(0, Math.floor(lr.from)), b = Math.min(data.length - 1, Math.ceil(lr.to)), step = Math.max(1, Math.ceil((b - a + 1) / perPane));
      for (let i = a; i <= b; i += step) { const d = data[i]; if (d.open == null) continue; const x = ts.logicalToCoordinate(i), yo = p.series.priceToCoordinate(d.open), yc = p.series.priceToCoordinate(d.close), yh = p.series.priceToCoordinate(d.high), yl = p.series.priceToCoordinate(d.low);
        if ([x, yo, yc, yh, yl].some((v) => v == null || !isFinite(v)) || x < 0 || x > w - aw) continue; const bw = Math.max(3, Math.min(14, (w - aw) / ((b - a + 1) / step) * 0.6));
        cs.push({ k: "rect", x: ox + x - bw / 2, y: oy + Math.min(yo, yc), w: bw, h: Math.max(2, Math.abs(yc - yo)), z: 3, wk: [oy + yh, oy + yl], cx: ox + x, up: d.close >= d.open }); } } } catch (e) {}
    if (!cs.length) for (let i = 0; i < perPane; i++) { const x = ox + 10 + (w - aw - 20) * i / perPane, y = oy + h * (0.3 + 0.35 * Math.sin(i / 5) + Math.random() * 0.08); cs.push({ k: "rect", x, y, w: 6, h: 6 + Math.random() * 18, z: 3, wk: [y - 6, y + 30], cx: x + 3, up: Math.random() > 0.5 }); }
    L.push(...cs, { k: "rect", x: ox + w - aw + 2, y: oy + h * 0.45, w: aw - 6, h: 16, z: 4, tag: 1 }); });
  L.forEach((l) => (l.r = Math.random())); L.sort((a, b) => Math.min(a.z, 3) - Math.min(b.z, 3) || a.r - b.r);
  L.forEach((l) => { l.per = l.k === "line" ? Math.abs(l.w) + Math.abs(l.h) : 2 * (l.w + l.h); l.p = 0; });
  const COL = ["#ff5a6e", "#48d6ff", "#8b5cf6", "#46e08c", "#ffd24a", "#4b7bff", "#ff8a3d", "#e86bff"], NA = full ? 24 : 14, T = full ? 2.6 : 1.35;
  const A = Array.from({ length: NA }, (_, i) => { const e = i % 4, rx = Math.random() * R.width, ry = Math.random() * R.height; return { x: e === 0 ? -20 : e === 1 ? R.width + 20 : rx, y: e === 2 ? -20 : e === 3 ? R.height + 20 : ry, vx: 0, vy: 0, c: COL[i % COL.length], job: null, ph: Math.random() * 6.28, h: 0 }; });
  let qi = 0, done = 0, t0 = performance.now(), last = t0, fin = false; const per = Math.max(0.05, Math.min(0.32, (T * 0.55 * NA) / Math.max(1, L.length)));
  const ptAt = (l, u) => { if (l.k === "line") return [l.x + l.w * u, l.y + l.h * u]; let d = u * l.per; if (d < l.w) return [l.x + d, l.y]; d -= l.w; if (d < l.h) return [l.x + l.w, l.y + d]; d -= l.h; if (d < l.w) return [l.x + l.w - d, l.y + l.h]; d -= l.w; return [l.x, l.y + l.h - d]; };
  const stroke = (l, u, a) => { g.globalAlpha = a; g.beginPath(); if (l.k === "line") { const [x, y] = ptAt(l, u); g.moveTo(l.x, l.y); g.lineTo(x, y); }
    else { g.moveTo(l.x, l.y); const d = u * l.per, cs = [[l.w, l.x + l.w, l.y], [l.w + l.h, l.x + l.w, l.y + l.h], [2 * l.w + l.h, l.x, l.y + l.h], [l.per, l.x, l.y]]; for (const [c, x, y] of cs) { if (d >= c) g.lineTo(x, y); else { const [px, py] = ptAt(l, u); g.lineTo(px, py); break; } } }
    g.setLineDash(l.dash ? [4, 5] : []); g.stroke(); if (l.wk && u >= 1) { g.beginPath(); g.moveTo(l.cx, l.wk[0]); g.lineTo(l.cx, l.y); g.moveTo(l.cx, l.y + l.h); g.lineTo(l.cx, l.wk[1]); g.stroke(); } };
  const cursor = (a) => { g.save(); g.translate(a.x, a.y); g.rotate(a.h - 0.5); g.globalAlpha = 1; g.shadowColor = a.c; g.shadowBlur = 8; g.fillStyle = a.c; g.strokeStyle = "rgba(255,255,255,.85)"; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, 0); g.lineTo(0, 13); g.lineTo(3.6, 9.6); g.lineTo(6.4, 15); g.lineTo(8.4, 14); g.lineTo(5.8, 8.8); g.lineTo(10.4, 8.6); g.closePath(); g.fill(); g.shadowBlur = 0; g.stroke(); g.restore(); };
  const pill = (x, y, txt) => { g.font = "600 9px Inter,sans-serif"; const w = g.measureText(txt).width + 8; g.globalAlpha = 0.95; g.fillStyle = "#2f5bff"; g.beginPath(); g.roundRect ? g.roundRect(x, y, w, 13, 3) : g.rect(x, y, w, 13); g.fill(); g.fillStyle = "#fff"; g.fillText(txt, x + 4, y + 9.5); };
  const stop = () => { fin = true; }; cv.addEventListener("pointerdown", stop); addEventListener("pointerdown", stop, { once: true });
  const fr = (now) => { now = performance.now(); const t = (now - t0) / 1000, dt = Math.max(0, Math.min(0.05, (now - last) / 1000)); last = now; const rush = fin || t > T * 0.85;
    const rev = fin ? 1 : Math.max(0, Math.min(1, (t - T * 0.62) / (T * 0.38))); host.style.opacity = String(rev);
    for (const a of A) { if (!a.job && qi < L.length && !rush) { a.job = L[qi++]; a.mv = true; }
      let tx, ty; if (a.job) { [tx, ty] = a.mv ? ptAt(a.job, 0) : ptAt(a.job, a.job.p); } else { tx = a.x + Math.cos(a.ph + t) * 40; ty = a.y + Math.sin(a.ph * 1.3 + t) * 40; }
      const dx = tx - a.x, dy = ty - a.y, dd = Math.hypot(dx, dy) || 1, sp = a.mv ? 1400 : 900, wob = Math.sin(t * 9 + a.ph) * (a.mv ? 0.35 : 0.15);
      const ux = dx / dd, uy = dy / dd, wx = ux - uy * wob, wy = uy + ux * wob; a.vx += (wx * sp - a.vx) * Math.min(1, dt * 9); a.vy += (wy * sp - a.vy) * Math.min(1, dt * 9);
      if (a.mv) { const st = Math.min(dd, Math.hypot(a.vx, a.vy) * dt); a.x += ux * st + (wx - ux) * st * 0.4; a.y += uy * st + (wy - uy) * st * 0.4; if (dd < 6) { a.mv = false; } }
      else if (a.job) { a.job.p = Math.min(1, a.job.p + dt / per); const [px, py] = ptAt(a.job, a.job.p); a.x = px; a.y = py; if (a.job.p >= 1) { a.job.done = true; done++; a.job = null; } }
      else { a.x += a.vx * dt * 0.15; a.y += a.vy * dt * 0.15; }
      if (Math.hypot(a.vx, a.vy) > 5) a.h = Math.atan2(a.vy, a.vx) - Math.PI / 2 + 0.5; }
    if (rush) L.forEach((l) => { if (!l.done) { l.p = Math.min(1, l.p + dt * 3); if (l.p >= 1) { l.done = true; done++; } } });
    g.clearRect(0, 0, R.width, R.height); const fade = 1 - rev * 0.85;
    g.lineWidth = 1.2; g.strokeStyle = "#5b7cff"; g.shadowColor = "#3b5bff"; g.shadowBlur = 6;
    for (const l of L) if (l.p > 0) { if (l.tag && l.done) { g.shadowBlur = 0; pill(l.x, l.y + 1.5, "LAST"); g.shadowBlur = 6; g.strokeStyle = "#5b7cff"; } stroke(l, l.p, (l.done ? 0.75 : 1) * fade); }
    g.shadowBlur = 0; for (const a of A) if (a.job && !a.mv) pill(a.x + 10, a.y + 10, `${Math.round(a.job.w || a.job.per)} × ${Math.round(a.job.h || 1)}`);
    for (const a of A) { g.globalAlpha = fade; cursor(a); }
    g.globalAlpha = Math.min(1, t * 4) * fade; const bw = 300, bx = R.width / 2 - bw / 2, by = R.height - 46; g.fillStyle = "rgba(14,14,20,.88)"; g.strokeStyle = "rgba(255,255,255,.12)"; g.beginPath(); g.roundRect ? g.roundRect(bx, by, bw, 30, 9) : g.rect(bx, by, bw, 30); g.fill(); g.stroke();
    COL.slice(0, 5).forEach((c, i) => { g.fillStyle = c; g.beginPath(); g.arc(bx + 16 + i * 9, by + 15, 4.5, 0, 6.29); g.fill(); });
    g.fillStyle = "#e8e6f2"; g.font = "600 11px Inter,sans-serif"; g.fillText(`${NA} agents`, bx + 66, by + 19); g.fillStyle = "#8d89a3"; g.fillText(`${done} / ${L.length} layers`, bx + 130, by + 19);
    g.fillStyle = "rgba(255,255,255,.12)"; g.fillRect(bx + 222, by + 13.5, 64, 3); g.fillStyle = "#8b5cf6"; g.fillRect(bx + 222, by + 13.5, 64 * done / Math.max(1, L.length), 3); g.globalAlpha = 1;
    if ((done >= L.length && rev >= 1) || t > T + 1.2) { host.style.opacity = ""; host.style.transition = ""; cv.style.opacity = "0"; setTimeout(() => cv.remove(), 300); removeEventListener("pointerdown", stop); return; }
    requestAnimationFrame(fr); };
  requestAnimationFrame(fr); }
/* ---------------- KAIROS OS Beta: welcome cinematic (first time you're let in) + onboarding tour ---------------- */
const APP_VERSION = "0.9.4", APP_LABEL = "Beta";
function wAudio() { try { const ac = new (window.AudioContext || window.webkitAudioContext)(), M = ac.createGain(); M.gain.value = 0.9; M.connect(ac.destination);
  const len = ac.sampleRate * 3, ir = ac.createBuffer(2, len, ac.sampleRate); for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2.4); }
  const V = ac.createConvolver(); V.buffer = ir; const vg = ac.createGain(); vg.gain.value = 0.5; V.connect(vg); vg.connect(M); return { ac, M, V }; } catch (e) { return null; } }
function wTone(A, f, t0, dur, vol, type = "sine") { const o = A.ac.createOscillator(), g = A.ac.createGain(); o.type = type; o.frequency.value = f; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.015); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur); o.connect(g); g.connect(A.M); g.connect(A.V); o.start(t0); o.stop(t0 + dur + 0.05); }
function wScore(A) { const ac = A.ac, t = ac.currentTime + 0.05;
  [329.63, 392, 440].forEach((f, k) => wTone(A, f, t + 0.15 + k * 0.32, 1.6, 0.045, "triangle"));   // "Welcome to…"
  const n = ac.createBufferSource(), nb = ac.createBuffer(1, ac.sampleRate * 2.4, ac.sampleRate), nd = nb.getChannelData(0); for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1; n.buffer = nb;   // riser into the pause
  const bp = ac.createBiquadFilter(); bp.type = "bandpass"; bp.Q.value = 6; bp.frequency.setValueAtTime(300, t + 1.4); bp.frequency.exponentialRampToValueAtTime(5000, t + 3.5); const ng = ac.createGain(); ng.gain.setValueAtTime(0, t + 1.4); ng.gain.linearRampToValueAtTime(0.14, t + 3.4); ng.gain.linearRampToValueAtTime(0, t + 3.55);
  n.connect(bp); bp.connect(ng); ng.connect(A.M); n.start(t + 1.4); n.stop(t + 3.8);
  const T = t + 3.6, b = ac.createOscillator(), bg = ac.createGain(); b.frequency.setValueAtTime(130, T); b.frequency.exponentialRampToValueAtTime(34, T + 1.3); bg.gain.setValueAtTime(0, T); bg.gain.linearRampToValueAtTime(0.7, T + 0.02); bg.gain.exponentialRampToValueAtTime(0.001, T + 2.4); b.connect(bg); bg.connect(A.M); b.start(T); b.stop(T + 2.5);   // the drop
  [110, 164.81, 220, 277.18, 329.63, 440].forEach((f, k) => { const o = ac.createOscillator(), g = ac.createGain(), lp = ac.createBiquadFilter(); o.type = "sawtooth"; o.frequency.value = f; o.detune.value = k % 2 ? 8 : -8; lp.type = "lowpass"; lp.frequency.setValueAtTime(400, T); lp.frequency.linearRampToValueAtTime(2400, T + 1.5); lp.frequency.linearRampToValueAtTime(600, T + 5); g.gain.setValueAtTime(0, T); g.gain.linearRampToValueAtTime(0.024, T + 0.5); g.gain.exponentialRampToValueAtTime(0.0005, T + 6.5); o.connect(lp); lp.connect(g); g.connect(A.M); g.connect(A.V); o.start(T); o.stop(T + 6.6); });
  [523.25, 659.25, 783.99, 1046.5].forEach((f, k) => wTone(A, f, T + 1.1 + k * 0.09, 1.4, 0.03));   // sparkle as BETA lands
}
function welcomeIntro(force) { if (document.getElementById("welcome")) return; const el = document.createElement("div"); el.id = "welcome";
  const nm = esc(((me && me.name) || (user && user.email) || "").split(/[@ ]/)[0]);
  el.innerHTML = `<canvas class="wfield"></canvas><div class="wgate"><div class="wring"><i></i><i></i><i></i><img src="icon.svg" alt=""></div><b>${nm ? nm.charAt(0).toUpperCase() + nm.slice(1) + ", you're in." : "You're in."}</b><button class="primary" id="w-go">Enter KAIROS</button><span>sound on 🔊</span></div>
    <div class="wstage"><div class="wwel">${"Welcome to".split("").map((c, i) => `<span style="--d:${i * 0.06}s">${c === " " ? "&nbsp;" : c}</span>`).join("")}<em>…</em></div><img class="wlock" src="brand/kairos-intro.svg?w=${Date.now()}" alt="KAIROS OS Beta"><div class="wtag">Every session, back on the screen.</div><div class="wcta"><button class="primary" id="w-tour">Show me around</button><button class="ghost" id="w-skip">Skip the tour</button></div></div>`;
  document.body.appendChild(el); wField(el.querySelector(".wfield"));
  const done = () => { prefs.welcomed = APP_VERSION; savePrefs(); el.classList.add("out"); setTimeout(() => { el.remove(); setTimeout(() => profileSetup(), 400); }, 900); };   // KING_PROFILE: right after the welcome
  el.querySelector("#w-go").onclick = () => { const A = wAudio(); if (A && prefs.sound !== false) { A.ac.resume(); wScore(A); } el.classList.add("play");
    setTimeout(() => el.classList.add("drop"), 3600); setTimeout(() => { const img = el.querySelector(".wlock"); img.src = "brand/kairos-intro.svg?d=" + Date.now(); }, 3600); setTimeout(() => el.classList.add("cta"), 6200); };
  el.querySelector("#w-skip").onclick = done; el.querySelector("#w-tour").onclick = () => { done(); setTimeout(tour, 500); }; }
function wField(cv) { const g = cv.getContext("2d"), D = Math.min(devicePixelRatio || 1, 2); let W, H, T = 0; const rs = () => { W = cv.width = innerWidth * D; H = cv.height = innerHeight * D; }; rs(); addEventListener("resize", rs);
  const fr = () => { if (!cv.isConnected) return; T += 0.004; g.clearRect(0, 0, W, H); const L = 36;
    for (let i = 0; i < L; i++) { const b = i / (L - 1), y0 = H * (0.08 + b * 0.92), a = 0.04 + 0.16 * Math.sin(Math.PI * b) ** 2; g.beginPath();
      for (let x = 0; x <= W + 12; x += 12 * D) { const u = x / W, y = y0 + Math.sin(u * 6 + T * 3 + b * 4) * 14 * D + Math.sin(u * 2.2 - T * 1.7 + b * 9) * 22 * D; x ? g.lineTo(x, y) : g.moveTo(x, y); }
      g.strokeStyle = `rgba(185,140,255,${a})`; g.lineWidth = D * 0.8; g.stroke(); } requestAnimationFrame(fr); }; requestAnimationFrame(fr); }

/* onboarding tour: spotlight each real control, one short line each */
const TOUR = [
  { sel: "#start", t: "Pick any day", d: "Five years of real NQ and ES. Pick a date (or hit the dice for a mystery day) and it loads itself." },
  { sel: "#play", t: "Replay it", d: "Play, pause, or step one bar at a time. Nothing from the future shows until it happens." },
  { sel: "#pad", t: "Trade it like it's live", d: "Buy, sell, join bid/ask, brackets, breakeven. Hotkeys B and S work too. Prop rules (daily loss, drawdown) are on." },
  { sel: "#laybtn", t: "Two charts, both tradable", d: "Split the screen, put NQ on one and ES on the other, and click a chart to trade it. Save layouts you like." },
  { sel: "#indbtn", t: "Your tools", d: "Sessions, FVGs and IFVGs, data highs and lows, SMT on every timeframe, CPI/NFP/FOMC lines, EMAs and more." },
  { sel: "#tools", t: "Draw on it", d: "Lines, boxes, fibs, channels, pitchforks, long/short positions. The ★ on any drawing saves a style like PDH or FVG." },
  { sel: "#chkbtn", t: "Checklist", d: "Pick a strategy and tick the rules you actually see before you enter. Stats shows whether your A+ setups really pay." },
  { sel: "#mediabtn", t: "Media dock", d: "Reese's whole video library, plus your own Spotify and YouTube, floating next to the chart." },
  { sel: '[data-view="journal"]', t: "Journal", d: "Every trade lands here on a calendar. Tag mistakes after each one." },
  { sel: '[data-view="learn"]', t: "Learn", d: "Reese's real trades (every one, from day one), plus take-or-fade drills and daily practice built from your mistakes." },
  { sel: '[data-view="friends"]', t: "The group", d: "Leaderboard, challenges, shared trades and chat with the crew." },
  { sel: '[data-view="settings"]', t: "Make it yours", d: "Themes, hotkeys, and your own sounds for take profits and stop-outs. Found a bug? The fix box goes straight to the build queue." }];
function tour(i = 0) { document.querySelectorAll(".tourbox,.tourspot").forEach((x) => x.remove()); if (i >= TOUR.length) { prefs.toured = APP_VERSION; savePrefs(); return toast("🎉 You're set. Have fun."); }
  view("trade"); const s = TOUR[i], el = document.querySelector(s.sel); if (!el || !el.offsetParent) return tour(i + 1); const r = el.getBoundingClientRect();
  const sp = document.createElement("div"); sp.className = "tourspot"; Object.assign(sp.style, { left: r.left - 6 + "px", top: r.top - 6 + "px", width: r.width + 12 + "px", height: r.height + 12 + "px" }); document.body.appendChild(sp);
  const bx = document.createElement("div"); bx.className = "tourbox"; bx.innerHTML = `<div class="tk">${i + 1} / ${TOUR.length}</div><b>${s.t}</b><p>${s.d}</p><div class="tdots">${TOUR.map((_, k) => `<i class="${k === i ? "on" : k < i ? "done" : ""}"></i>`).join("")}</div><div class="tb2"><button class="ghost small" data-t="x">Skip</button>${i ? '<button class="small" data-t="b">Back</button>' : ""}<button class="primary small" data-t="n">${i === TOUR.length - 1 ? "Done" : "Next"}</button></div>`;
  document.body.appendChild(bx); const bw = 320, bh = bx.offsetHeight || 190; let x = r.right + 16, y = r.top; if (x + bw > innerWidth - 10) x = Math.max(10, r.left - bw - 16); if (x < 10 || r.width > innerWidth * 0.5) { x = Math.min(innerWidth - bw - 10, Math.max(10, r.left)); y = r.bottom + 14; } if (y + bh > innerHeight - 10) y = Math.max(10, r.top - bh - 14);
  Object.assign(bx.style, { left: x + "px", top: y + "px" }); try { tone("click"); } catch (e) {}
  bx.onclick = (e) => { const b = e.target.closest("[data-t]"); if (!b) return; if (b.dataset.t === "n") tour(i + 1); else if (b.dataset.t === "b") tour(i - 1); else { document.querySelectorAll(".tourbox,.tourspot").forEach((x) => x.remove()); prefs.toured = APP_VERSION; savePrefs(); } }; }
/* ---------------- trade sounds (your own clips) + fun effects: price running to your target/stop, take profit, stop-out ---------------- */
const FX_SLOTS = { run_tp: "Running toward take profit", run_sl: "Running toward your stop", hit_tp: "Take profit hit", hit_sl: "Stopped out" };
const fxDB = () => new Promise((ok, no) => { const r = indexedDB.open("kairos-fx", 1); r.onupgradeneeded = () => r.result.createObjectStore("clips"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
async function fxGet(k) { try { const db = await fxDB(); return await new Promise((ok) => { const q = db.transaction("clips").objectStore("clips").get(k); q.onsuccess = () => ok(q.result || null); q.onerror = () => ok(null); }); } catch (e) { return null; } }
async function fxPut(k, v) { const db = await fxDB(); return new Promise((ok, no) => { const tx = db.transaction("clips", "readwrite"); v ? tx.objectStore("clips").put(v, k) : tx.objectStore("clips").delete(k); tx.oncomplete = ok; tx.onerror = () => no(tx.error); }); }
const fxCfg = () => (prefs.fx = prefs.fx || { on: true, runPct: 60, slots: {} });
let fxAudio = null, fxHave = {};
async function fxLoadHave() { for (const k of Object.keys(FX_SLOTS)) fxHave[k] = !!(await fxGet(k)); }
async function fxPlay(k) { const C = fxCfg(), s = C.slots[k] || {}; const rec = await fxGet(k); if (!rec || prefs.sound === false) return false;
  try { if (fxAudio) { fxAudio.pause(); URL.revokeObjectURL(fxAudio.src); } const a = new Audio(URL.createObjectURL(rec.blob)); fxAudio = a; const vol = Math.min(1, ((prefs.vol ?? 60) / 100) * ((s.vol ?? 100) / 100)); a.volume = vol;
    a.currentTime = Math.max(0, +s.start || 0); await a.play(); const len = Math.max(0.5, +s.len || 8);
    setTimeout(() => { if (fxAudio !== a) return; const t0 = Date.now(), f = setInterval(() => { const p = (Date.now() - t0) / 400; a.volume = Math.max(0, vol * (1 - p)); if (p >= 1) { clearInterval(f); a.pause(); } }, 40); }, len * 1000 - 400); return true; } catch (e) { return false; } }
function fxLayer() { let L = document.getElementById("fxl"); if (!L) { L = document.createElement("div"); L.id = "fxl"; L.innerHTML = '<canvas></canvas><div class="fxv"></div><div class="fxt"></div>'; document.body.appendChild(L); } return L; }
function fxBurst(win, amt) { if (fxCfg().on === false) return; const L = fxLayer(), cv = L.querySelector("canvas"), g = cv.getContext("2d"), D = Math.min(devicePixelRatio || 1, 2); cv.width = innerWidth * D; cv.height = innerHeight * D;
  L.className = win ? "win" : "loss"; void L.offsetWidth; L.classList.add("go"); const t = L.querySelector(".fxt"); t.textContent = (win ? "+" : "−") + money(Math.abs(amt)).replace("-", ""); 
  if (!win) { document.body.classList.add("fxshake"); setTimeout(() => document.body.classList.remove("fxshake"), 450); }
  const P = [], cx = innerWidth / 2 * D, cy = innerHeight * 0.45 * D, cols = win ? ["#4ade80", "#b98cff", "#f5c542", "#e4d6ff"] : ["#f87171", "#7f1d1d", "#fda4af"];
  for (let i = 0; i < (win ? 160 : 60); i++) { const a = Math.random() * 6.283, v = (win ? 6 + Math.random() * 14 : 2 + Math.random() * 6) * D; P.push({ x: cx, y: cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (win ? 6 * D : -2 * D), r: (2 + Math.random() * 4) * D, c: cols[i % cols.length], s: Math.random() * 6, life: 1 }); }
  const fr = () => { g.clearRect(0, 0, cv.width, cv.height); let alive = 0; for (const p of P) { if (p.life <= 0) continue; alive++; p.vy += (win ? 0.35 : 0.5) * D; p.vx *= 0.985; p.x += p.vx; p.y += p.vy; p.life -= 0.012; p.s += 0.2;
      g.globalAlpha = Math.max(0, p.life); g.fillStyle = p.c; g.save(); g.translate(p.x, p.y); g.rotate(p.s); g.fillRect(-p.r, -p.r / 2, p.r * 2, p.r); g.restore(); } g.globalAlpha = 1; if (alive) requestAnimationFrame(fr); else g.clearRect(0, 0, cv.width, cv.height); };
  requestAnimationFrame(fr); setTimeout(() => L.classList.remove("go"), 1900); }
function fxRun(toTp) { if (fxCfg().on === false) return; const L = fxLayer(); L.className = toTp ? "runtp" : "runsl"; void L.offsetWidth; L.classList.add("go"); setTimeout(() => L.classList.remove("go"), 2600); }
async function fxEvent(kind, amt) { if (kind === "hit_tp" || kind === "hit_sl") fxBurst(kind === "hit_tp", amt); else fxRun(kind === "run_tp"); return fxPlay(kind); }
function fxTick() { if (!pos.qty || (fxCfg().on === false && !Object.values(fxHave).some(Boolean))) return; const d = Math.sign(pos.qty), lp = last(); if (lp == null) return;
  const tp = pos.tp ?? pos.avg + d * (prefs.tpPts || 20), sl = pos.sl ?? pos.avg - d * (prefs.slPts || 10), th = (fxCfg().runPct || 60) / 100;
  const toTp = ((lp - pos.avg) * d) / Math.max(TICK, Math.abs(tp - pos.avg)), toSl = ((pos.avg - lp) * d) / Math.max(TICK, Math.abs(pos.avg - sl));
  pos.fxr = pos.fxr || {}; if (toTp >= th && !pos.fxr.tp) { pos.fxr.tp = 1; fxEvent("run_tp"); } else if (toSl >= th && !pos.fxr.sl) { pos.fxr.sl = 1; fxEvent("run_sl"); } }
function fxUI() { const box = $("s-fx"); if (!box) return; const C = fxCfg();
  box.innerHTML = Object.entries(FX_SLOTS).map(([k, n]) => { const s = C.slots[k] || {}; return `<div class="fxrow"><b>${n}</b><span class="tiny muted">${fxHave[k] ? "🎵 " + esc(s.name || "your clip") : "No clip"}</span>
    <label class="tiny">Start (s)<input type="number" min="0" step="0.5" value="${s.start || 0}" data-fxs="${k}"></label><label class="tiny">Length (s)<input type="number" min="0.5" max="30" step="0.5" value="${s.len || 8}" data-fxl="${k}"></label>
    <label class="small ghost fxup">Upload<input type="file" accept="audio/*,video/mp4" data-fxu="${k}" hidden></label><button class="small" data-fxp="${k}" ${fxHave[k] ? "" : "disabled"}>▶</button><button class="small ghost" data-fxx="${k}" ${fxHave[k] ? "" : "disabled"}>×</button></div>`; }).join("")
    + `<div class="row2"><label class="ck"><input type="checkbox" id="fx-on" ${C.on !== false ? "checked" : ""}> Effects (confetti on take profit, shake on a stop, glow while it runs)</label><label class="tiny">"Running" fires at<input type="number" id="fx-pct" min="20" max="95" step="5" value="${C.runPct || 60}">% of the way</label></div>`; }
async function boot() {
  if (DEMO) { user = { id: "demo", email: "demo" }; const d = document.createElement("div"); d.className = "demo"; d.textContent = "DEMO · made-up prices · nothing is saved"; document.body.appendChild(d); }
  else {
    const { data: { session } } = await sb.auth.getSession(); if (!session) { $("auth").classList.remove("hidden"); $("app").classList.add("hidden"); return; }
    user = session.user; const { data: okm } = await sb.rpc("is_member");
    if (!okm) { const { data: wl } = await sb.rpc("waitlisted"); if (wl) { location.href = "invite.html?in=1"; return; } $("auth").classList.remove("hidden"); $("a-msg").textContent = "Signed in as " + user.email + ", but this email isn't on the invite list yet. Ask King to add you."; return; }
    isAdmin = !!(await sb.rpc("is_admin")).data; $("vt-admin").classList.toggle("hidden", !isAdmin);
    const { data: fs } = await sb.from("features").select("key,enabled"); (fs || []).forEach((f) => (features[f.key] = f.enabled)); await loadPrefs();
  }
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");
  if (features.journal === false) document.querySelector('[data-view="journal"]').classList.add("hidden"); if (features.dom === false) $("m-dom").classList.add("hidden");
  if (features.drawings === false) document.querySelectorAll("[data-tool]").forEach((b) => !["cursor", "cross"].includes(b.dataset.tool) && b.classList.add("hidden"));
  if (features.multichart === false) { prefs.layout = "1"; $("laybtn").classList.add("hidden"); } if (features.notion === false) $("notioncard").classList.add("hidden");
  $("avatar").textContent = (user.email || "?")[0]; $("avatar").title = user.email;
  document.body.classList.toggle("glass", prefs.glass !== false); applyTheme(prefs.theme); await loadAccts().catch(() => {}); await loadMe().catch(() => {}); loadReese().catch(() => {}); try { initLive(); } catch (e) {} initChat().catch(() => {}); fillSettings(); lotsUI(); layMenu(); sideUI(); dockUI(); toolsUI(); buildPanes(); tfUI(); tgRestore(); favUI(); try { if (prefs.media) prefs.media.pop = false; railUI(); gridApply(); magUI(); plUI(); speedUI(); speedBestUI(); } catch (e) {} requestAnimationFrame(padUI); requestAnimationFrame(watchScales); mediaUI(); chkUI();
  if (!$("start").value) $("start").value = prefs.lastStart || new Date(Date.now() - 8 * 864e5).toISOString().slice(0, 10) + "T09:20";
  if (!DEMO) { if (prefs.lastSym) $("sym").value = prefs.lastSym; loadReplay().catch(() => {}); }   // data loads itself on open (last session you replayed)
  if (!DEMO) notionUI().catch(() => {});
  const h = decodeURIComponent(location.hash || ""); if (h.startsWith("#notion=")) { history.replaceState(null, "", location.pathname); view("settings"); nmsg("Notion: " + h.slice(8)); }
  if (DEMO) { $("start").value = "2026-10-14T09:45"; await loadReplay(); for (let i = 0; i < 25; i++) await stepFwd(); }
  refresh(); fxLoadHave().then(fxUI).catch(() => {}); if ($("s-ver")) $("s-ver").textContent = `Beta · version ${APP_VERSION}${window.KAIROS_DESKTOP ? " · desktop app " + window.KAIROS_DESKTOP.version : ""}. 1.0 is the full release.`;
  const qp = new URLSearchParams(location.search); if (qp.has("welcome") || (!DEMO && !prefs.welcomed)) afterIntro(() => setTimeout(() => welcomeIntro(), DEMO ? 300 : 600)); else if (qp.has("tour")) setTimeout(tour, 600);
  else if (!DEMO && me && !me.username && !prefs.psLater) setTimeout(() => profileSetup(), 4000);   // friends who already went through the welcome get it once too
}
$("a-in").onclick = async () => { try { kChime(new (window.AudioContext || window.webkitAudioContext)()); } catch (e) {} const { error } = await sb.auth.signInWithPassword({ email: $("a-email").value.trim(), password: $("a-pass").value }); $("a-msg").textContent = error ? error.message : ""; if (!error) boot(); };
$("a-up").onclick = async () => { const { data, error } = await sb.auth.signUp({ email: $("a-email").value.trim(), password: $("a-pass").value, options: { emailRedirectTo: location.origin + location.pathname } }); $("a-msg").textContent = error ? error.message : data.session ? "" : "Check your email to confirm, then sign in here."; if (data && data.session) boot(); };
$("logout").onclick = async () => { try { localStorage.removeItem("kz-name"); } catch (e) {} await sb.auth.signOut(); location.reload(); }; $("lockbtn").onclick = lockDlg;

/* ---------------- AI themes: your words -> the PC's Claude Code -> a new theme ---------------- */
const TH_KEYS = ["--bg", "--panel", "--acc", "--acc2", "--txt", "--mut", "--line"], TH_OK = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
function themeFrom(res) { if (!res || !res.vars) return null; const v = {}; for (const k of TH_KEYS) { const c = String(res.vars[k] || "").trim(); if (!TH_OK.test(c)) return null; v[k] = c; } return [String(res.name || "AI theme").slice(0, 24), v]; }
let aiThT = 0;
async function aiTheme() { const p = $("ai-th").value.trim(); if (p.length < 3) return; const msg = $("ai-th-msg");
  if (DEMO) { msg.textContent = "AI themes need a real login (they run on King's PC)."; return; }
  const { data, error } = await sb.from("theme_requests").insert({ prompt: p }).select("id").single(); if (error) return toast(error.message);
  $("ai-th").value = ""; msg.textContent = "🧠 Sent to Claude on King's PC… (if the PC is asleep it runs when it wakes; you can leave this page)"; aiThWatch(data.id, Date.now()); }
async function aiThWatch(id, t0) { clearTimeout(aiThT); const msg = $("ai-th-msg");
  const { data } = await sb.from("theme_requests").select("status,result").eq("id", id).single();
  if (data && data.status === "done") { const th = themeFrom(data.result); if (!th) { msg.textContent = "That one came back broken. Try wording it differently."; return; }
    const tid = "ai-" + id.slice(0, 6); prefs.myThemes = prefs.myThemes || {}; prefs.myThemes[tid] = th; THEMES[tid] = th; applyTheme(tid); savePrefs(); msg.textContent = "✅ " + th[0] + " is on. It's saved in your themes."; sfx("win"); return; }
  if (data && data.status === "failed") { msg.textContent = "Claude couldn't make that one. Try again with different words."; return; }
  msg.textContent = (data && data.status === "making" ? "🎨 Claude is making it…" : "🧠 Waiting for King's PC…") + " " + Math.round((Date.now() - t0) / 1000) + "s";
  aiThT = setTimeout(() => aiThWatch(id, t0), 4000); }

/* ---------------- TradeSea-style settings: order pad buttons, privacy masks, sounds per event, personal lockout, data speed ---------------- */
const PAD_GROUPS = { buysell: "Buy / sell", joinba: "Join bid / ask", close: "Close position", reverse: "Reverse", cancel: "Cancel all", flatten: "Flatten all", be: "Breakeven" };
const PAD_DEF = ["buysell", "joinba", "close", "reverse", "be", "flatten"];
function beNow() { if (!pos.qty) return toast("No open position"); const d = Math.sign(pos.qty); if ((last() - pos.avg) * d <= 0) return toast("Breakeven not available yet (trade isn't in profit)"); toBE(); snd("be"); toast("Stop moved to breakeven"); }
function padBtnsUI() { const on = prefs.padBtns || PAD_DEF; document.querySelectorAll("#pad [data-pg]").forEach((el) => el.classList.toggle("hidden", !on.includes(el.dataset.pg)));
  if ($("s-padbtns")) $("s-padbtns").innerHTML = Object.entries(PAD_GROUPS).map(([k, n]) => `<label class="ck"><input type="checkbox" data-pg2="${k}" ${on.includes(k) ? "checked" : ""}> ${n}</label>`).join(""); }
function maskUI() { const m = prefs.mask || {}; ["upl", "rpl", "bal", "ddl", "acct"].forEach((k) => document.body.classList.toggle("mask-" + k, !!(m.all || m[k])));
  document.querySelectorAll("[data-mask]").forEach((i) => (i.checked = !!m[i.dataset.mask])); }
const SND_EVENTS = { fill: "Order filled", place: "Order placed", cancel: "Order cancelled", stop: "Stop loss hit", target: "Take profit hit", closed: "Position closed", be: "Moved to breakeven", alert: "Alert triggered" };
const SND_KINDS = { chime: "Chime", buzz: "Buzz", pop: "Pop", coin: "Coin", bell: "Bell", custom: "My sound", off: "Off" };
const SND_DEF = { fill: "chime", place: "pop", cancel: "pop", stop: "buzz", target: "coin", closed: "chime", be: "pop", alert: "bell" };
function tone(kind) { if (prefs.sound === false) return; try { AC = AC || new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; } const t0 = AC.currentTime, vol = (prefs.vol ?? 60) / 100 * 0.18;
  const note = (f, at, dur, type = "sine", v = vol) => { const o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.setValueAtTime(f, t0 + at); g.gain.setValueAtTime(0, t0 + at); g.gain.linearRampToValueAtTime(v, t0 + at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + dur); o.connect(g).connect(AC.destination); o.start(t0 + at); o.stop(t0 + at + dur + 0.02); };
  if (kind === "alert") { note(1047, 0, 0.12, "triangle"); note(1568, 0.12, 0.12, "triangle"); note(2093, 0.24, 0.3); return; }
  if (kind === "chime") { note(880, 0, 0.12, "triangle"); note(1320, 0.06, 0.16); } else if (kind === "buzz") { note(150, 0, 0.22, "sawtooth", vol * 0.6); note(110, 0.05, 0.25, "square", vol * 0.35); }
  else if (kind === "pop") note(1200, 0, 0.05, "sine"); else if (kind === "coin") { note(988, 0, 0.08, "square", vol * 0.5); note(1319, 0.08, 0.25, "square", vol * 0.5); }
  else if (kind === "bell") { note(1568, 0, 0.6, "sine"); note(2349, 0, 0.4, "sine", vol * 0.4); }
  else if (kind === "custom") { try { const u = localStorage.getItem("rw-snd"); if (u) { const au = new Audio(u); au.volume = Math.min(1, (prefs.vol ?? 60) / 100); au.play().catch(() => {}); } } catch (e) {} } }
function snd(ev) { const m = { ...SND_DEF, ...(prefs.snd || {}) }; if (m[ev] && m[ev] !== "off") tone(m[ev]); }
function sndUI() { const m = { ...SND_DEF, ...(prefs.snd || {}) }; if (!$("s-snd")) return;
  $("s-snd").innerHTML = Object.entries(SND_EVENTS).map(([k, n]) => `<div><span>${n}</span><select data-snd="${k}">${Object.entries(SND_KINDS).map(([s, l]) => `<option value="${s}" ${m[k] === s ? "selected" : ""}>${l}</option>`).join("")}</select><button class="small" data-sndp="${k}">▶</button></div>`).join(""); }
function lockUI() { const u = prefs.lockUntil; $("s-lockmsg").textContent = u && Date.now() < u ? "🔒 Locked until " + new Date(u).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : ""; }
function speedUI() { document.querySelectorAll("#s-speed [data-sp]").forEach((b) => b.classList.toggle("on", b.dataset.sp === (prefs.speed || "fast"))); }
function tsSettingsUI() { padBtnsUI(); maskUI(); sndUI(); lockUI(); speedUI(); }

/* fix 4: readable tooltips. Native titles pop up under the cursor; this shows them in a styled bubble above the element (below if there's no room). */
(() => { const tp = document.createElement("div"); tp.id = "tip"; tp.className = "tip"; document.body.appendChild(tp); let cur = null, tmr = 0;
  const hide = () => { clearTimeout(tmr); tp.classList.remove("on"); if (cur && cur.dataset.tip != null && !cur.title) cur.title = cur.dataset.tip; cur = null; };
  document.addEventListener("mouseover", (e) => { const el = e.target.closest("[title]"); if (!el || el === cur || !el.title) return; hide(); cur = el; el.dataset.tip = el.title; el.title = "";
    tmr = setTimeout(() => { if (cur !== el) return; tp.textContent = el.dataset.tip; tp.classList.add("on"); const r = el.getBoundingClientRect(), t = tp.getBoundingClientRect();
      let y = r.top - t.height - 8; if (y < 4) y = r.bottom + 8; let x = r.left + r.width / 2 - t.width / 2; x = Math.max(6, Math.min(innerWidth - t.width - 6, x)); tp.style.left = x + "px"; tp.style.top = y + "px"; }, 350); });
  document.addEventListener("mouseout", (e) => { if (cur && !cur.contains(e.relatedTarget)) hide(); }); document.addEventListener("pointerdown", hide, true); })();

/* fix 1: hover a drawing (or select it) and a small toolbar pops up: color, thickness, line style, settings, lock, delete. Every tool has its own settings. */
const DCOL = ["#2962ff", "#ffce78", "#5ee6b8", "#ff6b7a", "#c4b5fd", "#e6eaf0"];
// KING_COLGRID (Nov 12 walkthrough): the pencil opens a full color grid (grays + 10 hues x 6 shades) and a "My colors" row
// at the bottom that keeps the custom colors you pick (+ opens the color picker; right-click a saved one to remove it).
const _hx = (h, s, l) => { s /= 100; l /= 100; const k = (n) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l), f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [f(0), f(8), f(4)].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join(""); };
const COLGRID = (() => { const rows = [[...Array(10)].map((_, i) => _hx(0, 0, 100 - i * 11))], hues = [0, 25, 45, 120, 165, 190, 215, 245, 275, 320];
  [[90, 88], [85, 76], [80, 64], [78, 54], [70, 42], [65, 30]].forEach(([sa, li]) => rows.push(hues.map((h) => _hx(h, sa, li)))); rows[4][6] = "#2962ff"; return rows; })();
function colGrid(cur) { const my = (prefs.myCols || []).slice(0, 10), c = (x) => `<button class="dc ${String(cur).toLowerCase() === x.toLowerCase() ? "on" : ""}" data-c="${x}" style="background:${x}" title="${x}"></button>`;
  return `<div class="cgrid">${COLGRID.flat().map(c).join("")}</div><div class="cmy"><span>My colors</span>${my.map((x) => c(x).replace('class="dc', 'data-my="1" class="dc')).join("")}<label class="cadd" title="Add a custom color">+<input type="color" id="cpick" value="${/^#[0-9a-f]{6}$/i.test(cur || "") ? cur : "#2962ff"}"></label></div>`; }
let dtbP = null, dtbT = 0;
function dtbShow(p) { const d = hov || sel, el = $("dtb"); clearTimeout(dtbT); if (!d) { dtbT = setTimeout(() => { if (!el.matches(":hover") && !(hov || sel)) el.classList.add("hidden"); }, 450); return; }
  dtbP = p; el.dataset.id = d.id; const r = p.el.getBoundingClientRect(), x1 = xOf(p, d.a.t), x2 = xOf(p, d.b.t), y = d.type === "long" || d.type === "short" ? yOf(p, Math.max(d.entry, d.sl, d.tp)) : Math.min(yOf(p, d.a.p) ?? 1e9, yOf(p, d.b.p) ?? 1e9);
  const pos = d.type === "long" || d.type === "short";
  // KING_DTB (Nov 12, King's Tradesea shot): grip · pencil (color) · T (label) · width · style · ★ · ⚙ · lock · trash, with line-art icons
  const SV = (path) => `<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const curC = /^#/.test(d.color || "") ? d.color : "#2962ff", curW = d.w || 1.4, curD = d.dash || "solid";
  el.innerHTML = '<span class="dgrip" aria-hidden="true">⋮⋮</span>' + (pos ? "" :
    `<button data-act="col" class="dico" title="Line color">${SV('<path d="M15 4l5 5L9 20H4v-5z"/>')}<i class="dund" style="background:${curC}"></i></button>` +
    `<button data-act="label" class="dico" title="Label: quick tags or your own text">${SV('<path d="M6 5h12M12 5v14"/>')}<i class="dund" style="background:${d.label ? curC : "transparent"}"></i></button>` +
    `<button data-act="wcyc" class="dtxt" title="Line width"><b style="height:${Math.min(3, Math.round(curW))}px"></b>${Math.max(1, Math.round(curW))}px</button>` +
    `<button data-act="dcyc" class="dtxt" title="Line style"><b class="dln ${curD}"></b></button>` +
    '<i class="dsep"></i>' + `<button data-act="preset" class="dico" title="Presets (PDH, FVG, OB…)">${SV('<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>')}</button>`) +
    `<button data-act="set" class="dico" title="Settings">${SV('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3h0a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v0a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>')}</button>` +
    `<button data-act="lock" class="dico ${d.locked ? "on" : ""}" title="${d.locked ? "Unlock" : "Lock"}">${SV(d.locked ? '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 018 0v3"/>' : '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 017.6-1.7"/>')}</button>` +
    `<button data-act="del" class="dico" title="Delete">${SV('<path d="M5 7h14M9 7V4.5h6V7M7 7l1 13h8l1-13"/>')}</button>` +
    (pos ? "" : `<div class="dcols hidden">${colGrid(d.color)}</div>`);
  el.classList.remove("hidden"); const tw = el.offsetWidth, cx = r.left + ((x1 ?? 0) + (x2 ?? x1 ?? 0)) / 2, ty = r.top + (y < 1e8 ? y : 40) - 46;
  el.style.left = Math.max(r.left + 4, Math.min(r.right - tw - 70, cx - tw / 2)) + "px"; el.style.top = Math.max(r.top + 4, ty) + "px"; }
/* confluence presets: named styles per tool (color, width, dash, fill, label), one tap to apply, optional default for new drawings */
const PRESET_SEED = { hline: [{ name: "PDH / PDL", color: "#f5c542", w: 1, dash: "dash", label: "PDH" }, { name: "Data high / low", color: "#f0abfc", w: 1, dash: "dot", label: "Data H" }, { name: "Key level", color: "#e5e7eb", w: 2, dash: "solid", label: "" }],
  rect: [{ name: "FVG", color: "#8b5cf6", fill: 18, label: "FVG" }, { name: "IFVG", color: "#7aa7ff", fill: 18, label: "IFVG" }, { name: "Order block", color: "#2bd4a0", fill: 14, label: "OB" }, { name: "Liquidity zone", color: "#ff6b7a", fill: 10, label: "Liq" }],
  fib: [{ name: "OTE", color: "#7aa7ff", w: 1, dash: "dash", label: "OTE" }], trend: [{ name: "Trendline liquidity", color: "#f5c542", w: 2, dash: "solid", label: "TL liq" }] };
const PRESET_KEYS = ["color", "w", "dash", "fill", "label"];
const presetsOf = (type) => { prefs.presets = prefs.presets || {}; if (!prefs.presets[type]) prefs.presets[type] = (PRESET_SEED[type] || []).map((x) => ({ ...x })); return prefs.presets[type]; };
function applyPreset(d, pr) { for (const k of PRESET_KEYS) if (pr[k] !== undefined) d[k] = pr[k]; }
function presetMenu(d, cx, cy) { const L = presetsOf(d.type), def = (prefs.presetDef || {})[d.type];
  menu([{ h: `${TOOLNAMES[d.type] || d.type} presets` }, ...L.map((pr, i) => ({ t: `${def === i ? "★ " : "\u2003 "}${pr.name}`, f: () => { applyPreset(d, pr); repaintAll(); } })),
    "-", { t: "Save this style as a preset…", f: () => { const name = (prompt("Preset name (e.g. PDH, FVG, OB)", d.label || "") || "").trim().slice(0, 24); if (!name) return; const pr = { name }; for (const k of PRESET_KEYS) if (d[k] !== undefined) pr[k] = d[k]; L.push(pr); savePrefs(); toast(`Preset "${name}" saved`); } },
    L.length ? { t: def != null ? "Stop using a default for new ones" : "Use a preset for every new one…", f: () => { prefs.presetDef = prefs.presetDef || {}; if (def != null) { delete prefs.presetDef[d.type]; savePrefs(); return toast("No default preset"); } const n = prompt(`Which preset? ${L.map((p, i) => `${i + 1}=${p.name}`).join(", ")}`); const i = (+n || 0) - 1; if (L[i]) { prefs.presetDef[d.type] = i; savePrefs(); toast(`New ${TOOLNAMES[d.type] || d.type}s use "${L[i].name}"`); } } } : null,
    L.length ? { t: "Delete a preset…", f: () => { const n = prompt(`Delete which? ${L.map((p, i) => `${i + 1}=${p.name}`).join(", ")}`); const i = (+n || 0) - 1; if (L[i]) { L.splice(i, 1); if (prefs.presetDef && prefs.presetDef[d.type] != null) delete prefs.presetDef[d.type]; savePrefs(); } } } : null], cx, cy); }
function toolSettings(d) { if (d.type === "long" || d.type === "short") return toolDlg(d);
  dlg(`<h3>${({ trend: "Trend line", ray: "Ray", hline: "Horizontal line", hray: "Horizontal ray", vline: "Vertical line", rect: "Zone", fib: "Fib retracement", text: "Note", measure: "Measure" })[d.type] || d.type} settings</h3>
    <label>${d.type === "text" ? "Text" : "Label (shows on the chart)"}<input id="ts-l" value="${esc(d.type === "text" ? d.text : d.label || "")}" maxlength="60"></label>
    <div class="row2"><label>Color<input id="ts-c" type="color" value="${/^#/.test(d.color || "") ? d.color : "#2962ff"}"></label><label>Thickness<select id="ts-w">${[1, 1.4, 2, 3, 4].map((w) => `<option ${(d.w || 1.4) === w ? "selected" : ""}>${w}</option>`).join("")}</select></label><label>Style<select id="ts-s">${["solid", "dash", "dot"].map((s) => `<option ${(d.dash || "solid") === s ? "selected" : ""}>${s}</option>`).join("")}</select></label></div>
    ${d.type === "rect" ? `<label>Fill strength<input id="ts-f" type="range" min="0" max="60" value="${d.fill ?? 12}"></label>` : ""}
    ${d.type !== "hline" && d.type !== "vline" && d.type !== "text" ? `<div class="row2"><label>Price A<input id="ts-pa" type="number" step="0.25" value="${d.a.p}"></label><label>Price B<input id="ts-pb" type="number" step="0.25" value="${d.b.p}"></label></div>` : `<label>Price<input id="ts-pa" type="number" step="0.25" value="${d.a.p}"></label>`}
    ${d.type === "fib" ? `<label>Fib levels (all fibs)</label><div class="fiblv">${[...new Set([...FIB_OPTS, ...(prefs.fibLv || FIB_DEF)])].sort((x, y) => x - y).map((l) => `<label class="ck"><input type="checkbox" data-fl="${l}" ${(prefs.fibLv || FIB_DEF).includes(l) ? "checked" : ""}> ${l}</label>`).join("")}</div>
      <label>Add your own (comma separated)<input id="ts-flx" placeholder="e.g. 0.25, 0.75, -0.5"></label><button type="button" class="small" id="ts-fld">Reset to default</button>` : ""}
    <label class="ck"><input id="ts-lk" type="checkbox" ${d.locked ? "checked" : ""}> Locked (can't be dragged)</label>`, () => {
    if (d.type === "fib") { const L = [...document.querySelectorAll("[data-fl]")].filter((c) => c.checked).map((c) => +c.dataset.fl); ($("ts-flx").value || "").split(",").map((v) => parseFloat(v)).filter((v) => isFinite(v) && Math.abs(v) <= 10).forEach((v) => L.includes(v) || L.push(v));
      prefs.fibLv = L.length ? L.sort((x, y) => x - y) : null; savePrefs(); }
    const l = $("ts-l").value.trim(); if (d.type === "text") d.text = l || d.text; else d.label = l; d.color = $("ts-c").value; d.w = +$("ts-w").value; d.dash = $("ts-s").value; d.locked = $("ts-lk").checked;
    if ($("ts-f")) d.fill = +$("ts-f").value; d.a.p = rnd(+$("ts-pa").value || d.a.p); if ($("ts-pb")) d.b.p = rnd(+$("ts-pb").value || d.b.p); else d.b.p = d.a.p; repaintAll(); });
  if ($("ts-fld")) $("ts-fld").onclick = () => document.querySelectorAll("[data-fl]").forEach((c) => (c.checked = FIB_DEF.includes(+c.dataset.fl))); }

/* fix 13: chart settings + sync across charts (interval, crosshair, time, date range); click the symbol on a chart to change it */
let syncing = false;
function syncCross(p, pr) { const S = prefs.sync || {}; if (syncing || S.cross === false || panes.length < 2) return; syncing = true;
  try { for (const q of panes) { if (q === p || q.dead) continue; if (!pr.point || pr.time == null) { q.chart.clearCrosshairPosition(); continue; } let pz = p.series.coordinateToPrice(pr.point.y); if (pz == null) continue; const qt = bucket(pr.time, q.sec);
      if (paneSym(q) !== paneSym(p)) { const c = q.candles; let lo = 0, hi = c.length - 1, k = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time <= qt) { k = m; lo = m + 1; } else hi = m - 1; } if (k < 0) continue; pz = c[k].close; }
      q.chart.setCrosshairPosition(pz, qt, q.series); } } catch (e) {} syncing = false; }
function syncTime(p) { const S = prefs.sync || {}; if (syncing || S.time === false || panes.length < 2 || p.i !== active) return; const vr = p.chart.timeScale().getVisibleRange(); if (!vr) return; syncing = true;
  try { for (const q of panes) if (q !== p && !q.dead && q.candles.length) q.chart.timeScale().setVisibleRange(vr); } catch (e) {} syncing = false; }
function chartSetUI() { const S = prefs.sync || {}; $("cs-ssym").checked = !!S.sym; $("cs-sint").checked = !!S.int; $("cs-scross").checked = S.cross !== false; $("cs-stime").checked = S.time !== false; $("cs-srange").checked = S.range !== false;
  document.querySelectorAll("#cs-sym [data-s]").forEach((b) => b.classList.toggle("on", b.dataset.s === sym)); }
function symMenu(e) { const r = e.target.getBoundingClientRect(), pe = e.target.closest(".pane"), p = panes.find((q) => q.el === pe) || panes[active], own = p && !(prefs.sync && prefs.sync.sym), cur = own ? paneSym(p) : sym;
  menu([{ h: own ? `Chart ${p.i + 1} symbol` : "Symbol (all charts)" }, ...["NQ", "ES"].map((s) => ({ t: (s === cur ? "✓ " : "\u2003 ") + s + (s === "NQ" ? " · Nasdaq-100 E-mini" : " · S&P 500 E-mini"), f: () => { if (s === cur) return; if (own) return setPaneSym(p.i, s); $("sym").value = s; $("sym").onchange(); } }))], r.left, r.bottom + 4); }
async function setPaneSym(i, s) { prefs.syms = prefs.syms || []; panes.forEach((q) => { if (!prefs.syms[q.i]) prefs.syms[q.i] = paneSym(q); }); prefs.syms[i] = s; savePrefs(); const p = panes[i]; if (!p) return;
  if (B["1m"].bars.length) { if (s !== sym && !X[s]) { toast("Loading " + s + "…"); await loadOthers(); toast(""); } if (i === active) setActive(i); rebuildPane(p); drawOpens(); drawOrders(); refresh(); p.chart.timeScale().scrollToRealTime(); }
  panes.forEach(label); }

/* fix 15: journal as a trading calendar. Each day shows net P&L, trade count and win rate (by the market date you replayed); weekly totals on the right; click a day to see its trades. */
let jMonth = null, jDay = null;
function calUI() { const days = {}; for (const t of jT) { const d = sessDay(t.t_entry); (days[d] = days[d] || []).push(t); }
  if (!jMonth) { const last = Object.keys(days).sort().pop(); jMonth = (last || new Date().toISOString().slice(0, 10)).slice(0, 7); }
  const [Y, M] = jMonth.split("-").map(Number), first = new Date(Date.UTC(Y, M - 1, 1)), start = new Date(first); start.setUTCDate(1 - first.getUTCDay());
  $("jc-title").textContent = first.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  let html = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Week"].map((d) => `<div class="jch">${d}</div>`).join(""), mNet = 0, mN = 0;
  for (let w = 0; w < 6; w++) { let wNet = 0, wN = 0, any = false;
    for (let k = 0; k < 7; k++) { const dt = new Date(start); dt.setUTCDate(start.getUTCDate() + w * 7 + k); const ds = dt.toISOString().slice(0, 10), inM = dt.getUTCMonth() === M - 1, ts = days[ds] || [];
      const net = ts.reduce((s, t) => s + +t.pnl, 0), wins = ts.filter((t) => t.pnl > 0).length; if (inM) any = true; if (inM) { wNet += net; wN += ts.length; mNet += net; mN += ts.length; }
      html += `<button class="jcd ${inM ? "" : "out"} ${ts.length ? (net >= 0 ? "up" : "dn") : ""} ${jDay === ds ? "on" : ""}" data-day="${ds}"><span class="n">${dt.getUTCDate()}</span>${ts.length ? `<b>${money(net)}</b><span class="tiny">${ts.length} trade${ts.length > 1 ? "s" : ""} · ${Math.round((100 * wins) / ts.length)}%</span>` : ""}</button>`; }
    html += `<div class="jcw ${wN ? (wNet >= 0 ? "up" : "dn") : ""}">${wN ? `<b>${money(wNet)}</b><span class="tiny">${wN} trades</span>` : ""}</div>`; if (!any && w > 3) break; }
  $("jc-grid").innerHTML = html; $("jc-sum").textContent = mN ? `${first.toLocaleString("en-US", { month: "short", timeZone: "UTC" })}: ${money(mNet)} · ${mN} trades` : "No trades this month";
  $("jc-all").classList.toggle("hidden", !jDay); }

/* fix 17: friends next to the chart. The group chat moves into the side panel (Friends tab) on the trade screen and back when you open the Friends page. */
function frSide() { const ch = document.querySelector(".fchat"); if (ch && ch.parentElement !== $("sfr")) $("sfr").appendChild(ch); $("frdot").classList.add("hidden"); $("chatdot").classList.add("hidden");
  const lp = $("livepill"); $("sfr-live").innerHTML = lp && !lp.classList.contains("hidden") ? lp.innerHTML : "Nobody else replaying right now."; setTimeout(() => ($("chat").scrollTop = 1e9), 30); }
function frHome() { const ch = document.querySelector(".fchat"), w = document.querySelector("#v-friends .fwrap"); if (ch && w && ch.parentElement !== w) w.appendChild(ch); }
function frOpen() { prefs.side = true; savePrefs(); sideUI(); document.querySelector('.mode[data-mode="friends"]').click(); }

/* fix 19: dropdowns. Every <select> gets a dark custom menu that springs open (Anime.js / Motion). The real select stays underneath so all existing code keeps working. */
(() => { let open = null;
  const label = (s) => { const o = s.options[s.selectedIndex]; return o ? o.textContent : ""; };
  const close = () => { if (!open) return; const m = open.m; open.w.classList.remove("open"); open = null; m.style.pointerEvents = "none"; try { if (window.anime && FX.ok()) anime.animate(m, { opacity: [1, 0], scale: [1, 0.96], duration: 120, ease: "inQuad", onComplete: () => m.remove() }); else m.remove(); } catch (e) { m.remove(); } };
  function enhance(s) { if (s.dataset.dd || s.multiple || s.closest(".nodd")) return; s.dataset.dd = "1"; const w = document.createElement("span"); w.className = "dd"; s.parentNode.insertBefore(w, s); w.appendChild(s);
    const b = document.createElement("button"); b.type = "button"; b.className = "ddb"; b.innerHTML = `<span></span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>`; w.appendChild(b);
    const sync = () => { const t = label(s); if (b.firstChild.textContent !== t) b.firstChild.textContent = t; b.disabled = s.disabled; w.style.display = s.style.display === "none" || s.classList.contains("hidden") ? "none" : ""; }; sync(); s.addEventListener("change", sync); s._ddSync = sync;
    b.onclick = (e) => { e.stopPropagation(); if (open && open.s === s) return close(); close(); const r = b.getBoundingClientRect(), m = document.createElement("div"); m.className = "ddm";
      m.innerHTML = [...s.options].map((o, i) => `<button type="button" class="ddo ${i === s.selectedIndex ? "on" : ""}" data-i="${i}" ${o.disabled ? "disabled" : ""}>${esc(o.textContent)}</button>`).join(""); document.body.appendChild(m);
      const mh = Math.min(m.scrollHeight, 320), below = innerHeight - r.bottom > mh + 12; m.style.minWidth = r.width + "px"; m.style.left = Math.min(r.left, innerWidth - m.offsetWidth - 8) + "px"; m.style.top = (below ? r.bottom + 4 : r.top - mh - 4) + "px"; m.style.maxHeight = "320px"; m.style.transformOrigin = below ? "top" : "bottom";
      w.classList.add("open"); open = { s, m, w };
      try { if (window.anime && FX.ok()) { anime.animate(m, { opacity: [0, 1], scale: [0.94, 1], translateY: [below ? -6 : 6, 0], duration: 260, ease: "outBack(1.6)" }); anime.animate(m.querySelectorAll(".ddo"), { opacity: [0, 1], translateX: [-6, 0], delay: anime.stagger(14), duration: 220, ease: "outQuad" }); } } catch (er) {}
      const on = m.querySelector(".on"); if (on) on.scrollIntoView({ block: "nearest" });
      m.onclick = (ev) => { const o = ev.target.closest(".ddo"); if (!o) return; const i = +o.dataset.i; close(); if (s.selectedIndex !== i) { s.selectedIndex = i; s.dispatchEvent(new Event("input", { bubbles: true })); s.dispatchEvent(new Event("change", { bubbles: true })); } sync(); }; }; }
  const all = () => document.querySelectorAll("select:not([data-dd])").forEach(enhance);
  new MutationObserver((ms) => { let add = false; for (const m of ms) { if (m.target.closest && m.target.closest(".ddb,.ddm")) continue; for (const n of m.addedNodes) if (n.nodeType === 1 && (n.tagName === "SELECT" || n.tagName === "OPTION" || n.querySelector?.("select,option"))) { add = true; break; } if (add) break; }
    if (add) { all(); document.querySelectorAll("select[data-dd]").forEach((s) => s._ddSync && s._ddSync()); } }).observe(document.body, { childList: true, subtree: true });
  setInterval(() => document.querySelectorAll("select[data-dd]").forEach((s) => s._ddSync && s._ddSync()), 400);   // code that sets .value directly
  document.addEventListener("pointerdown", (e) => { if (open && !e.target.closest(".ddm,.ddb")) close(); }, true); addEventListener("keydown", (e) => { if (e.key === "Escape") close(); });
  addEventListener("resize", close); document.addEventListener("scroll", (e) => { if (open && !e.target.closest?.(".ddm")) close(); }, true); all(); })();

/* (Alltra sync removed by King, 2026-11-11) */
let extT = []; function extMarkers() {}

/* ---------------- motion polish (Motion.dev springs + Anime.js count-ups; both optional, app works without them) ---------------- */
const FX = {
  ok: () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  spring(el, from = { opacity: [0, 1], y: [10, 0] }, o = {}) { try { if (el && window.Motion && FX.ok()) Motion.animate(el, from, { type: "spring", bounce: 0.22, duration: 0.45, ...o }); } catch (e) {} },
  pop(el) { FX.spring(el, { opacity: [0, 1], scale: [0.94, 1] }, { bounce: 0.3, duration: 0.4 }); },
  stagger(els) { try { if (window.Motion && FX.ok() && els.length) Motion.animate(els, { opacity: [0, 1], y: [8, 0] }, { delay: Motion.stagger(0.03), type: "spring", bounce: 0.2, duration: 0.4 }); } catch (e) {} },
  count(el) { try { if (!window.anime || !FX.ok() || !el) return; const txt = el.textContent, m = txt.match(/-?[\d,]*\.?\d+/); if (!m) return;
    const end = parseFloat(m[0].replace(/,/g, "")), dec = (m[0].split(".")[1] || "").length, pre = txt.slice(0, m.index), post = txt.slice(m.index + m[0].length), o = { v: 0 };
    anime.animate(o, { v: end, duration: 700, ease: "outExpo", onUpdate: () => { el.textContent = pre + o.v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + post; }, onComplete: () => { el.textContent = txt; } }); } catch (e) { } },
};
{ const _view = view; view = function (v) { _view(v); const el = $("v-" + v); if (el) FX.spring(el, { opacity: [0.4, 1], y: [6, 0] }, { duration: 0.35 }); };
  const _rs = renderStats; renderStats = async function () { await _rs.apply(this, arguments); document.querySelectorAll("#st-kpi b").forEach(FX.count); FX.stagger([...document.querySelectorAll("#st-kpi > div")]); };
  const _dlg = dlg; dlg = function () { const r = _dlg.apply(this, arguments); FX.pop($("dlgbox")); return r; };
  const _toast = toast; toast = function (m) { _toast(m); if (m) FX.spring($("toast"), { opacity: [0, 1], y: [16, 0] }, { bounce: 0.35 }); };
  /* old splash bounce removed (KING_STARTFX replaced the splash) */ }
document.querySelectorAll(".vtab[data-view]").forEach((b) => (b.onclick = () => view(b.dataset.view)));
$("start").addEventListener("change", () => { if (!pos.qty && !orders.length) { blind = null; blindUI(); loadReplay(); } });   // picking a date loads it right away
$("go").onclick = () => { blind = null; blindUI(); loadReplay(); }; $("play").onclick = play; $("step").onclick = () => { pause(); $("stepsz").value === "candle" ? stepCandle() : stepFwd(); };
$("blindbtn").onclick = () => { if (blind) { const d = blind.day; blind = null; blindUI(); toast("It was " + new Date(d + "T12:00:00Z").toUTCString().slice(0, 16)); } else mysteryDay(); }; $("back").onclick = () => { pause(); stepBack(); };
/* KING_TEMPLATES (Nov 13): a template is a named snapshot of every setting (charts, chart settings, tools + favorites, layout, timeframes,
   indicators, theme, glass, sounds, panels, trading rules, hotkeys...). Make as many as you want, switch, update, rename, delete.
   Progress and personal history (XP, streaks, lessons, journal, strategies, last session) are never part of a template. */
const TPL_SKIP = new Set(["templates", "tplOn", "credits", "quizDay", "quiz", "mxStreakDay", "mxStreak", "mxDone", "lockUntil", "xp", "toured", "welcomed", "lessons",
  "lastSym", "lastStart", "stAcct", "seenSess", "psLater", "acct", "alertPause", "aplus", "strats", "lfPlan", "saved"]);
function tplSnap() { const o = {}; for (const [k, v] of Object.entries(prefs)) if (!TPL_SKIP.has(k)) o[k] = v; return JSON.parse(JSON.stringify(o)); }
function tplList() { if (!Array.isArray(prefs.templates)) prefs.templates = []; return prefs.templates; }
function tplMenu() { const L = tplList(), on = prefs.tplOn;
  $("tplmenu").innerHTML = `<div class="mh">Templates</div>` + (L.length ? L.map((t, i) => `<div class="tplrow${t.name === on ? " on" : ""}"><button class="tplgo" data-tpl="${i}" title="Switch to this template">${t.name === on ? "✓ " : ""}${esc(t.name)}<i>${new Date(t.at || Date.now()).toLocaleDateString()}</i></button><button class="ib sm" data-tplup="${i}" title="Save my current settings into this template">⟳</button><button class="ib sm" data-tplren="${i}" title="Rename">✎</button><button class="ib sm" data-tpldel="${i}" title="Delete">✕</button></div>`).join("") : `<div class="tplnone">No templates yet. Save your current setup to start.</div>`)
    + `<button class="tplnew" data-tplnew="1">+ Save current setup as a template…</button>`; }
async function tplPersist() { if (DEMO || !user) return; try { await sb.from("prefs").upsert({ user_id: user.id, data: prefs, updated_at: new Date().toISOString() }); } catch (e) {} }
async function tplApply(i) { const t = tplList()[i]; if (!t) return; const keepT = tplList();
  for (const [k, v] of Object.entries(JSON.parse(JSON.stringify(t.data)))) if (!TPL_SKIP.has(k)) prefs[k] = v;
  prefs.templates = keepT; prefs.tplOn = t.name;
  if (DEMO) { try { applyTheme(prefs.theme); document.body.classList.toggle("glass", prefs.glass !== false); fillSettings(); } catch (e) {} return toast(`Template "${t.name}" (demo: reload not saved)`); }
  toast(`Switching to "${t.name}"…`); await tplPersist(); try { sessionStorage.setItem("kz-nointro", "1"); } catch (e) {} location.reload(); }
$("tplbtn").onclick = () => { tplMenu(); $("tplmenu").classList.toggle("hidden"); };
document.addEventListener("pointerdown", (e) => { if (!e.target.closest(".tplwrap")) $("tplmenu").classList.add("hidden"); });
$("tplmenu").onclick = async (e) => { const b = e.target.closest("button"); if (!b) return; const L = tplList();
  if (b.dataset.tplnew) { const name = (prompt("Name this template (e.g. NQ scalping, 4-chart SMT, Clean replay)") || "").trim().slice(0, 40); if (!name) return;
    const ex = L.findIndex((t) => t.name.toLowerCase() === name.toLowerCase()); const rec = { name, at: Date.now(), data: tplSnap() };
    if (ex >= 0) { if (!confirm(`"${L[ex].name}" already exists. Replace it with your current setup?`)) return; L[ex] = rec; } else L.push(rec);
    prefs.tplOn = name; savePrefs(); tplMenu(); return toast(`Saved template "${name}"`); }
  if (b.dataset.tpl != null) return tplApply(+b.dataset.tpl);
  if (b.dataset.tplup != null) { const t = L[+b.dataset.tplup]; if (!t || !confirm(`Overwrite "${t.name}" with your current settings?`)) return; t.data = tplSnap(); t.at = Date.now(); prefs.tplOn = t.name; savePrefs(); tplMenu(); return toast(`Updated "${t.name}"`); }
  if (b.dataset.tplren != null) { const t = L[+b.dataset.tplren]; const nm = (prompt("New name", t.name) || "").trim().slice(0, 40); if (!nm) return; if (prefs.tplOn === t.name) prefs.tplOn = nm; t.name = nm; savePrefs(); tplMenu(); return; }
  if (b.dataset.tpldel != null) { const t = L[+b.dataset.tpldel]; if (!t || !confirm(`Delete template "${t.name}"? Your current settings stay as they are.`)) return; L.splice(+b.dataset.tpldel, 1); if (prefs.tplOn === t.name) prefs.tplOn = null; savePrefs(); tplMenu(); } };
$("laybtn").onclick = () => $("laymenu").classList.toggle("hidden"); $("laymenu").onclick = (e) => { const b = e.target.closest(".lay"); if (b) { setLayout(b.dataset.lay); layMenu(); return; } const l = e.target.closest("[data-sl]"); if (l) return loadLayout(+l.dataset.sl);
  const d = e.target.closest("[data-sldel]"); if (d) { prefs.saved.splice(+d.dataset.sldel, 1); savePrefs(); layMenu(); return; } if (e.target.closest("#sl-save")) saveLayout(); };
document.addEventListener("click", (e) => { const b = e.target.closest("#tools [data-tool], #favbar [data-tool]"); if (b) setTool(b.dataset.tool); });
$("tools").addEventListener("contextmenu", (e) => { const b = e.target.closest("[data-tool]"); e.preventDefault(); const items = [{ h: "Toolbar" }];
  if (b) { const t = b.dataset.tool, on = prefs.favs.includes(t); items.push({ t: (on ? "Remove " : "Add ") + (TOOLNAMES[t] || t) + (on ? " from" : " to") + " favorites", f: () => { prefs.favs = on ? prefs.favs.filter((x) => x !== t) : [...prefs.favs, t]; prefs.favShow = true; savePrefs(); favUI(); } }); }
  items.push({ t: prefs.toolsPos ? "Dock toolbar on the left" : "Float toolbar (drag the grip)", f: () => { prefs.toolsPos = prefs.toolsPos ? null : { x: 70, y: 140 }; savePrefs(); toolsUI(); } }); menu(items, e.clientX, e.clientY); });
$("favbtn").onclick = () => { prefs.favShow = !prefs.favShow; savePrefs(); favUI(); };
$("favbar").addEventListener("contextmenu", (e) => { const b = e.target.closest("[data-tool]"); e.preventDefault(); menu([{ h: "Favorites" }, b ? { t: "Remove " + (TOOLNAMES[b.dataset.tool] || b.dataset.tool), f: () => { prefs.favs = prefs.favs.filter((x) => x !== b.dataset.tool); savePrefs(); favUI(); } } : null, { t: "Hide favorites bar", f: () => { prefs.favShow = false; savePrefs(); favUI(); } }], e.clientX, e.clientY); });
grip($("favgrip"), (e, st) => { const fb = $("favbar"), r = fb.getBoundingClientRect(); if (!st.r) st.r = r; fb.style.transform = "none"; fb.style.left = Math.max(0, Math.min(innerWidth - r.width, st.r.left + e.clientX - st.x)) + "px"; fb.style.top = Math.max(0, Math.min(innerHeight - r.height, st.r.top + e.clientY - st.y)) + "px"; },
  () => { const r = $("favbar").getBoundingClientRect(); prefs.favPos = { x: r.left, y: r.top }; savePrefs(); });
grip($("toolgrip"), (e, st) => { const t = $("tools"); if (!prefs.toolsPos) { prefs.toolsPos = { x: e.clientX - 20, y: e.clientY - 10 }; toolsUI(); } if (!st.r) st.r = t.getBoundingClientRect(); t.style.left = Math.max(0, Math.min(innerWidth - 50, st.r.left + e.clientX - st.x)) + "px"; t.style.top = Math.max(0, Math.min(innerHeight - 100, st.r.top + e.clientY - st.y)) + "px"; },
  () => { const r = $("tools").getBoundingClientRect(), home = $("tools").parentElement.getBoundingClientRect();
    // KING_RAILSNAP (Nov 12 walkthrough): drag it back near its spot on the left and it docks again
    if (prefs.toolsPos && r.left < home.left + 70 && Math.abs(r.top - home.top) < 160) { prefs.toolsPos = null; toolsUI(); savePrefs(); toast("Toolbar docked"); return; }
    if (prefs.toolsPos) { prefs.toolsPos = { x: r.left, y: r.top }; savePrefs(); } });
$("toolgrip").ondblclick = () => { prefs.toolsPos = null; savePrefs(); toolsUI(); };
grip($("dockgrip"), (e, st) => { if (st.h == null) { st.h = prefs.dockClosed ? 0 : prefs.dockH || 150; prefs.dockClosed = false; $("dock").classList.remove("closed"); } prefs.dockH = Math.max(60, Math.min(Math.round(innerHeight * 0.6), st.h + st.y - e.clientY)); dockH(); },
  () => { if (prefs.dockH < 70) { prefs.dockClosed = true; prefs.dockH = 150; } savePrefs(); dockUI(); });
$("sym").onchange = () => {   // switch instrument right away, at the same replay time
  if (!B["1m"].bars.length) return; const v = $("sym").value;
  if (panes.length > 1 && !(prefs.sync && prefs.sync.sym)) return setPaneSym(active, v);   // multi-chart: just this chart changes, positions on the others keep running
  if (pos.qty || orders.length || busyElsewhere()) { $("sym").value = sym; return toast("Close positions and cancel orders before switching instrument"); }
  $("start").value = fmt(loc(cursorT + 61)).replace(" ", "T"); loadReplay();
};
$("skipny").onclick = () => skipTo("09:30", "NY open"); $("skipasia").onclick = () => skipTo("20:00", "Asia open");
$("clr").onclick = () => { drawings.filter((d) => d.state === "armed").forEach(disarmTool); drawings = []; sel = null; repaintAll(); }; $("magnet").onclick = toggleMagnet;
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => { document.querySelectorAll(".mode").forEach((x) => x.classList.toggle("on", x === b)); ["scalp", "dom", "order", "friends"].forEach((m) => $("md-" + m).classList.toggle("hidden", m !== b.dataset.mode)); if (b.dataset.mode === "friends") frSide(); if (b.dataset.mode === "scalp" && !prefs.pad.show) { prefs.pad.show = true; padUI(); } refresh(); }));
document.querySelectorAll(".btab").forEach((b) => (b.onclick = () => { if (b.classList.contains("on") && !prefs.dockClosed) { prefs.dockClosed = true; savePrefs(); return dockUI(); } prefs.dockClosed = false; savePrefs(); dockUI();
  document.querySelectorAll(".btab").forEach((x) => x.classList.toggle("on", x === b)); ["acct", "pos", "ord", "hist"].forEach((k) => $("b-" + k).classList.toggle("hidden", k !== b.dataset.b)); }));
["tx-st", "tx-pay", "tx-exp", "tx-w2", "tx-wh"].forEach((k) => ($(k).oninput = taxCalc));
$("acctpill").onclick = acctMenu; $("ac-new").onclick = () => acctDlg(null);
$("ac-list").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; const id = b.dataset.use || b.dataset.edit || b.dataset.arch, a = accts.find((x) => x.id === id); if (!a) return;
  if (b.dataset.use) { pickAcct(id); renderAccts(); } else if (b.dataset.edit) acctDlg(a); else if (confirm("Archive " + a.name + "? Its trades stay in your journal.")) db.updAccount(id, { archived: true }).then(() => { accts = accts.filter((x) => x.id !== id); if (acct && acct.id === id) pickAcct(null); renderAccts(); }); };
["st-acct", "st-sym", "st-range"].forEach((k) => ($(k).onchange = () => { if (k === "st-acct") { prefs.stAcct = $(k).value; savePrefs(); } renderStats(); }));
$("ftabs").onclick = (e) => { const b = e.target.closest("[data-f]"); if (b) ftab(b.dataset.f); };
["lb-range", "lb-sym"].forEach((k) => ($(k).onchange = renderLB));
$("lb-share").onchange = async () => { if (!me) return; me.share_stats = $("lb-share").checked; if (!DEMO) await sb.from("profiles").update({ share_stats: me.share_stats }).eq("user_id", me.user_id); renderLB(); };
$("ch-new").onclick = newChallenge;
$("ch-list").onclick = async (e) => { const list = JSON.parse($("ch-list").dataset.ids || "[]"), b = e.target.closest("button"); if (!b) return; const c = list.find((x) => x.id === (b.dataset.take || b.dataset.delch)); if (!c) return;
  if (b.dataset.take) takeChallenge(c); else if (confirm("Delete this challenge?")) { if (DEMO) mem.ch = mem.ch.filter((x) => x.id !== c.id); else await sb.from("challenges").delete().eq("id", c.id); renderCh(); } };
$("sh-list").onclick = (e) => { const st = e.target.closest(".star"); if (st) return rateShare(st.closest(".stars").dataset.share, +st.dataset.n); const rb = e.target.closest("[data-replay]");
  if (rb) { const x = JSON.parse($("sh-list").dataset.list).find((z) => z.id === rb.dataset.replay); if (x) takeChallenge({ symbol: x.snap.symbol, start_ts: x.snap.t_entry - 3600 }); } };
$("sg-add").onclick = addSg; $("sg-text").onkeydown = (e) => { if (e.key === "Enter") addSg(); };
$("sg-list").onclick = async (e) => { const b = e.target.closest("[data-vote]"); if (!b) return; if (DEMO) { const x = mem.sg.find((z) => z.id === b.dataset.vote); x.votes = x.votes.includes("demo") ? [] : ["demo"]; } else { const { error } = await sb.rpc("vote_suggestion", { sid: b.dataset.vote }); if (error) toast(error.message); } renderSg(); };
$("sg-list").onchange = async (e) => { const id = e.target.dataset.st; if (id && !DEMO) { await sb.from("suggestions").update({ status: e.target.value }).eq("id", id); renderSg(); } };
$("lv-list").onclick = (e) => { const b = e.target.closest("[data-inv]"); if (b) invite(b.dataset.inv); }; $("livepill").onclick = () => { view("friends"); ftab("lv"); };
$("chkbtn").onclick = () => { prefs.chkShow = !prefs.chkShow; savePrefs(); chkUI(); };
$("mediabtn").onclick = () => { prefs.media = prefs.media || {}; prefs.media.show = !prefs.media.show; savePrefs(); mediaUI(); };
document.querySelectorAll(".mt button").forEach((b) => (b.onclick = () => { prefs.media.tab = b.dataset.m; savePrefs(); mediaUI(); }));
$("m-op").oninput = () => { prefs.media.op = +$("m-op").value; mediaLook(); }; $("m-op").onchange = savePrefs;   // KING_MEDIAWIN: just the look, no re-render (it used to rebuild the whole library on every slider tick)
$("m-ct").onclick = () => { prefs.media.ct = !prefs.media.ct; savePrefs(); mediaUI(); if (prefs.media.ct) toast("Click-through on: clicks go to the chart. Turn it off with the ⌖ button (it stays clickable)."); };
$("m-big").onclick = () => { prefs.media.big = !prefs.media.big; savePrefs(); mediaUI(); };
$("m-x").onclick = () => { prefs.media.show = false; savePrefs(); mediaUI(); };
grip($("mgrip"), (e, st) => { if (e.target.closest("button,input")) return; const m = $("media"); if (!st.r) st.r = m.getBoundingClientRect(); m.style.left = Math.max(0, Math.min(innerWidth - 120, st.r.left + e.clientX - st.x)) + "px"; m.style.top = Math.max(0, Math.min(innerHeight - 60, st.r.top + e.clientY - st.y)) + "px"; },
  () => { const r = $("media").getBoundingClientRect(); prefs.media.x = r.left; prefs.media.y = r.top; savePrefs(); });
$("ai-th-go").onclick = aiTheme; $("ai-th").onkeydown = (e) => { if (e.key === "Enter") aiTheme(); };
$("s-padbtns").onchange = (e) => { const all = [...document.querySelectorAll("[data-pg2]:checked")].map((i) => i.dataset.pg2); if (all.length > 6) { e.target.checked = false; return toast("Up to 6 groups"); } prefs.padBtns = all; savePrefs(); padBtnsUI(); };
$("s-mask").onchange = (e) => { const k = e.target.dataset.mask; if (!k) return; prefs.mask = { ...(prefs.mask || {}), [k]: e.target.checked }; savePrefs(); maskUI(); };
$("s-snd").onchange = (e) => { const k = e.target.dataset.snd; if (!k) return; prefs.snd = { ...(prefs.snd || {}), [k]: e.target.value }; savePrefs(); snd(k); };
$("s-snd").onclick = (e) => { const k = e.target.dataset.sndp; if (k) snd(k); };
$("s-fx").addEventListener("change", async (e) => { const C = fxCfg(), el = e.target; const k = el.dataset.fxs || el.dataset.fxl || el.dataset.fxu;
  if (el.id === "fx-on") { C.on = el.checked; savePrefs(); return; } if (el.id === "fx-pct") { C.runPct = Math.max(20, Math.min(95, +el.value || 60)); savePrefs(); return; } if (!k) return; C.slots[k] = C.slots[k] || {};
  if (el.dataset.fxs) C.slots[k].start = Math.max(0, +el.value || 0); else if (el.dataset.fxl) C.slots[k].len = Math.max(0.5, Math.min(30, +el.value || 8));
  else if (el.dataset.fxu) { const f = el.files[0]; if (!f) return; if (f.size > 15e6) return toast("Max 15 MB per clip"); await fxPut(k, { blob: f, name: f.name }); C.slots[k].name = f.name.slice(0, 40); fxHave[k] = true; fxUI(); toast(`🎵 Saved for "${FX_SLOTS[k]}" (on this device)`); }
  savePrefs(); });
$("s-fx").addEventListener("click", async (e) => { const p = e.target.closest("[data-fxp]"), x = e.target.closest("[data-fxx]"); if (p) { const k = p.dataset.fxp; fxEvent(k, k === "hit_sl" ? -250 : 420); }
  if (x) { const k = x.dataset.fxx; await fxPut(k, null); fxHave[k] = false; if (fxCfg().slots[k]) delete fxCfg().slots[k].name; savePrefs(); fxUI(); } });
$("s-intro").onclick = () => welcomeIntro(true); $("s-tour").onclick = () => { view("trade"); setTimeout(tour, 300); };
$("s-sndfile").onchange = (e) => { const f = e.target.files[0]; if (!f) return; if (f.size > 300000) return toast("Max 300 KB"); const r = new FileReader(); r.onload = () => { try { localStorage.setItem("rw-snd", r.result); toast("Sound saved. Pick 'My sound' for any event."); tone("custom"); } catch (er) { toast("Couldn't save the sound on this device"); } }; r.readAsDataURL(f); };
$("s-lockgo").onclick = () => { let v = $("s-lock").value; if (v === "0") return; if (v === "custom") { v = prompt("Lock out for how many hours?", "3"); if (!v || !(+v > 0)) return; }
  const until = v === "day" ? new Date(new Date().setHours(23, 59, 0, 0)).getTime() : Date.now() + +v * 3600e3; if (!confirm("Lock yourself out of trading until " + new Date(until).toLocaleString() + "? You can't undo this.")) return;
  prefs.lockUntil = until; savePrefs(); lockUI(); toast("🔒 Locked out"); };
$("s-speed").onclick = (e) => { const b = e.target.closest("[data-sp]"); if (!b) return; prefs.speed = b.dataset.sp; savePrefs(); speedUI(); };
$("pbe").onclick = beNow; $("pcan").onclick = () => { cancelAll(); snd("cancel"); }; $("pflat").onclick = flatten; $("pclose2").onclick = () => closeAll(); $("prev2").onclick = reverse;
$("dtb").onclick = (e) => { const b = e.target.closest("button"); if (!b) return; const d = drawings.find((z) => z.id === +$("dtb").dataset.id); if (!d) return;
  if (b.dataset.act === "col") { $("dtb").querySelector(".dcols").classList.toggle("hidden"); return; } if (b.dataset.act === "wcyc") { const W = [1, 2, 3, 4], k = W.indexOf(Math.round(d.w || 1.4)); d.w = W[(k + 1) % W.length]; } else if (b.dataset.act === "dcyc") { const D = ["solid", "dash", "dot"]; d.dash = D[(D.indexOf(d.dash || "solid") + 1) % 3]; } else if (b.dataset.c) d.color = b.dataset.c; else if (b.dataset.w) d.w = +b.dataset.w; else if (b.dataset.dash) d.dash = b.dataset.dash;
  else if (b.dataset.act === "set") { $("dtb").classList.add("hidden"); return toolSettings(d); } else if (b.dataset.act === "preset") { const r = b.getBoundingClientRect(); return presetMenu(d, r.left, r.bottom + 4); } else if (b.dataset.act === "label") { const r = b.getBoundingClientRect(); return labelPop(d, r); } else if (b.dataset.act === "lock") d.locked = !d.locked;
  else if (b.dataset.act === "del") { disarmTool(d); drawings = drawings.filter((z) => z !== d); if (sel === d) sel = null; if (hov === d) hov = null; $("dtb").classList.add("hidden"); repaintAll(); return; }
  repaintAll(); sel = d; dtbShow(dtbP); };
$("dtb").onmouseleave = () => { if (!$("dtb").querySelector(".dcols:not(.hidden)")) dtbShow(dtbP); };
$("dtb").addEventListener("change", (e) => { if (e.target.id !== "cpick") return; const d = drawings.find((z) => z.id === +$("dtb").dataset.id), v = e.target.value; if (!d) return;
  prefs.myCols = [v, ...(prefs.myCols || []).filter((x) => x !== v)].slice(0, 10); savePrefs(); d.color = v; repaintAll(); sel = d; dtbShow(dtbP); $("dtb").querySelector(".dcols").classList.remove("hidden"); });
$("dtb").addEventListener("contextmenu", (e) => { const b = e.target.closest("[data-my]"); if (!b) return; e.preventDefault(); prefs.myCols = (prefs.myCols || []).filter((x) => x !== b.dataset.c); savePrefs(); dtbShow(dtbP); $("dtb").querySelector(".dcols").classList.remove("hidden"); });
$("chartsetbtn").onclick = () => { fillSettings(); chartSetUI(); $("chartset").classList.remove("hidden"); };
$("cs-x").onclick = () => $("chartset").classList.add("hidden"); $("chartset").onclick = (e) => { if (e.target.id === "chartset") $("chartset").classList.add("hidden"); };
$("cs-sym").onclick = (e) => { const b = e.target.closest("[data-s]"); if (!b || b.dataset.s === sym) return; $("sym").value = b.dataset.s; $("sym").onchange(); chartSetUI(); };
$("cs-save").onclick = () => { prefs.sync = { sym: $("cs-ssym").checked, int: $("cs-sint").checked, cross: $("cs-scross").checked, time: $("cs-stime").checked, range: $("cs-srange").checked }; saveSettings(); if (B["1m"].bars.length) loadOthers().then(rebuildAll); else panes.forEach(label); $("chartset").classList.add("hidden"); toast("Chart settings saved"); };
$("s-save2").onclick = () => { saveSettings(); $("s-msg2").textContent = "Saved"; };
$("charts").addEventListener("click", (e) => { if (e.target.closest(".lname")) symMenu(e); });
$("jc-grid").onclick = (e) => { const b = e.target.closest("[data-day]"); if (!b) return; jDay = jDay === b.dataset.day ? null : b.dataset.day; loadJournal(); };
$("jc-prev").onclick = () => { const [y, m] = jMonth.split("-").map(Number), d = new Date(Date.UTC(y, m - 2, 1)); jMonth = d.toISOString().slice(0, 7); jDay = null; calUI(); loadJournal(); };
$("jc-next").onclick = () => { const [y, m] = jMonth.split("-").map(Number), d = new Date(Date.UTC(y, m, 1)); jMonth = d.toISOString().slice(0, 7); jDay = null; calUI(); loadJournal(); };
$("jc-all").onclick = () => { jDay = null; loadJournal(); };
$("frbtn").onclick = () => { if (prefs.side && !$("md-friends").classList.contains("hidden")) { prefs.side = false; savePrefs(); sideUI(); } else frOpen(); };
$("sfr-open").onclick = () => view("friends");
$("s-themes").onclick = (e) => { const b = e.target.closest("[data-th]"); if (b) { applyTheme(b.dataset.th); savePrefs(); sfx("click"); } };
$("helpbtn").onclick = helpDlg; addEventListener("keydown", (e) => { if (e.key === "Escape" && document.querySelector(".tourbox")) { document.querySelectorAll(".tourbox,.tourspot").forEach((x) => x.remove()); prefs.toured = APP_VERSION; savePrefs(); } });
$("chat-send").onclick = sendChat; $("chat-in").onkeydown = (e) => { if (e.key === "Enter") sendChat(); };
$("ltabs").onclick = (e) => { const b = e.target.closest("[data-l]"); if (b) ltab(b.dataset.l); }; $("rl-spoil").onchange = renderRL;
$("rl-list").onclick = (e) => { const b = e.target.closest("[data-rday]"); if (b) replayReese(reese.find((r) => r.id === b.dataset.rday)); };
$("qz-go").onclick = quizNext; $("qz-take").onclick = () => quizAnswer(true); $("qz-fade").onclick = () => quizAnswer(false); $("qz-more").onclick = quizNext; $("qz-stop").onclick = quizStop;
$("co-lessons").onclick = (e) => { const b = e.target.closest("[data-les]"); if (b) lessonDlg(+b.dataset.les); };
$("co-weeks").onclick = async (e) => { const b = e.target.closest("[data-wk]"); if (!b) return; if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); const d = new Date(b.dataset.wk + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() - 1); $("sym").value = "NQ"; $("start").value = d.toISOString().slice(0, 10) + "T17:30"; view("trade"); await loadReplay(); };
$("ev-list").onclick = (e) => { const b = e.target.closest("[data-buy]"); if (b) buyEval(b.dataset.buy); };
$("dockbtn").onclick = () => { prefs.dockClosed = !prefs.dockClosed; savePrefs(); dockUI(); };
$("tfbar").onclick = (e) => { const b = e.target.closest(".tf"); if (b) setPaneTf(active, b.dataset.tf); };
$("ranges").onclick = (e) => { const b = e.target.closest("[data-r]"); if (b) showRange(+b.dataset.r); };
$("gotobtn").onclick = () => { const s = $("start"); s.focus(); try { s.showPicker(); } catch (e) {} };
$("sc-pct").onclick = () => setScale("pct"); $("sc-log").onclick = () => setScale("log"); $("sc-auto").onclick = () => setScale("auto");
$("indbtn").onclick = indMenu; $("shotbtn").onclick = saveShot; $("sidebtn").onclick = () => { prefs.side = !prefs.side; savePrefs(); sideUI(); };
$("fullbtn").onclick = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
$("qdn").onclick = () => setLots(prefs.lots - 1); $("qup").onclick = () => setLots(prefs.lots + 1);
$("padmore").onclick = () => { prefs.pad.more = !prefs.pad.more; savePrefs(); padUI(); };
$("padshow").onclick = () => { prefs.pad.show = !prefs.pad.show; savePrefs(); padUI(); }; $("padx").onclick = () => { prefs.pad.show = false; savePrefs(); padUI(); };
$("lots").onclick = (e) => { const n = +e.target.dataset.lot; if (!n) return; setLots(n); };
$("pbuy").onclick = () => market(1); $("psell").onclick = () => market(-1); $("pjb").onclick = joinBid; $("pja").onclick = joinAsk;
$("scancel").onclick = cancelAll; $("sflat").onclick = flatten; $("d-buy").onclick = () => market(1); $("d-sell").onclick = () => market(-1); $("d-jb").onclick = joinBid; $("d-ja").onclick = joinAsk; $("d-close").onclick = () => closeAll(); $("d-rev").onclick = reverse;
let oside = 1;
$("o-buy").onclick = () => { oside = 1; $("o-buy").classList.add("on"); $("o-sell").classList.remove("on"); if (draft) { draft.side = 1; drawOrders(); } };
$("o-sell").onclick = () => { oside = -1; $("o-sell").classList.add("on"); $("o-buy").classList.remove("on"); if (draft) { draft.side = -1; drawOrders(); } };
document.querySelectorAll("[data-q]").forEach((b) => (b.onclick = () => { $("o-qty").value = Math.max(1, (+$("o-qty").value || 1) + +b.dataset.q); refresh(); }));
["o-sl", "o-tp", "o-qty"].forEach((k) => ($(k).oninput = refresh));
$("o-type").onchange = () => { const t = $("o-type").value; $("o-pxrow").classList.toggle("hidden", t === "market"); if (t === "market") draft = null; else if (last() != null) { draft = { side: oside, type: t, price: rnd(+$("o-px").value || last() - oside * 10) }; $("o-px").value = draft.price; } drawOrders(); };
$("o-px").oninput = () => { if (draft) { draft.price = rnd(+$("o-px").value); drawOrders(); } };
$("o-send").onclick = () => { const ty = $("o-type").value, q = +$("o-qty").value || 1, br = { slPts: +$("o-sl").value || 0, tpPts: +$("o-tp").value || 0, trail: $("o-trail").checked ? +$("o-sl").value : 0 };
  if (ty === "market") { if (canTrade()) fill(oside, q, last(), nowT(), br); return; } const p = draft ? draft.price : +$("o-px").value; if (!p) return toast("Set a price (drag the draft line)");
  place(oside, ty, p, q, br); draft = null; $("o-type").value = "market"; $("o-pxrow").classList.add("hidden"); drawOrders(); };
$("b-pos").onclick = (e) => { const a = e.target.dataset.a; if (a === "close") closeAll(); if (a === "rev") reverse(); if (a === "be") toBE(); };
$("b-ord").onclick = (e) => { const c = +e.target.dataset.c; if (c) { const o = orders.find((z) => z.id === c); orders = orders.filter((z) => z.id !== c); const d = o && drawings.find((z) => z.id === o.tool); if (d) d.state = "idle"; drawOrders(); refresh(); repaintAll(); } };
$("s-save").onclick = saveSettings; $("j-sym").onchange = loadJournal; $("j-csv").onclick = exportCsv;
$("j-notion").onclick = async () => { $("j-msg").textContent = "Syncing…"; try { const r = await notion("sync"); $("j-msg").textContent = "Sent " + r.synced + " trades to Notion"; loadJournal(); } catch (e) { $("j-msg").textContent = e.message; } };
$("jrows").addEventListener("change", (e) => { if (e.target.classList.contains("note")) db.note(e.target.closest("tr").dataset.id, e.target.value); });
$("jrows").addEventListener("click", (e) => { if (e.target.classList.contains("cardbtn")) { const t = jT.find((x) => x.id === e.target.closest("tr").dataset.id); if (t) shareCard(t, false); return; } if (!e.target.classList.contains("sharebtn")) return; const t = jT.find((x) => x.id === e.target.closest("tr").dataset.id); if (t) shareTrade(t); });
$("jrows").addEventListener("click", async (e) => { if (!e.target.classList.contains("shotlink")) return; e.preventDefault(); const t = jT.find((x) => x.id === e.target.closest("tr").dataset.id); const { data } = await sb.storage.from("shots").createSignedUrl(t.shots[0], 300); if (data) window.open(data.signedUrl, "_blank"); });
$("n-oauth").onclick = async () => { try { const r = await notion("oauth_url"); location.href = r.url; } catch (e) { nmsg(e.message); } };
$("n-save").onclick = async () => { nmsg("Checking token…"); try { await notion("save_token", { token: $("n-token").value }); $("n-token").value = ""; nmsg(""); notionUI(); } catch (e) { nmsg(e.message); } };
$("n-create").onclick = async () => { const id = $("n-pages").value; if (!id) return nmsg("Share a page with your integration first, then reload"); nmsg("Creating…"); try { await notion("setup", { page_id: id }); nmsg("Journal created. New trades will show up there."); notionUI(); } catch (e) { nmsg(e.message); } };
$("n-sync").onclick = async () => { nmsg("Syncing…"); try { const r = await notion("sync"); nmsg("Sent " + r.synced + " trades"); } catch (e) { nmsg(e.message); } };
$("n-auto").onchange = async () => { notionAuto = $("n-auto").checked; await notion("auto", { on: notionAuto }).catch(() => {}); };
$("n-off").onclick = async () => { if (!confirm("Disconnect Notion? Your Notion journal stays in Notion.")) return; await notion("disconnect").catch(() => {}); notionUI(); };
$("ad-add").onclick = async () => { const e = $("ad-email").value.trim().toLowerCase(); if (!e) return; const { error } = await sb.from("allowlist").insert({ email: e, role: "waitlist" }); if (error) alert(error.message); $("ad-email").value = ""; loadAdmin(); };
$("ad-list").addEventListener("click", async (e) => { if (e.target.id === "ad-launch") { if (!confirm("Open KAIROS to everyone on the waitlist?")) return; await sb.from("allowlist").update({ role: "member" }).eq("role", "waitlist"); return loadAdmin(); }
  if (e.target.dataset.role) { await sb.from("allowlist").update({ role: e.target.dataset.to }).eq("email", e.target.dataset.role); return loadAdmin(); } const em = e.target.dataset.del; if (!em || !confirm("Remove " + em + "? Their saved data stays, they just can't get in.")) return; await sb.from("allowlist").delete().eq("email", em); loadAdmin(); });
$("ad-feat").addEventListener("change", async (e) => { const k = e.target.dataset.feat; if (k) await sb.from("features").update({ enabled: e.target.checked, updated_at: new Date().toISOString() }).eq("key", k); });
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) || $("v-trade").classList.contains("hidden") || !$("dlg").classList.contains("hidden")) return; const k = e.key.toLowerCase(), K = prefs.keys;
  if (e.code === "Space") { e.preventDefault(); play(); } else if (e.key === "ArrowRight") { pause(); $("stepsz").value === "candle" ? stepCandle() : stepFwd(); } else if (e.key === "ArrowLeft") { pause(); stepBack(); }
  else if (e.key === "Escape") { setTool("cursor"); sel = null; hideCtx(); repaintAll(); } else if ((e.key === "Delete" || e.key === "Backspace") && sel) { if (sel.state === "armed") disarmTool(sel); drawings = drawings.filter((d) => d !== sel); sel = null; repaintAll(); }
  else if (k === K.buy) market(1); else if (k === K.sell) market(-1); else if (k === K.joinbid) joinBid(); else if (k === K.joinask) joinAsk(); else if (k === K.reverse) reverse(); else if (k === K.flatten) flatten(); else if (k === K.cancel) cancelAll(); else if (k === K.be) beNow(); else if (k === K.close) closeAll();
  else if (k === K.trend) setTool("trend"); else if (k === K.hline) setTool("hline"); else if (k === K.vline) setTool("vline"); else if (k === K.rect) setTool("rect"); else if (k === K.long) setTool("long"); else if (k === K.short) setTool("short"); else if (k === K.measure) setTool("measure");
});
addEventListener("resize", () => { padUI(); repaintAll(); });
sb.auth.onAuthStateChange((ev) => { if (ev === "SIGNED_IN" && !user) boot(); });
boot();

/* KING_TOOLRAIL (Nov 11, King's Brief 3): Tradesea / TradingView-style tool rail. Tools sit in groups; the group button shows the last tool you used
   from it; the small corner triangle (or right-click... no, right-click stays "add to favorites") opens a flyout with every tool, its name and hot key. */
function tgSync(t) { const it = document.querySelector('#tools .tfly [data-tool="' + t + '"]'); if (!it) { document.querySelectorAll("#tools .tg").forEach((g) => g.classList.toggle("act", !!g.querySelector('[data-tool="' + t + '"]'))); return; }
  const g = it.closest(".tg"), m = g.querySelector(".tgm"); if (m && m.dataset.tool !== t) { m.dataset.tool = t; m.title = it.title; m.innerHTML = it.querySelector(".ti").innerHTML; m.classList.toggle("lp", t === "long"); m.classList.toggle("sp", t === "short"); m.classList.add("on"); }
  try { prefs.tg = prefs.tg || {}; if (prefs.tg[g.dataset.g] !== t) { prefs.tg[g.dataset.g] = t; } } catch (e) {}
  document.querySelectorAll("#tools .tg").forEach((x) => x.classList.toggle("act", x === g)); tgClose(); }
function tgClose() { document.querySelectorAll("#tools .tfly").forEach((f) => f.classList.add("hidden")); document.querySelectorAll("#tools .tgx.open").forEach((b) => b.classList.remove("open")); }
function tgOpen(g) { const f = document.querySelector('#tools .tfly[data-g="' + g + '"]'), x = document.querySelector('#tools .tgx[data-g="' + g + '"]'); if (!f) return; const was = !f.classList.contains("hidden"); tgClose(); if (was) return;
  const r = f.closest(".tg").getBoundingClientRect(); f.classList.remove("hidden"); x && x.classList.add("open"); f.style.left = r.right + 6 + "px"; f.style.top = Math.max(8, Math.min(innerHeight - f.offsetHeight - 8, r.top - 4)) + "px"; }
function tgRestore() { try { const m = (prefs && prefs.tg) || {}; Object.entries(m).forEach(([g, t]) => { const it = document.querySelector('#tools .tfly[data-g="' + g + '"] [data-tool="' + t + '"]'), mb = document.querySelector('#tools .tg[data-g="' + g + '"] .tgm'); if (it && mb) { mb.dataset.tool = t; mb.title = it.title; mb.innerHTML = it.querySelector(".ti").innerHTML; mb.classList.toggle("lp", t === "long"); mb.classList.toggle("sp", t === "short"); } }); } catch (e) {} }
document.addEventListener("click", (e) => { const x = e.target.closest("#tools .tgx"); if (x) { e.stopPropagation(); return tgOpen(x.dataset.g); } if (window.__tgHold && e.target.closest("#tools .tgm")) return; if (!e.target.closest("#tools .tfly")) tgClose(); }, true);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") tgClose(); });
// long-press a group button also opens its flyout (touch + mouse), like Tradesea
// KING_HOLDPICK (Nov 12 walkthrough): hold → the flyout opens and stays open (the release no longer re-picks the old tool and
// closes it); slide onto a tool and let go to pick it, or let go and click one.
(() => { let lp = null, opened = false; document.addEventListener("pointerdown", (e) => { const m = e.target.closest("#tools .tgm"); if (!m) return; const g = m.closest(".tg"); if (!g.querySelector(".tfly")) return; opened = false; lp = setTimeout(() => { lp = null; opened = window.__tgHold = true; tgOpen(g.dataset.g); }, 380); });
  document.addEventListener("pointerup", (e) => { if (lp) { clearTimeout(lp); lp = null; } if (!opened) return;
    const el = document.elementFromPoint(e.clientX, e.clientY), it = el && el.closest("#tools .tfly [data-tool]"); if (it) { opened = window.__tgHold = false; it.click(); } });
  document.addEventListener("click", (e) => { if (opened && e.target.closest("#tools .tgm")) { opened = window.__tgHold = false; e.stopPropagation(); e.preventDefault(); } }, true);
  ["pointercancel"].forEach((k) => document.addEventListener(k, () => { if (lp) { clearTimeout(lp); lp = null; } })); })();

/* KING_LABELS (Nov 11, Brief 3): every drawing gets quick labels (Entry, Stop, Target, Liquidity, FVG…) plus a free text box, on top of presets */
const QUICK_LABELS = ["Entry", "Stop", "Target", "Liquidity", "BSL", "SSL", "FVG", "IFVG", "OB", "PDH", "PDL", "Data H", "Data L", "OTE"];
function labelPop(d, r) { document.getElementById("lblpop")?.remove(); const el = document.createElement("div"); el.id = "lblpop"; el.className = "lblpop";
  const cur = d.type === "text" ? d.text || "" : d.label || "";
  el.innerHTML = `<div class="lp-h">Label</div><div class="lp-chips">${QUICK_LABELS.map((q) => `<button class="lp-c ${cur === q ? "on" : ""}" data-q="${esc(q)}">${esc(q)}</button>`).join("")}</div>
    <div class="lp-row"><input id="lp-in" maxlength="60" placeholder="Or type your own…" value="${esc(cur)}"><button class="primary" id="lp-ok">Set</button></div>${cur ? '<button class="lp-clr" id="lp-clr">Remove label</button>' : ""}`;
  document.body.appendChild(el); el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.left - 40)) + "px"; el.style.top = Math.min(innerHeight - el.offsetHeight - 8, r.bottom + 6) + "px";
  const set = (v) => { v = (v || "").trim().slice(0, 60); if (d.type === "text") { if (v) d.text = v; } else d.label = v; close(); repaintAll(); try { saveDrawings && saveDrawings(); } catch (e) {} };
  const close = () => { el.remove(); removeEventListener("pointerdown", out, true); }, out = (ev) => { if (!el.contains(ev.target)) close(); };
  setTimeout(() => addEventListener("pointerdown", out, true), 0);
  el.querySelectorAll(".lp-c").forEach((b) => (b.onclick = () => set(b.dataset.q))); $("lp-ok").onclick = () => set($("lp-in").value);
  $("lp-in").onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") set($("lp-in").value); if (e.key === "Escape") close(); }; if ($("lp-clr")) $("lp-clr").onclick = () => set("");
  setTimeout(() => $("lp-in") && $("lp-in").focus(), 30); }

/* KING_FIXBUBBLE (Nov 11, Brief 3): a small bubble bottom-right on every screen; tap → Fix / Idea card that goes into the same fix box as Friends → Suggest.
   Tips slide out next to it every few minutes (Settings → Feature tips, or "Don't show tips" on any tip turns them off). */
(() => { const w = document.createElement("div"); w.id = "fxb"; w.innerHTML = `<div id="fxb-tip" class="fxb-tip hidden"><span id="fxb-tt"></span><button id="fxb-tx" title="Hide">×</button><button id="fxb-toff" class="fxb-off">Don't show tips</button></div>
  <div id="fxb-card" class="fxb-card hidden"><div class="fxb-h"><b>Send to Claude</b><button id="fxb-x" title="Close">×</button></div><div class="seg fxb-seg"><button data-k="fix" class="on">🔧 Fix</button><button data-k="idea">💡 Idea</button></div>
  <textarea id="fxb-in" maxlength="1000" placeholder="What should change? Where is it, and what should it do?"></textarea><div class="fxb-f"><span class="tiny muted" id="fxb-where"></span><button class="primary" id="fxb-go">Send</button></div></div>
  <button id="fxb-b" class="fxb-b" title="Fix or idea → Claude"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 00-5.4 5.2L4 16.8V20h3.2l5.3-5.3a4 4 0 005.2-5.4l-2.5 2.5-2.3-.5-.5-2.3z"/></svg></button>`;
  document.body.appendChild(w); let kind = "fix", tipT = null, idx = Math.floor(Math.random() * KTIPS.length);
  const where = () => { const v = document.querySelector(".vtab.on[data-view]"); return v ? (v.title || v.dataset.view) : "app"; };
  const open = (on) => { $("fxb-card").classList.toggle("hidden", !on); $("fxb-tip").classList.add("hidden"); if (on) { $("fxb-where").textContent = "From: " + where(); setTimeout(() => $("fxb-in").focus(), 30); } };
  $("fxb-b").onclick = () => open($("fxb-card").classList.contains("hidden")); $("fxb-x").onclick = () => open(false);
  $("fxtop").onclick = () => open($("fxb-card").classList.contains("hidden"));   // KING_FIXTOP (Nov 12 walkthrough): the top-bar button opens the same card
  w.querySelectorAll(".fxb-seg button").forEach((b) => (b.onclick = () => { kind = b.dataset.k; w.querySelectorAll(".fxb-seg button").forEach((x) => x.classList.toggle("on", x === b)); }));
  $("fxb-in").onkeydown = (e) => e.stopPropagation();
  $("fxb-go").onclick = async () => { const t = $("fxb-in").value.trim(); if (t.length < 3) return toast("Add a few words first"); const body = `[${where()}] ${t}`;
    if (DEMO) (mem.sg = mem.sg || []).push({ id: "g" + Date.now(), user_id: "demo", body, kind, status: "new", votes: [], created_at: new Date().toISOString() });
    else { const { error } = await sb.from("suggestions").insert({ body, kind }); if (error) return toast(error.message); }
    $("fxb-in").value = ""; open(false); toast(kind === "fix" ? "🔧 Sent. Claude will look at it." : "💡 Idea sent."); try { renderSg(); } catch (e) {} };
  const tipsOn = () => prefs.tips !== false;
  const showTip = () => { if (!tipsOn() || !$("fxb-card").classList.contains("hidden") || document.hidden) return; idx = (idx + 1) % KTIPS.length; $("fxb-tt").textContent = KTIPS[idx]; const t = $("fxb-tip"); t.classList.remove("hidden"); clearTimeout(tipT); tipT = setTimeout(() => t.classList.add("hidden"), 12000); };
  $("fxb-tx").onclick = () => $("fxb-tip").classList.add("hidden"); $("fxb-toff").onclick = () => { prefs.tips = false; try { savePrefs(); } catch (e) {} $("fxb-tip").classList.add("hidden"); if ($("s-tips")) $("s-tips").checked = false; toast("Tips off. Turn them back on in Settings."); };
  setTimeout(showTip, 90 * 1000); setInterval(showTip, 5 * 60 * 1000); window.kTipNow = showTip; })();

$("s-tips") && ($("s-tips").onchange = () => { prefs.tips = $("s-tips").checked; savePrefs(); if (prefs.tips) window.kTipNow && kTipNow(); });

/* KING_RAIL (Nov 11, Brief 3): the left sidebar expands to show names (button at the bottom) and its edge drags to any width; the width is remembered per user */
(() => { const R = $("rail"); R.querySelectorAll(".ri").forEach((b) => { if (b.querySelector(".rl")) return; const t = (b.title || "").split(/[:(]/)[0].trim(); if (!t) return; const s = document.createElement("span"); s.className = "rl"; s.textContent = b.id === "railx" ? "Collapse" : t; b.appendChild(s); });
  const W = (w) => { w = Math.round(w); if (innerWidth <= 900) { R.style.width = ""; R.classList.remove("wide"); return; } R.style.width = w + "px"; R.classList.toggle("wide", w >= 120); $("railx").title = w >= 120 ? "Collapse the sidebar" : "Expand the sidebar (drag its edge to resize)"; };
  window.railUI = () => W(prefs.railW || 52);
  $("railx").onclick = () => { const cur = prefs.railW || 52; prefs.railW = cur >= 120 ? 52 : prefs.railWide || 200; savePrefs(); W(prefs.railW); };
  grip($("railgrip"), (e, st) => { if (st.w == null) { st.w = R.offsetWidth; R.style.transition = "none"; } let w = Math.max(52, Math.min(300, st.w + e.clientX - st.x)); if (w < 96) w = 52; prefs.railW = w; W(w); },
    () => { R.style.transition = ""; if (prefs.railW >= 120) prefs.railWide = prefs.railW; savePrefs(); }); railUI(); })();

/* KING_MEDIAWIN (Nov 11, Brief 3): the Spotify / YouTube / Reese window: drag it by its title bar, resize it from the corner (the video grows with it),
   a bigger see-through slider with a % readout, and a pop-out into its own window you can put on a side screen. Size and spot are remembered. */
function mediaLook() { const M = prefs.media || {}, m = $("media"), op = M.op || 100; m.style.opacity = M.pop ? 1 : op / 100; $("m-op").value = op; if ($("m-opv")) $("m-opv").textContent = op + "%";
  if (M.w && !M.big && !M.pop) { m.style.width = Math.min(M.w, innerWidth - 20) + "px"; m.style.height = M.h ? Math.min(M.h, innerHeight - 20) + "px" : ""; } else if (!M.pop) { m.style.width = ""; m.style.height = ""; }
  if (M.pop) { m.style.width = "100%"; m.style.height = "100%"; }
  fitVideo(); }
// KING_MEDIAFIT (Nov 12 walkthrough): a big window no longer cuts the video off at the bottom. The video keeps 16:9 and
// takes the biggest size that fits both the width and the height left under the title bar (same in the pop-out window).
function fitVideo() { const m = $("media"), M = prefs.media || {}, sized = !!(M.pop || (M.h && !M.big)); m.classList.toggle("sized", sized);
  const f = m.querySelector(".vfr"); if (!f) return; if (!sized) { f.style.maxWidth = ""; return; }
  const top = [...m.children].filter((c) => !c.classList.contains("mbody") && !c.classList.contains("mres")).reduce((a, c) => a + c.offsetHeight, 0), vh = m.querySelector(".mvid .vh");
  const avail = m.clientHeight - top - (vh ? vh.offsetHeight + 4 : 0) - 26; f.style.maxWidth = Math.max(200, Math.floor(avail * 16 / 9)) + "px"; }
grip($("mres"), (e, st) => { const m = $("media"); if (!st.r) st.r = m.getBoundingClientRect(); prefs.media.big = false; m.classList.remove("big");
  prefs.media.w = Math.max(300, Math.min(innerWidth - st.r.left - 8, st.r.width + e.clientX - st.x)); prefs.media.h = Math.max(220, Math.min(innerHeight - st.r.top - 8, st.r.height + e.clientY - st.y)); mediaLook(); }, () => savePrefs());
let mediaWin = null;
async function mediaPop() { const m = $("media"); if (mediaWin) { try { mediaWin.close(); } catch (e) {} return; }
  const w = Math.round(m.offsetWidth || 420), h = Math.round(m.offsetHeight || 560);
  try { if (window.documentPictureInPicture) mediaWin = await documentPictureInPicture.requestWindow({ width: w, height: h }); } catch (e) { mediaWin = null; }
  if (!mediaWin) { mediaWin = window.open("", "kairos-media", `popup=yes,width=${w},height=${h}`); if (!mediaWin) return toast("Pop-out was blocked by the browser"); mediaWin.document.title = "KAIROS · Media"; }
  const d = mediaWin.document; [...document.querySelectorAll('link[rel="stylesheet"], style')].forEach((n) => d.head.appendChild(n.cloneNode(true)));
  d.body.style.cssText = "margin:0;background:#0b0e14;overflow:hidden"; d.body.className = "mpop"; prefs.media.pop = true; m.classList.add("popped"); d.body.appendChild(m); mediaLook(); $("m-pop").title = "Put it back in KAIROS";
  const back = () => { if (!mediaWin) return; mediaWin = null; document.body.appendChild(m); m.classList.remove("popped"); prefs.media.pop = false; mediaLook(); mediaUI(); $("m-pop").title = "Pop out into its own window (drag it to a side screen)"; };
  mediaWin.addEventListener("pagehide", back); mediaWin.addEventListener("beforeunload", back); mediaWin.addEventListener("resize", fitVideo); }
$("m-pop").onclick = mediaPop;

/* KING_GRIDLINES (Nov 11, King's "grid in background toggle"): Chart settings → Canvas → Grid lines (None / Both / Vertical / Horizontal) + strength, like Tradesea's Canvas tab */
function gridOpts() { const g = (prefs && prefs.gridl) || "both", a = Math.max(0, Math.min(30, prefs && prefs.gridA != null ? prefs.gridA : 4)) / 100, c = _rgba(((prefs && prefs.cs && prefs.cs.gridc) || "#ffffff"), a);
  return { vertLines: { visible: g === "both" || g === "vert", color: c }, horzLines: { visible: g === "both" || g === "horz", color: c } }; }
function gridApply() { panes.forEach((p) => { try { p.chart.applyOptions({ grid: gridOpts() }); } catch (e) {} }); if ($("cs-grid")) { $("cs-grid").value = prefs.gridl || "both"; $("cs-grida").value = prefs.gridA != null ? prefs.gridA : 4; } }
$("cs-grid") && ($("cs-grid").onchange = () => { prefs.gridl = $("cs-grid").value; gridApply(); savePrefs(); });
$("cs-grida") && ($("cs-grida").oninput = () => { prefs.gridA = +$("cs-grida").value; gridApply(); }); $("cs-grida") && ($("cs-grida").onchange = savePrefs);

/* KING_RAILX (Nov 11, from King's Tradesea shots): magnet with Weak / Strong (flyout), lock all drawings, hide all drawings */
(() => { const m = $("magnet"), g = $("magg"); g.appendChild(m); m.classList.add("tgm");
  g.insertAdjacentHTML("beforeend", `<button class="tgx" data-g="mag" title="Magnet mode"><svg viewBox="0 0 6 6"><path d="M6 0v6H0z" fill="currentColor"/></svg></button><div class="tfly hidden" data-g="mag"><div class="tfh">Magnet</div>
    <button class="tool fi" data-mag="weak"><span class="ti">${m.innerHTML}</span><span class="tn">Weak magnet</span><kbd>near</kbd></button><button class="tool fi" data-mag="strong"><span class="ti">${m.innerHTML}</span><span class="tn">Strong magnet</span><kbd>always</kbd></button><button class="tool fi" data-mag="off"><span class="ti"></span><span class="tn">Off</span></button></div>`);
  window.magUI = () => { g.querySelectorAll("[data-mag]").forEach((b) => b.classList.toggle("on", prefs.magnet ? b.dataset.mag === (prefs.magMode || "weak") : b.dataset.mag === "off")); m.title = prefs.magnet ? `Magnet: ${prefs.magMode === "strong" ? "strong (always snaps)" : "weak (snaps when close)"}` : "Magnet: off";
    $("lockall").classList.toggle("on", !!(drawings.length && drawings.every((d) => d.locked))); $("hideall").classList.toggle("on", !!prefs.hideDraw); $("hideall").title = prefs.hideDraw ? "Show drawings" : "Hide all drawings"; };
  g.querySelectorAll("[data-mag]").forEach((b) => (b.onclick = () => { const k = b.dataset.mag; prefs.magnet = k !== "off"; if (k !== "off") prefs.magMode = k; m.classList.toggle("on", prefs.magnet); savePrefs(); magUI(); tgClose(); toast(k === "off" ? "Magnet off" : k === "strong" ? "Strong magnet" : "Weak magnet"); }));
  $("lockall").onclick = () => { const all = drawings.length && drawings.every((d) => d.locked); drawings.forEach((d) => (d.locked = !all)); repaintAll(); magUI(); toast(all ? "Drawings unlocked" : "All drawings locked"); };
  $("hideall").onclick = () => { prefs.hideDraw = !prefs.hideDraw; savePrefs(); repaintAll(); magUI(); toast(prefs.hideDraw ? "Drawings hidden" : "Drawings showing"); };
  const tm = toggleMagnet; window.toggleMagnet = function () { tm(); magUI(); }; m.onclick = () => window.toggleMagnet(); setTimeout(() => { try { magUI(); } catch (e) {} }, 0); })();

/* KING_AXISLBL + KING_ADDTEXT (Nov 11, from King's Tradesea shots): a selected drawing shows its prices as blue labels on the price axis; a selected line shows "+ Add text" along it (click it to label the line) */
function axisSync(p) { try { (p._axL || []).forEach((l) => p.series.removePriceLine(l)); } catch (e) {} p._axL = [];
  if (!p._ax) return; for (const v of p._ax) { try { p._axL.push(p.series.createPriceLine({ price: v, color: "#2962ff", lineVisible: false, axisLabelVisible: true, title: "", axisLabelColor: "#2962ff", axisLabelTextColor: "#fff" })); } catch (e) {} } }
document.addEventListener("pointerdown", (e) => { if (!sel || !sel._addAt || e.button !== 0) return; const pe = e.target.closest && e.target.closest(".pane"); if (!pe) return; const p = panes.find((q) => q.el === pe); if (!p || sel.pane !== p.i) return;
  const r = pe.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top; if (Math.hypot(x - sel._addAt[0], y - sel._addAt[1]) > 26) return;
  e.stopPropagation(); e.preventDefault(); labelPop(sel, { left: e.clientX - 20, bottom: e.clientY + 6 }); }, true);

/* KING_CSTABS (Nov 12, King's Tradesea shots): Chart settings as tabs on the left */
document.querySelectorAll(".csnav [data-cst]").forEach((b) => (b.onclick = () => { document.querySelectorAll(".csnav [data-cst]").forEach((x) => x.classList.toggle("on", x === b)); document.querySelectorAll(".csp [data-csp]").forEach((s) => s.classList.toggle("hidden", s.dataset.csp !== b.dataset.cst)); }));

/* KING_MFE (Nov 12, night ideas): the trade review shows how far price went for you (MFE) and against you (MAE) between entry and exit, in points and R.
   Only bars you already replayed are used, so it never spoils what comes next. */
function mfeStats(t) { try { const bars = B["1m"].bars, lo = t.t_entry - 60, hi = t.t_exit; let up = 0, dn = 0;
    for (let k = 0; k < bars.length; k++) { const b = bars[k]; if (b.t < lo) continue; if (b.t > hi) break; const fav = t.dir > 0 ? b.h - t.entry : t.entry - b.l, adv = t.dir > 0 ? t.entry - b.l : b.h - t.entry; up = Math.max(up, fav); dn = Math.max(dn, adv); }
    const risk = t.stop != null ? Math.abs(t.entry - t.stop) : null; return { mfe: up, mae: dn, risk }; } catch (e) { return null; } }
function mfeLine(t) { const m = mfeStats(t); if (!m) return ""; const R = (x) => (m.risk ? ` (${(x / m.risk).toFixed(1)}R)` : "");
  const left = t.exit != null ? Math.max(0, m.mfe - Math.abs(t.exit - t.entry) * (Math.sign((t.exit - t.entry) * t.dir) || 0)) : 0;
  return `<div class="mfe"><span title="Most it went your way between entry and exit">▲ ${m.mfe.toFixed(2)} pts${R(m.mfe)}</span><span title="Most it went against you">▼ ${m.mae.toFixed(2)} pts${R(m.mae)}</span>${left > 0.01 ? `<span title="How much of the best move you gave back">left ${left.toFixed(2)} pts</span>` : ""}</div>`; }

/* KING_SPEED (Nov 12, night ideas): speed run = 10 take-or-fade setups in 5 minutes, scored, best kept */
let SPD = null, spdT = null;
function speedBestUI() { const b = (prefs.quiz || {}).speedBest; if ($("qz-best")) $("qz-best").textContent = b ? `Best speed run: ${b.right}/10 in ${Math.floor(b.secs / 60)}:${String(b.secs % 60).padStart(2, "0")}` : ""; }
function speedTick() { if (!SPD) return; const left = Math.max(0, Math.round((SPD.end - Date.now()) / 1000)); $("qz-clock").textContent = `⚡ ${SPD.n}/10 · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`; if (!left) speedEnd(); }
function speedEnd() { if (!SPD) return; clearInterval(spdT); const secs = Math.round((Math.min(Date.now(), SPD.end) - SPD.t0) / 1000), r = SPD.right; SPD = null; $("qz-clock").classList.add("hidden");
  const q = prefs.quiz || (prefs.quiz = { n: 0, right: 0, streak: 0, best: 0 }), b = q.speedBest; const better = !b || r > b.right || (r === b.right && secs < b.secs); if (better) q.speedBest = { right: r, secs }; savePrefs(); speedBestUI();
  quizStop(); view("learn"); toast(`⚡ Speed run: ${r}/10 right in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}${better ? " · new best!" : ""}`); if (better && r >= 7) addXp(20); }
$("qz-speed") && ($("qz-speed").onclick = async () => { SPD = { n: 0, right: 0, t0: Date.now(), end: Date.now() + 5 * 60 * 1000 }; $("qz-clock").classList.remove("hidden"); clearInterval(spdT); spdT = setInterval(speedTick, 500); speedTick(); await quizNext(); });
(() => { const qa = quizAnswer; window.quizAnswer = quizAnswer = async function (take) { const it = QZ && QZ.it; await qa(take); if (!SPD || !it) return; SPD.n++; if ((it.outcome === "win") === take) SPD.right++; speedTick(); if (SPD.n >= 10) return setTimeout(speedEnd, 900); setTimeout(() => SPD && quizNext(), 1100); }; })();
setTimeout(() => { try { speedBestUI(); } catch (e) {} }, 0);

/* KING_APLUS (Nov 12, night ideas): A+ only mode — with it on, a new trade is blocked until a strategy is picked and every one of its rules is ticked */
function aplusOk() { const s = curStrat(); if (!s) { toast("🅰️ A+ only: pick a strategy in the Checklist first"); if (!prefs.chkShow) { prefs.chkShow = true; chkUI(); } return false; }
  const miss = s.rules.filter((_, i) => !chk.has(i)); if (miss.length) { toast(`🅰️ A+ only: ${miss.length} rule${miss.length > 1 ? "s" : ""} not ticked (${miss.slice(0, 2).join(", ")}${miss.length > 2 ? "…" : ""})`); if (!prefs.chkShow) { prefs.chkShow = true; chkUI(); } return false; } return true; }
document.addEventListener("change", (e) => { if (e.target && e.target.id === "chk-ap") { prefs.aplus = e.target.checked; savePrefs(); toast(prefs.aplus ? "🅰️ A+ only is on: tick every rule before you enter" : "A+ only is off"); } });

/* KING_LFSIM (Nov 12, night ideas): runs your trades in the order you took them through a LucidFlex eval's rules
   (end-of-day trailing drawdown that locks at the starting balance, profit target, 50% consistency) and says the day you'd have passed or failed. */
function lfSim(tr, plan) { const [nm, start, R] = LUCID[plan]; const days = {}; for (const t of tr) { const d = sessDay(t.t_exit); days[d] = (days[d] || 0) + (+t.pnl || 0); }
  const order = Object.keys(days).sort(); let bal = start, peak = start, floor = start - R.mdd, best = 0, n = 0;
  for (const d of order) { n++; bal += days[d]; best = Math.max(best, days[d]); if (bal <= floor) return { nm, out: "fail", day: d, n, bal, why: `balance ${money(bal - start)} hit the drawdown line` };
    peak = Math.max(peak, bal); floor = Math.min(start, peak - R.mdd);   // EOD trailing, stops trailing at the starting balance
    const prof = bal - start; if (prof >= R.ptg) { const share = best / prof; if (!R.cons || share <= R.cons / 100) return { nm, out: "pass", day: d, n, bal, why: `hit ${money(prof)} with the biggest day ${Math.round(share * 100)}% of profit` };
      return { nm, out: "cons", day: d, n, bal, why: `hit the target but the biggest day is ${Math.round(share * 100)}% of profit (needs ${R.cons}% or less): keep trading smaller days` }; } }
  return { nm, out: "open", day: order[order.length - 1], n, bal, why: `still going: ${money(bal - start)} of ${money(R.ptg)}, drawdown line ${money(floor - start)}` }; }
function lfUI(tr) { const el = $("st-lf"); if (!el) return; const plan = prefs.lfPlan || "lf50";
  const sel = `<select id="lf-plan">${Object.entries(LUCID).map(([k, v]) => `<option value="${k}" ${k === plan ? "selected" : ""}>${v[0]}</option>`).join("")}</select>`;
  if (!tr.length) { el.innerHTML = `<div class="mcin">${sel}</div><div class="small muted">No trades in this filter yet.</div>`; } else {
    const r = lfSim(tr.slice().sort((a, b) => a.t_exit - b.t_exit), plan), col = r.out === "pass" ? "pos-up" : r.out === "fail" ? "pos-dn" : "";
    el.innerHTML = `<div class="mcin">${sel}</div><div class="lfres"><b class="${col}">${{ pass: "✅ Passed", fail: "❌ Failed", cons: "⚠️ Consistency", open: "⏳ Not done yet" }[r.out]}</b> on trading day ${r.n} (${r.day})</div><div class="small">${esc(r.why)}</div><div class="tiny muted">Uses the eval rules built into KAIROS (end-of-day trailing drawdown that stops at your starting balance, target, consistency). Replay results, not a promise.</div>`; }
  $("lf-plan").onchange = () => { prefs.lfPlan = $("lf-plan").value; savePrefs(); lfUI(tr); }; }

/* KING_PLAYLIST (Nov 12, night ideas): queue 10 sessions by filter and step through them with Next */
function plDays(kind, n = 10) { const a = Date.UTC(2021, 1, 1), z = Date.UTC(2026, 9, 30), out = new Set(); let guard = 0;
  while (out.size < n && guard++ < 20000) { const d = new Date(a + Math.random() * (z - a)), wd = d.getUTCDay(), s = d.toISOString().slice(0, 10);
    if (wd < 1 || wd > 5 || (d.getUTCMonth() === 11 && d.getUTCDate() >= 24) || (d.getUTCMonth() === 0 && d.getUTCDate() <= 2)) continue;
    if (kind === "news" && !econOn(s).length) continue; if (kind === "mon" && wd !== 1) continue; if (kind === "fri" && wd !== 5) continue; out.add(s); }
  return [...out].sort(); }
function plUI() { const P = prefs.pl, el = $("plpill"); if (!el) return; if (!P || !P.days || !P.days.length) { el.classList.add("hidden"); return; }
  el.classList.remove("hidden"); el.title = P.name + " playlist"; el.innerHTML = `${P.i + 1}/${P.days.length}<button class="pb" id="pl-next" title="Next session" ${P.i + 1 >= P.days.length ? "disabled" : ""}>▶</button><button class="pb" id="pl-x" title="End playlist">×</button>`;
  $("pl-next").onclick = () => plGo(P.i + 1); $("pl-x").onclick = () => { prefs.pl = null; savePrefs(); plUI(); }; }
async function plGo(i) { const P = prefs.pl; if (!P || i >= P.days.length) return; if (pos.qty || orders.length) return toast("Close positions and cancel orders first"); P.i = i; savePrefs(); plUI();
  $("start").value = P.days[i] + "T08:30"; await loadReplay(); toast(`▤ ${P.name}: session ${i + 1} of ${P.days.length}`); }
$("plbtn") && ($("plbtn").onclick = (e) => { const r = e.target.getBoundingClientRect(), mk = (name, kind) => ({ t: name, f: () => { prefs.pl = { name, days: plDays(kind), i: 0 }; savePrefs(); plGo(0); } });
  menu([{ h: "Session playlist (10 days)" }, mk("Random days", "any"), mk("News days (CPI, jobs, FOMC)", "news"), mk("Mondays", "mon"), mk("Fridays", "fri"), prefs.pl ? "-" : null, prefs.pl ? { t: "End playlist", f: () => { prefs.pl = null; savePrefs(); plUI(); } } : null].filter(Boolean), r.left, r.bottom + 4); });
setTimeout(() => { try { plUI(); } catch (e) {} }, 0);
// KING_IPHONE: the Trade view is the start view, so the replay controls show before any tab is tapped
if (![...document.body.classList].some((c) => c.startsWith("v-"))) document.body.classList.add("v-trade");

// KING_A11Y (Nov 12): Esc closes Chart settings too
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("chartset").classList.contains("hidden")) $("chartset").classList.add("hidden"); });

addEventListener("resize", () => { try { fitVideo(); } catch (e) {} });

/* KING_CS2 (Nov 12 walkthrough): Chart settings with everything from King's Tradesea screenshots: Symbol, Status line, Scales and lines,
   Canvas, Trading (+ Multi-chart). Every change previews live; Ok saves, Cancel puts it back, Apply to all keeps it open, Template saves named sets.
   Not carried over (no such thing in KAIROS): navigation / pane buttons, scale modes A and L, lock price to bar ratio, left price scale. */
function _rgba(hex, a) { const m = /^#([0-9a-f]{6})$/i.exec(hex || ""); if (!m) return hex; const n = parseInt(m[1], 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"], DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function csDate(d, C) { const y = d.getUTCFullYear(), m = d.getUTCMonth(), n = d.getUTCDate(), yy = String(y).slice(2);
  return C.df === "iso" ? `${y}-${String(m + 1).padStart(2, "0")}-${String(n).padStart(2, "0")}` : C.df === "us" ? `${String(m + 1).padStart(2, "0")}/${String(n).padStart(2, "0")}/${yy}` : (C.df === "tv" ? DOW[d.getUTCDay()] + " " : "") + `${n} ${MON[m]} '${yy}`; }
function csClock(d, C, sec) { let h = d.getUTCHours(); const mm = String(d.getUTCMinutes()).padStart(2, "0"), ss = sec && d.getUTCSeconds() ? ":" + String(d.getUTCSeconds()).padStart(2, "0") : "";
  if (C.hf === "12") { const ap = h >= 12 ? " PM" : " AM"; h = h % 12 || 12; return `${h}:${mm}${ss}${ap}`; } return `${String(h).padStart(2, "0")}:${mm}${ss}`; }
function csHover(t) { const C = csG(), d = new Date(t * 1000); return csDate(d, Object.assign({}, C, { df: C.df === "tv" ? "tv" : C.df })) + "  " + csClock(d, C, true); }
function csTick(t, k) { const C = csG(), d = new Date(t * 1000); if (k === 0) return String(d.getUTCFullYear()); if (k === 1) return MON[d.getUTCMonth()];
  if (k === 2) return (C.dow ? DOW[d.getUTCDay()] + " " : "") + d.getUTCDate(); return csClock(d, C, k === 4); }
function csApply(p) { if (!p || p.dead) return; const C = csG(), up = prefs.up, dn = prefs.dn, clear = "rgba(0,0,0,0)";
  try { p.series.applyOptions({ upColor: C.body ? up : clear, downColor: C.body ? dn : clear, borderVisible: !!C.bord, borderUpColor: C.bu || up, borderDownColor: C.bd || dn, wickVisible: !!C.wick, wickUpColor: C.wu || up, wickDownColor: C.wd || dn,
      priceFormat: { type: "price", precision: C.prec === "0.01" ? 2 : C.prec === "1" ? 0 : 2, minMove: C.prec === "def" ? TICK : +C.prec }, lastValueVisible: C.last === "vl" || C.last === "v", priceLineVisible: C.last === "vl" || C.last === "l" });
    const bg = C.bgk === "solid" ? { type: "solid", color: C.bg1 } : C.bgk === "grad" ? { type: "gradient", topColor: C.bg1, bottomColor: C.bg2 } : { type: "solid", color: "transparent" }, xc = _rgba(C.xc, 0.35);
    p.chart.applyOptions({ layout: { background: bg, textColor: C.txc, fontSize: +C.txs }, grid: gridOpts(), rightPriceScale: { borderColor: C.lnc, scaleMargins: { top: (+C.mt || 0) / 100, bottom: (+C.mb || 0) / 100 } }, timeScale: { borderColor: C.lnc, tickMarkFormatter: blind ? undefined : csTick },
      localization: blind ? {} : { timeFormatter: csHover }, crosshair: { vertLine: { color: xc, style: +C.xs }, horzLine: { color: xc, style: +C.xs } } });
  } catch (e) {}
  const L = p.el.querySelector(".legend"), nm = p.el.querySelector(".lname"), s = paneSym(p), tf = prefs.tfs[p.i] || "5m";
  nm.style.display = C.title ? "" : "none"; nm.textContent = C.titleK === "t" ? s : C.titleK === "ti" ? `${s} · ${tf}` : `${s} · ${tf} · CME`; L.querySelector("i").style.display = C.mstat ? "" : "none";
  p.el.querySelector(".ohlc").style.display = C.vals ? "" : "none"; L.style.background = C.lbg ? `rgba(10,13,19,${(+C.lbga || 0) / 100})` : ""; L.style.padding = C.lbg ? "3px 8px" : ""; L.style.borderRadius = C.lbg ? "8px" : "";
  if (!L.querySelector(".cdn")) L.insertAdjacentHTML("beforeend", '<span class="cdn"></span>'); p.el.querySelector(".wmark").style.display = C.wm ? "" : "none";
  if (C.prevClr) rebuildPane(p); csLines(p); paint(p); }
function csApplyAll() { panes.forEach(csApply); const C = csG(); if ($("prev2")) $("prev2").style.display = C.rev ? "" : "none"; try { drawOrders(); } catch (e) {} }
// previous day close, visible high / low, bid / ask lines + the bar countdown (cheap: existing lines are moved, not rebuilt)
function csLines(p) { if (!p || p.dead || !p.candles.length) return; const C = csG(); p.csl = p.csl || {};
  const set = (k, on, price, color, title) => { const L = p.csl[k]; if (!on || price == null || !isFinite(price)) { if (L) { try { p.series.removePriceLine(L); } catch (e) {} delete p.csl[k]; } return; }
    if (L) { L.applyOptions({ price, color, title }); return; } p.csl[k] = p.series.createPriceLine({ price, color, title, lineWidth: 1, lineStyle: 2, axisLabelVisible: true }); };
  const last = p.candles[p.candles.length - 1], start = Math.floor((last.time - 18 * 3600) / 86400) * 86400 + 18 * 3600; let pc = null; for (let k = p.candles.length - 1; k >= 0; k--) if (p.candles[k].time < start) { pc = p.candles[k].close; break; }
  set("pdc", C.pdc === "l", pc, C.pdcc, "Prev close");
  let hi = null, lo = null; if (C.hl === "l") { const vr = p.chart.timeScale().getVisibleLogicalRange(); if (vr) for (let k = Math.max(0, Math.floor(vr.from)); k <= Math.min(p.candles.length - 1, Math.ceil(vr.to)); k++) { const c = p.candles[k]; hi = hi == null ? c.high : Math.max(hi, c.high); lo = lo == null ? c.low : Math.min(lo, c.low); } }
  set("hi", C.hl === "l", hi, C.hlc, "High"); set("lo", C.hl === "l", lo, C.hlc, "Low");
  set("bid", C.ba === "l", last.close, C.bidc, "Bid"); set("ask", C.ba === "l", last.close + TICK, C.askc, "Ask");
  const cd = p.el.querySelector(".cdn"); if (cd) { if (C.cd && p.sec >= 60 && B["1m"].bars.length) { const now = loc(nowT()), left = p.sec - (((now - (p.sec >= 14400 ? 18 * 3600 : 0)) % p.sec) + p.sec) % p.sec, h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sx = left % 60;
      cd.textContent = (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(sx).padStart(2, "0"); } else cd.textContent = ""; }
  if (C.chg) { const o = p.el.querySelector(".ohlc"); if (o && !o.innerHTML && p.candles.length > 1) { const pv = p.candles[p.candles.length - 2].close, ch = last.close - pv; o.innerHTML = `<b class="${ch >= 0 ? "pos-up" : "pos-dn"}">${ch >= 0 ? "+" : ""}${px2(ch)} (${((ch / pv) * 100).toFixed(2)}%)</b>`; } }
  csMarks(p); }
function csMarks(p) { const C = csG(); if (!C.exm) { if (p._mk) { p.series.setMarkers([]); p._mk = 0; } return; } const s = paneSym(p), mk = execs.filter((x) => x.sym === s).map((x) => ({ time: bucket(loc(x.t), p.sec), position: x.side > 0 ? "belowBar" : "aboveBar", color: x.side > 0 ? "#2bd4a0" : "#ff6b7a", shape: x.side > 0 ? "arrowUp" : "arrowDown", text: C.exl ? `${x.side > 0 ? "B" : "S"} ${x.qty} @ ${px2(x.price)}` : "" }))
  .filter((m) => p.candles.length && m.time <= p.candles[p.candles.length - 1].time).sort((a, b) => a.time - b.time); const key = mk.length + "|" + C.exl + "|" + p.sec; if (p._mkk === key) return; p._mkk = key; p._mk = mk.length; try { p.series.setMarkers(mk); } catch (e) {} }
// the settings window
const CSF = { "cs-prevclr": "prevClr", "cs-body": "body", "cs-bord": "bord", "cs-bu": "bu", "cs-bd": "bd", "cs-wick": "wick", "cs-wu": "wu", "cs-wd": "wd", "cs-prec": "prec", "cs-title": "title", "cs-titlek": "titleK", "cs-mstat": "mstat", "cs-vals": "vals", "cs-chg": "chg", "cs-lbg": "lbg", "cs-lbga": "lbga",
  "cs-cd": "cd", "cs-last": "last", "cs-pdc": "pdc", "cs-pdcc": "pdcc", "cs-hl": "hl", "cs-hlc": "hlc", "cs-ba": "ba", "cs-bidc": "bidc", "cs-askc": "askc", "cs-dow": "dow", "cs-df": "df", "cs-hf": "hf", "cs-keepl": "keepC",
  "cs-bgk": "bgk", "cs-bg1": "bg1", "cs-bg2": "bg2", "cs-gridc": "gridc", "cs-brk": "brk", "cs-brkc": "brkc", "cs-xc": "xc", "cs-xs": "xs", "cs-wm": "wm", "cs-txc": "txc", "cs-txs": "txs", "cs-lnc": "lnc", "cs-mt": "mt", "cs-mb": "mb", "cs-mr": "mr",
  "cs-oneclick": "oneClick", "cs-pos": "pos", "cs-rev": "rev", "cs-pnl": "pnl", "cs-pnlp": "pnlp", "cs-pnlb": "pnlb", "cs-exm": "exm", "cs-exl": "exl", "cs-ext": "ext" };
function csFill() { const C = csG(); for (const [id, k] of Object.entries(CSF)) { const el = $(id); if (!el) continue; if (el.type === "checkbox") el.checked = !!C[k]; else el.value = C[k] === "" && el.type === "color" ? (k[1] === "u" ? prefs.up : prefs.dn) : C[k]; }
  const T = prefs.csT || {}; $("cs-tpl").innerHTML = '<option value="">Template</option>' + Object.keys(T).map((n) => `<option value="t:${esc(n)}">${esc(n)}</option>`).join("") + '<option value="__save">Save as template…</option><option value="__def">Reset to default</option>'; }
function csRead() { const o = {}; for (const [id, k] of Object.entries(CSF)) { const el = $(id); if (!el) continue; o[k] = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? +el.value : el.value; } return o; }
$("chartset").addEventListener("input", (e) => { if (!CSF[e.target.id] && !["s-up", "s-dn"].includes(e.target.id)) return; csTmp = csRead(); if (e.target.id === "s-up") prefs.up = e.target.value; if (e.target.id === "s-dn") prefs.dn = e.target.value; csApplyAll(); });
$("chartset").addEventListener("change", (e) => { if (CSF[e.target.id]) { csTmp = csRead(); csApplyAll(); } });
$("chartsetbtn").addEventListener("click", () => { csSnap = { cs: JSON.parse(JSON.stringify(prefs.cs || {})), up: prefs.up, dn: prefs.dn }; csTmp = null; csFill(); });
const csCommit = () => { prefs.cs = Object.assign({}, prefs.cs || {}, csRead()); csTmp = null; savePrefs(); csApplyAll(); };
$("cs-save").addEventListener("click", csCommit, true); $("cs-all").onclick = () => { csCommit(); toast("Applied to all charts"); };
$("cs-cancel").onclick = () => { if (csSnap) { prefs.cs = csSnap.cs; prefs.up = csSnap.up; prefs.dn = csSnap.dn; } csTmp = null; csApplyAll(); $("chartset").classList.add("hidden"); };
$("cs-tpl").onchange = () => { const v = $("cs-tpl").value; $("cs-tpl").value = "";
  if (v === "__save") { const n = (prompt("Template name") || "").trim().slice(0, 30); if (!n) return; prefs.csT = Object.assign({}, prefs.csT || {}, { [n]: Object.assign(csRead(), { up: $("s-up").value, dn: $("s-dn").value }) }); savePrefs(); csFill(); toast("Template saved"); return; }
  const src = v === "__def" ? Object.assign({}, CS_DEF, { up: "#2bd4a0", dn: "#ff6b7a" }) : v.startsWith("t:") ? (prefs.csT || {})[v.slice(2)] : null; if (!src) return;
  csTmp = Object.assign({}, src); if (src.up) { prefs.up = src.up; prefs.dn = src.dn; $("s-up").value = src.up; $("s-dn").value = src.dn; } const keep = prefs.cs; prefs.cs = csTmp; csFill(); prefs.cs = keep; csApplyAll(); };
// KING_SETPAGE: the group nav highlights the group you're looking at
(() => { const v = $("v-settings"), nav = v && v.querySelector(".setnav"); if (!nav) return;
  nav.addEventListener("click", (e) => { const a = e.target.closest("a[data-sg]"); if (!a) return; e.preventDefault(); $("sg-" + a.dataset.sg).scrollIntoView({ behavior: "smooth", block: "start" }); });
  const mark = () => { let cur = "you"; if (v.classList.contains("hidden") || !v.offsetHeight) return nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.sg === "you")); v.querySelectorAll(".setg").forEach((g) => { if (g.getBoundingClientRect().top < 140) cur = g.id.slice(3); }); nav.querySelectorAll("a").forEach((a) => a.classList.toggle("on", a.dataset.sg === cur)); };
  v.addEventListener("scroll", mark, { passive: true }); mark(); })();

/* KING_NAMEFX + KING_PROFILE (Nov 12 walkthrough): welcome uses the real name, then a quick profile setup (display name + @username).
   Names with keywords get effects everywhere names show (chat, live, leaderboard, shares). King can also give a name any effect by hand
   (Admin → Usernames & effects); that's stored in profiles.name_fx and only an admin can change it (staged SQL 2026-11-12_usernames.sql). */
const NAME_FX = [["fart", "fart", "💨"], ["poop", "poop", "💩"], ["poo", "poop", "💩"], ["juicy", "juicy", "🍑"], ["goat", "goat", "🐐"], ["king", "king", "👑"], ["sigma", "sigma", ""], ["moon", "moon", "🌙"], ["degen", "degen", "🎰"], ["money", "money", "💸"], ["cash", "money", "💸"], ["sauce", "juicy", "🔥"], ["drip", "juicy", "💧"], ["toot", "fart", "💨"]];
function fxFor(name, uid) { const P = profs[uid] || (me && uid === me.user_id ? me : null), set = P && P.name_fx; if (set === "none") return null; if (set) { const f = NAME_FX.find((x) => x[1] === set); return [set, f ? f[2] : ""]; }
  const hay = ((name || "") + " " + ((P && P.username) || "")).toLowerCase(), f = NAME_FX.find(([k]) => hay.includes(k)); return f ? [f[1], f[2]] : null; }
function nmFx(name, uid) { const n = esc(name || "trader"), f = fxFor(name, uid); return f ? `<span class="nfx nfx-${f[0]}" data-e="${f[1]}">${n}</span>` : n; }
function who(uid, fb) { return nmFx(names[uid] || fb, uid); }
function profileSetup(force) { if (document.getElementById("psetup")) return; if (!force && (DEMO || !me || me.username)) return; const el = document.createElement("div"); el.id = "psetup"; el.className = "dlgwrap";
  const nm0 = (me && me.name) || ""; el.innerHTML = `<div class="glass dlg pop psbox"><h3>Set up your profile</h3><p class="small muted">This is what friends see in chat, Live and the leaderboard.</p>
    <label>Display name<input id="ps-n" maxlength="24" value="${esc(nm0.charAt(0).toUpperCase() + nm0.slice(1))}"></label>
    <label>Username<div class="psu"><span>@</span><input id="ps-u" maxlength="16" placeholder="3-16 letters, numbers or _" value="${esc((me && me.username) || "")}"></div></label>
    <div class="psprev"><span class="tiny muted">Preview</span><b id="ps-pv"></b></div><div id="ps-msg" class="tiny"></div>
    <div class="row" style="margin-top:12px"><button id="ps-later" class="ghost">Later</button><button id="ps-ok" class="primary">Save</button></div></div>`;
  document.body.appendChild(el);
  const pv = () => { const n = $("ps-n").value.trim() || "You", u = $("ps-u").value.trim().toLowerCase(); profs.__pv = { username: u }; $("ps-pv").innerHTML = nmFx(n, "__pv") + (u ? ` <span class="muted small">@${esc(u)}</span>` : ""); };
  ["ps-n", "ps-u"].forEach((id) => { $(id).oninput = pv; $(id).onkeydown = (e) => e.stopPropagation(); }); pv();
  $("ps-later").onclick = () => { prefs.psLater = Date.now(); savePrefs(); el.remove(); };
  $("ps-ok").onclick = async () => { const n = $("ps-n").value.trim().slice(0, 24), u = $("ps-u").value.trim().toLowerCase(); if (!n) return ($("ps-msg").textContent = "Add a display name");
    if (!/^[a-z0-9_]{3,16}$/.test(u)) return ($("ps-msg").textContent = "Username: 3-16 letters, numbers or _");
    if (!DEMO && me) { const { error } = await sb.from("profiles").update({ name: n, username: u }).eq("user_id", me.user_id); try { localStorage.setItem("kz-name", String(n)); } catch (e) {} if (error) return ($("ps-msg").textContent = /duplicate|unique/i.test(error.message) ? "That username is taken" : /column/i.test(error.message) ? "Usernames turn on after the next update" : "Couldn't save: " + error.message); }
    if (me) { me.name = n; me.username = u; names[me.user_id] = n; profs[me.user_id] = me; } if ($("s-name")) $("s-name").value = n; el.remove(); toast("Profile saved"); }; }
$("s-prof") && ($("s-prof").onclick = () => profileSetup(true));
async function adFx() { const box = $("ad-fx"); if (!box || DEMO || !isAdmin) return; const { data } = await sb.from("profiles").select("*"); const opts = ["", "none", ...new Set(NAME_FX.map((x) => x[1]))];
  box.innerHTML = (data || []).map((p) => `<div class="row"><span style="flex:3">${nmFx(p.name, p.user_id)} <span class="muted">${p.username ? "@" + esc(p.username) : "(no username yet)"}</span></span><select data-fx="${p.user_id}" style="flex:2">${opts.map((o) => `<option value="${o}" ${(p.name_fx || "") === o ? "selected" : ""}>${o === "" ? "Auto (keywords)" : o === "none" ? "No effect" : o}</option>`).join("")}</select></div>`).join("") || "No profiles yet";
  box.querySelectorAll("[data-fx]").forEach((s) => (s.onchange = async () => { const { error } = await sb.from("profiles").update({ name_fx: s.value || null }).eq("user_id", s.dataset.fx); toast(error ? "Couldn't save: " + error.message : "Effect saved"); if (!error && profs[s.dataset.fx]) profs[s.dataset.fx].name_fx = s.value || null; })); }
document.addEventListener("click", (e) => { if (e.target.closest('[data-view="admin"]')) setTimeout(adFx, 300); });

/* KING_GETAPP (Nov 12): "Get the app" on the sign-in card and in Settings → App. Picks the right way for the device:
   Windows → the latest installer from GitHub Releases; iPhone → Share → Add to Home Screen; Android / desktop Chrome → install prompt. */
let _bip = null; addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); _bip = e; });
async function latestExe() { try { const r = await fetch("https://api.github.com/repos/meyerjos004/rewind/releases/latest", { cache: "no-store" }); const j = await r.json(); const a = (j.assets || []).find((x) => /\.exe$/i.test(x.name)); if (a) return { url: a.browser_download_url, ver: j.tag_name }; } catch (e) {} return { url: "https://github.com/meyerjos004/rewind/releases/latest", ver: "" }; }
async function getApp() { const ua = navigator.userAgent, ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1), android = /Android/.test(ua), win = /Windows/.test(ua);
  const stand = matchMedia("(display-mode: standalone)").matches || navigator.standalone; const ex = win ? await latestExe() : null;
  const step = (n, t) => `<div class="gstep"><b>${n}</b><span>${t}</span></div>`;
  const ios_ = `<h4>iPhone / iPad</h4>${step(1, "Open this page in <b>Safari</b>")}${step(2, "Tap <b>Share</b> (the square with the arrow)")}${step(3, "Tap <b>Add to Home Screen</b> → Add")}`;
  const and_ = `<h4>Android</h4>${_bip ? '<button class="primary" id="ga-pwa">Install KAIROS</button>' : step(1, "Chrome menu <b>⋮</b> → <b>Install app</b> (or Add to Home screen)")}`;
  const win_ = `<h4>Windows</h4><a class="primary gdl" href="${ex ? ex.url : "https://github.com/meyerjos004/rewind/releases/latest"}">Download KAIROS for Windows${ex && ex.ver ? " (" + esc(ex.ver) + ")" : ""}</a><div class="tiny muted">Run the installer. If Windows says "protected your PC": More info → Run anyway. It updates itself.</div>`;
  const pc_ = `<h4>Mac / other computers</h4>${_bip ? '<button class="primary" id="ga-pwa">Install KAIROS</button>' : step(1, "Chrome or Edge: the install icon in the address bar")}`;
  dlg(`<h3>Get the app</h3>${stand ? `<p class="small muted">You're already using the installed app ✓</p>` : ""}${ios ? ios_ : android ? and_ : win ? win_ + `<details class="gmore"><summary>Phone</summary>${ios_}${and_}</details>` : pc_ + `<details class="gmore"><summary>Phone / Windows</summary>${ios_}${and_}${win_}</details>`}
    <p class="tiny muted" style="margin-top:10px">Link for friends: <b>meyerjos004.github.io/rewind/go</b> (everyone signs in and lands in their own KAIROS)</p>`, () => {});
  setTimeout(() => { const ok = $("dl-ok"); if (ok) ok.textContent = "Done"; const x = $("dl-x"); if (x) x.style.display = "none"; const b = $("ga-pwa"); if (b) b.onclick = async () => { _bip.prompt(); await _bip.userChoice; _bip = null; }; }, 0); }
$("a-get") && ($("a-get").onclick = getApp); $("s-get") && ($("s-get").onclick = getApp);
if (new URLSearchParams(location.search).has("get")) setTimeout(getApp, 1200);

/* KING_CSGRID (Nov 12, Will's fix, King: "a grid of colors, not presets"): every color in Chart settings opens the same color grid as the
   drawing pencil (grays + 10 hues x 6 shades + My colors + custom picker). The hidden color input underneath still carries the value. */
function csSwatches() { document.querySelectorAll("#chartset input.csc").forEach((inp) => { if (inp._sw) return; const b = document.createElement("button"); b.type = "button"; b.className = "cssw"; b.title = "Pick a color";
    inp.after(b); inp._sw = b; inp.classList.add("csc-h"); const sync = () => { b.style.background = inp.value; }; sync(); inp.addEventListener("input", sync); inp.addEventListener("change", sync); inp._sync = sync;
    b.onclick = (e) => { e.stopPropagation(); csColPop(inp, b); }; }); document.querySelectorAll("#chartset input.csc").forEach((i) => i._sync && i._sync()); }
function csColPop(inp, btn) { document.getElementById("cspop")?.remove(); const el = document.createElement("div"); el.id = "cspop"; el.className = "cspop dtb"; el.innerHTML = `<div class="dcols">${colGrid(inp.value)}</div>`; document.body.appendChild(el);
  const r = btn.getBoundingClientRect(); el.style.left = Math.max(8, Math.min(innerWidth - el.offsetWidth - 8, r.left - 10)) + "px"; el.style.top = (r.bottom + el.offsetHeight + 8 > innerHeight ? r.top - el.offsetHeight - 6 : r.bottom + 6) + "px";
  const set = (v) => { inp.value = v; inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); };
  el.addEventListener("click", (e) => { const c = e.target.closest("[data-c]"); if (!c) return; set(c.dataset.c); close(); });
  el.addEventListener("change", (e) => { if (e.target.id !== "cpick") return; const v = e.target.value; prefs.myCols = [v, ...(prefs.myCols || []).filter((x) => x !== v)].slice(0, 10); savePrefs(); set(v); close(); });
  el.addEventListener("contextmenu", (e) => { const b = e.target.closest("[data-my]"); if (!b) return; e.preventDefault(); prefs.myCols = (prefs.myCols || []).filter((x) => x !== b.dataset.c); savePrefs(); close(); csColPop(inp, btn); });
  const close = () => { el.remove(); removeEventListener("pointerdown", out, true); }, out = (e) => { if (!el.contains(e.target) && e.target !== btn) close(); }; setTimeout(() => addEventListener("pointerdown", out, true), 0); }
$("chartsetbtn").addEventListener("click", () => setTimeout(csSwatches, 0)); csSwatches();
