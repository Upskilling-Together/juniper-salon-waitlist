// Staff dashboard for the Juniper Salon refill prototype.
const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");

// Small inline icon set (decorative: the words always carry the meaning).
const svg = (p) =>
  `<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5v.01"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  send: svg('<path d="M21 3 10 14"/><path d="m21 3-7 18-4-7-7-4z"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  dash: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>'),
  ban: svg('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>'),
  message: svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M3 3l18 18"/>'),
  dot: svg('<circle cx="12" cy="12" r="4" fill="currentColor" stroke="none"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/>'),
  question: svg('<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6"/><path d="M12 17v.01"/>'),
  phone: svg('<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 17.5h2"/>'),
  chevron: svg('<path d="m6 9 6 6 6-6"/>').replace('class="icon"', 'class="icon chev"'),
};
const ext = '<span aria-hidden="true"> ↗</span>';
const chip = (state, text, icon) => `<span class="chip chip--${state}">${icon ? ICONS[icon] : ""}${text}</span>`;

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let meta = null;
let serverOffset = 0; // server clock - browser clock
let lastData = null;
let wlFilter = "waiting";
let wlStylist = "";
let wlService = "";
let opTab = "active";
let statFilter = null; // "awaiting_approval" | "held" | "unfilled" | "offering"
let view = "openings"; // phone/tablet only
let connState = null;
let attentionCount = 0;
let titleError = false;
const selections = new Map(); // openingId -> Set(clientIds) while awaiting approval
const approvalSettings = new Map(); // openingId -> { batchSize, replyWindow }
const openHistory = new Set();
const openSettings = new Set();
const expanded = new Set(); // finished cards showing details
const cardCache = new Map(); // openingId -> rendered signature
const inFlight = new Set();
let busy = false;
let pendingFocus = null;

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const now = () => Date.now() + serverOffset;

// ---------------------------------------------------------------------------
// Time formatting
// ---------------------------------------------------------------------------
function formatClock(ms) {
  const t = new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "\u00a0");
  return t === "12:00\u00a0PM" ? "noon" : t;
}
function parseSlot(startsAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt || "");
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  return { mo, d, utc: Date.UTC(y, mo - 1, d, h, mi) };
}
function wallTime(utc) {
  const dt = new Date(utc);
  const h = dt.getUTCHours();
  const mi = dt.getUTCMinutes();
  if (h === 12 && mi === 0) return "noon";
  return `${h % 12 || 12}:${pad(mi)}\u00a0${h < 12 ? "AM" : "PM"}`; // never split "12:30 PM" across lines
}
/**
 * An epoch time on the SALON's wall clock (not this device's): the opening's start is stored both as
 * wall time and as epoch ms, which gives the salon's UTC offset. Falls back to the device clock.
 */
function salonClock(s, ms) {
  const p = parseSlot(s?.opening?.startsAt);
  if (!p || s.opening.startsAtMs == null || ms == null) return formatClock(ms);
  return wallTime(ms + (p.utc - s.opening.startsAtMs));
}
/** "at 1:00 PM" today, otherwise "on Sat, Oct 17 at 9:00 AM": when offers stop (start − Stop offering). */
function cutoffAt(s) {
  const p = parseSlot(s?.opening?.startsAt);
  if (!p) return s?.offeringCutoffAt ? `at ${salonClock(s, s.offeringCutoffAt)}` : "";
  const wall = p.utc - (s.opening.stopOfferingMinutesBefore ?? meta?.defaultStopOfferingMinutes ?? 60) * 60_000;
  const d = new Date(wall);
  const time = wallTime(wall);
  return d.toISOString().slice(0, 10) === meta?.today ? `at ${time}` : `on ${DAY[d.getUTCDay()]}, ${MONTH[d.getUTCMonth()]} ${d.getUTCDate()} at ${time}`;
}
function relativeDay(startsAt, today) {
  if (!today || !startsAt) return "";
  const d = startsAt.slice(0, 10);
  if (d === today) return "Today";
  const t = parseSlot(`${today}T00:00`);
  return t && d === new Date(t.utc + 86_400_000).toISOString().slice(0, 10) ? "Tomorrow" : "";
}
/** endTime(startsAt, durationMinutes) and friends, all on the salon's wall clock. */
function slotParts(startsAt, durationMinutes) {
  const p = parseSlot(startsAt);
  if (!p) return { rel: "", day: startsAt ?? "", start: "", range: "", short: startsAt ?? "" };
  const dow = DAY[new Date(p.utc).getUTCDay()];
  const start = wallTime(p.utc);
  const end = durationMinutes ? wallTime(p.utc + durationMinutes * 60_000) : "";
  return {
    rel: relativeDay(startsAt, meta?.today),
    day: `${dow}, ${MONTH[p.mo - 1]} ${p.d}`,
    start,
    range: end ? `${start} – ${end}` : start,
    short: `${dow} ${start}`,
  };
}
const startsAtMs = (op) => op.startsAtMs ?? parseSlot(op.startsAt)?.utc ?? 0;
const shortDate = (iso) => new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
function windowText(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`;
}
/** Secondary, relative countdown text: "(14:12 left)" or "(about 1 hr 5 min left)". */
function countdownState(deadline, lowMs) {
  const ms = deadline - now();
  if (ms <= 0) return { text: "(time's up)", low: false };
  // Changes once a minute (seconds only in the final minute) so the page isn't constantly moving.
  const s = Math.ceil(ms / 1000);
  const text =
    s >= 3600
      ? `(about ${Math.floor(s / 3600)} hr${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ""} left)`
      : s > 60
        ? `(${Math.floor(s / 60)} min left)`
        : `(${Math.floor(s / 60)}:${pad(s % 60)} left)`;
  const low = ms < lowMs;
  const lowText = `Less than ${Math.round(lowMs / 60_000)} min left`;
  return { text: low ? (s > 60 ? `(${lowText})` : `${text} ${lowText}`) : text, low };
}
function countdownSpan(deadline, lowMs = 60_000) {
  const st = countdownState(deadline, lowMs);
  return `<span class="countdown${st.low ? " low" : ""}" aria-hidden="true" data-deadline="${deadline}" data-low="${lowMs}">${esc(st.text)}</span>`;
}

const offerUrl = (openingId, offer) =>
  `/offer.html?o=${encodeURIComponent(openingId)}&c=${encodeURIComponent(offer.clientId)}&t=${encodeURIComponent(offer.token)}`;

// ---------------------------------------------------------------------------
// Toasts: #status (polite, auto-hides after 10 s) and #alert (stays until closed)
// ---------------------------------------------------------------------------
function toast(message, isError = false, lead = "Couldn't save:") {
  if (isError) {
    $("#alert-text").innerHTML = `${ICONS.alert} <strong>${esc(lead)}</strong> ${esc(message)}`;
    $("#alert").classList.add("is-visible");
    $("#alert-close").hidden = false;
    return;
  }
  const t = $("#status");
  t.textContent = message;
  t.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => {
    t.classList.remove("is-visible");
    t.textContent = "";
  }, 10_000);
}
function closeAlert() {
  $("#alert").classList.remove("is-visible");
  $("#alert-text").textContent = "";
  $("#alert-close").hidden = true;
}
// While a toast is showing, reserve its height at the bottom of the viewport so a keyboard-focused
// control is always scrolled clear of it (WCAG 2.4.11).
new ResizeObserver(() => {
  const h = $(".toasts").getBoundingClientRect().height;
  document.documentElement.style.setProperty("--toast-h", `${Math.ceil(h)}px`);
  document.documentElement.classList.toggle("has-toast", h > 0);
}).observe($(".toasts"));
// Escape dismisses the error alert from anywhere (dialogs handle their own Escape first).
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !$("#alert").classList.contains("is-visible")) return;
  if (document.querySelector("dialog[open]")) return;
  closeAlert();
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.body = body;
    throw error;
  }
  return body;
}

function setTitle() {
  const n = attentionCount;
  document.title = `${titleError ? "Error: " : ""}${n ? `(${n} need${n === 1 ? "s" : ""} you) ` : ""}Open chairs – Juniper Salon`;
}

// ---------------------------------------------------------------------------
// Focus helpers: re-rendering must never drop the keyboard user's place.
// ---------------------------------------------------------------------------
const FOCUS_KEYS = ["action", "id", "offer", "confirm", "select", "setting", "stat", "filter", "tab", "view"];
function focusSelector(el) {
  if (!el || el === document.body) return null;
  let sel = FOCUS_KEYS.filter((k) => el.dataset?.[k] !== undefined)
    .map((k) => `[data-${k}="${CSS.escape(el.dataset[k])}"]`)
    .join("");
  if (sel && el.dataset.select !== undefined) sel += `[value="${CSS.escape(el.value)}"]`;
  if (sel) return sel;
  if (el.matches("summary")) {
    const d = el.closest("details[data-history]");
    return d ? `details[data-history="${CSS.escape(d.dataset.history)}"] > summary` : null;
  }
  if (el.matches("a[href]")) return `a[href="${CSS.escape(el.getAttribute("href"))}"]`;
  return null;
}
/** Replace innerHTML only when it changed, keeping focus on the equivalent element. */
function patch(el, html) {
  if (el._html === html) return;
  const active = document.activeElement;
  const sel = active && el.contains(active) ? focusSelector(active) : null;
  el.innerHTML = html;
  el._html = html;
  if (sel) el.querySelector(sel)?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------------------
// Add opening drawer
// ---------------------------------------------------------------------------
const openingDialog = $("#opening-dialog");
let dialogOpener = null;
let skipReturnFocus = false;
let creating = false;

/** "1 hour", "1 hour 30 min", "45 min" for the Stop offering setting. */
function minutesText(min) {
  const m = Number(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return `${h} hour${h === 1 ? "" : "s"}${r ? ` ${r} min` : ""}`;
}
function settingsSummaryText(batch, choice, stop) {
  const win = choice === "auto" ? "auto reply window" : choice === "fast" ? "fast demo reply window" : `${windowText(Number(choice) * 60)} to reply`;
  return `Offer settings: up to ${batch} per round · ${win} · stop ${minutesText(stop)} before`;
}
const replyDefaults = () => meta?.replyWindowDefaults ?? { sameDayMinutes: 15, laterMinutes: 120 };
function updateWindowHint() {
  const form = $("#opening-form");
  const choice = form.replyWindow.value;
  const isToday = form.date.value === meta?.today;
  const d = replyDefaults();
  let text;
  if (choice === "auto") {
    text = `Clients get ${isToday ? `${minutesText(d.sameDayMinutes)} (opening is today)` : `${minutesText(d.laterMinutes)} (opening is later)`} to reply, counted from when the texts go out.`;
  } else if (choice === "fast") text = "Fast demo: a clearly labelled 30-second reply window so you can watch rounds advance. Fast demo ignores texting hours.";
  else text = `Clients get ${windowText(Number(choice) * 60)} to reply, counted from when the texts go out.`;
  $("#window-hint").textContent = `${text} Shortened if needed so replies close before the “Stop offering” time.`;
  $("#offer-settings-summary").textContent = settingsSummaryText(form.batchSize.value, choice, form.stopOfferingMinutesBefore.value);
}

function openOpeningDialog(trigger) {
  dialogOpener = trigger ?? $("#add-opening-btn");
  if (!openingDialog.open) openingDialog.showModal();
  $("#f-service").focus();
}
openingDialog.addEventListener("close", () => {
  titleError = false;
  setTitle();
  if (skipReturnFocus) return;
  (dialogOpener?.isConnected ? dialogOpener : $("#add-opening-btn")).focus();
});
document.querySelectorAll("[data-close-dialog]").forEach((b) => b.addEventListener("click", () => b.closest("dialog")?.close()));

const FIELD_IDS = ["f-service", "f-stylist", "f-date", "f-time", "f-duration"];
function setFieldError(id, message) {
  const input = document.getElementById(id);
  const err = document.getElementById(`${id}-err`);
  if (message) {
    input.setAttribute("aria-invalid", "true");
    err.innerHTML = `${ICONS.alert}<span><span class="sr-only">Error:</span> ${esc(message)}</span>`;
    err.hidden = false;
  } else {
    input.removeAttribute("aria-invalid");
    err.textContent = "";
    err.hidden = true;
  }
}
function validate(form) {
  const errors = [];
  if (!form.service.value) errors.push(["f-service", "Choose a service"]);
  if (!form.stylist.value) errors.push(["f-stylist", "Choose a stylist"]);
  if (!form.date.value) errors.push(["f-date", "Enter a date"]);
  else if (meta?.today && form.date.value < meta.today) errors.push(["f-date", "Choose a date today or later"]);
  if (!form.time.value) errors.push(["f-time", "Enter a time"]);
  else if (form.date.value) {
    // Same rule as the workflow: outreach stops "Stop offering" minutes before the start.
    const [y, mo, dd] = form.date.value.split("-").map(Number);
    const [h, mi] = form.time.value.split(":").map(Number);
    const startMs = new Date(y, mo - 1, dd, h, mi).getTime();
    const stop = Number(form.stopOfferingMinutesBefore.value);
    if (startMs <= now()) errors.push(["f-time", "That time has already passed"]);
    else if (startMs - stop * 60_000 <= now()) {
      errors.push(["f-time", `Too close to the start time to offer it. Offers stop ${minutesText(stop)} before it starts: choose a later time or a shorter “Stop offering” time`]);
    }
  }
  const d = Number(form.durationMinutes.value);
  const { min, max } = meta?.durationLimits ?? { min: 30, max: 180 };
  if (!form.durationMinutes.value || !Number.isInteger(d) || d < min || d > max) errors.push(["f-duration", `Length must be between ${min} and ${max} minutes`]);
  return errors;
}
function showErrors(errors, serverMessage) {
  FIELD_IDS.forEach((id) => setFieldError(id, null));
  errors.forEach(([id, msg]) => setFieldError(id, msg));
  const box = $("#error-summary");
  const items = errors.map(([id, msg]) => `<li><a href="#${id}" data-focus-field="${id}">${esc(msg)}</a></li>`);
  if (serverMessage) items.push(`<li>Could not add the opening: ${esc(serverMessage)}</li>`);
  titleError = items.length > 0;
  setTitle();
  if (!items.length) {
    box.hidden = true;
    $("#error-list").innerHTML = "";
    return;
  }
  $("#error-list").innerHTML = items.join("");
  box.hidden = false;
  box.focus();
}
$("#error-list").addEventListener("click", (event) => {
  const a = event.target.closest("a[data-focus-field]");
  if (!a) return;
  event.preventDefault();
  document.getElementById(a.dataset.focusField)?.focus();
});

async function setupForm() {
  meta = await api("/api/meta");
  const sample = new Set(meta.sampleStylists ?? []);
  const stylistOption = (s, value = s) => `<option value="${esc(value)}">${esc(s)}${sample.has(s) ? " (sample name)" : ""}</option>`;
  const stylistOptions = meta.stylists.map((s) => stylistOption(s)).join("");
  $("#f-service").innerHTML = meta.services.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#f-stylist").innerHTML = stylistOptions;
  $("#wl-stylist").innerHTML = `<option value="">Any</option>${stylistOptions}`;
  $("#wl-service").innerHTML = `<option value="">Any</option>${meta.services.map((s) => `<option>${esc(s)}</option>`).join("")}`;
  $("#cl-service").innerHTML = meta.services.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#cl-preferred").innerHTML = `<option value="">No preference</option>${stylistOptions}`;
  $("#cl-only").innerHTML = stylistOptions;
  if (sample.size) {
    const names = [...sample];
    const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0];
    $("#f-stylist-hint").textContent = `${list} are sample names. Confirm with Lena.`;
    $("#wl-sample-stylists").textContent = `${list} are sample stylist names (confirm with Lena).`;
  } else {
    $("#f-stylist-hint").hidden = true;
    $("#wl-sample-stylists").hidden = true;
  }
  if (meta.stopOfferingOptions?.length) {
    $("#f-stop").innerHTML = meta.stopOfferingOptions
      .map((m) => `<option value="${m}" ${m === meta.defaultStopOfferingMinutes ? "selected" : ""}>${esc(minutesText(m))}</option>`)
      .join("");
  }
  if (meta.textingHours?.label) {
    $("#texting-hours-text").textContent = `Offer texts go out ${meta.textingHours.label} salon time (Lena: “sounds about right”). Same-day openings can be texted any time. Fast demo ignores texting hours.`;
  }
  const lim = meta.durationLimits ?? { min: 30, max: 180 };
  $("#f-duration").min = lim.min;
  $("#f-duration").max = lim.max;
  $("#f-duration-hint").textContent = `In minutes, ${lim.min} to ${lim.max}. Filled in from the service; change it if needed.`;
  const fillDuration = () => {
    const d = meta.serviceDurations?.[$("#f-service").value];
    if (d) $("#f-duration").value = d;
  };
  fillDuration();
  // Default start: about 2¼ hours from now, so it's clear of the default 1-hour "Stop offering" cutoff.
  const t = new Date(now());
  t.setMinutes(Math.ceil((t.getMinutes() + 135) / 15) * 15, 0, 0);
  const tDate = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  $("#f-date").value = tDate < meta.today ? meta.today : tDate;
  $("#f-date").min = meta.today;
  $("#f-time").value = `${pad(t.getHours())}:${pad(t.getMinutes())}`;
  $("#temporal-ui").href = `${meta.temporalUi}/namespaces/default/workflows`;
  updateWindowHint();
  const form = $("#opening-form");
  $("#f-service").addEventListener("change", fillDuration);
  form.addEventListener("change", updateWindowHint);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (creating) return;
    const errors = validate(form);
    if (errors.length) return showErrors(errors);
    showErrors([]);
    const fd = new FormData(form);
    const choice = fd.get("replyWindow");
    const body = {
      service: fd.get("service"),
      stylist: fd.get("stylist"),
      startsAt: `${fd.get("date")}T${fd.get("time")}`,
      durationMinutes: Number(fd.get("durationMinutes")),
      batchSize: Number(fd.get("batchSize")),
      stopOfferingMinutesBefore: Number(fd.get("stopOfferingMinutesBefore")),
      fastDemo: choice === "fast",
      replyWindowMinutes: choice === "auto" || choice === "fast" ? null : Number(choice),
      simulateTextFailure: fd.get("simulateTextFailure") === "on",
    };
    const btn = $("#create-btn");
    creating = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = "Finding matches…";
    try {
      const created = await api("/api/openings", { method: "POST", body });
      skipReturnFocus = true;
      openingDialog.close();
      skipReturnFocus = false;
      form.simulateTextFailure.checked = false;
      toast(`Opening added. Finding matches for ${body.service} with ${body.stylist}.`);
      statFilter = null;
      opTab = "active";
      setView("openings");
      applyTabs();
      await refresh();
      const card = document.getElementById(`card-${created.openingId}`);
      if (card && !card.closest("[hidden]")) {
        card.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
        card.querySelector(".opening-title")?.focus({ preventScroll: true });
      } else {
        $("#add-opening-btn").focus();
      }
    } catch (error) {
      showErrors([], error.message);
    } finally {
      creating = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = "Find matches";
    }
  });
}

// ---------------------------------------------------------------------------
// Confirm dialog (one shared <dialog>)
// ---------------------------------------------------------------------------
const confirmDialog = $("#confirm-dialog");
let confirmResolve = null;
let confirmTrigger = null;
/** Resolve the confirm that is open right now (once), then close the box. */
function settleConfirm(ok) {
  const resolve = confirmResolve;
  confirmResolve = null;
  const reason = $("#confirm-reason").value.trim();
  if (confirmDialog.open) confirmDialog.close(ok ? "ok" : "cancel");
  resolve?.({ ok, reason });
}
function openConfirm({ title, body, actionLabel, safeLabel, variant, withReason, metaLine = "Any texts are simulated." }) {
  confirmTrigger = { el: document.activeElement, card: document.activeElement?.closest?.("article.opening")?.id };
  $("#confirm-h").textContent = title;
  $("#confirm-body").textContent = body;
  $("#confirm-meta").textContent = metaLine;
  $("#confirm-reason-field").hidden = !withReason;
  $("#confirm-reason").value = "";
  $("#confirm-ok").textContent = actionLabel;
  $("#confirm-ok").className = `btn ${variant === "danger" ? "btn-danger-solid" : "btn-primary"}`;
  $("#confirm-safe").textContent = safeLabel;
  confirmResolve?.({ ok: false, reason: "" }); // an earlier confirm that never settled
  confirmDialog.returnValue = "";
  confirmDialog.showModal();
  $("#confirm-safe").focus();
  return new Promise((resolve) => (confirmResolve = resolve));
}
// "Confirm" is the form's only submit button, so Enter in the Reason field confirms.
confirmDialog.querySelector("form").addEventListener("submit", (event) => {
  event.preventDefault();
  settleConfirm(true);
});
$("#confirm-safe").addEventListener("click", () => settleConfirm(false));
confirmDialog.addEventListener("cancel", (event) => {
  event.preventDefault(); // Escape: settle this confirm ourselves rather than waiting on "close"
  settleConfirm(false);
});
confirmDialog.addEventListener("close", () => {
  // A late "close" from an earlier confirm must not touch one that is open now.
  if (confirmDialog.open) return;
  if (confirmResolve) settleConfirm(false);
  const t = confirmTrigger;
  if (t?.el?.isConnected) t.el.focus();
  else if (t?.card) document.getElementById(t.card)?.querySelector(".opening-title")?.focus();
});

// ---------------------------------------------------------------------------
// Add to waitlist drawer (same pattern as Add opening)
// ---------------------------------------------------------------------------
const clientDialog = $("#client-dialog");
const clientForm = $("#client-form");
let clientOpener = null;
let addingClient = false;
let skipClientReturn = false;
const CL_FIELDS = { name: "cl-name", mobile: "cl-mobile", service: "cl-service", stylistRule: "cl-rule", availabilityNote: "cl-note", textingConsent: "cl-consent" };
/** Where an error link should land: the input itself, or the first option of a radio group. */
const focusTargetFor = (id) => {
  const el = document.getElementById(id);
  return el?.tagName === "FIELDSET" ? el.querySelector("input:checked") ?? el.querySelector("input") : el;
};

function setGroupError(id, message) {
  const el = document.getElementById(id);
  const err = document.getElementById(`${id}-err`);
  if (!el || !err) return;
  if (el.tagName === "FIELDSET") el.classList.toggle("is-invalid", Boolean(message));
  else if (message) el.setAttribute("aria-invalid", "true");
  else el.removeAttribute("aria-invalid");
  if (message) {
    err.innerHTML = `${ICONS.alert}<span><span class="sr-only">Error:</span> ${esc(message)}</span>`;
    err.hidden = false;
  } else {
    err.textContent = "";
    err.hidden = true;
  }
}
function syncRuleFields() {
  const only = clientForm.ruleKind.value === "required";
  $("#cl-only-field").hidden = !only;
  $("#cl-preferred-field").hidden = only;
}
const digitsOf = (m) => {
  const d = String(m ?? "").replace(/\D/g, "");
  return d.length === 11 && d.startsWith("1") ? d.slice(1) : d;
};
/** Texting consent goes with the mobile number: show the answer already on file for it. */
function updateKnownConsent() {
  const d = digitsOf(clientForm.mobile.value);
  const el = $("#cl-consent-known");
  const match = d.length >= 10 ? (lastData?.waitlist?.clients ?? []).filter((c) => digitsOf(c.mobile) === d && consentOf(c) !== "not_asked") : [];
  const latest = match.sort((a, b) => ((a.consentRecordedAt ?? "") < (b.consentRecordedAt ?? "") ? 1 : -1))[0];
  el.hidden = !latest;
  el.textContent = latest
    ? `This number is already on the waitlist (${latest.name}): ${CONSENT[consentOf(latest)][1]}. Yes or No here updates every entry with this number; Didn't ask keeps that answer.`
    : "";
}
function resetClientForm() {
  clientForm.reset();
  syncRuleFields();
  showClientErrors([]);
  updateKnownConsent();
}
function openClientDialog(trigger) {
  clientOpener = trigger ?? $("#add-client-btn");
  if (!clientDialog.open) clientDialog.showModal();
  $("#cl-name").focus();
}
clientDialog.addEventListener("close", () => {
  titleError = false;
  setTitle();
  if (skipClientReturn) return;
  (clientOpener?.isConnected ? clientOpener : $("#add-client-btn")).focus();
});
clientForm.addEventListener("change", (event) => {
  if (event.target.name === "ruleKind") syncRuleFields();
});
clientForm.mobile.addEventListener("input", updateKnownConsent);

function validateClient(form) {
  const errors = [];
  if (!form.name.value.trim()) errors.push(["cl-name", "Enter their name"]);
  const digits = form.mobile.value.replace(/\D/g, "");
  if (!form.mobile.value.trim()) errors.push(["cl-mobile", "Enter their mobile number"]);
  else if (digits.length < 10 || digits.length > 15) errors.push(["cl-mobile", "Enter a valid mobile number, like (555) 010-0150"]);
  if (!form.service.value) errors.push(["cl-service", "Choose a service"]);
  if (form.ruleKind.value === "required" && !form.only.value) errors.push(["cl-rule", "Choose which stylist they need"]);
  if (!form.textingConsent.value) errors.push(["cl-consent", "Answer “Can we text them about earlier openings?”: Yes, No or Didn't ask"]);
  return errors;
}
function showClientErrors(errors, serverMessage) {
  Object.values(CL_FIELDS).forEach((id) => setGroupError(id, null));
  errors.forEach(([id, msg]) => setGroupError(id, msg));
  const box = $("#cl-error-summary");
  const items = errors.map(([id, msg]) => `<li><a href="#${id}" data-focus-field="${id}">${esc(msg)}</a></li>`);
  if (serverMessage) items.push(`<li>Could not add them: ${esc(serverMessage)}</li>`);
  titleError = items.length > 0;
  setTitle();
  if (!items.length) {
    box.hidden = true;
    $("#cl-error-list").innerHTML = "";
    return;
  }
  $("#cl-error-list").innerHTML = items.join("");
  box.hidden = false;
  box.focus();
}
$("#cl-error-list").addEventListener("click", (event) => {
  const a = event.target.closest("a[data-focus-field]");
  if (!a) return;
  event.preventDefault();
  focusTargetFor(a.dataset.focusField)?.focus();
});
clientForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (addingClient) return;
  const errors = validateClient(clientForm);
  if (errors.length) return showClientErrors(errors);
  showClientErrors([]);
  const f = clientForm;
  const body = {
    name: f.name.value.trim(),
    mobile: f.mobile.value.trim(),
    service: f.service.value,
    stylistRule: f.ruleKind.value === "required" ? { kind: "required", stylist: f.only.value } : { kind: "any", ...(f.preferred.value ? { preferred: f.preferred.value } : {}) },
    availabilityNote: f.availabilityNote.value,
    textingConsent: f.textingConsent.value,
  };
  const btn = $("#add-client-submit");
  addingClient = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "Adding…";
  try {
    const result = await api("/api/waitlist", { method: "POST", body });
    skipClientReturn = true;
    clientDialog.close();
    skipClientReturn = false;
    resetClientForm();
    toast(result.message || `${result.client?.name ?? body.name} added to the back of the waitlist.`);
    wlFilter = "waiting";
    setView("waitlist");
    await refresh();
    const row = result.client?.id && document.getElementById(`client-${result.client.id}`);
    if (row && !row.closest("[hidden]")) row.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "nearest" });
    $("#add-client-btn").focus({ preventScroll: true });
  } catch (error) {
    const fieldErrors = (error.body?.fieldErrors ?? []).filter((e) => CL_FIELDS[e.field]).map((e) => [CL_FIELDS[e.field], e.message]);
    showClientErrors(fieldErrors, fieldErrors.length ? "" : error.message);
  } finally {
    addingClient = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = "Add to waitlist";
  }
});

// ---------------------------------------------------------------------------
// Record texting answer (small dialog: Opted in / Opted out, then Save)
// ---------------------------------------------------------------------------
const consentDialog = $("#consent-dialog");
const consentForm = $("#consent-form");
let consentClient = null;
let consentTrigger = null;
let savingConsent = false;
const findClient = (id) => lastData?.waitlist?.clients?.find((c) => c.id === id);

function openConsentDialog(clientId, trigger) {
  const c = findClient(clientId);
  if (!c) return;
  consentClient = c;
  consentTrigger = { el: trigger, id: clientId };
  consentForm.reset();
  setGroupError("consent-group", null);
  $("#consent-h").textContent = `Record texting answer for ${c.name}`;
  $("#consent-body").textContent =
    `Can we text ${firstName(c.name)} about earlier openings? Right now: ${CONSENT[consentOf(c)][1]}. Only record what they told you.`;
  const notes = [];
  if (consentOf(c) === "opted_out") notes.push("They asked not to be texted. Only change this if they asked to get texts again.");
  if (c.holding && !c.holding.held) notes.push("They have an offer out now. If you record No, they won't get any more texts about it.");
  const sharing = (lastData?.waitlist?.clients ?? []).filter((x) => x.id !== c.id && digitsOf(x.mobile) === digitsOf(c.mobile)).length;
  if (sharing) notes.push(`The answer applies to this mobile number, so ${sharing} other waitlist ${sharing === 1 ? "entry" : "entries"} with it will change too.`);
  $("#consent-note").textContent = notes.join(" ");
  $("#consent-note").hidden = !notes.length;
  const current = consentForm.querySelector(`input[value="${consentOf(c)}"]`);
  if (current) current.checked = true;
  consentDialog.showModal();
  (consentForm.querySelector("input:checked") ?? consentForm.querySelector("input")).focus();
}
$("#consent-safe").addEventListener("click", () => consentDialog.close());
consentDialog.addEventListener("close", () => {
  const t = consentTrigger;
  consentTrigger = null;
  if (t?.el?.isConnected) return t.el.focus();
  const id = CSS.escape(t?.id ?? "");
  // The row re-rendered (the answer changed): land on the same row's controls, else the panel's button.
  (document.querySelector(`[data-action="wl-consent"][data-id="${id}"]`) ??
    document.querySelector(`[data-action="wl-manage"][data-id="${id}"]`) ??
    $("#add-client-btn")).focus();
});
consentForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingConsent || !consentClient) return;
  const answer = consentForm.answer.value;
  if (answer !== "opted_in" && answer !== "opted_out") {
    setGroupError("consent-group", "Choose Yes, opted in or No, opted out");
    consentForm.querySelector("input").focus();
    return;
  }
  const btn = $("#consent-ok");
  savingConsent = true;
  btn.setAttribute("aria-busy", "true");
  btn.textContent = "Saving…";
  busy = true;
  try {
    const result = await api(`/api/waitlist/${encodeURIComponent(consentClient.id)}/consent`, { method: "POST", body: { textingConsent: answer } });
    consentDialog.close();
    toast(
      result.message ||
        `${consentClient.name}: ${answer === "opted_in" ? "opted in. They can now be suggested and texted." : "opted out. They won't be suggested or texted."}`,
    );
  } catch (error) {
    setGroupError("consent-group", error.message);
  } finally {
    savingConsent = false;
    busy = false;
    btn.removeAttribute("aria-busy");
    btn.textContent = "Save answer";
    const id = consentClient?.id;
    await refresh();
    // The row's "Record texting answer" button goes away once they've answered: keep focus on that row.
    if (!consentDialog.open && (!document.activeElement || document.activeElement === document.body) && id) {
      (document.querySelector(`[data-action="wl-manage"][data-id="${CSS.escape(id)}"]`) ?? $("#add-client-btn")).focus();
    }
  }
});

async function removeFromWaitlist(clientId, trigger) {
  const c = findClient(clientId);
  if (!c) return;
  const { ok, reason } = await openConfirm({
    title: `Remove ${c.name} from the waitlist?`,
    body: "Only remove someone who asked to come off the list. They won't be suggested or texted again, and they stay under “All” for history. Nobody is texted about this.",
    metaLine: "This can't be undone here: adding them again puts them at the back of the line.",
    actionLabel: "Remove from waitlist",
    safeLabel: "Keep them",
    variant: "danger",
    withReason: true,
  });
  if (!ok) return;
  busy = true;
  if (trigger?.isConnected) {
    trigger.setAttribute("aria-busy", "true");
    trigger.textContent = "Removing…";
  }
  try {
    const result = await api(`/api/waitlist/${encodeURIComponent(clientId)}/remove`, { method: "POST", body: reason ? { reason } : {} });
    wlManageOpen.delete(clientId);
    toast(result.message || `${c.name} was removed from the waitlist.`);
    busy = false;
    await refresh();
    $("#add-client-btn").focus();
  } catch (error) {
    toast(error.message, true);
  } finally {
    busy = false;
    if (lastData) {
      $("#waitlist")._html = null;
      renderWaitlist(lastData);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering: summary row
// ---------------------------------------------------------------------------
/** A late yes can only be booked or dismissed while the opening's workflow is still running. */
function lateYesOpen(o) {
  const s = o.state;
  return o.running !== false && !["cancelled", "left_open"].includes(s.status) && !(s.status === "filled" && s.square.done);
}
const pendingLate = (s) => s.offers.filter((x) => x.lateReply === "expired" && !x.lateYesResolved);
/** The appointment time has already gone by (server clock). */
const isPast = (s) => s.opening.startsAtMs !== undefined && s.opening.startsAtMs < now();

function classify(o) {
  const s = o.state;
  if (!s) return { group: "finished", key: "unknown" };
  const lateYes = pendingLate(s).length > 0 && lateYesOpen(o);
  const held = s.status === "filled" && !s.square.done;
  let group = "finished";
  if (s.status === "awaiting_approval" || held || s.status === "unfilled" || lateYes) group = "needs";
  else if (s.status === "finding_matches" || s.status === "offering") group = "waiting";
  const past = group !== "finished" && !held && isPast(s);
  // Scheduled rounds (waiting for texting hours) have sent nothing, so they aren't "Offers out".
  const key = held ? "held" : s.status === "offering" && s.scheduled ? "scheduled" : s.status;
  return { group, key, held, lateYes, past };
}

const STATS = [
  ["awaiting_approval", "Needs your OK", "warn", true],
  ["held", "Held · confirm in Square", "held", true],
  ["unfilled", "Not filled", "nobody", true],
  ["offering", "Offers out", "info", false],
];
function renderSummary(data) {
  const counts = { awaiting_approval: 0, held: 0, unfilled: 0, offering: 0 };
  for (const o of data.openings) {
    const k = classify(o).key;
    if (k in counts) counts[k]++;
  }
  const r = data.refill;
  const closed = r.filled + r.unfilled + r.leftOpen;
  const pct = r.rate == null ? null : Math.round(r.rate * 100);
  const items = STATS.map(([key, label, tone, action]) => {
    const n = counts[key];
    const pressed = statFilter === key;
    const flag = n && action;
    return `<li><button type="button" class="stat stat--${tone}${n ? " is-nonzero" : ""}" data-action="stat-filter" data-stat="${key}" aria-pressed="${pressed}">
      <span class="stat-value">${n}</span>
      <span class="stat-text">
        <span class="stat-label">${flag ? ICONS.alert : ""}<span>${label}${flag ? '<span class="sr-only">, action needed</span>' : ""}</span></span>
        ${pressed ? `<span class="stat-on">${ICONS.check}Filtering list</span>` : ""}
      </span>
    </button></li>`;
  }).join("");
  const refill = `
      <div class="refill-top"><span class="stat-label" id="refill-h">Last-minute chairs refilled</span><span class="refill-value num">${closed ? `${r.filled} of ${closed} (${pct}%)` : "No finished openings yet"}</span></div>
      <div class="meter" aria-hidden="true">
        <div class="meter-fill" style="width:${pct ?? 0}%"></div>
        <span class="meter-tick" style="left:${r.baseline * 100}%"></span>
        <span class="meter-tick" style="left:${r.goal * 100}%"></span>
      </div>
      <p class="stat-note">~${Math.round(r.baseline * 100)}% before · ${Math.round(r.goal * 100)}% goal</p>
      <p class="stat-note">Counts openings that start within ${r.lastMinuteHours ?? 48} hours of being added, Lena’s “last-minute”.${r.later?.closed ? ` Openings further ahead: ${r.later.filled} of ${r.later.closed} refilled, not counted.` : ""}</p>
      <p class="stat-note">Prototype data, not proof of the business goal. Held and cancelled openings aren’t counted.</p>`;
  patch($("#summary"), items);
  patch($("#refill"), refill);
}

// ---------------------------------------------------------------------------
// Rendering: opening cards
// ---------------------------------------------------------------------------
function ruleText(rule) {
  if (rule.kind === "required") return `Only ${rule.stylist}`;
  return rule.preferred ? `Any stylist (prefers ${rule.preferred})` : "Any stylist";
}
const firstName = (name) => String(name ?? "").split(" ")[0];
const windowChoice = (op) => (op.fastDemo ? "fast" : String(op.replyWindowSeconds / 60));

function textPreview(text, metaLine) {
  return `<figure class="text-preview" aria-label="Simulated text, not sent">
      <figcaption class="sim-label">${ICONS.message}Simulated text — not sent</figcaption>
      <blockquote class="text-preview-body"><p>${esc(text)}</p></blockquote>
      ${metaLine ? `<p class="text-preview-meta">${metaLine}</p>` : ""}
    </figure>`;
}

function statusChip(s) {
  switch (s.status) {
    case "finding_matches": return chip("info", "Finding matches", "dot");
    case "awaiting_approval": return chip("warn", "Needs your OK", "alert");
    case "offering": return s.scheduled ? chip("info", "Scheduled", "clock") : chip("info", "Offers out", "send");
    case "filled": return s.square.done ? chip("ok", "Booked", "check") : chip("held", "Held · confirm in Square", "clock");
    case "unfilled":
      return s.unfilledKind === "too_close" || s.unfilledKind === "time_passed"
        ? chip("nobody", s.unfilledKind === "too_close" ? "Too close to start" : "Time passed", "dash")
        : chip("nobody", "Nobody took it", "dash");
    case "cancelled": return chip("neutral", "Cancelled", "ban");
    case "left_open": return chip("neutral", "Left open", "dot");
    default: return chip("neutral", "Unknown", "dot");
  }
}

function approveCountText(size, n) {
  if (!size) return "Nobody selected yet.";
  return size > n ? `${size} approved. The rest are next if nobody says yes.` : `${size} approved.`;
}
function approvalSummaryText(settings) {
  const w = settings.replyWindow === "fast" ? "Fast demo: 30 seconds" : `${windowText(Number(settings.replyWindow) * 60)} to reply`;
  return `Offer settings: ${settings.batchSize} per round · ${w}`;
}

function renderApproval(id, s) {
  if (!selections.has(id)) selections.set(id, new Set(s.suggestions.map((m) => m.clientId)));
  const sel = selections.get(id);
  const settings = approvalSettings.get(id) ?? { batchSize: s.opening.batchSize, replyWindow: windowChoice(s.opening) };
  approvalSettings.set(id, settings);
  const windowOptions = [["10", "10 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"], ["fast", "Fast demo: 30 seconds"]];
  if (!windowOptions.some(([v]) => v === settings.replyWindow)) windowOptions.unshift([settings.replyWindow, windowText(Number(settings.replyWindow) * 60)]);
  const n = Math.min(sel.size, Number(settings.batchSize));
  const open = openSettings.has(id);
  const eid = esc(id);
  return `
    <div class="panel">
      <div class="panel-head">
        <h5 class="panel-title">Approve who gets texted</h5>
        ${s.cycle > 1 ? chip("neutral", s.cycle === 2 ? "Second try" : `Try ${s.cycle}`, "dot") : ""}
      </div>
      <p class="meta">Earliest joiner first · wants this service · stylist rule fits · opted in to texts.</p>
      <p class="panel-key">Nothing is sent until you approve. <span class="panel-key-sub">Untick anyone who shouldn't get it.</span></p>
      <ul class="picks">
        ${s.suggestions
          .map(
            (m) => `<li><label class="pick">
              <input type="checkbox" data-select="${eid}" value="${esc(m.clientId)}" ${sel.has(m.clientId) ? "checked" : ""} />
              <span class="pick-body">
                <span class="pick-top"><span class="pick-name">${esc(m.name)}</span>${m.checkNote ? chip("warn", "Check note", "alert") : ""}${m.prefersThisStylist ? chip("neutral", "Prefers this stylist", "dot") : ""}${m.textedBefore ? chip("neutral", "Texted before — no reply", "dot") : ""}</span>
                <span class="pick-note">“${esc(m.availabilityNote)}”</span>
                <span class="pick-meta">${esc(ruleText(m.stylistRule))} · joined ${esc(shortDate(m.joinedAt))}</span>
              </span>
            </label></li>`,
          )
          .join("")}
      </ul>
      <div class="settings-line">
        <span class="settings-summary">${esc(approvalSummaryText(settings))}</span>
        <button type="button" class="btn btn-quiet btn-sm" data-action="toggle-settings" data-id="${eid}" aria-expanded="${open}" aria-controls="set-${eid}">${ICONS.pencil}Change<span class="sr-only"> offer settings</span></button>
      </div>
      <fieldset class="settings" id="set-${eid}" ${open ? "" : "hidden"}>
        <legend>How to offer it</legend>
        <div class="field">
          <label for="bs-${eid}">Texts per round</label>
          <select id="bs-${eid}" data-setting="batchSize" data-id="${eid}">
            ${[1, 2, 3, 4, 5].map((k) => `<option ${Number(settings.batchSize) === k ? "selected" : ""}>${k}</option>`).join("")}
          </select>
        </div>
        <div class="field">
          <label for="rw-${eid}">Reply window</label>
          <select id="rw-${eid}" data-setting="replyWindow" data-id="${eid}">
            ${windowOptions.map(([v, l]) => `<option value="${esc(v)}" ${settings.replyWindow === v ? "selected" : ""}>${esc(l)}</option>`).join("")}
          </select>
        </div>
      </fieldset>
      ${timingNote(s)}
      <div class="actions">
        <button type="button" class="btn btn-primary btn-block-phone" data-action="approve" data-id="${eid}" aria-describedby="cnt-${eid}" ${sel.size ? "" : 'aria-disabled="true"'}>Approve &amp; text ${n}</button>
        ${s.cycle > 1 ? `<button type="button" class="btn btn-secondary" data-action="leave-open" data-id="${eid}">Leave it open, don't text anyone</button>` : ""}
      </div>
      <p class="meta approve-count" id="cnt-${eid}">${approveCountText(sel.size, n)}</p>
      <p class="inline-error" role="alert" hidden>${ICONS.alert}<span>Choose at least one person to text.</span></p>
    </div>`;
}

/** Checkbox / select changes patch only these bits, so focus never moves. */
function patchApproval(id) {
  const card = document.getElementById(`card-${id}`);
  const sel = selections.get(id) ?? new Set();
  const settings = approvalSettings.get(id);
  if (!card || !settings) return;
  const n = Math.min(sel.size, Number(settings.batchSize));
  const btn = card.querySelector('[data-action="approve"]');
  if (btn && !btn.hasAttribute("aria-busy")) {
    btn.textContent = `Approve & text ${n}`;
    if (sel.size) btn.removeAttribute("aria-disabled");
    else btn.setAttribute("aria-disabled", "true");
  }
  const count = card.querySelector(".approve-count");
  if (count) count.textContent = approveCountText(sel.size, n);
  const sum = card.querySelector(".settings-summary");
  if (sum) sum.textContent = approvalSummaryText(settings);
  if (sel.size) card.querySelector(".inline-error")?.setAttribute("hidden", "");
}

const OFFER_STATUS = {
  live: ["info", "Waiting for reply", "clock"],
  sending: ["info", "Sending…", "send"],
  declined: ["neutral", "Declined", "dot"],
  timed_out: ["neutral", "No reply", "dot"],
  told_filled: ["neutral", "Told filled", "dot"],
  accepted: ["ok", "Said yes", "check"],
  released: ["neutral", "Hold released", "dot"],
  told_cancelled: ["neutral", "Told cancelled", "dot"],
};

const hoursLabel = () => meta?.textingHours?.label ?? "9:00 AM–8:00 PM";
/** When outreach stops ("Offers stop at 1:30 PM, 1 hour before it starts"), plus who texting hours apply to. */
function timingNote(s) {
  const stop = s.opening.stopOfferingMinutesBefore ?? meta?.defaultStopOfferingMinutes ?? 60;
  const cutoff = s.offeringCutoffAt ? `Offers stop ${cutoffAt(s)}, ${minutesText(stop)} before it starts.` : "";
  const isToday = s.opening.startsAt?.slice(0, 10) === meta?.today;
  const hours = s.opening.fastDemo
    ? "Fast demo ignores texting hours."
    : isToday
      ? "Same-day opening: texting hours don't apply."
      : `Offer texts go out ${hoursLabel()}; outside those hours they're scheduled.`;
  return `<p class="opening-note">${ICONS.clock}<span>${esc([cutoff, hours].filter(Boolean).join(" "))}</span></p>`;
}
function bypassChip(s) {
  // The card's progress line already carries the full "Fast demo ignores texting hours" label.
  if (s.opening.fastDemo) return chip("demo", "Fast demo", "message");
  if (s.textingCheck?.bypass === "same_day" && !s.textingCheck.withinHours) return chip("neutral", "Same-day: sent outside texting hours", "dot");
  return "";
}

function renderScheduled(id, s) {
  const sc = s.scheduled;
  // Only people who can still be texted (anyone removed or opted out since approval is skipped at send time).
  const nextUp = s.queue
    .filter((cid) => findClient(cid)?.textable !== false)
    .map((cid) => s.suggestions.find((m) => m.clientId === cid)?.name ?? cid);
  return `
    <div class="panel panel--info">
      <div class="panel-head"><h5 class="panel-title">${esc(sc.text)}</h5></div>
      <p>It's outside texting hours (<span class="nw">${esc(hoursLabel())}</span>), so nothing is sent until <span class="nw">${esc(sc.untilLabel || salonClock(s, sc.until))}</span>. You can still cancel the opening.</p>
      ${s.offeringCutoffAt ? `<p class="meta">Offers stop ${esc(cutoffAt(s))}. The reply window is shortened if needed to end by then.</p>` : ""}
      <p class="meta">${nextUp.length ? `First to be texted: ${esc(nextUp.slice(0, s.opening.batchSize).join(", "))}` : ""}</p>
    </div>`;
}

function renderOffering(id, s) {
  if (s.scheduled) return renderScheduled(id, s);
  const round = s.currentRound;
  const roundOffers = round ? s.offers.filter((o) => round.offerIds.includes(o.offerId)) : [];
  const nextUp = s.queue.map((cid) => s.suggestions.find((m) => m.clientId === cid)?.name ?? cid);
  const sending = roundOffers.some((o) => o.status === "sending");
  const sent = roundOffers.find((o) => o.smsText);
  const capped =
    round?.windowCapped && round.replyWindowSeconds
      ? `<p class="opening-note">${ICONS.info}<span>Reply window shortened to ${esc(windowText(round.replyWindowSeconds))} so replies close before the cutoff ${esc(cutoffAt(s))} (offers stop ${esc(minutesText(s.opening.stopOfferingMinutesBefore ?? 60))} before it starts).</span></p>`
      : "";
  return `
    <div class="panel">
      <h5 class="panel-title">${round ? (sending ? "Sending texts…" : "Waiting for replies") : "Getting the next round ready…"}</h5>
      ${
        roundOffers.length
          ? `<ul class="offered">${roundOffers
              .map((o) => {
                const [tone, word, icon] = OFFER_STATUS[o.status] ?? ["neutral", o.status, "dot"];
                return `<li>
                  <div class="offered-main">
                    <span class="offered-top"><span class="pick-name">${esc(o.name)}</span>${chip(tone, word, icon)}</span>
                    ${o.status === "live" && o.deadline ? `<span class="meta">Reply by ${esc(salonClock(s, o.deadline))} ${countdownSpan(o.deadline)}</span>` : ""}
                  </div>
                  ${o.status === "live" ? `<a class="btn btn-secondary btn-sm" href="${offerUrl(id, o)}" target="_blank" rel="noopener">Preview client’s text (simulated)<span class="sr-only"> for ${esc(o.name)}, opens in new tab</span></a>` : ""}
                </li>`;
              })
              .join("")}</ul>`
          : ""
      }
      ${capped}
      ${sent ? textPreview(sent.smsText.replace(/https?:\/\/\S+/, "[offer link]"), `To ${esc(sent.name)}${sent.sentAt ? ` · would have been sent ${esc(salonClock(s, sent.sentAt))}` : ""}`) : ""}
      ${round?.deadline ? `<p class="meta row-wrap">First yes wins.${bypassChip(s) ? ` ${bypassChip(s)}` : ""}</p>` : ""}
      <p class="meta">${nextUp.length ? `Next up: ${esc(nextUp.join(", "))}` : "Next up: nobody. This is the last round."}</p>
    </div>`;
}

function renderHeld(id, s, ctx) {
  const w = s.winner;
  const booking = s.bookingRecorded;
  const eid = esc(id);
  return `
    <div class="panel">
      <h5 class="panel-title">Held for ${esc(w?.name)}</h5>
      <p>Said yes at ${esc(salonClock(s, w?.acceptedAt))}${w?.via === "late_yes" ? " (booked from a late yes)" : ""}.
        ${booking?.applied ? "Marked booked on the waitlist." : booking ? `<strong class="danger-text">Waitlist not updated: ${esc(booking.reason)} — check before confirming.</strong>` : "Updating waitlist…"}</p>
      <p>Hold releases at <strong>${esc(salonClock(s, w?.holdUntil))}</strong> ${countdownSpan(w?.holdUntil ?? 0, 120_000)} if not confirmed.</p>
      <p class="panel-key">To do: confirm with ${esc(firstName(w?.name))} and update the appointment in Square.</p>
      <p class="meta">This prototype doesn't change Square.</p>
      <div class="actions actions--split">
        <button type="button" class="btn btn-primary" data-action="ask" data-confirm="square-done" data-id="${eid}">Done — updated in Square<span class="sr-only"> for ${esc(w?.name)}, ${esc(ctx)}</span></button>
        <button type="button" class="btn btn-secondary" data-action="ask" data-confirm="release-hold" data-id="${eid}">Couldn't confirm — release hold<span class="sr-only"> for ${esc(w?.name)}</span></button>
      </div>
    </div>`;
}

function renderStatusBlock(id, s, ctx, past = false) {
  const eid = esc(id);
  switch (s.status) {
    case "finding_matches":
      return `<div class="panel"><div class="skeleton-line" aria-hidden="true"></div><p>Checking the waitlist…</p></div>`;
    case "awaiting_approval":
      return renderApproval(id, s);
    case "offering":
      return renderOffering(id, s);
    case "unfilled": {
      const noMatches = s.unfilledKind === "no_matches";
      const tooClose = s.unfilledKind === "too_close" && !past;
      const passed = s.unfilledKind === "time_passed" || past;
      const stopped = passed || tooClose;
      const help = stopped
        ? "“Leave it open” closes it. It counts as not refilled."
        : noMatches
          ? "“Check again” reads the current waitlist again. “Leave it open” counts as not refilled."
          : "“Keep trying” checks the waitlist again and asks you to approve. Anyone who said no is skipped; people texted before with no reply go to the end of the list. “Leave it open” counts as not refilled.";
      const reason = passed && s.unfilledKind !== "time_passed" ? "The appointment time has passed." : s.unfilledReason;
      return `
        <div class="panel">
          <h5 class="panel-title">${passed ? "The time has passed" : tooClose ? "Stopped offering" : "What next?"}</h5>
          ${reason ? `<p>${esc(reason)}</p>` : ""}
          <p class="meta">${help}</p>
          <div class="actions">
            ${stopped ? "" : `<button type="button" class="btn btn-primary" data-action="keep-trying" data-id="${eid}">${noMatches ? "Check again" : "Keep trying"}</button>`}
            <button type="button" class="btn ${stopped ? "btn-primary" : "btn-secondary"}" data-action="leave-open" data-id="${eid}">Leave it open</button>
          </div>
        </div>`;
    }
    case "filled":
      if (s.square.done) {
        return `<p class="outcome-line">${ICONS.check}<span>Booked for ${esc(s.winner?.name)}. Confirmed in Square at ${esc(salonClock(s, s.square.doneAt))}.</span></p>`;
      }
      return renderHeld(id, s, ctx);
    case "cancelled":
      return `<p class="outcome-line">${s.cancelReason ? `${esc(s.cancelReason)}. ` : ""}Anyone holding an offer was told it's no longer available.</p>`;
    case "left_open":
      return `<p class="outcome-line">Stopped offering. Counted as not refilled.</p>`;
    default:
      return "";
  }
}

function renderLateYes(id, s, open = true) {
  const pending = pendingLate(s);
  if (!pending.length) return "";
  if (!open) {
    return pending
      .map((o) => `<p class="outcome-line">${ICONS.info}<span>${esc(o.name)} said yes late, after outreach closed. No action needed.</span></p>`)
      .join("");
  }
  const canBook = !["filled", "cancelled", "left_open"].includes(s.status);
  // One main button per card: Book is primary unless the status panel already has one.
  const bookClass = ["awaiting_approval", "unfilled"].includes(s.status) ? "btn-secondary" : "btn-primary";
  return pending
    .map(
      (o) => `
    <div class="panel panel--warn">
      <h5 class="panel-title">${esc(o.name)} said yes late</h5>
      <p>Replied at ${esc(salonClock(s, o.lateYesAt))}, after the reply window ended. Not booked yet. They were told the salon will check.</p>
      <div class="actions">
        ${canBook ? `<button type="button" class="btn ${bookClass}" data-action="late-book" data-offer="${esc(o.offerId)}" data-id="${esc(id)}">Book ${esc(firstName(o.name))}</button>` : `<p class="meta">Too late to book here — ${s.status === "filled" ? "someone else holds it" : "outreach is closed"}.</p>`}
        <button type="button" class="btn btn-secondary" data-action="late-dismiss" data-offer="${esc(o.offerId)}" data-id="${esc(id)}">Dismiss<span class="sr-only"> ${esc(o.name)}'s late yes</span></button>
      </div>
    </div>`,
    )
    .join("");
}

function renderPeople(s) {
  if (!s.offers.length) return "";
  // One entry per person (their latest offer), so nobody shows up in two lists across Keep-trying tries.
  const latest = new Map();
  for (const x of s.offers) latest.set(x.clientId, x);
  const people = [...latest.values()].filter((x) => x.offerId !== s.winner?.offerId);
  const label = (x) => (s.cycle > 1 ? `${x.name} (try ${x.cycle})` : x.name);
  const by = (st) => people.filter((x) => x.status === st).map(label);
  const rows = [
    ["Declined", by("declined")],
    ["No reply", by("timed_out")],
    ["Told filled", by("told_filled")],
    ["Hold released", by("released")],
    ["Told cancelled", by("told_cancelled")],
  ].filter(([, list]) => list.length);
  if (!rows.length) return "";
  return `<dl class="people">${rows.map(([dt, list]) => `<div><dt>${dt}</dt><dd>${esc(list.join(", "))}</dd></div>`).join("")}</dl>`;
}

function renderFoot(o, s, title, ctx) {
  const id = o.workflowId;
  const closed = ["filled", "cancelled", "left_open"].includes(s.status);
  const canCancel = !closed || (s.status === "filled" && !s.square.done);
  return `<div class="opening-foot">
      <details class="history" data-history="${esc(id)}" ${openHistory.has(id) ? "open" : ""}>
        <summary>History (${s.history.length})</summary>
        <ol class="timeline">
          ${[...s.history]
            .reverse()
            .map(
              (h) =>
                `<li><time datetime="${new Date(h.at).toISOString()}">${esc(salonClock(s, h.at))}</time><span>${/^simulated text/i.test(h.text) ? `${chip("demo", "Simulated", "message")} ` : ""}${esc(h.text)}</span></li>`,
            )
            .join("")}
        </ol>
      </details>
      <a class="foot-link" href="${esc(o.temporalUrl)}" target="_blank" rel="noopener">View workflow in Temporal${ext}<span class="sr-only"> (opens in new tab)</span></a>
      ${canCancel ? `<button type="button" class="btn btn-danger-quiet" data-action="ask" data-confirm="cancel" data-id="${esc(id)}">Cancel opening<span class="sr-only">: ${esc(title)}, ${esc(ctx)}</span></button>` : ""}
    </div>`;
}

function renderCard(o, c, group) {
  const id = o.workflowId;
  const eid = esc(id);
  if (!o.state) {
    return `<article class="opening" id="card-${eid}" data-id="${eid}" data-key="unknown" aria-labelledby="op-${eid}-title">
      <div class="opening-head">
        <div class="opening-heading"><h4 class="opening-title" id="op-${eid}-title" tabindex="-1">${eid}</h4></div>
        <div class="opening-chips">${chip("neutral", "Unknown", "dot")}</div>
      </div>
      <p class="outcome-line">${
        !o.running && /nondeterminism/i.test(o.error ?? "")
          ? "Closed opening from an earlier prototype build — its full history is still in Temporal."
          : `Can't read this opening right now${o.error ? `: ${esc(o.error)}` : ""}. Is the Worker running?`
      }</p>
      <div class="opening-foot"><a class="foot-link" href="${esc(o.temporalUrl)}" target="_blank" rel="noopener">View in Temporal${ext}<span class="sr-only"> (opens in new tab)</span></a></div>
    </article>`;
  }
  const s = o.state;
  const op = s.opening;
  const slot = slotParts(op.startsAt, op.durationMinutes);
  const title = `${op.service} · ${op.stylist}`;
  const ctx = `${slot.short}`;
  const round = s.currentRound;
  const roundOffers = round ? s.offers.filter((x) => round.offerIds.includes(x.offerId)) : [];
  const progress =
    s.status === "offering" && round
      ? `Round ${round.number} · ${roundOffers.length} texted`
      : `Up to ${op.batchSize} per round · ${windowText(op.replyWindowSeconds)} to reply${op.stopOfferingMinutesBefore ? ` · stops ${minutesText(op.stopOfferingMinutesBefore)} before` : ""}`;
  const demoChips = `${op.fastDemo ? chip("demo", "Fast demo ignores texting hours", "message") : ""}${op.simulateTextFailure ? chip("demo", "Simulated text failure", "message") : ""}`;
  const tone =
    group !== "needs" ? "" : c.lateYes && s.status !== "filled" && s.status !== "unfilled" ? "warn" : c.held ? "held" : s.status === "unfilled" ? "nobody" : "warn";
  // Each part of the date line stays whole ("12:30 PM" never splits); separators lead the next part.
  const when = [slot.rel ? `${slot.rel} · ${slot.day}` : slot.day, slot.range, `${op.durationMinutes} min`]
    .map((part, i) => `<span class="nw">${i ? "· " : ""}${esc(part)}</span>`)
    .join(" ");
  const titleHtml = `<h4 class="opening-title${s.status === "cancelled" ? " is-struck" : ""}" id="op-${eid}-title" tabindex="-1">${esc(title)}<span class="sr-only">, ${esc(slot.day)} ${esc(slot.start)}</span></h4>`;
  const chips = `<div class="opening-chips">${statusChip(s)}${c.past ? chip("neutral", "Past", "clock") : ""}${c.lateYes ? chip("warn", "Late yes", "alert") : ""}${o.lastMinute ? chip("neutral", `Last-minute (within ${lastData?.refill?.lastMinuteHours ?? 48} h)`, "clock") : ""}</div>`;
  if (group === "finished") {
    const open = expanded.has(id);
    return `<article class="opening opening--finished" id="card-${eid}" data-id="${eid}" data-key="${esc(c.key)}" aria-labelledby="op-${eid}-title">
      <div class="opening-head">
        <div class="opening-heading">${titleHtml}<p class="opening-when">${when}</p></div>
        ${chips}
        <button type="button" class="btn btn-quiet btn-sm details-toggle" data-action="toggle-details" data-id="${eid}" aria-expanded="${open}" aria-controls="det-${eid}">${open ? "Hide details" : "Show details"}<span class="sr-only">: ${esc(title)}</span>${ICONS.chevron}</button>
      </div>
      <div class="opening-details" id="det-${eid}" ${open ? "" : "hidden"}>
        ${renderLateYes(id, s, false)}
        ${renderStatusBlock(id, s, ctx)}
        ${renderPeople(s)}
        ${renderFoot(o, s, title, ctx)}
      </div>
    </article>`;
  }
  // Status chip comes straight after the title block, before the progress line and any demo chips.
  return `
    <article class="opening${tone ? ` opening--${tone}` : ""}" id="card-${eid}" data-id="${eid}" data-key="${esc(c.key)}" aria-labelledby="op-${eid}-title">
      <div class="opening-head">
        <div class="opening-heading">${titleHtml}<p class="opening-when">${when}</p></div>
        ${chips}
        <p class="opening-progress"><span>${esc(progress)}</span>${demoChips}</p>
      </div>
      <div class="decision">
        ${renderLateYes(id, s, lateYesOpen(o))}
        ${renderStatusBlock(id, s, ctx, c.past)}
      </div>
      ${renderPeople(s)}
      ${renderFoot(o, s, title, ctx)}
    </article>`;
}

function sortKey(o, c) {
  const s = o.state;
  if (!s) return 0;
  // Things staff can still act on today come first; openings whose time has passed sink to the end.
  if (c.group === "needs") return (c.past ? 1e15 : 0) + (c.held && s.winner ? s.winner.holdUntil : startsAtMs(s.opening));
  if (c.group === "waiting") return (c.past ? 1e15 : 0) + (s.currentRound?.deadline ?? 1e14);
  return -(s.closedAt ?? s.history.at(-1)?.at ?? 0); // finished: newest first
}

function upsertCard(o, c, group) {
  const id = o.workflowId;
  const sig = JSON.stringify([o.state, o.error, o.running, group, c.past, c.lateYes]);
  const el = document.getElementById(`card-${id}`);
  if (el && cardCache.get(id) === sig) return el;
  cardCache.set(id, sig);
  const tmp = document.createElement("div");
  tmp.innerHTML = renderCard(o, c, group).trim();
  const fresh = tmp.firstElementChild;
  if (el) el.replaceWith(fresh);
  return fresh;
}

function renderOpenings(data) {
  const active = document.activeElement;
  const activeCard = active?.closest?.("article.opening");
  const focusInfo = activeCard ? { el: active, card: activeCard.id, sel: focusSelector(active) } : null;

  const buckets = { needs: [], waiting: [], finished: [] };
  for (const o of data.openings) {
    const c = classify(o);
    buckets[c.group].push({ o, c, key: sortKey(o, c) });
  }
  for (const list of Object.values(buckets)) list.sort((a, b) => a.key - b.key);

  $("#loading").hidden = true;
  const none = !data.openings.length;
  $("#empty-openings").hidden = !none;
  const activeCount = buckets.needs.length + buckets.waiting.length;
  $("#tab-active-n").textContent = `(${activeCount})`;
  $("#tab-finished-n").textContent = `(${buckets.finished.length})`;
  $("#vs-openings").textContent = `(${activeCount})`;
  $("#needs-n").textContent = `(${buckets.needs.length})`;
  $("#waiting-n").textContent = `(${buckets.waiting.length})`;
  $("#needs-empty").hidden = buckets.needs.length > 0;
  $("#waiting-section").hidden = !buckets.waiting.length;
  $("#finished-empty").hidden = buckets.finished.length > 0;

  const seen = new Set();
  for (const [group, list] of Object.entries(buckets)) {
    const container = $(`#group-${group}`);
    const els = list.map(({ o, c }) => {
      seen.add(`card-${o.workflowId}`);
      return upsertCard(o, c, group);
    });
    const current = [...container.children];
    if (current.length !== els.length || current.some((el, i) => el !== els[i])) els.forEach((el) => container.appendChild(el));
  }
  document.querySelectorAll("#openings-view article.opening").forEach((el) => {
    if (!seen.has(el.id)) {
      cardCache.delete(el.dataset.id);
      el.remove();
    }
  });

  // Focus restore: same control if it still exists, otherwise the card's title.
  if (focusInfo && document.activeElement !== focusInfo.el) {
    const card = document.getElementById(focusInfo.card);
    const target = (focusInfo.sel && card?.querySelector(focusInfo.sel)) || card?.querySelector(".opening-title");
    pendingFocus = target;
  }
  applyTabs(none);
  applyStatFilter();
  if (pendingFocus) {
    // A card that just finished moves to the (hidden) Finished tab: land on "Needs you" instead.
    const target = pendingFocus.closest("[hidden]") ? $("#needs-you") : pendingFocus;
    pendingFocus = null;
    target.focus({ preventScroll: true });
  }
}

function applyTabs(none = !lastData?.openings.length) {
  document.querySelectorAll("#op-tabs button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.tab === opTab)));
  const loaded = $("#loading").hidden;
  $("#active-groups").hidden = !loaded || none || opTab !== "active";
  $("#finished-group").hidden = !loaded || none || opTab !== "finished";
}

const STAT_LABEL = Object.fromEntries(STATS.map(([k, l]) => [k, l]));
function applyStatFilter() {
  document.querySelectorAll("#group-needs > article, #group-waiting > article").forEach((el) => {
    el.hidden = Boolean(statFilter) && el.dataset.key !== statFilter;
  });
  $("#filter-note").hidden = !statFilter;
  if (statFilter) $("#filter-note-text").textContent = `Showing only: ${STAT_LABEL[statFilter]}.`;
  // While filtering, hide a group (heading included) that has no matching cards.
  const visible = (g) => $(`#group-${g}`).querySelectorAll(":scope > article:not([hidden])").length;
  const total = (g) => $(`#group-${g}`).children.length;
  const needsShown = statFilter ? visible("needs") > 0 : true;
  $("#needs-you").hidden = !needsShown;
  $("#needs-empty").hidden = Boolean(statFilter) || total("needs") > 0;
  $("#waiting-section").hidden = statFilter ? visible("waiting") === 0 : total("waiting") === 0;
}

// ---------------------------------------------------------------------------
// Rendering: waitlist
// ---------------------------------------------------------------------------
const CONSENT = {
  opted_in: ["ok", "Opted in to texts", "check"],
  opted_out: ["danger", "Opted out — don't text", "ban"],
  not_asked: ["warn", "Not asked yet — don't text", "question"],
};
const consentOf = (c) => (c.textingConsent in CONSENT ? c.textingConsent : "not_asked");
function consentChip(c) {
  const [tone, text, icon] = CONSENT[consentOf(c)];
  return chip(tone, text, icon);
}
function clientStatusChip(c) {
  if (c.status === "removed") return chip("neutral", "Removed — asked to come off", "ban");
  if (c.status === "booked" && c.holding?.held) return chip("held", "Held, staff to confirm", "clock");
  if (c.status === "booked") return chip("ok", "Booked", "check");
  if (c.holding) return chip("info", `Offer out${c.holding.deadline ? ` · ${esc(formatClock(c.holding.deadline))}` : ""}`, "clock");
  // "Waiting" is the default state: only label it when the list mixes states.
  return wlFilter === "all" ? chip("neutral", "Waiting", "dot") : "";
}
const wlManageOpen = new Set();
const canRemove = (c) => c.status === "waiting" && !c.holding;

function renderClient(c) {
  const id = esc(c.id);
  const name = esc(c.name);
  const removed = c.status === "removed";
  const consent = consentOf(c);
  const chips = `<span class="client-chips">${clientStatusChip(c)}${removed ? "" : consentChip(c)}</span>`;
  const removedLine = removed
    ? `<p class="client-meta">Removed${c.removedAt ? ` ${esc(shortDate(c.removedAt))}` : ""}${c.removedReason ? `: “${esc(c.removedReason)}”` : ""}. Kept for history; never suggested or texted.</p>`
    : "";
  let actions = "";
  if (!removed) {
    const open = wlManageOpen.has(c.id);
    const consentDetail =
      consent === "not_asked"
        ? "Not asked yet"
        : `${CONSENT[consent][1]}${c.consentSource ? ` (${esc(c.consentSource.toLowerCase())}${c.consentRecordedAt ? `, ${esc(shortDate(c.consentRecordedAt))}` : ""})` : ""}`;
    const removeBit = canRemove(c)
      ? `<button type="button" class="btn btn-danger-quiet btn-sm" data-action="wl-remove" data-id="${id}">Remove from waitlist<span class="sr-only">: ${name}</span></button>`
      : `<p class="meta">${c.status === "booked" ? "Booked from an opening, so they can't be removed here." : "Has an offer out right now. Cancel or finish their current offer before removing them."}</p>`;
    actions = `
      <div class="client-row-actions">
        ${consent === "not_asked" ? `<button type="button" class="btn btn-secondary btn-sm" data-action="wl-consent" data-id="${id}">Record texting answer<span class="sr-only"> for ${name}</span></button>` : ""}
        <button type="button" class="btn btn-quiet btn-sm" data-action="wl-manage" data-id="${id}" aria-expanded="${open}" aria-controls="wlm-${id}">Manage<span class="sr-only"> ${name}</span>${ICONS.chevron}</button>
      </div>
      <div class="client-manage" id="wlm-${id}" ${open ? "" : "hidden"}>
        <dl>
          <div><dt>Mobile</dt><dd>${esc(c.mobile)}</dd></div>
          <div><dt>Texting answer</dt><dd>${consentDetail}</dd></div>
        </dl>
        <div class="actions">
          ${consent === "not_asked" ? "" : `<button type="button" class="btn btn-secondary btn-sm" data-action="wl-consent" data-id="${id}" data-where="manage">Record texting answer<span class="sr-only"> for ${name}</span></button>`}
          ${removeBit}
        </div>
      </div>`;
  }
  return `<li class="client${removed ? " is-removed" : ""}" id="client-${id}">
        <div class="client-top"><span class="client-name">${name}</span>${chips}</div>
        <p class="client-meta">${esc(c.service)} · ${esc(c.stylistRuleText)} · joined ${esc(shortDate(c.joinedAt))}</p>
        <p class="client-note">${c.availabilityNote ? `“${esc(c.availabilityNote)}”` : '<span class="muted">No availability note</span>'}</p>
        ${removedLine}
        ${actions}
      </li>`;
}

function renderWaitlist(data) {
  const wl = data.waitlist;
  if (wl.error) {
    patch($("#waitlist"), `<li class="wl-empty">Waitlist unavailable: ${esc(wl.error)}</li>`);
    return;
  }
  const count = (f) => (f === "all" ? wl.clients.length : wl.clients.filter((c) => c.status === f).length);
  document.querySelectorAll("#wl-filter button").forEach((b) => {
    const f = b.dataset.filter;
    const pressed = f === wlFilter;
    const html = `${pressed ? ICONS.check : ""}${f[0].toUpperCase()}${f.slice(1)} <span class="num">(${count(f)})</span>`;
    if (b._html !== html) {
      b.innerHTML = html;
      b._html = html;
    }
    b.setAttribute("aria-pressed", String(pressed));
  });
  $("#vs-waitlist").textContent = `(${count("waiting")})`;
  const waiting = wl.clients.filter((c) => c.status === "waiting");
  const n = (k) => waiting.filter((c) => consentOf(c) === k).length;
  const consentHtml = `${ICONS.info}<span>Only clients who opted in are suggested or texted. Waiting: ${n("opted_in")} opted in · ${n("opted_out")} opted out · ${n("not_asked")} not asked yet.</span>`;
  patch($("#wl-consent"), consentHtml);
  const clients = wl.clients
    .filter((c) => wlFilter === "all" || c.status === wlFilter)
    .filter((c) => !wlStylist || c.stylistRule?.kind !== "required" || c.stylistRule.stylist === wlStylist)
    .filter((c) => !wlService || c.service === wlService)
    // Removed people sink to the end of "All"; otherwise earliest joiner first.
    .sort((a, b) => (a.status === "removed") - (b.status === "removed") || (a.joinedAt < b.joinedAt ? -1 : 1));
  const filtered = wlStylist || wlService;
  const empty =
    wlFilter === "booked" && !filtered
      ? `<li class="wl-empty">Nobody has been booked from the waitlist yet.</li>`
      : `<li class="wl-empty"><p>No one matches these filters.</p>${filtered ? `<button type="button" class="btn btn-quiet btn-sm" data-action="clear-wl-filters">Clear filters</button>` : ""}</li>`;
  patch($("#waitlist"), clients.map(renderClient).join("") || empty);
  updateWaitlistTabstop();
}
/** The waitlist panel is a tab stop only when it scrolls on its own (desktop), so keyboard users can scroll it. */
function updateWaitlistTabstop() {
  const el = $("#waitlist-view");
  const scrolls = desktopMq.matches && el.scrollHeight > el.clientHeight + 1;
  if (scrolls) el.setAttribute("tabindex", "0");
  else el.removeAttribute("tabindex");
}

// ---------------------------------------------------------------------------
// Attention: Lena & Carla are often with clients, so the tab title shows what needs them,
// and (if allowed) a browser notification fires when something new needs a tap.
// ---------------------------------------------------------------------------
let seenAttention = null;
function updateAttention(openings) {
  const items = [];
  for (const o of openings) {
    const s = o.state;
    if (!s) continue;
    const what = `${s.opening.service} · ${s.opening.stylist} ${slotParts(s.opening.startsAt).short}`;
    if (s.status === "awaiting_approval") items.push([`${o.workflowId}:approve:${s.cycle}`, `Approve who gets texted — ${what}`]);
    if (s.status === "unfilled") items.push([`${o.workflowId}:unfilled:${s.cycle}`, `${s.unfilledKind === "too_close" ? "Too close to the start time" : "Nobody took it"} — ${what}`]);
    if (s.status === "filled" && !s.square.done && s.winner) items.push([`${o.workflowId}:held:${s.winner.offerId}`, `${s.winner.name} said yes — confirm in Square (${what})`]);
    if (lateYesOpen(o)) for (const x of pendingLate(s)) items.push([`${o.workflowId}:late:${x.offerId}`, `${x.name} said yes late — ${what}`]);
  }
  attentionCount = items.length;
  setTitle();
  const link = $("#attention");
  const html = items.length ? `${ICONS.alert}${items.length} need${items.length === 1 ? "s" : ""} you` : "";
  if (link._html !== html) {
    link.innerHTML = html;
    link._html = html;
  }
  link.hidden = !items.length;
  if (seenAttention && "Notification" in window && Notification.permission === "granted") {
    for (const [key, text] of items) if (!seenAttention.has(key)) new Notification("Juniper Salon", { body: text, tag: key });
  }
  seenAttention = new Set(items.map(([key]) => key));
  $("#alerts-btn").hidden = !("Notification" in window) || Notification.permission !== "default";
}
async function enableAlerts() {
  if (!("Notification" in window)) return toast("This browser can't show notifications.", true, "Alerts:");
  const result = await Notification.requestPermission();
  toast(result === "granted" ? "Alerts on. You'll get a notification when something needs you." : "Alerts not enabled.");
  $("#alerts-btn").hidden = true;
  $("#add-opening-btn").focus();
}

function setConn(ok) {
  if (connState === ok) return;
  connState = ok;
  $("#conn").className = `conn ${ok ? "is-live" : "is-bad"}`;
  $("#conn-text").textContent = ok ? "Live" : "Offline, retrying";
}

function renderAll(data) {
  updateAttention(data.openings);
  renderSummary(data);
  renderOpenings(data);
  renderWaitlist(data);
}

async function refresh() {
  if (busy) return;
  try {
    const data = await api("/api/dashboard");
    serverOffset = data.now - Date.now();
    lastData = data;
    renderAll(data);
    setConn(true);
    $("#updated").textContent = `Updated ${formatClock(Date.now())}`;
  } catch {
    setConn(false);
  }
}

// ---------------------------------------------------------------------------
// View switch (phone/tablet) and tabs
// ---------------------------------------------------------------------------
const desktopMq = matchMedia("(min-width: 1024px)");
function setView(v) {
  view = v;
  try {
    localStorage.setItem("juniper.view", v);
  } catch {}
  applyView();
}
function applyView() {
  const desktop = desktopMq.matches;
  $("#openings-view").hidden = !desktop && view !== "openings";
  $("#waitlist-view").hidden = !desktop && view !== "waitlist";
  document.querySelectorAll("#view-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
}
try {
  const saved = localStorage.getItem("juniper.view");
  if (saved === "openings" || saved === "waitlist") view = saved;
} catch {}
desktopMq.addEventListener("change", () => {
  applyView();
  updateWaitlistTabstop();
});
addEventListener("resize", () => updateWaitlistTabstop());
applyView();

$("#view-switch").addEventListener("click", (event) => {
  const b = event.target.closest("button[data-view]");
  if (b) setView(b.dataset.view);
});
$("#op-tabs").addEventListener("click", (event) => {
  const b = event.target.closest("button[data-tab]");
  if (!b) return;
  opTab = b.dataset.tab;
  if (opTab === "finished") statFilter = null;
  applyTabs();
  if (lastData) renderSummary(lastData);
  applyStatFilter();
});
$("#attention").addEventListener("click", (event) => {
  event.preventDefault();
  statFilter = null;
  opTab = "active";
  setView("openings");
  applyTabs();
  applyStatFilter();
  if (lastData) renderSummary(lastData);
  const target = $("#needs-you");
  target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function staffAction(id, action, body, button, busyLabel = "Saving…") {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  const original = button?.innerHTML;
  if (button) {
    button.setAttribute("aria-busy", "true");
    button.textContent = busyLabel;
  }
  busy = true;
  try {
    const result = await api(`/api/openings/${encodeURIComponent(id)}/${action}`, { method: "POST", body: body ?? {} });
    toast(action === "approve" ? await approveOutcome(id, result.message) : result.message);
    if (action === "approve") selections.delete(id);
  } catch (error) {
    toast(error.message, true);
    if (button?.isConnected) {
      button.innerHTML = original;
      button.removeAttribute("aria-busy");
    }
  } finally {
    busy = false;
    inFlight.delete(id);
    cardCache.delete(id);
    await refresh();
  }
}

const findState = (id) => lastData?.openings.find((o) => o.workflowId === id)?.state;

/**
 * After approval, say what actually happened (texts out, scheduled for texting hours, or stopped)
 * rather than promising "texts are going out". Polls briefly while the round gets going.
 */
async function approveOutcome(id, fallback) {
  for (let i = 0; i < 12; i++) {
    const s = await api(`/api/openings/${encodeURIComponent(id)}`).then((r) => r.state).catch(() => null);
    if (s?.status === "offering" && s.scheduled) return `${fallback} ${s.scheduled.text}.`;
    if (s?.status === "offering" && s.currentRound?.sentAt) {
      const names = s.offers.filter((o) => s.currentRound.offerIds.includes(o.offerId)).map((o) => o.name);
      return `${fallback} Simulated texts sent to ${names.join(", ")}.`;
    }
    if (s?.status === "unfilled") return `${fallback} Offers stopped: ${s.unfilledReason}`;
    if (s && s.status !== "offering") return fallback;
    await new Promise((r) => setTimeout(r, 250));
  }
  return `${fallback} Sending texts…`;
}

function confirmCopy(kind, id, offerId) {
  const s = findState(id);
  const w = s?.winner;
  const first = firstName(w?.name) || "the client";
  if (kind === "cancel") {
    return {
      title: "Cancel this opening?",
      body: `Anyone holding an offer${s?.status === "filled" && w ? ` (including ${first}’s hold)` : ""} is told it’s no longer available.`,
      actionLabel: "Cancel opening",
      safeLabel: "Keep it",
      variant: "danger",
      withReason: true,
    };
  }
  if (kind === "release-hold") {
    return {
      title: `Release ${first}’s hold?`,
      body: `${first} is told it couldn’t be confirmed and stays on the waitlist. The next approved people are texted.`,
      actionLabel: "Release hold",
      safeLabel: "Keep holding",
      variant: "danger",
      withReason: true,
    };
  }
  if (kind === "square-done") {
    return { title: "Mark as done in Square?", body: "This closes the opening and counts it as refilled.", actionLabel: "Yes — Square updated", safeLabel: "Not yet", variant: "primary" };
  }
  const late = firstName(s?.offers.find((o) => o.offerId === offerId)?.name) || "this client";
  return { title: `Dismiss ${late}’s late yes?`, body: `${late} isn’t booked and stays on the waitlist.`, actionLabel: "Dismiss", safeLabel: "Go back", variant: "danger" };
}

document.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el || el.tagName === "INPUT") return;
  const id = el.dataset.id;
  const action = el.dataset.action;
  switch (action) {
    case "add-opening":
      openOpeningDialog(el);
      break;
    case "add-client":
      openClientDialog(el);
      break;
    case "wl-manage": {
      const open = !wlManageOpen.has(id);
      open ? wlManageOpen.add(id) : wlManageOpen.delete(id);
      el.setAttribute("aria-expanded", String(open));
      document.getElementById(`wlm-${id}`).hidden = !open;
      $("#waitlist")._html = null; // re-render keeps the new open state
      break;
    }
    case "wl-consent":
      openConsentDialog(id, el);
      break;
    case "wl-remove":
      removeFromWaitlist(id, el);
      break;
    case "alerts":
      enableAlerts();
      break;
    case "close-alert":
      closeAlert();
      $("#main").focus();
      break;
    case "stat-filter":
      statFilter = statFilter === el.dataset.stat ? null : el.dataset.stat;
      if (statFilter) {
        opTab = "active";
        setView("openings");
      }
      applyTabs();
      if (lastData) renderSummary(lastData);
      applyStatFilter();
      break;
    case "clear-stat":
      statFilter = null;
      if (lastData) renderSummary(lastData);
      applyStatFilter();
      $(`#summary [data-stat]`)?.focus();
      break;
    case "clear-wl-filters":
      wlStylist = wlService = "";
      $("#wl-stylist").value = "";
      $("#wl-service").value = "";
      if (lastData) renderWaitlist(lastData);
      $("#wl-stylist").focus();
      break;
    case "toggle-settings": {
      const open = !openSettings.has(id);
      open ? openSettings.add(id) : openSettings.delete(id);
      el.setAttribute("aria-expanded", String(open));
      document.getElementById(`set-${id}`).hidden = !open;
      break;
    }
    case "toggle-details": {
      const open = !expanded.has(id);
      open ? expanded.add(id) : expanded.delete(id);
      el.setAttribute("aria-expanded", String(open));
      el.firstChild.textContent = open ? "Hide details" : "Show details";
      document.getElementById(`det-${id}`).hidden = !open;
      break;
    }
    case "approve": {
      if (el.getAttribute("aria-busy") === "true") return;
      const sel = selections.get(id) ?? new Set();
      if (!sel.size) {
        el.closest(".panel")?.querySelector(".inline-error")?.removeAttribute("hidden");
        return;
      }
      const settings = approvalSettings.get(id) ?? {};
      const body = { clientIds: [...sel], batchSize: Number(settings.batchSize) };
      if (settings.replyWindow === "fast") body.fastDemo = true;
      else body.replyWindowMinutes = Number(settings.replyWindow);
      staffAction(id, "approve", body, el, "Approving…");
      break;
    }
    case "ask": {
      if (el.getAttribute("aria-busy") === "true") return;
      const kind = el.dataset.confirm;
      const { ok, reason } = await openConfirm(confirmCopy(kind, id));
      if (!ok) return;
      const trigger = el.isConnected ? el : null;
      staffAction(id, kind, kind === "square-done" ? {} : { reason }, trigger);
      break;
    }
    case "late-book":
      staffAction(id, "late-yes", { offerId: el.dataset.offer, action: "book" }, el);
      break;
    case "late-dismiss": {
      const { ok } = await openConfirm(confirmCopy("late-dismiss", id, el.dataset.offer));
      if (ok) staffAction(id, "late-yes", { offerId: el.dataset.offer, action: "dismiss" }, el.isConnected ? el : null);
      break;
    }
    case "keep-trying":
      staffAction(id, "keep-trying", {}, el);
      break;
    case "leave-open":
      staffAction(id, "leave-open", {}, el);
      break;
  }
});

// Checkbox and setting changes patch in place: no re-render, so keyboard focus stays put.
document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.select) {
    const sel = selections.get(el.dataset.select) ?? new Set();
    el.checked ? sel.add(el.value) : sel.delete(el.value);
    selections.set(el.dataset.select, sel);
    patchApproval(el.dataset.select);
  } else if (el.dataset.setting) {
    const s = approvalSettings.get(el.dataset.id) ?? {};
    s[el.dataset.setting] = el.value;
    approvalSettings.set(el.dataset.id, s);
    patchApproval(el.dataset.id);
  } else if (el.id === "wl-stylist" || el.id === "wl-service") {
    wlStylist = $("#wl-stylist").value;
    wlService = $("#wl-service").value;
    if (lastData) renderWaitlist(lastData);
  }
});

document.addEventListener(
  "toggle",
  (event) => {
    const el = event.target;
    if (el.dataset?.history) el.open ? openHistory.add(el.dataset.history) : openHistory.delete(el.dataset.history);
  },
  true,
);

$("#wl-filter").addEventListener("click", (event) => {
  const b = event.target.closest("button[data-filter]");
  if (!b) return;
  wlFilter = b.dataset.filter;
  if (lastData) renderWaitlist(lastData);
});

// Countdowns tick every second without re-rendering (and without announcing).
setInterval(() => {
  document.querySelectorAll(".countdown[data-deadline]").forEach((el) => {
    const st = countdownState(Number(el.dataset.deadline), Number(el.dataset.low) || 60_000);
    if (el.textContent !== st.text) el.textContent = st.text;
    el.classList.toggle("low", st.low);
  });
}, 1000);

setupForm()
  .catch((error) => toast(error.message, true, "Couldn't load:"))
  .finally(() => {
    refresh();
    setInterval(refresh, 2000);
  });
