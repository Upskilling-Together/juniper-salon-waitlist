// Client offer page (phone-first). Opened from the simulated text link.
const params = new URLSearchParams(location.search);
const openingId = params.get("o") ?? "";
const clientId = params.get("c") ?? "";
const token = params.get("t") ?? "";
const main = document.querySelector("#main");
const card = document.querySelector("#card");
const greeting = document.querySelector("#greeting");
const statusEl = document.querySelector("#offer-status");
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pad = (n) => String(n).padStart(2, "0");

// Fictional salon number (555 range) — the same one shown in the header.
const SALON_PHONE = "(555) 010-0100";
const SALON_TEL = "tel:+15550100100";

const svg = (p) =>
  `<svg class="icon" aria-hidden="true" focusable="false" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICONS = {
  alert: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5v.01"/>'),
  clock: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  check: svg('<path d="m5 12.5 4.5 4.5L19 7"/>'),
  info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5v.01"/>'),
  circle: svg('<circle cx="12" cy="12" r="8"/>'),
  message: svg('<path d="M4 5h16v11H9l-5 4z"/><path d="M3 3l18 18"/>'),
};

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let view = null;
let serverOffset = 0;
let submitting = null; // "accept" | "decline" while a reply is in flight
let lastResult = null;
let lastSig = null;
let prevLeft = null;
const announced = new Set();

function wallTime(utc) {
  const dt = new Date(utc);
  const h = dt.getUTCHours();
  const mi = dt.getUTCMinutes();
  if (h === 12 && mi === 0) return "noon";
  return `${h % 12 || 12}:${pad(mi)}\u00a0${h < 12 ? "AM" : "PM"}`; // never split a time across lines
}
function formatClock(ms) {
  const t = new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "\u00a0");
  return t === "12:00\u00a0PM" ? "noon" : t;
}
/** Salon-local "today" approximated from the (server-corrected) clock. */
function todayString() {
  const d = new Date(Date.now() + serverOffset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function slot(startsAt, durationMinutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt || "");
  if (!m) return { rel: "", day: startsAt, shortDay: "", start: "", range: "" };
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const utc = Date.UTC(y, mo - 1, d, h, mi);
  const dow = new Date(utc).getUTCDay();
  const start = wallTime(utc);
  const end = durationMinutes ? wallTime(utc + durationMinutes * 60_000) : "";
  const today = todayString();
  const t = /^(\d{4})-(\d{2})-(\d{2})$/.exec(today);
  const tomorrow = t ? new Date(Date.UTC(+t[1], +t[2] - 1, +t[3]) + 86_400_000).toISOString().slice(0, 10) : "";
  const date = startsAt.slice(0, 10);
  return {
    rel: date === today ? "Today" : date === tomorrow ? "Tomorrow" : "",
    day: `${DAY[dow]}, ${MONTH[mo - 1]} ${d}`,
    shortDay: DAY[dow].slice(0, 3),
    start,
    range: end ? `${start} – ${end}` : start,
  };
}

function remaining() {
  if (!view?.deadline) return null;
  return Math.max(0, view.deadline - (Date.now() + serverOffset));
}
function leftText(ms) {
  const s = Math.ceil(ms / 1000);
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `(about ${h} hr${m ? ` ${m} min` : ""} left)`;
  }
  // Steps once a minute; seconds only in the final minute, so the page isn't constantly moving.
  if (s > 60) return `(${Math.floor(s / 60)} min left)`;
  const base = `(${Math.floor(s / 60)}:${pad(s % 60)} left)`;
  return ms < 60_000 ? `${base} Less than 1 min left` : base;
}

// h1: what the page's biggest line says for each result. box: a headline inside the result box,
// used only where the h1 doesn't already say it.
const OUTCOME = {
  booked: { tone: "ok", icon: "check", h1: (n) => `You're first, ${n}. We're holding it for you`, box: (p) => `Held: ${p.shortDay} ${p.start}` },
  declined: { tone: "neutral", icon: "info", h1: () => "Thanks for letting us know" },
  filled_notice: { tone: "neutral", icon: "info", h1: (n) => `Sorry ${n}, this time was just taken` },
  already_taken: { tone: "neutral", icon: "info", h1: (n) => `Sorry ${n}, this time was just taken` },
  expired: { tone: "neutral", icon: "clock", h1: () => "Reply time has ended", fallback: "This offer has ended, so the appointment isn't guaranteed." },
  no_longer_available: { tone: "neutral", icon: "info", h1: (n) => `Sorry ${n}, this opening is no longer available` },
  hold_released: { tone: "neutral", icon: "info", h1: (n) => `Sorry ${n}, we couldn't confirm this time` },
  already_answered: { tone: "neutral", icon: "info", h1: (n) => `Hi ${n}, you've already answered` },
  not_ready: { tone: "neutral", icon: "clock", h1: (n) => `Hi ${n}`, box: () => "Still sending. Try again in a moment" },
  error: { tone: "danger", icon: "alert", h1: (n) => `Hi ${n}`, box: () => "Something went wrong" },
};

function callButton() {
  return `<p><a class="btn btn-secondary" href="${SALON_TEL}">Call Juniper Salon<span class="sr-only"> at ${SALON_PHONE}</span></a></p>`;
}

/** The held page already says "holding it for you" in the h1; keep only the next step. */
function boxMessage(key, message) {
  const o = OUTCOME[key] ?? OUTCOME.no_longer_available;
  let text = message || o.fallback || "";
  if (key === "booked") text = text.replace(/^It's yours\s*[—-]\s*we're holding it for you\.\s*/i, "");
  return text;
}

function outcomePanel(key, message, p) {
  const o = OUTCOME[key] ?? OUTCOME.no_longer_available;
  const text = boxMessage(key, message);
  const reassure =
    !["booked", "already_answered", "not_ready", "error"].includes(key) && !/waitlist/i.test(text)
      ? `<p class="reassure">${ICONS.check}<span>You're still on the waitlist with your place.</span></p>`
      : "";
  const tracker =
    key === "booked"
      ? `<ol class="tracker" aria-label="What happens next">
           <li class="done">${ICONS.check}<span>Held for you</span></li>
           <li>${ICONS.circle}<span>The salon confirms by text (usually within 15 min)</span></li>
         </ol>`
      : "";
  const head = o.box
    ? `<div class="outcome-head">${ICONS[o.icon]}<h2 id="outcome-h" tabindex="-1">${esc(o.box(p))}</h2></div>${text ? `<p>${esc(text)}</p>` : ""}`
    : `<div class="outcome-head">${ICONS[o.icon]}${text ? `<p>${esc(text)}</p>` : ""}</div>`;
  return `<div class="outcome outcome--${o.tone}">
      ${head}
      ${tracker}
      ${reassure}
      ${callButton()}
    </div>`;
}

let prevOutcomeKey; // undefined until the first render
let deadlineObserver = null;

function render() {
  if (!view) return;
  const p = slot(view.startsAt, view.durationMinutes);
  const left = remaining();
  const expiredLocally = view.canRespond && left === 0;
  const canRespond = view.canRespond && !expiredLocally;
  const message = lastResult?.message ?? view.message;
  const outcome = lastResult?.outcome ?? view.outcome;
  // Only re-render when the view really changes; the countdown updates its own node.
  const sig = JSON.stringify([canRespond, expiredLocally, outcome, message, view.deadline, view.startsAt, view.smsText, view.roundSize, view.fastDemo, submitting]);
  if (sig === lastSig) return;
  lastSig = sig;

  const hadFocus = document.activeElement?.id === "accept" || document.activeElement?.id === "decline";
  const focusId = document.activeElement?.id;
  document.title = `Your offer: ${p.shortDay} ${p.start} – Juniper Salon`;
  const outcomeKey = expiredLocally ? "expired" : !view.canRespond && message ? outcome : null;
  // The biggest line always matches the result shown under it.
  const headline = outcomeKey ? (OUTCOME[outcomeKey] ?? OUTCOME.no_longer_available).h1(view.firstName) : `Hi ${view.firstName}, a spot just opened up`;
  greeting.textContent = headline;
  const dim = outcomeKey && outcomeKey !== "booked";
  const deadline = view.deadline ? formatClock(view.deadline) : "";
  const summary = `
    <section class="summary-card${dim ? " is-dim" : ""}" aria-labelledby="sc-h">
      <h2 class="sc-label" id="sc-h">${dim ? "Offer details" : "Your appointment"}</h2>
      <p class="when-day">${p.rel ? `${esc(p.rel)} · ` : ""}${esc(p.day)}</p>
      <p class="when-time">${esc(p.range)}</p>
      <dl class="details">
        <div><dt>Service</dt><dd>${esc(view.service)} · ${esc(view.durationMinutes)} min</dd></div>
        <div><dt>Stylist</dt><dd><span class="initials" aria-hidden="true">${esc(String(view.stylist).slice(0, 2).toUpperCase())}</span>${esc(view.stylist)}</dd></div>
        <div><dt>Where</dt><dd>Juniper Salon (sample salon)</dd></div>
      </dl>
    </section>`;

  const busyAttr = (choice) => (submitting === choice ? 'aria-busy="true"' : "");
  const decision = canRespond
    ? `<div class="decision-offer">
        <p class="deadline">Reply by ${esc(deadline)} <span class="countdown${left < 60_000 ? " low" : ""}" id="countdown" aria-hidden="true">${esc(leftText(left ?? 0))}</span></p>
        ${view.fastDemo ? `<p><span class="chip chip--demo">${ICONS.message}Fast demo: 30-second reply window</span></p>` : ""}
        <p class="rule">${ICONS.info}<span>${
          view.roundSize > 1
            ? `Offered to ${esc(view.roundSize)} people. The first yes gets it. Late replies aren't guaranteed.`
            : `Offered only to you until ${esc(deadline)}. Late replies aren't guaranteed.`
        }</span></p>
        <div class="decision-bar">
          <span class="bar-deadline" aria-hidden="true">Reply by ${esc(deadline)}</span>
          <button type="button" class="btn btn-primary btn-xl" id="accept" ${busyAttr("accept")}>${submitting === "accept" ? "Sending…" : "Yes, I want it"}</button>
        </div>
        <button type="button" class="btn btn-secondary btn-lg" id="decline" ${busyAttr("decline")}>${submitting === "decline" ? "Sending…" : "No thanks"}</button>
      </div>`
    : "";

  const sms = view.smsText
    ? `<div>
        <p class="tp-title">The text you received</p>
        <figure class="text-preview" aria-label="Simulated text, not sent">
          <figcaption class="sim-label">${ICONS.message}Simulated text — not sent</figcaption>
          <blockquote class="text-preview-body"><p>${esc(view.smsText.replace(/https?:\/\/\S+/, "[this page]"))}</p></blockquote>
        </figure>
      </div>`
    : "";

  card.innerHTML = `${summary}${decision}${outcomeKey ? outcomePanel(outcomeKey, expiredLocally ? "" : message, p) : ""}${sms}`;
  document.documentElement.classList.toggle("has-bar", canRespond);
  main.setAttribute("aria-busy", "false");
  document.querySelector("#accept")?.addEventListener("click", () => answer("accept"));
  document.querySelector("#decline")?.addEventListener("click", () => answer("decline"));

  // Keep the keyboard user's place: same button if it is still there, otherwise the result headline.
  if (hadFocus) {
    const same = document.getElementById(focusId);
    (same ?? document.querySelector("#outcome-h") ?? greeting)?.focus();
  }
  if (expiredLocally) announce("ended", "Reply time has ended");
  else if (outcomeKey && outcomeKey !== prevOutcomeKey && prevOutcomeKey !== undefined && !hadFocus) {
    // The result changed while the client wasn't on Yes/No (someone else took it, it was cancelled…): say so once.
    const box = OUTCOME[outcomeKey]?.box?.(p);
    announce(`outcome:${outcomeKey}`, [headline, box, boxMessage(outcomeKey, message)].filter(Boolean).join(". "));
  }
  prevOutcomeKey = outcomeKey;
  watchDeadline();
}

/** On short screens the Yes bar repeats "Reply by …" only while the in-page deadline is scrolled away. */
function watchDeadline() {
  deadlineObserver?.disconnect();
  const line = document.querySelector(".deadline");
  const bar = document.querySelector(".decision-bar");
  if (!line || !bar || !("IntersectionObserver" in window)) return;
  deadlineObserver = new IntersectionObserver(([entry]) => bar.classList.toggle("deadline-in-view", entry.isIntersecting), {
    rootMargin: "0px 0px -96px 0px",
  });
  deadlineObserver.observe(line);
}

function announce(key, text) {
  if (announced.has(key)) return;
  announced.add(key);
  statusEl.textContent = text;
}

function renderInvalid() {
  document.title = "Offer link not working – Juniper Salon";
  greeting.textContent = "This link isn't working anymore";
  card.innerHTML = `<p>If you're on our waitlist, you still have your place.</p>
    <p><a class="btn btn-secondary" href="${SALON_TEL}">Call the salon<span class="sr-only"> at ${SALON_PHONE}</span></a></p>`;
  main.setAttribute("aria-busy", "false");
}
function renderError() {
  greeting.textContent = "Something went wrong";
  card.innerHTML = `<p>We couldn't load this offer. Check your connection and refresh the page, or call the salon.</p>${callButton()}`;
  main.setAttribute("aria-busy", "false");
}

async function load() {
  if (submitting) return;
  if (!openingId || !clientId || !token) {
    renderInvalid();
    return false;
  }
  const response = await fetch(
    `/api/offers/${encodeURIComponent(openingId)}?c=${encodeURIComponent(clientId)}&t=${encodeURIComponent(token)}`,
  );
  const body = await response.json().catch(() => ({}));
  if (response.status === 403 || response.status === 404 || body.valid === false) {
    view = null;
    renderInvalid();
    return false;
  }
  if (!response.ok) {
    // Server trouble: keep showing what we have; on the first load, say so.
    if (!view) renderError();
    throw new Error(body.error || `Request failed (${response.status})`);
  }
  serverOffset = body.now - Date.now();
  view = body;
  if (!view.canRespond && lastResult && lastResult.outcome !== view.outcome) lastResult = null;
  render();
  return true;
}

async function answer(choice) {
  if (submitting) return;
  submitting = choice;
  render();
  try {
    const response = await fetch(`/api/offers/${encodeURIComponent(openingId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, token, answer: choice }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastResult = { outcome: "error", message: body.error || "Please try again, or call the salon." };
    } else {
      lastResult = { outcome: body.outcome, message: body.message };
      if (body.view?.valid) view = body.view;
    }
    if (view) view.canRespond = false;
  } catch {
    lastResult = { outcome: "error", message: "We couldn't send your reply. Check your connection and try again, or call the salon." };
    if (view) view.canRespond = false;
  } finally {
    submitting = null;
    render();
  }
}

setInterval(() => {
  const left = remaining();
  if (left === null || !view?.canRespond) return;
  const el = document.querySelector("#countdown");
  if (el) {
    el.textContent = leftText(left);
    el.classList.toggle("low", left < 60_000);
  }
  // Screen readers hear milestones only, never every tick.
  if (prevLeft !== null) {
    if (prevLeft > 300_000 && left <= 300_000) announce("5min", "5 minutes left to reply");
    if (prevLeft > 60_000 && left <= 60_000) announce("1min", "1 minute left to reply");
  }
  prevLeft = left;
  if (left === 0) render();
}, 1000);

load()
  .then((ok) => {
    if (ok !== false) setInterval(() => load().catch(() => {}), 3000);
  })
  .catch(renderError);
