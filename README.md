# Hyperion Calendar

Office timings, availability and plans for Hyperion's **Admins and
Superadmins**. A separate app from Meeting Ledger, but it uses the **same
Firebase project** on purpose: the same accounts sign in, and it can show
Meeting Ledger's scheduled meetings, logged meetings and approved travel
without copying any data.

Vanilla JS, no build step. Hosted on GitHub Pages. Files: `index.html`,
`app.js`, `styles.css`, `config.js`, `README.md`.

## Who can use it

Only active **Admins and Superadmins** (their role is set in Meeting
Ledger's Team tab). Anyone else who signs in sees a "this calendar is for
Admins and Superadmins" screen, and the security rules refuse them the
data anyway. Accounts, passwords and roles are all managed in Meeting
Ledger; there's no sign-up here.

## What's on it

- **Office timings.** Each person sets their regular week once (which days,
  from–to). It shows as the shaded "available" band on the grid and in the
  day headers. Days off show as "Off".
- **Your own entries** (+ Add, or click an empty slot on your grid):
  Busy, Out of office, Working from home, Leave. Timed or all-day; leave
  can span several days.
- **From Meeting Ledger, read-only:**
  - *Meetings scheduled* — with a time they sit in the grid as a one-hour
    block; without one they're an all-day item; day-TBC ones appear in a
    "This week, day not confirmed" strip. Plans already marked Done are
    left out (the logged meeting shows instead).
  - *Logged meetings* — as "Met: name" on that day.
  - *Approved travel plans* — as "Travelling: place" across those days.
    Pending or rejected trips don't show.
- **Tasks (Superadmin only, private).** The day planner moved here from
  Meeting Ledger, unchanged: paste a list, Mark done asks what was done
  (required) and an optional next step for today or a later day, past
  days are read-only, open tasks are carried to today only when you
  choose. Nobody else can see them, not even other Superadmins.

## Views

- **Week** — the time grid (07:00–22:00) for one person.
- **Day** — one day, with your tasks beside it.
- **Team** — every Admin/Superadmin side by side for the week: office
  hours, leave/out of office/WFH, travel and timed items. Click a name to
  open their week.

Pick whose calendar to look at with the dropdown. Everyone sees everything
on each other's calendars **except tasks**. You can only add or change your
own entries; other people's open read-only.

## Setup (one time)

1. **Rules.** The calendar's rules (`calProfiles`, `calEvents`, plus the
   existing `dayTasks`) are in **Meeting Ledger's `firestore.rules`** —
   one rules file for the whole project. Publish that file in Firebase
   Console → Firestore → Rules.
2. **Repo.** Create a new GitHub repo (e.g. `hyperion-calendar`) under the
   same account as Meeting Ledger and upload these five files to the root.
3. **Pages.** Repo → Settings → Pages → Deploy from branch → `main` / root.
   The site will be at `https://<account>.github.io/hyperion-calendar/`.
4. **Sign-in domain.** Firebase only allows sign-in from approved domains.
   If the calendar is on the same `<account>.github.io` as Meeting Ledger,
   it's already approved. If not, add it in Firebase Console →
   Authentication → Settings → Authorized domains.

`config.js` must keep the same values as Meeting Ledger's — that's what
connects the two.

## Data

| Collection | What | Who reads | Who writes |
|---|---|---|---|
| `calProfiles/{email}` | office timings | Admin, Superadmin | the owner |
| `calEvents` | busy / leave / OOO / WFH | Admin, Superadmin | the owner |
| `dayTasks` | private tasks | the owning Superadmin | the owning Superadmin |
| `users`, `meetings`, `weeklyPlans`, `travelPlans` | Meeting Ledger data | (as per Meeting Ledger rules) | never written by the calendar |

Dates are stored as `YYYY-MM-DD` and times as 24-hour `HH:MM`; DD-MM-YYYY
is display only. Logged meetings are fetched one week at a time; everything
else loads once at sign-in. Light and dark themes (◐ in the top bar).

## Not built (yet)

- Syncing with Outlook calendars (needs the Azure app registration).
- Recurring entries ("every Tuesday 3–4 pm") — add them one by one for now.
- Booking someone's free slot.
