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
- `staff-dashboard.png`: the staff dashboard at 10 PM. A later-week opening is **Scheduled — texts go out at 9:00 AM tomorrow (outside texting hours)**, with its "offers stop 1 hour before" cutoff. A fast-demo opening that nobody took shows **Keep trying** / **Leave it open** (people texted before go to the end of the list). It also shows the "Last-minute chairs refilled" meter (openings within 48 hours, against Lena's 50% goal) and the waitlist with consent badges, **Add to waitlist**, and sample stylist names marked "confirm with Lena".
- `client-offer-phone.png`: the client's phone page. It's labelled as a simulated client view and shows the appointment, a "Reply by" time with minutes left, "Offered to 2 people. The first yes gets it. Late replies aren't guaranteed.", **Yes, I want it** / **No thanks**, and the simulated text that led there.
