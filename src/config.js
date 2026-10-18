// Church-specific configuration.
// To add or remove a branch, edit this list and redeploy (npm run deploy).

export const BRANCHES = [
  "Kharis Church Accra",
  "Kharis Church Birmingham",
  "Kharis Church Brighton",
  "Kharis Church Bristol",
  "Kharis Church Chatham",
  "Kharis Church Chelmsford",
  "Kharis Church Coventry",
  "Kharis Church Croydon",
  "Kharis Church Freetown",
  "Kharis Church London",
  "Kharis Church Luton",
  "Kharis Church Manchester",
  "Kharis Church Northampton",
  "Kharis Church Nottingham",
  "Kharis Church Orpington",
  "Kharis Church Reading",
  "Kharis Phase 2 Barking",
  "Kharis Phase 2 Birmingham",
  "Kharis Phase 2 London",
  "Kharis Phase 2 Peterborough",
  "Kharis Phase 2 Romford",
  "Kharis Phase 2 Southampton"
];

// Default schedule — used for any day that staff have NOT customised in the
// dashboard (Schedule tab). Per-day overrides live in the `schedules` table.
// Slots are { start, end } in 24h "HH:MM"; they may overlap if you want
// staggered entry windows.
export const DEFAULT_CAPACITY = 30;
export const DEFAULT_SLOTS = [
  { start: "09:00", end: "11:00" },
  { start: "11:00", end: "13:00" },
  { start: "13:00", end: "15:00" },
  { start: "15:00", end: "17:00" }
];

// Grace period (minutes after a slot's START time). A booking not checked in
// by start + GRACE_MINUTES is auto-cancelled as a no-show and can't be let in.
export const GRACE_MINUTES = 15;

// Requisitions ("what it's needed for"). The /requisitions area uses this list
// for its category dropdown. Edit this list and redeploy to change the options.
// "Other" should stay last so people always have a fallback.
export const REQUISITION_CATEGORIES = [
  "Landscaping",
  "Painting",
  "Electrical",
  "Plumbing",
  "Flooring",
  "Furniture & fittings",
  "Signage",
  "Decorating",
  "Other"
];

// How often a recurring requisition repeats. `perYear` is used to annualise a
// recurring amount (cost per occurrence x perYear) for the spend totals. Edit
// this list and redeploy to change the options.
export const REQUISITION_FREQUENCIES = [
  { value: "weekly",    label: "Weekly",    perYear: 52 },
  { value: "monthly",   label: "Monthly",   perYear: 12 },
  { value: "quarterly", label: "Quarterly", perYear: 4 },
  { value: "yearly",    label: "Yearly",    perYear: 1 }
];

// Everything is run in UK local time.
export const TIMEZONE = "Europe/London";
