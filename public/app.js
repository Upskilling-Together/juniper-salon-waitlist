// Staff dashboard for the Juniper Salon refill prototype.
const $ = (sel) => document.querySelector(sel);
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const STATUS_LABEL = {
  finding_matches: "Finding matches",
  awaiting_approval: "Awaiting approval",
  offering: "Offering",
  filled: "Filled",
  unfilled: "Unfilled",
  cancelled: "Cancelled",
  left_open: "Left open",
  unknown: "Unknown",
};
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

let meta = null;
let serverOffset = 0; // server clock - browser clock
let wlFilter = "waiting";
const selections = new Map(); // openingId -> Set(clientIds) while awaiting approval
const approvalSettings = new Map(); // openingId -> { batchSize, replyWindow }
const openHistory = new Set();
const confirming = new Map(); // openingId -> "cancel" | "square-done" | "release-hold" (inline confirm open)
const cardCache = new Map(); // openingId -> rendered signature
let busy = false;

function formatSlot(startsAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt || "");
  if (!m) return startsAt;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const dow = new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const today = meta && startsAt.slice(0, 10) === meta.today ? "Today, " : "";
  return `${today}${DAY[dow]} ${MONTH[mo - 1]} ${d} · ${h12}:${String(mi).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}
const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
const shortDate = (iso) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
function windowText(seconds) {
  if (seconds < 60) return `${seconds} sec`;
  const m = Math.round(seconds / 60);
  return m >= 60 && m % 60 === 0 ? `${m / 60} hr` : `${m} min`;
}
function countdownText(deadline) {
  const left = Math.max(0, deadline - (Date.now() + serverOffset));
  const s = Math.ceil(left / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}:${String(sec).padStart(2, "0")}`;
}
const offerUrl = (openingId, offer) =>
  `/offer.html?o=${encodeURIComponent(openingId)}&c=${encodeURIComponent(offer.clientId)}&t=${encodeURIComponent(offer.token)}`;

function toast(message, isError = false) {
  const t = $("#toast");
  t.textContent = message;
  t.className = `toast${isError ? " error" : ""}`;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), isError ? 6000 : 3500);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

// ---------------------------------------------------------------------------
// New opening form
// ---------------------------------------------------------------------------
function updateWindowHint() {
  const form = $("#opening-form");
  const choice = form.replyWindow.value;
  const isToday = form.date.value === meta?.today;
  let text;
  if (choice === "auto") text = `Clients get ${isToday ? "15 minutes (opening is today)" : "60 minutes (opening is later)"} to reply, counted from when the texts go out.`;
  else if (choice === "fast") text = "Fast demo: a clearly-labelled 30-second reply window so you can watch rounds advance.";
  else text = `Clients get ${windowText(Number(choice) * 60)} to reply, counted from when the texts go out.`;
  $("#window-hint").textContent = text;
}

async function setupForm() {
  meta = await api("/api/meta");
  $("#f-service").innerHTML = meta.services.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#f-stylist").innerHTML = meta.stylists.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#f-date").value = meta.today;
  $("#f-date").min = meta.today;
  const now = new Date();
  now.setMinutes(Math.ceil((now.getMinutes() + 31) / 15) * 15, 0, 0);
  $("#f-time").value = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  $("#temporal-ui").href = `${meta.temporalUi}/namespaces/default/workflows`;
  updateWindowHint();
  const form = $("#opening-form");
  form.addEventListener("change", updateWindowHint);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    $("#form-error").textContent = "";
    const fd = new FormData(form);
    const choice = fd.get("replyWindow");
    const body = {
      service: fd.get("service"),
      stylist: fd.get("stylist"),
      startsAt: `${fd.get("date")}T${fd.get("time")}`,
      durationMinutes: Number(fd.get("durationMinutes")),
      batchSize: Number(fd.get("batchSize")),
      fastDemo: choice === "fast",
      replyWindowMinutes: choice === "auto" || choice === "fast" ? null : Number(choice),
      simulateTextFailure: fd.get("simulateTextFailure") === "on",
    };
    $("#create-btn").disabled = true;
    try {
      const created = await api("/api/openings", { method: "POST", body });
      toast(`Opening created — finding matches for ${body.service} with ${body.stylist}.`);
      $("#new-opening").open = false;
      form.simulateTextFailure.checked = false;
      await refresh();
      document.getElementById(`card-${created.openingId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      $("#form-error").textContent = error.message;
    } finally {
      $("#create-btn").disabled = false;
    }
  });
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function renderTiles(data) {
  const r = data.refill;
  const openings = data.openings.filter((o) => o.state);
  const needApproval = openings.filter((o) => o.state.status === "awaiting_approval").length;
  const unfilled = openings.filter((o) => o.state.status === "unfilled").length;
  const offering = openings.filter((o) => o.state.status === "offering").length;
  const squareTodo = openings.filter((o) => o.state.status === "filled" && !o.state.square.done).length;
  updateAttention(openings);
  const pct = r.rate == null ? null : Math.round(r.rate * 100);
  const closed = r.filled + r.unfilled + r.leftOpen;
  $("#tiles").innerHTML = `
    <div class="tile refill">
      <div class="label">Refill rate</div>
      <div class="value">${pct == null ? "—" : `${pct}%`}</div>
      <div class="meter" aria-hidden="true">
        <div class="fill" style="width:${pct ?? 0}%"></div>
        <div class="mark" style="left:${r.baseline * 100}%"><span>~30% before</span></div>
        <div class="mark" style="left:${r.goal * 100}%"><span>50% goal</span></div>
      </div>
      <div class="small muted">${r.filled} confirmed of ${closed} (${r.unfilled + r.leftOpen} unfilled/left open; ${r.held} held and ${r.cancelled} cancelled not counted).</div>
      <div class="tiny muted"><strong>${esc(r.label)}.</strong></div>
    </div>
    <div class="tile ${unfilled ? "alert" : ""}"><div class="label">Nobody took it</div><div class="value">${unfilled}</div></div>
    <div class="tile"><div class="label">Need approval</div><div class="value">${needApproval}</div></div>
    <div class="tile"><div class="label">Offering now</div><div class="value">${offering}</div></div>
    <div class="tile ${squareTodo ? "warn" : ""}"><div class="label">Held — confirm in Square</div><div class="value">${squareTodo}</div></div>`;
}

function names(offers) {
  return offers.length ? offers.map((o) => esc(o.name)).join(", ") : '<span class="muted">—</span>';
}

function ruleText(rule) {
  if (rule.kind === "required") return `Only ${rule.stylist}`;
  return rule.preferred ? `Any stylist (prefers ${rule.preferred})` : "Any stylist";
}

function tagText(tags) {
  const parts = [...tags.days, ...tags.parts];
  return parts.length ? parts.join(" · ") : "no tags";
}

function renderApproval(id, s) {
  if (!selections.has(id)) selections.set(id, new Set(s.suggestions.map((m) => m.clientId)));
  const sel = selections.get(id);
  const settings = approvalSettings.get(id) ?? {
    batchSize: s.opening.batchSize,
    replyWindow: s.opening.fastDemo ? "fast" : String(s.opening.replyWindowSeconds / 60),
  };
  approvalSettings.set(id, settings);
  const windowOptions = [["10", "10 min"], ["15", "15 min"], ["30", "30 min"], ["60", "1 hour"], ["120", "2 hours"], ["fast", "Fast demo: 30 seconds"]];
  if (!windowOptions.some(([v]) => v === settings.replyWindow)) windowOptions.unshift([settings.replyWindow, windowText(Number(settings.replyWindow) * 60)]);
  return `
    <div class="block warn">
      <h3>Approve who gets texted ${s.cycle > 1 ? `(try #${s.cycle})` : ""}</h3>
      <p class="small muted" style="margin:0 0 6px">Suggested from the waitlist — same service, stylist rule OK, availability roughly fits. Earliest joiner first. <strong>Nothing is sent until you approve.</strong> Untick anyone who shouldn't get it.</p>
      ${s.suggestions
        .map(
          (m) => `
        <label class="suggestion">
          <input type="checkbox" data-select="${esc(id)}" value="${esc(m.clientId)}" ${sel.has(m.clientId) ? "checked" : ""} />
          <span>
            <span class="client-name">${esc(m.name)}</span>
            ${m.checkNote ? '<span class="badge warn">Check note</span>' : ""}
            ${m.prefersThisStylist ? '<span class="badge ok">Prefers this stylist</span>' : ""}
            <br /><span class="note">“${esc(m.availabilityNote)}”</span>
            <br /><span class="tiny muted">${esc(ruleText(m.stylistRule))} · joined ${esc(shortDate(m.joinedAt))} · ${esc(m.mobile)}</span>
          </span>
        </label>`,
        )
        .join("")}
      <div class="form-grid">
        <label class="field">Texts per round
          <select data-setting="batchSize" data-id="${esc(id)}">
            ${[1, 2, 3, 4, 5].map((n) => `<option ${Number(settings.batchSize) === n ? "selected" : ""}>${n}</option>`).join("")}
          </select>
        </label>
        <label class="field">Reply window
          <select data-setting="replyWindow" data-id="${esc(id)}">
            ${windowOptions.map(([v, l]) => `<option value="${v}" ${settings.replyWindow === v ? "selected" : ""}>${l}</option>`).join("")}
          </select>
        </label>
      </div>
      <div class="row" style="margin-top:10px">
        <button data-action="approve" data-id="${esc(id)}" ${sel.size ? "" : "disabled"}>Approve &amp; text ${Math.min(sel.size, Number(settings.batchSize))} now (${sel.size} approved)</button>
        ${s.cycle > 1 ? `<button class="secondary" data-action="leave-open" data-id="${esc(id)}">Don't text anyone — leave it open</button>` : ""}
      </div>
    </div>`;
}

function renderOffering(id, s) {
  const round = s.currentRound;
  const roundOffers = round ? s.offers.filter((o) => round.offerIds.includes(o.offerId)) : [];
  const nextUp = s.queue.map((cid) => s.suggestions.find((m) => m.clientId === cid)?.name ?? cid);
  const sending = roundOffers.some((o) => o.status === "sending");
  return `
    <div class="block">
      <h3>${round ? `Round ${round.number}: ${sending ? "sending texts…" : "holding the offer"}` : "Preparing the next round…"}</h3>
      ${roundOffers
        .map(
          (o) => `
        <div class="holder">
          <span><strong>${esc(o.name)}</strong> <span class="tiny muted">${esc(o.mobile)}</span><br />
            <span class="small muted">${o.status === "live" ? "No reply yet" : esc(o.status.replace("_", " "))}</span></span>
          <span class="row">
            ${o.status === "live" && o.deadline ? `<span class="countdown" data-deadline="${o.deadline}">${countdownText(o.deadline)}</span>` : ""}
            ${o.status === "live" ? `<a class="btn secondary small" href="${offerUrl(id, o)}" target="_blank" rel="noopener">Open client offer</a>` : ""}
          </span>
        </div>`,
        )
        .join("")}
      ${round?.deadline ? `<p class="tiny muted" style="margin:6px 0 0">Reply by ${esc(clock(round.deadline))}${s.opening.fastDemo ? " · Fast demo (30-second window)" : ""}. First yes wins.</p>` : ""}
      <p class="small muted" style="margin:6px 0 0">Next up: ${nextUp.length ? esc(nextUp.join(", ")) : "nobody — this is the last round"}</p>
    </div>`;
}

function renderStatusBlock(id, s) {
  switch (s.status) {
    case "finding_matches":
      return `<div class="block"><h3>Finding matches on the waitlist…</h3></div>`;
    case "awaiting_approval":
      return renderApproval(id, s);
    case "offering":
      return renderOffering(id, s);
    case "unfilled": {
      const noMatches = s.unfilledKind === "no_matches";
      const passed = s.unfilledKind === "time_passed";
      return `
        <div class="block danger">
          <h3>${noMatches ? "No one on the waitlist matches" : passed ? "Time has passed — nobody took it" : "Nobody took it"}</h3>
          <p class="small" style="margin:0 0 10px">${esc(s.unfilledReason ?? "")}</p>
          <div class="row">
            ${passed ? "" : `<button data-action="keep-trying" data-id="${esc(id)}">${noMatches ? "Check again" : "Keep trying"}</button>`}
            <button class="secondary" data-action="leave-open" data-id="${esc(id)}">Leave it open</button>
          </div>
          <p class="tiny muted" style="margin:8px 0 0">${noMatches ? "Check again re-reads the current waitlist." : "Keep trying re-checks the current waitlist (skipping anyone who declined this opening) and asks you to approve again."} Leave it open counts as unfilled.</p>
        </div>`;
    }
    case "filled": {
      const w = s.winner;
      if (s.square.done) {
        return `
        <div class="block ok">
          <h3>Filled by ${esc(w?.name)} <span class="tiny muted">${esc(w?.mobile)}</span></h3>
          <p class="small" style="margin:0">✓ Confirmed — Square appointment updated (${esc(clock(s.square.doneAt))}).</p>
        </div>`;
      }
      const booking = s.bookingRecorded;
      return `
        <div class="block ok">
          <h3>Held for ${esc(w?.name)} — confirm in Square</h3>
          <p class="small" style="margin:0 0 4px">${esc(w?.mobile)} · said yes at ${esc(clock(w?.acceptedAt))}${w?.via === "late_yes" ? " (booked from a late yes)" : ""}.
            ${booking?.applied ? "Marked booked on the waitlist." : booking ? `<strong class="danger-text">Waitlist not updated: ${esc(booking.reason)} — check before confirming.</strong>` : "Updating waitlist…"}</p>
          <p class="small" style="margin:0 0 8px">Hold auto-releases in <span class="countdown" data-deadline="${w?.holdUntil}">${countdownText(w?.holdUntil ?? 0)}</span> if not confirmed.</p>
          <p class="small" style="margin:0 0 8px"><strong>To-do: confirm with ${esc(w?.name?.split(" ")[0])} and update the appointment in Square.</strong> <span class="muted">This prototype doesn't touch Square.</span></p>
          ${confirmBlock(id, "square-done", "Mark as done in Square? This closes the opening.", "Yes — Square updated", false)
            ?? confirmBlock(id, "release-hold", `Release the hold for ${esc(w?.name)}? The next approved people get offered it.`, "Yes, release hold", true)
            ?? `<div class="row">
                <button data-action="ask" data-confirm="square-done" data-id="${esc(id)}">Done — updated in Square</button>
                <button class="secondary" data-action="ask" data-confirm="release-hold" data-id="${esc(id)}">Couldn't confirm — release hold</button>
              </div>`}
        </div>`;
    }
    case "cancelled":
      return `<div class="block"><h3>Cancelled</h3><p class="small" style="margin:0">${s.cancelReason ? esc(s.cancelReason) + ". " : ""}Anyone holding an offer was told it's no longer available.</p></div>`;
    case "left_open":
      return `<div class="block"><h3>Left open</h3><p class="small" style="margin:0">Outreach closed — counted as unfilled.</p></div>`;
    default:
      return "";
  }
}

/** Inline confirmation (instead of window.prompt / one-tap checkboxes) — returns undefined when not open. */
function confirmBlock(id, action, question, yesLabel, withReason) {
  if (confirming.get(id) !== action) return undefined;
  return `
    <div class="confirm">
      <p class="small" style="margin:0 0 8px"><strong>${question}</strong></p>
      ${withReason ? `<input class="reason" data-reason="${esc(id)}" placeholder="Reason (optional)" maxlength="200" />` : ""}
      <div class="row" style="margin-top:8px">
        <button class="${action === "square-done" ? "" : "danger-solid"}" data-action="${action}" data-id="${esc(id)}">${yesLabel}</button>
        <button class="secondary" data-action="never-mind" data-id="${esc(id)}">${action === "cancel" ? "Keep it" : "Not now"}</button>
      </div>
    </div>`;
}

function renderLateYes(id, s) {
  const pending = s.offers.filter((o) => o.lateReply === "expired" && !o.lateYesResolved);
  if (!pending.length) return "";
  const canBook = !["filled", "cancelled", "left_open"].includes(s.status);
  return pending
    .map(
      (o) => `
    <div class="block warn late-yes">
      <h3>${esc(o.name)} said yes late</h3>
      <p class="small" style="margin:0 0 8px">Replied at ${esc(clock(o.lateYesAt))}, after their reply window ended — not booked. They were told the salon will check and get back to them.</p>
      <div class="row">
        ${canBook ? `<button data-action="late-book" data-offer="${esc(o.offerId)}" data-id="${esc(id)}">Book ${esc(o.name.split(" ")[0])}</button>` : `<span class="small muted">Too late to book here — ${s.status === "filled" ? "someone else holds it" : "outreach is closed"}.</span>`}
        <button class="secondary" data-action="late-dismiss" data-offer="${esc(o.offerId)}" data-id="${esc(id)}">Dismiss</button>
      </div>
    </div>`,
    )
    .join("");
}

function renderCard(o) {
  const id = o.workflowId;
  if (!o.state) {
    return `<article class="card" id="card-${esc(id)}">
      <div class="card-head"><div><div class="card-title">${esc(id)}</div><div class="small muted">${
        !o.running && /nondeterminism/i.test(o.error ?? "")
          ? "Closed opening from an earlier prototype build — its full history is still in Temporal."
          : `Can't read this opening right now${o.error ? `: ${esc(o.error)}` : ""}. Is the Worker running?`
      }</div></div><span class="pill unknown">Unknown</span></div>
      <div class="card-foot"><a class="small" href="${esc(o.temporalUrl)}" target="_blank" rel="noopener">View in Temporal</a></div>
    </article>`;
  }
  const s = o.state;
  const op = s.opening;
  // One entry per person (their latest offer), so nobody shows up in two lists across Keep-trying tries.
  const latest = new Map();
  for (const x of s.offers) latest.set(x.clientId, x);
  const people = [...latest.values()].filter((x) => x.offerId !== s.winner?.offerId);
  const tryLabel = (x) => (s.cycle > 1 ? `${x.name} (try ${x.cycle})` : x.name);
  const by = (st) => people.filter((x) => x.status === st).map((x) => ({ name: tryLabel(x) }));
  const closed = ["filled", "cancelled", "left_open"].includes(s.status);
  const pillLabel = s.status === "filled" ? (s.square.done ? "Filled" : "Held — confirm") : STATUS_LABEL[s.status] ?? s.status;
  const needsStaff =
    s.status === "awaiting_approval" || (s.status === "filled" && !s.square.done) || s.offers.some((x) => x.lateReply === "expired" && !x.lateYesResolved);
  const cls = s.status === "unfilled" ? "attention" : needsStaff ? "approval" : "";
  return `
    <article class="card ${cls}" id="card-${esc(id)}">
      <div class="card-head">
        <div>
          <div class="card-title">${esc(op.service)} · ${esc(op.stylist)}</div>
          <div class="card-when">${esc(formatSlot(op.startsAt))} <span class="muted small">· ${esc(op.durationMinutes)} min</span></div>
          <div class="tiny muted">${op.batchSize} per round · ${esc(windowText(op.replyWindowSeconds))} to reply${op.fastDemo ? " (Fast demo)" : ""}${op.simulateTextFailure ? " · simulating a failed first text" : ""}</div>
        </div>
        <span class="pill ${esc(s.status)}">${esc(pillLabel)}</span>
      </div>
      ${renderLateYes(id, s)}
      ${renderStatusBlock(id, s)}
      ${
        s.offers.length
          ? `<dl class="outcomes">
              <div><dt>Declined</dt><dd>${names(by("declined"))}</dd></div>
              <div><dt>No reply (timed out)</dt><dd>${names(by("timed_out"))}</dd></div>
              <div><dt>Told filled</dt><dd>${names(by("told_filled"))}</dd></div>
              ${by("released").length ? `<div><dt>Hold released</dt><dd>${names(by("released"))}</dd></div>` : ""}
              ${by("told_cancelled").length ? `<div><dt>Told cancelled</dt><dd>${names(by("told_cancelled"))}</dd></div>` : ""}
            </dl>`
          : ""
      }
      <details class="history" data-history="${esc(id)}" ${openHistory.has(id) ? "open" : ""}>
        <summary>History (${s.history.length})</summary>
        <ol class="timeline">
          ${[...s.history]
            .reverse()
            .map((h) => `<li><time>${esc(clock(h.at))}</time><span>${esc(h.text)}</span></li>`)
            .join("")}
        </ol>
      </details>
      <div class="card-foot">
        <a class="small" href="${esc(o.temporalUrl)}" target="_blank" rel="noopener">View workflow in Temporal ↗</a>
        ${closed && !(s.status === "filled" && !s.square.done) ? "" : confirming.get(id) === "cancel" ? "" : `<button class="danger" data-action="ask" data-confirm="cancel" data-id="${esc(id)}">Cancel opening</button>`}
      </div>
      ${confirmBlock(id, "cancel", `Cancel this opening? Anyone holding an offer${s.status === "filled" ? " (including the held yes)" : ""} is told it's no longer available.`, "Yes, cancel opening", true) ?? ""}
    </article>`;
}

function renderOpenings(data) {
  const container = $("#openings");
  if (!data.openings.length) {
    container.innerHTML = `<div class="empty panel">No openings yet. When a client cancels, tap <strong>+ New opening</strong>.</div>`;
    cardCache.clear();
    return;
  }
  const ids = data.openings.map((o) => o.workflowId);
  // Rebuild only cards whose data changed, so taps and ticks aren't lost on refresh.
  const existing = new Map([...container.querySelectorAll("article.card")].map((el) => [el.id.slice(5), el]));
  if ([...existing.keys()].join() !== ids.join()) {
    container.innerHTML = "";
    cardCache.clear();
    existing.clear();
  }
  for (const o of data.openings) {
    const sig = JSON.stringify([o.state, o.error, [...(selections.get(o.workflowId) ?? [])], approvalSettings.get(o.workflowId), confirming.get(o.workflowId)]);
    if (cardCache.get(o.workflowId) === sig && existing.has(o.workflowId)) continue;
    cardCache.set(o.workflowId, sig);
    const tmp = document.createElement("div");
    tmp.innerHTML = renderCard(o).trim();
    const el = tmp.firstElementChild;
    if (existing.has(o.workflowId)) existing.get(o.workflowId).replaceWith(el);
    else container.appendChild(el);
  }
}

function renderWaitlist(data) {
  const wl = data.waitlist;
  if (wl.error) {
    $("#waitlist").innerHTML = `<p class="muted small">Waitlist unavailable: ${esc(wl.error)}</p>`;
    return;
  }
  $("#wl-source").textContent = wl.source;
  document.querySelectorAll("#wl-filter button").forEach((b) => {
    const n = b.dataset.filter === "all" ? wl.clients.length : wl.clients.filter((c) => c.status === b.dataset.filter).length;
    b.textContent = `${b.dataset.filter[0].toUpperCase()}${b.dataset.filter.slice(1)} (${n})`;
    b.className = b.dataset.filter === wlFilter ? "" : "secondary";
  });
  const clients = wl.clients
    .filter((c) => wlFilter === "all" || c.status === wlFilter)
    .sort((a, b) => (a.joinedAt < b.joinedAt ? -1 : 1));
  $("#waitlist").innerHTML =
    clients
      .map(
        (c) => `
      <div class="client">
        <div class="client-top">
          <span class="client-name">${esc(c.name)}</span>
          <span>${
            c.optedOut
              ? `<span class="badge danger">Opted out — never texted</span>`
              : c.status === "booked" && c.holding?.held
                ? `<span class="badge warn">Held — staff to confirm</span>`
              : c.status === "booked"
              ? `<span class="badge ok">Booked</span>`
              : c.holding
                ? `<span class="badge info">Holding offer${c.holding.deadline ? ` · <span class="countdown" data-deadline="${c.holding.deadline}">${countdownText(c.holding.deadline)}</span>` : ""}</span>`
                : `<span class="badge">Waiting</span>`
          }</span>
        </div>
        <div class="client-meta">${esc(c.service)} · ${esc(c.stylistRuleText)} · joined ${esc(shortDate(c.joinedAt))}</div>
        <div class="small"><span class="note">“${esc(c.availabilityNote)}”</span> <span class="tiny muted">[${esc(tagText(c.availabilityTags))}]</span></div>
        <div class="tiny muted">${esc(c.mobile)}</div>
      </div>`,
      )
      .join("") || `<p class="muted small">Nobody here.</p>`;
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
    const what = `${s.opening.service} · ${s.opening.stylist} ${formatSlot(s.opening.startsAt)}`;
    if (s.status === "awaiting_approval") items.push([`${o.workflowId}:approve:${s.cycle}`, `Approve who gets texted — ${what}`]);
    if (s.status === "unfilled") items.push([`${o.workflowId}:unfilled:${s.cycle}`, `Nobody took it — ${what}`]);
    if (s.status === "filled" && !s.square.done && s.winner) items.push([`${o.workflowId}:held:${s.winner.offerId}`, `${s.winner.name} said yes — confirm in Square (${what})`]);
    for (const x of s.offers) if (x.lateReply === "expired" && !x.lateYesResolved) items.push([`${o.workflowId}:late:${x.offerId}`, `${x.name} said yes late — ${what}`]);
  }
  document.title = items.length ? `(${items.length}) Juniper — needs you` : "Juniper Salon · Refill openings";
  $("#attention").textContent = items.length ? `${items.length} need${items.length === 1 ? "s" : ""} you` : "";
  $("#attention").hidden = !items.length;
  if (seenAttention && "Notification" in window && Notification.permission === "granted") {
    for (const [key, text] of items) if (!seenAttention.has(key)) new Notification("Juniper Salon", { body: text, tag: key });
  }
  seenAttention = new Set(items.map(([key]) => key));
  const btn = $("#alerts-btn");
  if (btn) btn.hidden = !("Notification" in window) || Notification.permission !== "default";
}
async function enableAlerts() {
  if (!("Notification" in window)) return toast("This browser can't show notifications.", true);
  const result = await Notification.requestPermission();
  toast(result === "granted" ? "Alerts on — you'll get a notification when something needs you." : "Alerts not enabled.");
  $("#alerts-btn").hidden = true;
}

async function refresh() {
  if (busy) return;
  try {
    const data = await api("/api/dashboard");
    serverOffset = data.now - Date.now();
    renderTiles(data);
    renderOpenings(data);
    renderWaitlist(data);
    $("#conn").textContent = "Live";
    $("#conn").className = "conn";
    $("#updated").textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`;
  } catch (error) {
    $("#conn").textContent = error.message;
    $("#conn").className = "conn bad";
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------
async function staffAction(id, action, body, button) {
  if (button) button.disabled = true;
  busy = true;
  try {
    const result = await api(`/api/openings/${encodeURIComponent(id)}/${action}`, { method: "POST", body: body ?? {} });
    toast(result.message);
    if (action === "approve") selections.delete(id);
  } catch (error) {
    toast(error.message, true);
    if (button) button.disabled = false;
  } finally {
    busy = false;
    cardCache.delete(id);
    await refresh();
  }
}

document.addEventListener("click", (event) => {
  const el = event.target.closest("[data-action]");
  if (!el || el.tagName === "INPUT") return;
  const id = el.dataset.id;
  const action = el.dataset.action;
  const reason = () => document.querySelector(`[data-reason="${CSS.escape(id)}"]`)?.value ?? "";
  const rerender = () => {
    cardCache.delete(id);
    refresh();
  };
  if (action === "approve") {
    const settings = approvalSettings.get(id) ?? {};
    const body = { clientIds: [...(selections.get(id) ?? [])], batchSize: Number(settings.batchSize) };
    if (settings.replyWindow === "fast") body.fastDemo = true;
    else body.replyWindowMinutes = Number(settings.replyWindow);
    staffAction(id, "approve", body, el);
  } else if (action === "ask") {
    confirming.set(id, el.dataset.confirm);
    rerender();
  } else if (action === "never-mind") {
    confirming.delete(id);
    rerender();
  } else if (action === "cancel" || action === "release-hold" || action === "square-done") {
    const body = action === "square-done" ? {} : { reason: reason() };
    confirming.delete(id);
    staffAction(id, action, body, el);
  } else if (action === "late-book" || action === "late-dismiss") {
    staffAction(id, "late-yes", { offerId: el.dataset.offer, action: action === "late-book" ? "book" : "dismiss" }, el);
  } else if (action === "keep-trying") staffAction(id, "keep-trying", {}, el);
  else if (action === "leave-open") staffAction(id, "leave-open", {}, el);
  else if (action === "alerts") enableAlerts();
});

document.addEventListener("change", (event) => {
  const el = event.target;
  if (el.dataset.select) {
    const sel = selections.get(el.dataset.select) ?? new Set();
    el.checked ? sel.add(el.value) : sel.delete(el.value);
    selections.set(el.dataset.select, sel);
    cardCache.delete(el.dataset.select);
    refresh();
  } else if (el.dataset.setting) {
    const s = approvalSettings.get(el.dataset.id) ?? {};
    s[el.dataset.setting] = el.value;
    approvalSettings.set(el.dataset.id, s);
    cardCache.delete(el.dataset.id);
    refresh();
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
  refresh();
});

// Countdowns tick every second without re-rendering.
setInterval(() => {
  document.querySelectorAll("[data-deadline]").forEach((el) => {
    const deadline = Number(el.dataset.deadline);
    el.textContent = countdownText(deadline);
    el.classList.toggle("low", deadline - (Date.now() + serverOffset) < 60_000);
  });
}, 1000);

setupForm()
  .catch((error) => toast(error.message, true))
  .finally(() => {
    refresh();
    setInterval(refresh, 2000);
  });
