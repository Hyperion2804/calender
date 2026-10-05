import { ORG_DOMAIN, firebaseConfig, OFFICE } from "./config.js";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, addDoc, updateDoc,
  deleteDoc, query, where, serverTimestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/* ============================================================
   Hyperion Calendar
   Same Firebase project as Meeting Ledger. Reads (never writes)
   Meeting Ledger's users, meetings, weeklyPlans and travelPlans.
   Writes only its own collections: calEvents (busy / leave / out of
   office / WFH) and dayTasks (a Superadmin's private tasks — the old
   Meeting Ledger day planner). Office timings are one firm-wide schedule
   (OFFICE in config.js) plus the holidays list (managed here).
   Dates are always stored and compared as YYYY-MM-DD and times as
   24-hour HH:MM; DD-MM-YYYY is display only.
   ============================================================ */

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);   // getElementById only — not a CSS selector

const state = {
  user: null, profile: null,
  people: [],            // active Admins + Superadmins: { email, name, role }
  holidays: new Map(),   // "YYYY-MM-DD" -> name, managed in the Holidays view
  events: [],            // calEvents
  plans: [],             // Meeting Ledger weeklyPlans (meetings scheduled)
  travel: [],            // Meeting Ledger travelPlans
  meetings: [],          // Meeting Ledger meetings, for the loaded weeks
  loadedWeeks: new Set(),
  tasks: [],             // own dayTasks (Superadmin only)
  view: "week", anchor: "", person: "", holYear: new Date().getFullYear()
};

/* ============================ small helpers ============================ */
const pad = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const todayISO = () => isoOf(new Date());
const localDate = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d); };
const addDaysISO = (iso, n) => { const d = localDate(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const weekStartOf = (iso) => { const d = localDate(iso); const back = (d.getDay() + 6) % 7; d.setDate(d.getDate() - back); return isoOf(d); };
const weekDays = (iso) => { const s = weekStartOf(iso); return Array.from({ length: 7 }, (_, i) => addDaysISO(s, i)); };
const fmtDMY = (iso) => (iso && /^\d{4}-\d{2}-\d{2}$/.test(iso)) ? iso.split("-").reverse().join("-") : (iso || "");
const fmtDay = (iso) => localDate(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const toMin = (t) => { const [h, m] = t.split(":").map(Number); return h * 60 + m; };
const fromMin = (m) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const onDomain = (email) => email.endsWith("@" + ORG_DOMAIN);
const isSuperAdmin = () => state.profile?.role === "superadmin";
const me = () => state.user.email;
const nameOf = (email) => (state.people.find((p) => p.email === email) || {}).name || email;

function toast(msg) {
  document.querySelectorAll(".toast").forEach((t) => t.remove());
  const t = document.createElement("div");
  t.className = "toast";
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}

// <dialog> with a fallback for browsers/tests without showModal.
function openDialog(id) { const d = $(id); if (d.showModal) d.showModal(); else d.setAttribute("open", ""); }
function closeDialog(id) { const d = $(id); if (d.close) d.close(); else d.removeAttribute("open"); }
document.querySelectorAll("dialog").forEach((d) =>
  d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeDialog(d.id))));

/* ============================ theme ============================ */
$("btn-theme").addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  if (dark) document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", "dark");
  try { localStorage.setItem("theme", dark ? "light" : "dark"); } catch (e) { /* private mode */ }
});

/* ============================ sign in ============================ */
function signinError(msg) { $("signin-error").textContent = msg; $("signin-error").hidden = !msg; }

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  signinError("");
  const email = $("si-email").value.trim().toLowerCase();
  const pw = $("si-password").value;
  if (!onDomain(email)) return signinError(`Use your @${ORG_DOMAIN} address.`);
  if (!pw) return signinError("Enter your password.");
  try { await signInWithEmailAndPassword(auth, email, pw); }
  catch (err) { signinError("That email and password didn't match. Use the same ones as Meeting Ledger."); }
});
$("btn-forgot").addEventListener("click", async () => {
  const email = $("si-email").value.trim().toLowerCase();
  if (!onDomain(email)) return signinError(`Type your @${ORG_DOMAIN} address above first.`);
  try { await sendPasswordResetEmail(auth, email); toast("Password reset email sent"); }
  catch (e) { signinError("Couldn't send a reset email. " + (e.message || "")); }
});
$("btn-signout").addEventListener("click", () => signOut(auth));
$("btn-denied-signout").addEventListener("click", () => signOut(auth));

function showOnly(id) {
  for (const v of ["view-signin", "view-denied", "view-app"]) $(v).hidden = v !== id;
}
function deny(title, text) {
  $("denied-title").textContent = title;
  $("denied-text").textContent = text;
  showOnly("view-denied");
}

onAuthStateChanged(auth, async (user) => {
  $("boot").hidden = true;
  if (!user) { state.user = null; state.profile = null; showOnly("view-signin"); return; }
  const email = (user.email || "").toLowerCase();
  if (!onDomain(email)) { await signOut(auth); signinError(`Use your @${ORG_DOMAIN} address.`); return; }
  if (!user.emailVerified) {
    return deny("Confirm your email first.", "Open the verification email from Meeting Ledger, then sign in here again.");
  }
  state.user = { email, uid: user.uid };
  let prof = null;
  try { const snap = await getDoc(doc(db, "users", email)); prof = snap.exists() ? snap.data() : null; } catch (e) { prof = null; }
  if (!prof || prof.active !== true || !["admin", "superadmin"].includes(prof.role)) {
    return deny("This calendar is for Admins and Superadmins.",
      "Your account doesn't have access. If you think it should, ask a Superadmin to check your role in Meeting Ledger.");
  }
  state.profile = prof;
  $("who-name").textContent = prof.name || email;
  $("who-role").textContent = prof.role === "superadmin" ? "Superadmin" : "Admin";
  showOnly("view-app");
  state.anchor = todayISO();
  state.person = email;
  try {
    await loadAll();
  } catch (e) {
    toast("Couldn't load everything. " + (e.message || ""));
  }
  render();
});

/* ============================ loading ============================ */
async function loadAll() {
  const [users, events, plans, travel] = await Promise.all([
    getDocs(collection(db, "users")),
    getDocs(collection(db, "calEvents")),
    getDocs(collection(db, "weeklyPlans")),
    getDocs(collection(db, "travelPlans"))
  ]);
  state.people = users.docs.map((d) => ({ email: d.id, ...d.data() }))
    .filter((u) => u.active === true && ["admin", "superadmin"].includes(u.role))
    .map((u) => ({ email: u.email, name: u.name || u.email, role: u.role }))
    .sort((a, b) => (a.email === me() ? -1 : b.email === me() ? 1 : a.name.localeCompare(b.name)));
  state.events = events.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.plans = plans.docs.map((d) => ({ id: d.id, ...d.data() }));
  state.travel = travel.docs.map((d) => ({ id: d.id, ...d.data() }));
  await loadHolidays();
  await loadTasks();
  await ensureWeek(state.anchor);
  fillPersonSelect();
}

// Logged meetings can be many, so they're fetched a week at a time.
async function ensureWeek(iso) {
  const start = weekStartOf(iso);
  if (state.loadedWeeks.has(start)) return;
  const end = addDaysISO(start, 6);
  const snap = await getDocs(query(collection(db, "meetings"), where("date", ">=", start), where("date", "<=", end)));
  const ids = new Set(state.meetings.map((m) => m.id));
  snap.docs.forEach((d) => { if (!ids.has(d.id)) state.meetings.push({ id: d.id, ...d.data() }); });
  state.loadedWeeks.add(start);
}

// Never allowed to break the rest of the load: without it the calendar
// still runs on the regular week (Sundays, 2nd/4th Saturdays).
async function loadHolidays() {
  try {
    const snap = await getDocs(collection(db, "holidays"));
    state.holidays = new Map(snap.docs.map((d) => [d.id, d.data().name || "Holiday"]));
  } catch (e) { state.holidays = new Map(); }
}

// Private tasks: rules let only the owning Superadmin read them, and the
// query must filter by owner to be allowed. Nobody else even asks.
async function loadTasks() {
  if (!isSuperAdmin()) { state.tasks = []; return; }
  const snap = await getDocs(query(collection(db, "dayTasks"), where("ownerEmail", "==", me())));
  state.tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function reloadEvents() {
  const snap = await getDocs(collection(db, "calEvents"));
  state.events = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function fillPersonSelect() {
  $("person-select").innerHTML = state.people.map((p) =>
    `<option value="${esc(p.email)}">${esc(p.email === me() ? `${p.name} (you)` : p.name)}</option>`).join("");
  $("person-select").value = state.person;
}

/* ============================ office days (firm-wide) ============================ */
// One schedule for everyone: OFFICE in config.js (Mon–Sat, Sundays and the
// 2nd/4th Saturdays off) plus the holidays a Superadmin adds in the
// Holidays view here. Meeting Ledger has an identical copy of these functions.
const ORDINAL = ["", "1st", "2nd", "3rd", "4th", "5th"];
// The regular week only, ignoring holidays.
function regularDay(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  if (dow === 0) return { working: false, reason: "Sunday" };
  if (dow === 6) {
    const nth = Math.ceil(d / 7);
    if (OFFICE.offSaturdays.includes(nth)) return { working: false, reason: `${ORDINAL[nth]} Saturday` };
  }
  return { working: true, start: OFFICE.start, end: OFFICE.end };
}
function officeDay(iso) {
  if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return { working: true, start: OFFICE.start, end: OFFICE.end };
  const hol = state.holidays.get(iso);
  if (hol) return { working: false, holiday: true, reason: hol };
  return regularDay(iso);
}

/* ============================ what's on a given day ============================ */
const EVENT_LABEL = { busy: "Busy", ooo: "Out of office", wfh: "Working from home", leave: "Leave" };

// Office hours for that day, or null on a day off. Same for everyone.
function officeHoursOn(iso) {
  const o = officeDay(iso);
  return o.working ? o : null;
}
// Everything for one person on one day, split into all-day items and
// timed items. Meeting Ledger items are read-only here.
function itemsFor(email, iso) {
  const allDay = [], timed = [];
  const hol = state.holidays.get(iso);
  if (hol) allDay.push({ kind: "holiday", label: `Holiday: ${hol}`, src: "holiday", ref: { date: iso, name: hol } });
  for (const e of state.events) {
    if (e.ownerEmail !== email || e.date > iso || e.endDate < iso) continue;
    const label = e.title || EVENT_LABEL[e.kind] || "Busy";
    if (e.allDay) allDay.push({ kind: e.kind, label: e.title ? `${EVENT_LABEL[e.kind]}: ${e.title}` : EVENT_LABEL[e.kind], src: "event", ref: e });
    else timed.push({ kind: e.kind, label, start: e.start, end: e.end, src: "event", ref: e });
  }
  for (const t of state.travel) {
    if (t.rmEmail !== email || t.status !== "Approved") continue;
    if ((t.fromDate || "") <= iso && (t.toDate || t.fromDate || "") >= iso) {
      allDay.push({ kind: "travel", label: `Travelling: ${t.destination || ""}`, src: "travel", ref: t });
    }
  }
  for (const p of state.plans) {
    // Shows for the person who planned it and anyone going along.
    if ((p.rmEmail !== email && !(p.companionEmails || []).includes(email)) || p.date !== iso || p.status === "Done") continue;
    if (p.time && TIME_RE.test(p.time)) {
      const s = toMin(p.time);
      timed.push({ kind: "meet", label: `Meeting: ${p.name}`, start: p.time, end: fromMin(Math.min(s + 60, 24 * 60 - 1)), src: "plan", ref: p });
    } else {
      allDay.push({ kind: "meet", label: `Meeting: ${p.name}`, src: "plan", ref: p });
    }
  }
  for (const m of state.meetings) {
    if (m.rmEmail !== email || m.date !== iso) continue;
    allDay.push({ kind: "logged", label: `Met: ${m.prospectName || ""}`, src: "meeting", ref: m });
  }
  const order = { holiday: -1, leave: 0, ooo: 1, wfh: 2, travel: 3, busy: 4, meet: 5, logged: 6 };
  allDay.sort((a, b) => order[a.kind] - order[b.kind]);
  timed.sort((a, b) => a.start.localeCompare(b.start));
  return { allDay, timed, onLeave: allDay.some((x) => x.kind === "leave"), dayOff: !officeDay(iso).working };
}
// Meetings scheduled for the week with the day still TBC.
function tbcFor(email, weekStart) {
  return state.plans.filter((p) => (p.rmEmail === email || (p.companionEmails || []).includes(email)) && !p.date && p.weekStart === weekStart && p.status !== "Done");
}

/* ============================ rendering ============================ */
const GRID_START = 7 * 60, GRID_END = 22 * 60;   // 07:00–22:00 visible

function render() {
  for (const b of document.querySelectorAll("#view-seg button")) b.setAttribute("aria-selected", String(b.dataset.view === state.view));
  $("panel-week").hidden = state.view !== "week";
  $("panel-day").hidden = state.view !== "day";
  $("panel-team").hidden = state.view !== "team";
  $("panel-holidays").hidden = state.view !== "holidays";
  $("person-select").hidden = state.view === "team" || state.view === "holidays";
  const mine = state.person === me();
  $("btn-add").hidden = state.view === "holidays" ? true : state.view === "team" ? false : !mine;
  const days = weekDays(state.anchor);
  $("cal-range").textContent = state.view === "holidays" ? `Holidays ${state.holYear}`
    : state.view === "day" ? fmtDay(state.anchor)
    : `${fmtDay(days[0])} – ${fmtDay(days[6])}`;
  const note = [];
  if (!["team", "holidays"].includes(state.view) && !mine) note.push(`Viewing <b>${esc(nameOf(state.person))}</b>'s calendar. Read-only.`);
  $("cal-note").innerHTML = note.join(" ");
  $("cal-note").hidden = !note.length;
  if (state.view === "week") renderGrid($("week-grid"), days);
  if (state.view === "day") { renderGrid($("day-grid"), [state.anchor]); renderTasks(); }
  if (state.view === "team") renderTeam(days);
  if (state.view === "holidays") renderHolidays();
}

// Lays overlapping timed items side by side (simple lane assignment).
function layoutLanes(items) {
  const out = []; let cluster = [], clusterEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of cluster) {
      let lane = lanes.findIndex((end) => end <= it.s);
      if (lane === -1) { lane = lanes.length; lanes.push(0); }
      lanes[lane] = it.e; it.lane = lane;
    }
    cluster.forEach((it) => { it.lanes = lanes.length; out.push(it); });
    cluster = []; clusterEnd = -1;
  };
  for (const raw of items) {
    const it = { ...raw, s: toMin(raw.start), e: toMin(raw.end) };
    if (cluster.length && it.s >= clusterEnd) flush();
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  }
  if (cluster.length) flush();
  return out;
}

function renderGrid(host, days) {
  const email = state.person, mine = email === me(), today = todayISO();
  const hourPx = 48, px = (min) => ((Math.max(GRID_START, Math.min(GRID_END, min)) - GRID_START) / 60) * hourPx;
  const ws = weekStartOf(days[0]);
  const tbc = tbcFor(email, ws);
  const openTasks = (iso) => state.tasks.filter((t) => t.day === iso && t.status === "Open").length;
  const showTasks = mine && isSuperAdmin();

  let html = `<div class="cal-grid${days.length === 1 ? " one-day" : ""}" style="--days:${days.length}">`;
  // header row
  html += `<div class="gh"></div>`;
  for (const iso of days) {
    const h = officeHoursOn(iso);
    const off = officeDay(iso);
    const n = showTasks ? openTasks(iso) : 0;
    html += `<div class="gh${iso === today ? " today" : ""}">
      <span class="gh-dow">${esc(localDate(iso).toLocaleDateString(undefined, { weekday: "short" }))}</span>
      <span class="gh-date">${esc(fmtDMY(iso).slice(0, 5))}</span>
      <span class="gh-hours${h ? "" : " off"}" title="${h ? "Office hours" : esc(off.reason)}">${h ? `${esc(h.start)}–${esc(h.end)}` : off.holiday ? "Holiday" : "Off"}</span>
      ${n && days.length > 1 ? `<button class="gh-tasks" data-goto-day="${iso}">${n} task${n === 1 ? "" : "s"}</button>` : ""}
    </div>`;
  }
  // day-TBC strip
  if (tbc.length) {
    html += `<div class="tbc-strip"><b>This week, day not confirmed:</b> ${tbc.map((p) =>
      `<button class="btn-link" data-plan="${p.id}">${esc(p.name)}</button>`).join(" · ")}</div>`;
  }
  // all-day row
  html += `<div class="allday label">All day</div>`;
  const per = days.map((iso) => itemsFor(email, iso));
  per.forEach(({ allDay }) => {
    html += `<div class="allday">${allDay.map((it) => chip(it)).join("")}</div>`;
  });
  // time grid
  html += `<div class="hours-col">`;
  for (let m = GRID_START; m < GRID_END; m += 60) html += `<div class="hour-label">${fromMin(m)}</div>`;
  html += `</div>`;
  days.forEach((iso, i) => {
    const { timed, onLeave, dayOff } = per[i];
    const h = officeHoursOn(iso);
    html += `<div class="day-col${mine ? " mine" : ""}${onLeave ? " on-leave" : ""}${dayOff ? " day-off" : ""}" data-day="${iso}">`;
    for (let m = GRID_START; m < GRID_END; m += 60) html += `<div class="hline"></div>`;
    if (h && toMin(h.end) > toMin(h.start)) {
      html += `<div class="office-band" style="top:${px(toMin(h.start))}px;height:${px(toMin(h.end)) - px(toMin(h.start))}px"></div>`;
    }
    for (const it of layoutLanes(timed)) {
      const top = px(it.s), height = Math.max(18, px(it.e) - px(it.s) - 2);
      const w = 100 / it.lanes;
      html += `<button class="ev k-${it.kind}" style="top:${top}px;height:${height}px;left:calc(${it.lane * w}% + 2px);width:calc(${w}% - 4px)" ${refAttr(it)}>
        <b>${esc(it.label)}</b><span class="t">${esc(it.start)}–${esc(it.end)}</span></button>`;
    }
    if (iso === today) {
      const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
      if (nm >= GRID_START && nm <= GRID_END) html += `<div class="now-line" style="top:${px(nm)}px"></div>`;
    }
    html += `</div>`;
  });
  html += `</div>`;
  host.innerHTML = html;
  wireItems(host);
  host.querySelectorAll("[data-goto-day]").forEach((b) => b.addEventListener("click", () => goDay(b.dataset.gotoDay)));
  if (mine) {
    host.querySelectorAll(".day-col").forEach((col) => col.addEventListener("click", (e) => {
      if (e.target.closest(".ev")) return;
      const rect = col.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const min = GRID_START + Math.floor((y / hourPx) * 60 / 30) * 30;   // snap to 30 minutes
      const start = Math.max(GRID_START, Math.min(GRID_END - 60, isFinite(min) ? min : 9 * 60));
      openEventForm(null, { date: col.dataset.day, start: fromMin(start), end: fromMin(start + 60) });
    }));
  }
}

function refAttr(it) {
  if (it.src === "event") return `data-event="${it.ref.id}"`;
  if (it.src === "plan") return `data-plan="${it.ref.id}"`;
  if (it.src === "travel") return `data-travel="${it.ref.id}"`;
  if (it.src === "holiday") return `data-holiday="${it.ref.date}"`;
  return `data-meeting="${it.ref.id}"`;
}
function chip(it) {
  return `<button class="chipx k-${it.kind}" ${refAttr(it)} title="${esc(it.label)}">${esc(it.label)}</button>`;
}
function wireItems(host) {
  host.querySelectorAll("[data-event]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const ev = state.events.find((x) => x.id === b.dataset.event);
    if (!ev) return;
    if (ev.ownerEmail === me()) openEventForm(ev); else showDetail("event", ev);
  }));
  host.querySelectorAll("[data-plan]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); showDetail("plan", state.plans.find((x) => x.id === b.dataset.plan)); }));
  host.querySelectorAll("[data-travel]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); showDetail("travel", state.travel.find((x) => x.id === b.dataset.travel)); }));
  host.querySelectorAll("[data-holiday]").forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const iso = b.dataset.holiday;
    showDetail("holiday", { date: iso, name: state.holidays.get(iso) });
  }));
  host.querySelectorAll("[data-meeting]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); showDetail("meeting", state.meetings.find((x) => x.id === b.dataset.meeting)); }));
}

function renderTeam(days) {
  const today = todayISO();
  let html = `<table class="team-table"><thead><tr><th>Person</th>${days.map((iso) =>
    `<th class="${iso === today ? "today" : ""}">${esc(fmtDay(iso))}</th>`).join("")}</tr></thead><tbody>`;
  for (const p of state.people) {
    html += `<tr><td><button class="btn-link team-person" data-person="${esc(p.email)}">${esc(p.email === me() ? `${p.name} (you)` : p.name)}</button>
      <div class="team-role">${p.role === "superadmin" ? "Superadmin" : "Admin"}</div></td>`;
    for (const iso of days) {
      const h = officeHoursOn(iso);
      const off = officeDay(iso);
      const { allDay, timed } = itemsFor(p.email, iso);
      const lines = [
        h ? `<span class="cell-hours">${esc(h.start)}–${esc(h.end)}</span>`
          : off.holiday ? "" : `<span class="cell-off">Off · ${esc(off.reason)}</span>`,
        ...allDay.map((it) => chip(it)),
        ...timed.map((it) => `<span class="cell-line"><span class="t">${esc(it.start)}</span>${esc(it.label)}</span>`)
      ];
      html += `<td><div class="cell">${lines.join("")}</div></td>`;
    }
    html += `</tr>`;
  }
  html += `</tbody></table>`;
  $("team-grid").innerHTML = html;
  wireItems($("team-grid"));
  $("team-grid").querySelectorAll("[data-person]").forEach((b) => b.addEventListener("click", () => {
    state.person = b.dataset.person; $("person-select").value = state.person; setView("week");
  }));
}

/* ============================ details (read-only) ============================ */
function showDetail(kind, r) {
  if (!r) return;
  let title = "", rows = [];
  if (kind === "event") {
    title = r.title || EVENT_LABEL[r.kind];
    rows = [["Whose", nameOf(r.ownerEmail)], ["Type", EVENT_LABEL[r.kind]],
      ["When", r.allDay ? (r.date === r.endDate ? fmtDMY(r.date) : `${fmtDMY(r.date)} to ${fmtDMY(r.endDate)}`) : `${fmtDMY(r.date)}, ${r.start}–${r.end}`],
      ["Notes", r.notes || "—"]];
  } else if (kind === "holiday") {
    title = `Holiday: ${r.name}`;
    rows = [["Date", fmtDMY(r.date)], ["Who", "Everyone, office closed"], ["From", "Holidays (firm-wide)"]];
  } else if (kind === "plan") {
    title = `Meeting: ${r.name}`;
    rows = [["Whose", r.rmName || r.rmEmail], ["Going with", (r.companionNames || []).join(", ") || "Alone"], ["When", r.date ? `${fmtDMY(r.date)}${r.time ? ", " + r.time : ""}` : `Week of ${fmtDMY(r.weekStart)}, day not confirmed`],
      ["Person type", r.personType || "—"], ["Location", r.location || "—"], ["Purpose", r.purpose || "—"], ["Status", r.status || "—"],
      ["From", "Meeting Ledger → Meetings scheduled"]];
  } else if (kind === "travel") {
    title = `Travelling: ${r.destination}`;
    rows = [["Whose", r.rmName || r.rmEmail], ["Dates", `${fmtDMY(r.fromDate)} to ${fmtDMY(r.toDate)}`],
      ["Meetings planned", String(r.meetingsPlanned ?? 0)], ["Events planned", String(r.eventsPlanned || 0)],
      ["Remarks", r.remarks || "—"], ["From", "Meeting Ledger → Travel plan (approved)"]];
  } else {
    title = `Met: ${r.prospectName}`;
    rows = [["Whose", r.rmName || r.rmEmail], ["Date", fmtDMY(r.date)], ["Person type", r.personType || "—"],
      ["Meeting", r.meetingType || "—"], ["Result", r.result || "—"], ["From", "Meeting Ledger → logged meeting"]];
  }
  $("detail-title").textContent = title;
  $("detail-list").innerHTML = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  openDialog("dlg-detail");
}

/* ============================ navigation ============================ */
async function moveTo(iso) {
  state.anchor = iso;
  try { await ensureWeek(iso); } catch (e) { toast("Couldn't load that week's meetings. " + (e.message || "")); }
  render();
}
function setView(v) { state.view = v; render(); }
function goDay(iso) { state.view = "day"; moveTo(iso); }

document.querySelectorAll("#view-seg button").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view)));
// In the Holidays view, ‹ › and Today step through years instead.
$("btn-prev").addEventListener("click", () => state.view === "holidays" ? (state.holYear -= 1, render())
  : moveTo(addDaysISO(state.anchor, state.view === "day" ? -1 : -7)));
$("btn-next").addEventListener("click", () => state.view === "holidays" ? (state.holYear += 1, render())
  : moveTo(addDaysISO(state.anchor, state.view === "day" ? 1 : 7)));
$("btn-today").addEventListener("click", () => state.view === "holidays" ? (state.holYear = Number(todayISO().slice(0, 4)), render())
  : moveTo(todayISO()));
$("person-select").addEventListener("change", () => { state.person = $("person-select").value; render(); });

/* ============================ add / edit an event ============================ */
let editingEventId = null;

function syncAllDay() {
  const all = $("ev-allday").checked;
  $("field-ev-start").hidden = all;
  $("field-ev-end").hidden = all;
  $("field-ev-enddate").hidden = !all;
  $("lbl-ev-date").textContent = all ? "From" : "Date";
}
$("ev-allday").addEventListener("change", syncAllDay);
// Leave and WFH are usually whole days; busy and out-of-office usually aren't.
$("ev-kind").addEventListener("change", () => {
  if (editingEventId) return;
  $("ev-allday").checked = ["leave", "wfh"].includes($("ev-kind").value);
  syncAllDay();
});

function openEventForm(ev, defaults = {}) {
  editingEventId = ev ? ev.id : null;
  $("event-error").hidden = true;
  $("event-title").textContent = ev ? "Edit" : "Add to your calendar";
  $("btn-ev-delete").hidden = !ev;
  const base = ev || { kind: "busy", title: "", allDay: false, date: defaults.date || state.anchor, endDate: defaults.date || state.anchor,
    start: defaults.start || "10:00", end: defaults.end || "11:00", notes: "" };
  $("ev-kind").value = base.kind;
  $("ev-title").value = base.title || "";
  $("ev-allday").checked = !!base.allDay;
  $("ev-date").value = base.date;
  $("ev-enddate").value = base.endDate || base.date;
  $("ev-start").value = base.start || "10:00";
  $("ev-end").value = base.end || "11:00";
  $("ev-notes").value = base.notes || "";
  syncAllDay();
  openDialog("dlg-event");
}
$("btn-add").addEventListener("click", () => openEventForm(null, { date: state.view === "day" ? state.anchor : todayISO() }));

$("event-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("event-error");
  err.hidden = true;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  const allDay = $("ev-allday").checked;
  const data = {
    kind: $("ev-kind").value,
    title: $("ev-title").value.trim(),
    allDay,
    date: $("ev-date").value,
    endDate: allDay ? ($("ev-enddate").value || $("ev-date").value) : $("ev-date").value,
    start: allDay ? "" : $("ev-start").value,
    end: allDay ? "" : $("ev-end").value,
    notes: $("ev-notes").value.trim(),
    ownerEmail: me(), ownerName: state.profile.name || me(),
    updatedAt: serverTimestamp()
  };
  // Same checks as firestore.rules, so problems show here, not as a refusal.
  if (!["busy", "leave", "ooo", "wfh"].includes(data.kind)) return fail("Pick a type.");
  if (data.title.length > 200) return fail("Keep the title under 200 characters.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data.date)) return fail("Pick a date.");
  if (allDay && data.endDate < data.date) return fail("The end date can't be before the start date.");
  if (!allDay) {
    if (!TIME_RE.test(data.start) || !TIME_RE.test(data.end)) return fail("Enter both times as HH:MM.");
    if (data.end <= data.start) return fail("The end time must be after the start time.");
  }
  try {
    if (editingEventId) await updateDoc(doc(db, "calEvents", editingEventId), data);
    else await addDoc(collection(db, "calEvents"), { ...data, createdAt: serverTimestamp() });
    closeDialog("dlg-event");
    toast(editingEventId ? "Updated" : "Added");
    await reloadEvents();
    render();
  } catch (e2) { fail("Couldn't save that. " + (e2.message || "")); }
});

$("btn-ev-delete").addEventListener("click", async () => {
  if (!editingEventId || !confirm("Delete this from your calendar?")) return;
  try {
    await deleteDoc(doc(db, "calEvents", editingEventId));
    closeDialog("dlg-event");
    toast("Deleted");
    await reloadEvents();
    render();
  } catch (e) { $("event-error").textContent = "Couldn't delete that. " + (e.message || ""); $("event-error").hidden = false; }
});

/* ============================ tasks (Superadmin, private) ============================ */
// Moved here from Meeting Ledger's day planner, unchanged in behaviour:
// paste a list, mark done with what was done (+ optional next step on a
// chosen day), past days read-only, open tasks carried to today only when
// chosen. Same dayTasks documents, so earlier tasks are all here.
const TS = { OPEN: "Open", DONE: "Done", CARRIED: "Carried" };
const TASK_MAX_LEN = 500, TASK_MAX_LINES = 50, NOTE_MAX = 1000, BATCH_ITEMS = 200;
let completingId = null;

function parseLines(text) {
  return String(text || "").split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:\d{1,3}[.)](?!\d)|[-•*–])\s*/, "").trim())
    .filter(Boolean);
}
const taskTag = (st) => st === TS.DONE ? "tag-green" : st === TS.CARRIED ? "tag-flat" : "tag-amber";
function taskOrigin(t) {
  if (t.status === TS.CARRIED && t.carriedTo) return `Carried to ${fmtDMY(t.carriedTo)}`;
  if (!t.carriedFrom) return "";
  const first = t.firstDay && t.firstDay !== t.carriedFrom ? ` · first planned ${fmtDMY(t.firstDay)}` : "";
  return `Carried from ${fmtDMY(t.carriedFrom)}${first}`;
}

function renderTasks() {
  const show = isSuperAdmin() && state.person === me();
  $("tasks-card").hidden = !show;
  $("panel-day").classList.toggle("no-tasks", !show);
  if (!show) return;
  const day = state.anchor, today = todayISO(), isPast = day < today;
  $("task-form").hidden = isPast;
  $("task-past").hidden = !isPast;
  const items = state.tasks.filter((t) => t.day === day).sort((a, b) => (a.seq || 0) - (b.seq || 0));
  const openHere = items.filter((t) => t.status === TS.OPEN);

  const banner = $("task-banner");
  banner.hidden = true; banner.innerHTML = "";
  if (isPast && openHere.length) {
    banner.innerHTML = `${openHere.length} task${openHere.length === 1 ? "" : "s"} left open this day.
      <button type="button" class="btn-link" id="btn-task-carry-all">Carry ${openHere.length === 1 ? "it" : "all"} to today</button>`;
    banner.hidden = false;
    $("btn-task-carry-all").addEventListener("click", () => carryTasks(openHere.map((t) => t.id)));
  } else if (day === today) {
    const stale = state.tasks.filter((t) => t.status === TS.OPEN && t.day < today);
    if (stale.length) {
      const latest = stale.map((t) => t.day).sort().pop();
      banner.innerHTML = `${stale.length} task${stale.length === 1 ? "" : "s"} still open from earlier days.
        <button type="button" class="btn-link" id="btn-task-review">Review</button>`;
      banner.hidden = false;
      $("btn-task-review").addEventListener("click", () => moveTo(latest));
    }
  }

  if (!items.length) {
    $("task-list").innerHTML = `<p class="empty">${isPast ? "No tasks were planned this day." : "No tasks for this day yet. Add them below."}</p>`;
    return;
  }
  $("task-list").innerHTML = items.map((t) => {
    const open = t.status === TS.OPEN, done = t.status === TS.DONE;
    const actions = [
      open && isPast ? `<button class="btn-link" data-t-carry="${t.id}">Carry to today</button>` : "",
      open && completingId !== t.id ? `<button class="btn-link" data-t-done="${t.id}">Mark done</button>` : "",
      done ? `<button class="btn-link" data-t-reopen="${t.id}">Mark open</button>` : "",
      open || done ? `<button class="btn-link danger" data-t-delete="${t.id}">Remove</button>` : ""
    ].join("");
    const origin = taskOrigin(t);
    return `
    <article class="entry">
      <div class="entry-top">
        <span class="entry-name task-text${done ? " task-done" : ""}">${esc(t.text)}</span>
        <span class="tag ${taskTag(t.status)}">${esc(t.status)}</span>
        ${actions ? `<span class="entry-actions">${actions}</span>` : ""}
      </div>
      ${origin ? `<div class="entry-meta">${esc(origin)}</div>` : ""}
      ${t.fromTaskText ? `<div class="entry-meta">Next step from: ${esc(t.fromTaskText)}</div>` : ""}
      ${done && t.doneNote ? `<div class="entry-remarks"><strong>Done:</strong> ${esc(t.doneNote)}</div>` : ""}
      ${done && t.nextStep ? `<div class="entry-meta">Next step → ${esc(fmtDay(t.nextStepDay))}: ${esc(t.nextStep)}</div>` : ""}
      ${open && completingId === t.id ? `
      <div class="dt-complete">
        <label class="field"><span>What was done</span>
          <textarea id="t-done-note" rows="2" placeholder="What happened, what was agreed"></textarea></label>
        <div class="dt-next-row">
          <label class="field"><span>Next step <em>optional</em></span>
            <input type="text" id="t-next-text" placeholder="The follow-on task, if any" autocomplete="off" /></label>
          <label class="field"><span>For</span>
            <input type="date" id="t-next-day" value="${day > today ? day : today}" min="${today}" /></label>
        </div>
        <p id="t-complete-error" class="form-error" hidden></p>
        <div class="form-actions">
          <button type="button" class="btn btn-primary btn-sm" id="btn-t-complete-save">Mark done</button>
          <button type="button" class="btn-link" id="btn-t-complete-cancel">Cancel</button>
        </div>
      </div>` : ""}
    </article>`;
  }).join("");

  const list = $("task-list");
  list.querySelectorAll("[data-t-carry]").forEach((b) => b.addEventListener("click", () => carryTasks([b.dataset.tCarry])));
  list.querySelectorAll("[data-t-done]").forEach((b) => b.addEventListener("click", () => { completingId = b.dataset.tDone; renderTasks(); $("t-done-note").focus(); }));
  list.querySelectorAll("[data-t-reopen]").forEach((b) => b.addEventListener("click", () => reopenTask(b.dataset.tReopen)));
  list.querySelectorAll("[data-t-delete]").forEach((b) => b.addEventListener("click", () => deleteTask(b.dataset.tDelete)));
  if ($("btn-t-complete-save")) {
    $("btn-t-complete-save").addEventListener("click", () => completeTask(completingId));
    $("btn-t-complete-cancel").addEventListener("click", () => { completingId = null; renderTasks(); });
  }
}

$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("task-error");
  err.hidden = true;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  if (!isSuperAdmin()) return fail("Tasks are for Superadmins.");
  const day = state.anchor;
  if (day < todayISO()) return fail("That day has passed. Add tasks to today or a later day.");
  const items = parseLines($("task-text").value);
  if (!items.length) return fail("Type at least one task.");
  if (items.length > TASK_MAX_LINES) return fail(`That's ${items.length} lines. Add up to ${TASK_MAX_LINES} at a time.`);
  const tooLong = items.findIndex((t) => t.length > TASK_MAX_LEN);
  if (tooLong !== -1) return fail(`Line ${tooLong + 1} is longer than ${TASK_MAX_LEN} characters. Shorten it or split it.`);
  try {
    const batch = writeBatch(db);
    const base = Date.now();
    items.forEach((text, i) => batch.set(doc(collection(db, "dayTasks")), {
      day, text, status: TS.OPEN, seq: base + i, carriedFrom: "", carriedTo: "", firstDay: day,
      ownerEmail: me(), ownerName: state.profile.name || me(),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    }));
    await batch.commit();
    toast(items.length === 1 ? "Task added" : `Added ${items.length} tasks`);
    $("task-text").value = "";
    await loadTasks();
    renderTasks();
  } catch (e2) { fail("Couldn't save that. " + (e2.message || "")); }
});

async function completeTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.status !== TS.OPEN) return;
  const err = $("t-complete-error");
  err.hidden = true;
  const fail = (m) => { err.textContent = m; err.hidden = false; };
  const note = $("t-done-note").value.trim();
  const nextText = $("t-next-text").value.trim();
  const nextDay = $("t-next-day").value;
  if (!note) return fail("Add what was done before marking this done.");
  if (note.length > NOTE_MAX) return fail(`Keep "what was done" under ${NOTE_MAX} characters.`);
  if (nextText) {
    if (nextText.length > TASK_MAX_LEN) return fail(`Keep the next step under ${TASK_MAX_LEN} characters.`);
    if (!nextDay) return fail("Pick a day for the next step.");
    if (nextDay < todayISO()) return fail("The next step can be for today or a later day.");
  }
  try {
    const batch = writeBatch(db);
    batch.update(doc(db, "dayTasks", id), {
      status: TS.DONE, doneNote: note, nextStep: nextText, nextStepDay: nextText ? nextDay : "", updatedAt: serverTimestamp()
    });
    if (nextText) batch.set(doc(collection(db, "dayTasks")), {
      day: nextDay, text: nextText, status: TS.OPEN, seq: Date.now(), carriedFrom: "", carriedTo: "", firstDay: nextDay,
      fromTaskId: id, fromTaskText: t.text, ownerEmail: me(), ownerName: state.profile.name || me(),
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    await batch.commit();
    completingId = null;
    toast(nextText ? `Done. Next step added for ${fmtDay(nextDay)}` : "Marked done");
    await loadTasks();
    render();
  } catch (e) { fail("Couldn't save that. " + (e.message || "")); }
}

async function reopenTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || t.status !== TS.DONE) return;
  const patch = { status: TS.OPEN, doneNote: "", nextStep: "", nextStepDay: "", updatedAt: serverTimestamp() };
  try { await updateDoc(doc(db, "dayTasks", id), patch); Object.assign(t, patch); render(); }
  catch (e) { toast("Couldn't update that. " + (e.message || "")); }
}

async function deleteTask(id) {
  const t = state.tasks.find((x) => x.id === id);
  if (!t || !confirm(`Remove "${t.text}"?`)) return;
  try { await deleteDoc(doc(db, "dayTasks", id)); state.tasks = state.tasks.filter((x) => x.id !== id); render(); }
  catch (e) { toast("Couldn't remove that. " + (e.message || "")); }
}

async function carryTasks(ids) {
  const target = todayISO();
  const items = ids.map((id) => state.tasks.find((x) => x.id === id))
    .filter((t) => t && t.status === TS.OPEN && t.day < target)
    .sort((a, b) => (a.day || "").localeCompare(b.day || "") || (a.seq || 0) - (b.seq || 0));
  if (!items.length) return;
  try {
    const base = Date.now();
    for (let c = 0; c < items.length; c += BATCH_ITEMS) {
      const batch = writeBatch(db);
      items.slice(c, c + BATCH_ITEMS).forEach((t, i) => {
        batch.set(doc(collection(db, "dayTasks")), {
          day: target, text: t.text, status: TS.OPEN, seq: base + c + i,
          carriedFrom: t.day, carriedTo: "", firstDay: t.firstDay || t.day,
          fromTaskId: t.fromTaskId || "", fromTaskText: t.fromTaskText || "",
          ownerEmail: me(), ownerName: state.profile.name || me(),
          createdAt: serverTimestamp(), updatedAt: serverTimestamp()
        });
        batch.update(doc(db, "dayTasks", t.id), { status: TS.CARRIED, carriedTo: target, updatedAt: serverTimestamp() });
      });
      await batch.commit();
    }
    toast(items.length === 1 ? "Carried to today" : `Carried ${items.length} tasks to today`);
  } catch (e) { toast("Couldn't carry that. " + (e.message || "")); }
  await loadTasks();
  render();
}

/* ============================ holidays (firm-wide) ============================ */
// Every Admin/Superadmin sees the list here; only a Superadmin adds or
// removes. Meeting Ledger reads the same collection for everyone else
// (next-working-day plan, day-off warnings). One doc per holiday, ID = the
// date, so a date can never be listed twice.
const HOLIDAY_NAME_MAX = 100, HOLIDAY_MAX_LINES = 60;

function renderHolidays() {
  const sats = OFFICE.offSaturdays.map((n) => ORDINAL[n]).join(" and ");
  $("office-rule").innerHTML = `Monday to Saturday, <span class="mono">${esc(OFFICE.start)}–${esc(OFFICE.end)}</span>.
    Sundays and the ${esc(sats)} Saturdays of every month are off, and so are the holidays below.`;
  const upcoming = [];
  let d = todayISO();
  for (let i = 0; i < 400 && upcoming.length < 4; i++) {
    const o = officeDay(d);
    if (!o.working && o.reason !== "Sunday") upcoming.push(`${fmtDay(d)} (${o.reason})`);
    d = addDaysISO(d, 1);
  }
  $("office-next-off").textContent = upcoming.length ? `Coming up, apart from Sundays: ${upcoming.join(" · ")}` : "";

  const year = state.holYear, sa = isSuperAdmin(), today = todayISO();
  $("holiday-add-card").hidden = !sa;
  const rows = [...state.holidays.entries()]
    .filter(([iso]) => iso.startsWith(`${year}-`))
    .sort(([a], [b]) => a.localeCompare(b));
  $("hol-count").textContent = `${rows.length} in ${year}`;
  $("tbl-holidays").innerHTML = `<thead><tr><th>Date</th><th>Day</th><th>Holiday</th>${sa ? "<th></th>" : ""}</tr></thead><tbody>${
    rows.length ? rows.map(([iso, name]) => {
      const reg = regularDay(iso);
      const weekday = localDate(iso).toLocaleDateString(undefined, { weekday: "long" });
      return `<tr class="${iso < today ? "row-past" : ""}">
        <td class="num">${esc(fmtDMY(iso))}</td><td>${esc(weekday)}</td>
        <td>${esc(name)}${reg.working ? "" : ` <span class="tag tag-flat">Already off: ${esc(reg.reason)}</span>`}</td>
        ${sa ? `<td class="act"><button class="btn-link danger" data-hol-delete="${esc(iso)}">Remove</button></td>` : ""}
      </tr>`;
    }).join("")
    : `<tr><td colspan="${sa ? 4 : 3}" class="empty">No holidays added for ${year} yet.${sa ? " Add them below." : " A Superadmin adds them here."}</td></tr>`
  }</tbody>`;
  $("tbl-holidays").querySelectorAll("[data-hol-delete]").forEach((b) =>
    b.addEventListener("click", () => deleteHoliday(b.dataset.holDelete)));
}

// "26-01-2027 Republic Day" (also 26/01/2027, 2027-01-26, or a comma/tab
// between date and name, as pasted from Excel). Returns {iso, name} or an
// error string.
function parseHolidayLine(line) {
  let m = line.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})\s*[,;:\-–]?\s*(.*)$/);
  let y, mo, d, name;
  if (m) { [, d, mo, y, name] = m; }
  else if ((m = line.match(/^(\d{4})-(\d{2})-(\d{2})\s*[,;:\-–]?\s*(.*)$/))) { [, y, mo, d, name] = m; }
  else return "doesn't start with a date as DD-MM-YYYY";
  y = Number(y); mo = Number(mo); d = Number(d);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return "isn't a real date";
  name = (name || "").trim();
  if (!name) return "has no holiday name after the date";
  if (name.length > HOLIDAY_NAME_MAX) return `has a name longer than ${HOLIDAY_NAME_MAX} characters`;
  return { iso: `${y}-${pad(mo)}-${pad(d)}`, name };
}

$("holiday-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("holiday-error");
  err.hidden = true;
  const fail = (msg) => { err.textContent = msg; err.hidden = false; };
  if (!isSuperAdmin()) return fail("Only a Superadmin can add holidays.");
  const lines = $("holiday-text").value.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return fail("Type at least one holiday, as DD-MM-YYYY then the name.");
  if (lines.length > HOLIDAY_MAX_LINES) return fail(`That's ${lines.length} lines. Add up to ${HOLIDAY_MAX_LINES} at a time.`);
  const items = [], seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const r = parseHolidayLine(lines[i]);
    if (typeof r === "string") return fail(`Line ${i + 1} ${r}: “${lines[i]}”`);
    if (seen.has(r.iso)) return fail(`Line ${i + 1}: ${fmtDMY(r.iso)} is listed twice.`);
    seen.add(r.iso);
    items.push(r);
  }
  try {
    const batch = writeBatch(db);
    items.forEach(({ iso, name }) => batch.set(doc(db, "holidays", iso), {
      date: iso, name, updatedByEmail: me(), updatedAt: serverTimestamp()
    }));
    await batch.commit();
    items.forEach(({ iso, name }) => state.holidays.set(iso, name));
    $("holiday-text").value = "";
    state.holYear = Number(items[0].iso.slice(0, 4));
    toast(items.length === 1 ? "Holiday added" : `Added ${items.length} holidays`);
    render();
  } catch (e2) { fail("Couldn't save that. " + (e2.message || "")); }
});

async function deleteHoliday(iso) {
  const name = state.holidays.get(iso);
  if (!isSuperAdmin() || !name || !confirm(`Remove ${name} (${fmtDMY(iso)}) from the holidays?`)) return;
  try {
    await deleteDoc(doc(db, "holidays", iso));
    state.holidays.delete(iso);
    toast("Holiday removed");
    render();
  } catch (e) { toast("Couldn't remove that. " + (e.message || "")); }
}
