# Juniper Salon — Refill Openings

Lena runs Juniper Salon. When a client cancels at the last minute, she or Carla open the Google Sheet waitlist and text the 3 or 4 people who seem to fit. They text several people at once because it fills the chair faster. That speed has a cost:
- Sometimes two people say yes, and someone ends up disappointed.
- On busy days it's hard to keep track of who was texted and who declined.
- Sometimes nobody answers and the chair stays empty.

Today they refill about **3 in 10** last-minute cancellations. Lena's goal is **at least half**, without anyone having to keep checking their phone.

This prototype keeps the speed of texting several people at once, but **only one yes can win**. Temporal follows each opening while staff are busy with clients: it waits for replies, moves on when nobody answers, and tells staff the moment they need to act.

## Run it

You need **Node.js 20+** and **Docker Desktop**.

```bash
npm install
npm run dev
```

- Staff dashboard: <http://localhost:3000>
- Temporal Web UI: <http://localhost:8233> (each opening also has a **View workflow in Temporal** link)

Press **Ctrl+C** to stop the app, and run `npm run stop` to stop Temporal. Temporal's data is kept in a Docker volume. To start over with a fresh waitlist, run `docker compose down -v`. (A waitlist saved by an earlier version is upgraded in place: the old "opted out" flag becomes a texting answer, anyone without a recorded answer becomes **Not asked yet**, and Highlights / Trim become Color / Haircut. Openings started by an earlier version can't be shown; start fresh to see the new rules end to end.)

## Try it

1. **Create an opening.** Click **Add opening** and enter a Haircut with Lena at least two hours from now (the length fills in from the service). Open **Offer settings** and set **Reply window** to **Fast demo: 30 seconds**. Fast demo ignores texting hours, so this works at any time of day.
2. **Approve the matches.** The system suggests people who want that service, accept that stylist, and whose availability note roughly fits, earliest joiner first. Each note is shown exactly as staff wrote it, and anything the system can't interpret is marked **Check note**. Untick anyone, then click **Approve & text**. **Nothing is sent before approval.**
3. **Reply as a client.** Click **Preview client's text** to see the page a client would open from the text: the service, stylist, date and exact time, a "Reply by" time with a countdown, **Yes, I want it** and **No thanks** buttons, and the text itself.
4. **Race two yeses.** Open two clients' offers and accept both. The first yes **holds** the slot. The other client sees "Sorry, this time was just taken," and everyone else in that round is told it's filled and that they're still on the waitlist.
5. **Confirm in Square.** The card now reads **Held for …** with a **Held · confirm in Square** label. Click **Done — updated in Square**, or **Couldn't confirm — release hold** to move on to the next people. Both ask you to confirm first. If nobody does either within **15 minutes**, the hold is released automatically.
6. **Let it time out.** Leave a fast-demo round unanswered. The people in it are marked **No reply** and the next people are texted automatically. When nobody is left, the card moves to **Needs you**, marked **Nobody took it**, with **Keep trying** and **Leave it open** buttons.
7. **Late yes.** The client page removes **Yes** and **No** when the countdown ends, so a late yes can only be sent through the API. Copy the offer link from **Preview client's text** (it has `o`, `c` and `t` in it), let that reply window end, then run:

   ```sh
   curl -X POST http://localhost:3000/api/offers/<o>/respond \
     -H "Content-Type: application/json" \
     -d '{"clientId":"<c>","token":"<t>","answer":"accept"}'
   ```

   The client is told the salon will check, and staff see "… said yes late" with **Book** and **Dismiss** buttons while the opening is still open. A late yes is never booked automatically.
8. **Cancel.** **Cancel opening** works at any point until the slot is confirmed in Square. It asks you to confirm first. Every open offer then shows "This opening is no longer available," and no later tap can book it.

More to try:
- **Texting hours.** Create an opening for a later day without Fast demo and approve it before 9:00 AM: the card reads **Scheduled — texts go out at 9:00 AM (outside texting hours)**. After 8:00 PM it reads **… at 9:00 AM tomorrow (outside texting hours)**. Nothing is sent until then, and **Cancel opening** still works while it waits.
- **Start-time cutoff.** Add a same-day opening about 90 minutes away, set **Reply window** to **1 hour** (or 2 hours), and leave **Stop offering … before it starts** at 1 hour. The first round's window is shortened to about 30 minutes so replies close by the cutoff, and the text and client page show that shorter window. (With **Auto**, a same-day opening gets 15 minutes, which already fits, so nothing is shortened.) The card says **Stopped offering: Too close to the start time to offer it** when the next round would start after the cutoff, when less than 5 minutes would be left to reply, when an approval list is still waiting at the cutoff, or when an opening is added inside the cutoff.
- **Waitlist.** Each person shows a texting badge: **Opted in to texts**, **Opted out — don't text** or **Not asked yet — don't text**. Use **Add to waitlist** to add someone, which requires an answer to "Can we text them about earlier openings?" (Yes, No or Didn't ask). The answer goes with the mobile number, so every entry with that number shares it. Use **Record texting answer** for someone marked **Not asked yet** (or under **Manage** to change an answer). Recording **No** takes effect straight away: consent is checked again just before every client text, so someone with an offer out gets no more texts about it. **Manage → Remove from waitlist** is for someone who asked to come off it. It asks you to confirm, and removed people stay under **All** marked **Removed — asked to come off**.

Two other options: **Simulate first text attempt failing** shows a failed send being retried in the workflow's Event History, and **Turn on alerts** shows browser notifications when something needs staff.

## What Lena told us, and what the prototype does

| Lena said | Prototype |
| --- | --- |
| 20–30 people, kept in a Google Sheet (name, mobile, service, stylist preference, availability). | 24 **fictional** sample clients, labelled as sample data from the Sheet. Staff can **Add to waitlist**, and a new person joins at the back of the line. |
| Five stylists (only Lena and Carla named so far). Main services: Haircut, Color and Blowout, about 30 minutes to 3 hours. | Five stylists: Lena, Carla, and three **sample names (Sam, Jules, Nico), to confirm with Lena**. Services are Haircut (45 min by default), Color (120) and Blowout (45). Staff can set 30 to 180 minutes. |
| People aren't removed automatically; they stay until they ask to come off. | **Remove from waitlist** is only for someone who asked, and it asks you to confirm. It can't be used while that person has a live offer or a held slot. Once they decline, their offer no longer blocks it. Removed people stay in the history under **All**, and are never suggested or texted again. |
| Some clients will only see one stylist; others will see anyone if the time works. | Each client is either **Only Lena** (etc.) or **Any stylist**. "Any stylist" clients are suggested for every stylist's openings. |
| Availability is loose notes like "weekday afternoons" or "after 5". | Notes are shown word for word. A rough reading is used only to *suggest* matches. |
| She wants to approve the suggested matches before anything goes out. | Approval is a required step in the workflow. |
| Earliest joiner first; she texts 3–4 people at once because speed matters most. | Texts go out in rounds, default 3, adjustable from 1 to 5, earliest joiner first. |
| Two yeses cause problems, and someone gets let down. | **First yes wins**, decided atomically. Everyone else is told right away and keeps their place. |
| A client who fits two openings should only be offered one at a time — "otherwise they could accept both and create another scheduling problem." | The waitlist Workflow reserves each client for one opening's offer at a time. While their offer is live, other openings skip them and keep their place for the next round. |
| She waits about 10–15 minutes for same-day openings, and closer to 2 hours for later ones, but it's not a firm rule. | The default window is 15 minutes for same-day openings and 2 hours for later ones. Staff can change it per opening. |
| No texts very early or late, unless it's a same-day opening that needs filling. | Offer texts go out only from **9:00 AM to 8:00 PM** salon time. Lena said those hours "sound about right". They're set in one place (`src/rules.ts`). Same-day openings, and Fast demo, can text at any time. A round that's due outside those hours waits until the next 9:00 AM. It never waits until midnight just because a next-day opening becomes same-day then. Alerts to staff aren't restricted. |
| Still try if there's enough time for the client to get here. Thirty minutes might be too short, depending on the service and the person. | Each opening has a **Stop offering … before it starts** setting: 30, 45, 60, 90 or 120 minutes, with 60 as the default. Each reply window is shortened so it ends by the cutoff. If less than 5 minutes would be left, or the cutoff has passed, outreach stops: "Too close to the start time to offer it." This also applies to an approval list nobody has approved by the cutoff. If a send is so slow that the promised window would run past the cutoff (or past 8:00 PM), it is abandoned, nobody is texted, and the round is planned again. |
| A yes after the slot is filled shouldn't be booked; the client stays on the list. | "Sorry, this time was just taken." The client keeps their place. |
| A late yes while the slot is still open shouldn't be automatic, and the text should make clear a late reply doesn't guarantee the appointment. | The offer text and page both say late replies aren't guaranteed. A late yes is flagged for staff to **Book** or **Dismiss**. |
| Declines and no-replies stay on the list for future openings. | Their place on the list is never changed. |
| Ask people when they join, and record whether they've opted in to texts. Some have already opted out. | Each client is recorded as **Opted in**, **Opted out** or **Not asked yet**. **Only opted-in clients are suggested or texted.** The answer belongs to the mobile number: if any entry with that number opted out, the number is never texted. The waitlist Workflow refuses to reserve anyone else, and consent is checked again just before every client text (offers and follow-ups), so an opt-out recorded mid-offer stops further texts. Add to waitlist requires an answer, and staff can **Record texting answer** later. The sample data has 19 clients opted in, 2 opted out and 3 not asked yet. |
| Staff need to see the service, stylist, time, who has the offer, declines and timeouts, and whether it's filled or cancelled. | All of this is on each opening card, along with a timestamped history. |
| If nobody takes it, she wants to know right away and then decide. Re-offering to people who didn't reply is fine, but try others first. | **Nobody took it** alert with **Keep trying** and **Leave it open**. Keep trying lists people never texted for this opening first; people texted before with no reply go to the end, marked **Texted before — no reply**. Anyone who declined is left out. |
| Square stays the real calendar, and nothing books automatically. | A yes only *holds* the slot. Staff confirm and update Square themselves. |
| If a hold can't be confirmed, release it and offer it to the next person, automatically after about 15 minutes. | **Release hold** button, plus an automatic release after 15 minutes. |
| Simulated texts must be clearly labelled during the demo, so nobody mistakes them for real messages. | Every page has a **Demo** banner, and each message appears in a dashed bubble marked **Simulated text — not sent**. The history and Worker logs say "simulated" too. |
| She wants it warm and calm, not like a technical dashboard, with soft, welcoming colors. Later direction: professional, simple, and accessible to everyone. | A plain, professional booking-software look: a warm off-white background, white cards, one sage green for main actions, and plain words ("Open chairs", "Needs your OK", "Needs you"). Colors, focus outlines and keyboard use follow WCAG 2.2 AA. |
| Lena and Carla are usually with clients when a cancellation comes in. Alerts should go to both of them for now. | Simulated alert texts to **both Lena and Carla** (the history reads "Simulated text to Lena and Carla: …"), a "needs you" count in the tab title and header, optional browser alerts, and a phone-friendly layout. |
| Success means refilling at least half of last-minute cancellations (within 48 hours of the appointment), up from about 3 in 10. | A refill-rate meter compared against the ~30% baseline and the 50% goal. It counts only **last-minute** openings (starting within 48 hours of being added, marked **Last-minute (within 48 h)** on the card). Openings further ahead are shown separately. A chair counts as refilled only once it's confirmed in Square, and the meter is labelled as prototype data. |

## How Temporal is used

**One Workflow per opening** (`openingWorkflow`, ID `opening-<id>`, task queue `juniper-salon`). The whole life of an opening is one durable workflow, from suggesting matches through approval, rounds of offers, the hold, and confirmation or cancellation. If the browser is closed or the Worker restarts, the opening carries on where it left off.

- **Durable timers** handle the reply window, the 15-minute hold, and waiting for texting hours. The reply window starts only after the texts have actually been sent, and it never runs past the opening's start-time cutoff.
- **Texting hours are checked in an Activity** (`textingWindow`). The Workflow passes in its own clock, and the Activity works out the salon-local time, whether the opening is today, and the next allowed send time. Workflow code never reads a timezone, so it stays deterministic.
- **Updates** carry every staff and client action and return a clear answer: `approveMatches`, `respond`, `cancelOpening`, `releaseHold`, `resolveLateYes`, `markSquareDone`, `keepTrying` and `leaveOpen`. The `respond` handler has no `await` between checking and recording the winner, so two yeses arriving together can't both win, and a cancel and a yes can't both take effect.
- **Queries** (`getOpening`) supply the dashboard and the client page.
- **Activities** (simulated) cover suggesting matches, checking texting hours, sending texts to clients and to Lena and Carla, and updating the waitlist. Temporal retries failed sends, and cancelling an opening stops a send that is still retrying.

**One long-running waitlist Workflow** (`juniper-waitlist`) is the single owner of each client's status. It reserves a client for one opening's offer at a time, so nobody gets two offers at once, and it records a booking only once. Staff changes are validated **Updates**: `addClient` (joins at the back of the line), `recordConsent`, and `removeClient` (refused while the person has a live offer or a held slot). It uses continue-as-new to keep its history small.

## Checks

```bash
npm run typecheck
npm test
```

There are 71 tests: Workflow tests run in Temporal's time-skipping test environment with mocked Activities, plus unit tests for matching and texting hours. They cover:
- nothing is sent before approval;
- two simultaneous yeses produce one winner;
- a late yes after a fill;
- a timeout moves on to the next round;
- when nobody is left: **Keep trying** and **Leave it open**;
- cancel blocks a later yes;
- bad links are rejected;
- only opted-in clients are suggested or reserved, and opted-out or not-asked clients never are;
- texting hours: a round waits overnight and sends at 9:00 AM, Cancel works during the wait, and same-day openings and Fast demo send at any time;
- the start-time cutoff: the reply window is shortened so it ends by the cutoff, outreach stops when it's too close (also on an approval list left waiting), Keep trying is refused then, and a send that comes back too late texts nobody;
- consent: an opt-out recorded after someone was picked, or while their offer is live, stops every further text to them; one answer per mobile number;
- Keep trying puts earlier non-responders at the end;
- staff alerts go to both Lena and Carla;
- Add to waitlist: validation, and new people join at the back of the line;
- Remove from waitlist: refused during a live offer or a held slot, allowed otherwise, and removed people are never suggested;
- holds, their release, and the automatic release;
- a late yes is flagged for staff;
- the waitlist never books one client twice;
- matching on stylist rules (all five stylists), services, availability notes and join order.

The flow was also checked live against the Docker Temporal server. Screenshots are in [`evidence/`](evidence/).

## What's simulated, and what's next

- **No real texts are sent.** Texts are logged by an Activity and shown on screen marked **Simulated text — not sent**. **Preview client's text** stands in for the text link. A pilot would need an SMS provider sending from the salon number, plus opt-out handling on that provider (for example, a reply of STOP should record **Opted out**).
- **No Google Sheets or Square connection.** The waitlist is sample data, and Square stays manual, as Lena asked.
- **To confirm with Lena:** the three sample stylist names and the default lengths for each service.
- **Local only.** There is no staff login, and the offer links are local. Real use needs authentication and secure public offer links.
- **Refill rate is illustrative.** It reflects only the openings in this prototype and doesn't prove the 50% goal.

**Suggested next step:** a two-to-four-week pilot with Lena and Carla, using a small group of waitlist clients who have agreed to be texted. Track the refill rate against the ~30% baseline, how often staff had to step in, and whether the reply windows feel right.
