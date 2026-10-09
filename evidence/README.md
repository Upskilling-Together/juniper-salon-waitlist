# Evidence

All names and phone numbers are fictional sample data.

- `temporal-opening-workflow.png`: one completed `openingWorkflow` (`opening-695091b9`) in the Temporal Web UI, run from a fresh clone of this repository with `npm install && npm run dev`. It shows the Workflow ID, the **Completed** status, the `juniper-salon` Task Queue, 81 history events, and the timeline:
  1. suggest matches and a simulated alert to Lena and Carla;
  2. staff approval (Update);
  3. the texting-hours check, reserving clients on the waitlist, and sending the (simulated) offer texts;
  4. the 2-hour reply timer;
  5. two `respond` Updates: the first yes holds the slot, the second is told it's already taken;
  6. marking the client booked, notifying the others, and the 15-minute hold timer;
  7. `markSquareDone`, which completes the opening.
- `staff-dashboard.png`: the staff dashboard at 10 PM. A later-week opening is **Scheduled — texts go out at 9:00 AM tomorrow (outside texting hours)**, with its "offers stop 1 hour before" cutoff. A fast-demo opening that nobody took shows **Keep trying** / **Leave it open** (people texted before go to the end of the list). It also shows the "Last-minute chairs refilled" meter (openings within 48 hours, against Lena's 50% goal) and the waitlist with consent badges, **Add to waitlist**, and sample stylist names marked "confirm with Lena".
- `client-offer-phone.png`: the client's phone page. It's labelled as a simulated client view and shows the appointment, a "Reply by" time with minutes left, "Offered to 2 people. The first yes gets it. Late replies aren't guaranteed.", **Yes, I want it** / **No thanks**, and the simulated text that led there.

Lena's closing answer: "I'd want to know clearly when the automatic process stops or fails, so Carla and I don't assume it's still running." These were taken live against the Docker Temporal server:

- `automation-texts-failing.png`: an opening made with **Simulate texts failing (keeps retrying)** is in **Needs you** with a **Texts not sending** chip: "Texts aren't going out — nobody in this round has been texted yet. It keeps retrying (failed 9 times so far). Text them yourself or cancel the opening.", the last error in smaller type, and each person marked "Not sent yet — retrying". Below it, an opening whose workflow was terminated in Temporal reads "Stopped unexpectedly — automatic offers are no longer running for this opening…" and lists the people who may be waiting to hear back. (The green "running again" notice is left over from the outage below.)
- `automation-worker-stopped.png`: the Worker was killed. About 10 seconds later the page shows the persistent banner "Automatic offers have STOPPED — the background service isn't running…", what it means for clients and what staff can do, the time it was last seen working, and that Lena and Carla got a simulated alert (sent once the outage had lasted 30 seconds). The header reads "Offers stopped" and the tab title starts with "STOPPED –". Openings show their last-read state; running ones read "Paused — background service not running (see the banner at the top)", and the waitlist says when it was last read.
- `automation-running-again.png`: the Worker was started again, and the page shows "Automatic offers are running again. The background service was down from 11:30 AM to 11:31 AM."
- `automation-cant-reach.png`: the API was frozen with the page open. Within about 10 seconds the page shows "Can't reach the system — what you see may be out of date (last updated 11:31 AM)", the header reads "Offline, retrying", and each card's line becomes "Unknown — can't reach the system, so this may have changed (last read 11:31 AM)".
