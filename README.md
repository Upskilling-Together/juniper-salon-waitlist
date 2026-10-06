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

Press **Ctrl+C** to stop the app, and run `npm run stop` to stop Temporal. Temporal's data is kept in a Docker volume. To start over with a fresh waitlist, run `docker compose down -v`.

## Try it

1. **Create an opening.** Click **Add opening** and enter a Haircut with Lena later today, with the reply window set to **Fast demo: 30 seconds**.
2. **Approve the matches.** The system suggests people who want that service, accept that stylist, and whose availability note roughly fits, earliest joiner first. Each note is shown exactly as staff wrote it, and anything the system can't interpret is marked **Check note**. Untick anyone, then click **Approve & text**. **Nothing is sent before approval.**
3. **Reply as a client.** Click **Preview client's text** to see the page a client would open from the text: the text itself, then the service, stylist, date, exact time and a countdown, with **Yes, I want it** and **No thanks** buttons.
4. **Race two yeses.** Open two clients' offers and accept both. The first yes **holds** the slot. The other client sees "Sorry, this time was just taken," and everyone else in that round is told it's filled and that they're still on the waitlist.
5. **Confirm in Square.** The card now reads **Held for … — confirm in Square**. Click **Done — updated in Square**, or **Couldn't confirm — release hold** to move on to the next people. If nobody does either within **15 minutes**, the hold is released automatically.
6. **Let it time out.** Leave a fast-demo round unanswered. The people in it are marked **No reply** and the next people are texted automatically. When nobody is left, the card turns red: **Nobody took it**, with **Keep trying** and **Leave it open** buttons.
7. **Late yes.** Accept an offer after its countdown ends. The client is told the salon will check, and staff see "… said yes late" with **Book** and **Dismiss** buttons. A late yes is never booked automatically.
8. **Cancel.** **Cancel opening** works at any point before the slot is confirmed. Every open offer then shows "This opening is no longer available," and no later tap can book it.

Two other options: **Simulate first text attempt failing** shows a failed send being retried in the workflow's Event History, and **Turn on alerts** shows browser notifications when something needs staff.

## What Lena told us, and what the prototype does

| Lena said | Prototype |
| --- | --- |
| 20–30 people, kept in a Google Sheet (name, mobile, service, stylist preference, availability). | 24 **fictional** sample clients, labelled as sample data from the Sheet. |
| Some clients will only see one stylist; others will see anyone if the time works. | Each client is either **Only Lena** (etc.) or **Any stylist**. "Any stylist" clients are suggested for every stylist's openings. |
| Availability is loose notes like "weekday afternoons" or "after 5". | Notes are shown word for word. A rough reading is used only to *suggest* matches. |
| She wants to approve the suggested matches before anything goes out. | Approval is a required step in the workflow. |
| Earliest joiner first; she texts 3–4 people at once because speed matters most. | Texts go out in rounds, default 3, adjustable from 1 to 5, earliest joiner first. |
| Two yeses cause problems, and someone gets let down. | **First yes wins**, decided atomically. Everyone else is told right away and keeps their place. |
| She waits about 10–15 minutes for same-day openings and 1–2 hours for later ones, but it's not a firm rule. | The default window is 15 minutes for same-day openings and 60 minutes for later ones. Staff can change it per opening. |
| A yes after the slot is filled shouldn't be booked; the client stays on the list. | "Sorry, this time was just taken." The client keeps their place. |
| A late yes while the slot is still open shouldn't be automatic, and the text should make clear a late reply doesn't guarantee the appointment. | The offer text and page both say late replies aren't guaranteed. A late yes is flagged for staff to **Book** or **Dismiss**. |
| Declines and no-replies stay on the list for future openings. | Their place on the list is never changed. |
| Some clients have opted out and must never be contacted. | Opted-out clients are never suggested or texted, and are badged on the waitlist. |
| Staff need to see the service, stylist, time, who has the offer, declines and timeouts, and whether it's filled or cancelled. | All of this is on each opening card, along with a timestamped history. |
| If nobody takes it, she wants to know right away and then decide. | **Nobody took it** alert with **Keep trying** and **Leave it open**. |
| Square stays the real calendar, and nothing books automatically. | A yes only *holds* the slot. Staff confirm and update Square themselves. |
| If a hold can't be confirmed, release it and offer it to the next person, automatically after about 15 minutes. | **Release hold** button, plus an automatic release after 15 minutes. |
| Simulated texts must be clearly labelled during the demo, so nobody mistakes them for real messages. | Every page has a **Demo** banner, and each message appears in a dashed bubble marked **Simulated text — not sent**. The history and Worker logs say "simulated" too. |
| She wants it warm and calm, not like a technical dashboard, with soft, welcoming colors. | Linen and sage colors with blush and honey accents, a gentle serif for headings, rounded cards, and friendlier words ("Open chairs", "Waiting for your OK", "Someone cancelled? Add the opening"). |
| Lena and Carla are usually with clients when a cancellation comes in. | Simulated texts to the salon phone, a "needs you" count in the tab title, optional browser alerts, and a phone-friendly layout. |
| Success means refilling at least half of cancellations, up from about 3 in 10. | A refill-rate tile compared against the ~30% baseline and the 50% goal. It counts only openings confirmed in Square, and it's labelled as prototype data. |

## How Temporal is used

**One Workflow per opening** (`openingWorkflow`, ID `opening-<id>`, task queue `juniper-salon`). The whole life of an opening is one durable workflow, from suggesting matches through approval, rounds of offers, the hold, and confirmation or cancellation. If the browser is closed or the Worker restarts, the opening carries on where it left off.

- **Durable timers** handle the reply window and the 15-minute hold. The reply window starts only after the texts have actually been sent.
- **Updates** carry every staff and client action and return a clear answer: `approveMatches`, `respond`, `cancelOpening`, `releaseHold`, `resolveLateYes`, `markSquareDone`, `keepTrying` and `leaveOpen`. The `respond` handler has no `await` between checking and recording the winner, so two yeses arriving together can't both win, and a cancel and a yes can't both take effect.
- **Queries** (`getOpening`) supply the dashboard and the client page.
- **Activities** (simulated) cover suggesting matches, sending texts to clients and to the salon phone, and updating the waitlist. Temporal retries failed sends, and cancelling an opening stops a send that is still retrying.

**One long-running waitlist Workflow** (`juniper-waitlist`) is the single owner of each client's status. It reserves a client for one opening's offer at a time, so nobody gets two offers at once, and it records a booking only once. It uses continue-as-new to keep its history small.

## Checks

```bash
npm run typecheck
npm test
```

There are 42 tests: Workflow tests run in Temporal's time-skipping test environment, plus matching unit tests. They cover:
- nothing is sent before approval;
- two simultaneous yeses produce one winner;
- a late yes after a fill;
- a timeout moves on to the next round;
- when nobody is left: **Keep trying** and **Leave it open**;
- cancel blocks a later yes;
- bad links are rejected;
- opt-outs are never texted;
- holds, their release, and the automatic release;
- a late yes is flagged for staff;
- the waitlist never books one client twice;
- matching on stylist rules, availability notes and join order.

The flow was also checked live against the Docker Temporal server. Screenshots are in [`evidence/`](evidence/).

## What's simulated, and what's next

- **No real texts are sent.** Texts are logged by an Activity and shown on screen marked **Simulated text — not sent**. **Preview client's text** stands in for the text link. A pilot would need an SMS provider sending from the salon number, plus opt-out handling on that provider.
- **No Google Sheets or Square connection.** The waitlist is sample data, and Square stays manual, as Lena asked.
- **Local only.** There is no staff login, and the offer links are local. Real use needs authentication and secure public offer links.
- **Refill rate is illustrative.** It reflects only the openings in this prototype and doesn't prove the 50% goal.

**Suggested next step:** a two-to-four-week pilot with Lena and Carla, using a small group of waitlist clients who have agreed to be texted. Track the refill rate against the ~30% baseline, how often staff had to step in, and whether the reply windows feel right.
