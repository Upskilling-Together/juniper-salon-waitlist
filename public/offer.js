// Client offer page (phone-first). Opened from the simulated text link.
const params = new URLSearchParams(location.search);
const openingId = params.get("o") ?? "";
const clientId = params.get("c") ?? "";
const token = params.get("t") ?? "";
const card = document.querySelector("#card");
const greeting = document.querySelector("#greeting");
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const DAY = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

let view = null;
let serverOffset = 0;
let submitting = false;
let lastResult = null;

function parts(startsAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt);
  if (!m) return { date: startsAt, time: "" };
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return { date: `${DAY[dow]}, ${MONTH[mo - 1]} ${d}`, time: `${h12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}` };
}

function remaining() {
  if (!view?.deadline) return null;
  return Math.max(0, view.deadline - (Date.now() + serverOffset));
}
function countdownText(ms) {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}

const TONE = {
  booked: "good",
  declined: "neutral",
  filled_notice: "neutral",
  already_taken: "bad",
  expired: "bad",
  no_longer_available: "bad",
  already_answered: "neutral",
  hold_released: "neutral",
  not_ready: "neutral",
};

function render() {
  if (!view) return;
  const { date, time } = parts(view.startsAt);
  greeting.textContent =
    (lastResult?.outcome ?? view.outcome) === "booked" ? `It's yours, ${view.firstName}!` : `Hi ${view.firstName} — a spot just opened up`;
  const left = remaining();
  const expiredLocally = view.canRespond && left === 0;
  const message = lastResult?.message ?? view.message;
  const outcome = lastResult?.outcome ?? view.outcome;
  card.innerHTML = `
    <div class="muted small">${esc(view.service)} with ${esc(view.stylist)}</div>
    <div class="offer-time">${esc(time)}</div>
    <div><strong>${esc(date)}</strong></div>
    <ul class="offer-details">
      <li><span>Service</span><span>${esc(view.service)}</span></li>
      <li><span>Stylist</span><span>${esc(view.stylist)}</span></li>
      <li><span>Date</span><span>${esc(date)}</span></li>
      <li><span>Exact time</span><span>${esc(time)} (${esc(view.durationMinutes)} min)</span></li>
    </ul>
    ${
      view.canRespond && !expiredLocally
        ? `<div class="deadline">Reply within<span class="countdown" id="countdown">${countdownText(left ?? 0)}</span>
             ${view.fastDemo ? '<span class="tiny">Fast demo: 30-second reply window</span>' : ""}</div>
           ${view.roundSize > 1 ? `<p class="small muted">${view.roundSize} people were offered this time. The first person to say yes gets it.</p>` : ""}
           <div class="offer-actions">
             <button id="accept" ${submitting ? "disabled" : ""}>Yes, I want it</button>
             <button id="decline" class="secondary" ${submitting ? "disabled" : ""}>No thanks</button>
           </div>`
        : ""
    }
    ${expiredLocally ? `<div class="outcome bad">This offer has expired. You're still on the waitlist with your place.</div>` : ""}
    ${!view.canRespond && message ? `<div class="outcome ${TONE[outcome] ?? "neutral"}">${esc(message)}</div>` : ""}`;
  document.querySelector("#accept")?.addEventListener("click", () => answer("accept"));
  document.querySelector("#decline")?.addEventListener("click", () => answer("decline"));
}

async function load() {
  if (submitting) return;
  const response = await fetch(
    `/api/offers/${encodeURIComponent(openingId)}?c=${encodeURIComponent(clientId)}&t=${encodeURIComponent(token)}`,
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    greeting.textContent = "Offer not found";
    card.innerHTML = `<div class="outcome bad">${esc(body.error || "This offer link isn't valid.")}</div>`;
    view = null;
    return false;
  }
  serverOffset = body.now - Date.now();
  view = body;
  if (!view.canRespond && lastResult && lastResult.outcome !== view.outcome) lastResult = null;
  render();
  return true;
}

async function answer(choice) {
  submitting = true;
  render();
  try {
    const response = await fetch(`/api/offers/${encodeURIComponent(openingId)}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, token, answer: choice }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      lastResult = { outcome: "no_longer_available", message: body.error || "Something went wrong — please try again." };
    } else {
      lastResult = { outcome: body.outcome, message: body.message };
      if (body.view?.valid) view = body.view;
    }
    if (view) view.canRespond = false;
  } finally {
    submitting = false;
    render();
  }
}

setInterval(() => {
  const el = document.querySelector("#countdown");
  const left = remaining();
  if (el && left !== null) {
    el.textContent = countdownText(left);
    if (left === 0) render();
  }
}, 1000);

load().then((ok) => {
  if (ok !== false) setInterval(() => load().catch(() => {}), 3000);
});
