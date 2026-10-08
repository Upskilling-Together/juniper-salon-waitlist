# Evidence

All names and phone numbers are fictional sample data.

- `temporal-opening-workflow.png`: one completed `openingWorkflow` (`opening-40938a1b`) in the Temporal Web UI. It shows the Workflow ID, the **Completed** status, the `juniper-salon` Task Queue, and the timeline:
  1. suggest matches;
  2. staff approval (Update);
  3. reserve clients on the waitlist;
  4. send texts;
  5. the 1-hour reply timer;
  6. two `respond` Updates that raced, with exactly one winner;
  7. the 15-minute hold timer;
  8. `markSquareDone`.
- `staff-dashboard.png`: the staff dashboard ("Open chairs"). It shows the full-width **Demo** strip and the summary counts. Openings are grouped into **Needs you** (one waiting for staff to approve who gets texted) and **Waiting on clients** (offers out, with reply-by times and the offer text marked **Simulated text — not sent**). It also shows the refill meter against Lena's 50% goal, and the waitlist with notes exactly as staff wrote them, including an opted-out client.
- `client-offer-phone.png`: the client's phone page. It's labelled as a simulated client view and shows the appointment, a "Reply by" time with minutes left, "Offered to 2 people. The first yes gets it. Late replies aren't guaranteed.", **Yes, I want it** / **No thanks**, and the simulated text that led there.
