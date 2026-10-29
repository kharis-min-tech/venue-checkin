-- Kharis venue check-in — database schema (Cloudflare D1 / SQLite)
-- Safe to run more than once.

-- Members who book a time slot in advance.
CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  reference      TEXT    NOT NULL UNIQUE,      -- short code shown at the gate, e.g. K7F2Q
  created_at     TEXT    NOT NULL,             -- ISO timestamp (UTC)
  visit_date     TEXT    NOT NULL,             -- YYYY-MM-DD (the day they are visiting)
  slot           TEXT    NOT NULL,             -- one of the four slot keys, e.g. 09:00-11:00
  full_name      TEXT    NOT NULL,
  branch         TEXT    NOT NULL,
  purpose        TEXT    NOT NULL,
  phone          TEXT    NOT NULL,
  vehicle_reg    TEXT,
  status         TEXT    NOT NULL DEFAULT 'booked',  -- 'booked' | 'cancelled'
  checked_in_at  TEXT,                          -- set by security on arrival
  checked_out_at TEXT                           -- set by security on departure
);

CREATE INDEX IF NOT EXISTS idx_bookings_date_slot ON bookings (visit_date, slot);
CREATE INDEX IF NOT EXISTS idx_bookings_name      ON bookings (full_name);
CREATE INDEX IF NOT EXISTS idx_bookings_onsite    ON bookings (checked_in_at, checked_out_at);

-- External visitors (contractors etc.) — no slot booking, checked in on the day.
-- People on site to WORK (not touring): Kharis workers/members and external
-- contractors. Self sign-in at /workers, or added by staff. Used as the
-- health & safety register.
CREATE TABLE IF NOT EXISTS visitors (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at     TEXT    NOT NULL,
  visit_date     TEXT    NOT NULL,             -- YYYY-MM-DD
  full_name      TEXT    NOT NULL,
  kind           TEXT,                          -- 'worker' (Kharis) | 'contractor' (external)
  company        TEXT,                          -- contractors
  branch         TEXT,                          -- Kharis workers
  purpose        TEXT    NOT NULL,
  vehicle_reg    TEXT,
  signature      TEXT,                          -- PNG data URL captured on screen
  safety_ack     INTEGER,                       -- 1 = agreed to site safety rules
  checked_in_at  TEXT,
  checked_out_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_visitors_date   ON visitors (visit_date);
CREATE INDEX IF NOT EXISTS idx_visitors_onsite ON visitors (checked_in_at, checked_out_at);

-- Venue-uplift requisitions: a request to spend money improving the building
-- (landscaping, painting, etc.), plus the running spend log. The request form
-- at /requisitions is public (anyone can file one); the spend log and the
-- approve/decline review sit behind an admin passcode, separate from the staff
-- portal. A requisition is either a one-off cost or a recurring commitment
-- (with a frequency); recurring amounts are the cost per occurrence.
-- `cost_pence` is the price of ONE unit, so the amount actually being asked
-- for is always cost_pence * quantity — anything that sums money must multiply.
CREATE TABLE IF NOT EXISTS requisitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  reference   TEXT    NOT NULL UNIQUE,            -- short code, e.g. RK7F2Q
  created_at  TEXT    NOT NULL,                   -- ISO timestamp (UTC) submitted
  requestor   TEXT    NOT NULL,                   -- who is asking for it
  item        TEXT    NOT NULL,                   -- what is being bought
  item_url    TEXT,                               -- optional link to the item (product page etc.)
  category    TEXT    NOT NULL,                   -- what it's for: Landscaping, Painting, …
  quantity    INTEGER NOT NULL DEFAULT 1,         -- how many of the item are being asked for
  cost_pence  INTEGER NOT NULL,                   -- GBP whole pence, PER UNIT (per occurrence if recurring)
  value_checked INTEGER NOT NULL DEFAULT 0,       -- 1 = requestor confirmed they compared alternatives
  kind        TEXT    NOT NULL DEFAULT 'one_off', -- 'one_off' | 'recurring'
  frequency   TEXT,                               -- recurring only: weekly|monthly|quarterly|yearly
  approver    TEXT    NOT NULL,                   -- person who signs it off
  notes       TEXT,                               -- optional extra detail
  status      TEXT    NOT NULL DEFAULT 'pending', -- 'pending' | 'approved' | 'declined'
  decided_at  TEXT,                               -- when it moved off 'pending'
  decided_by  TEXT                                -- optional: who reviewed it
);

CREATE INDEX IF NOT EXISTS idx_requisitions_status  ON requisitions (status);
CREATE INDEX IF NOT EXISTS idx_requisitions_created ON requisitions (created_at);

-- Per-day overrides for opening times and capacity. A day with no row here
-- uses the DEFAULT_SLOTS / DEFAULT_CAPACITY from src/config.js.
CREATE TABLE IF NOT EXISTS schedules (
  visit_date TEXT    PRIMARY KEY,          -- YYYY-MM-DD
  slots      TEXT    NOT NULL,             -- JSON array of {start,end} ("HH:MM")
  capacity   INTEGER NOT NULL,             -- people per slot
  closed     INTEGER NOT NULL DEFAULT 0,   -- 1 = no bookings this day
  updated_at TEXT    NOT NULL
);
