-- Story AA-55 (22263): one structure for every audit record.
--
-- The audit requirement names four things to record: login attempts, password
-- changes, point changes and driver application decisions. Each of those was
-- being kept somewhere different, in a shape of its own, and one of them was
-- not being kept at all -- a sponsor's decision on an application overwrites
-- sponsor_applications.status, which records neither who decided nor when.
-- Reading "what happened to this account" meant four queries that return four
-- different shapes, and still missed that one.
--
-- So: one table, one shape, one insert. Every audit record lands here from now
-- on, written through src/audit/log.js and nowhere else.
--
-- What this table is NOT is a replacement for the tables that do a job besides
-- recording. login_attempts is what the lockout counts; point_transactions is
-- the driver's point history and the sponsor reports. Those stay where they
-- are and keep their own shape, and they append an event here as well. Pointing
-- a security control and four reports at the audit log would make this table
-- load-bearing for features, which is the opposite of what an audit log is for.
--
-- password_changes (migration 019) is the exception, because recording was the
-- only thing it ever did and nothing in the app reads it. Its rows are copied
-- below and the app stops writing it. The table is left in place: dropping a
-- table that holds the only copy of something is a decision for a later story,
-- taken on purpose and not as a side effect of this one.
--
-- Runs after 021 (via `npm run db:migrate`). Safe to rerun.

CREATE TABLE IF NOT EXISTS audit_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  -- What happened, as 'thing.happened'. VARCHAR rather than ENUM so a new kind
  -- of event does not need a migration before it can be recorded; the list the
  -- app will write is in src/audit/log.js.
  event_type VARCHAR(48) NOT NULL,
  -- Who did it. NULL when nobody was signed in: a reset link or a setup link,
  -- where the link itself is the credential. Where somebody was, this is the
  -- person at the keyboard, so an impersonating administrator is recorded as
  -- the administrator and not as the account they are acting as.
  actor_user_id INT NULL,
  -- Whose account it was about. NULL for an event about no account in
  -- particular, such as a sign-in attempt with a username that does not exist.
  subject_user_id INT NULL,
  -- The sponsor the event concerned, where one did. NULL is ordinary and not a
  -- gap: a sign-in and a password change have no sponsor (story AA-57).
  sponsor_id INT NULL,
  -- the part that varies: a password change's method, a point change's size
  -- and reason, an application decision's reason
  -- wide enough to hold sponsor_applications.rejection_reason (2000) whole
  -- anything filtered or counted earns its own column instead
  detail VARCHAR(2048) NULL,
  -- Set by the database, never by the application, and compared in SQL. One
  -- clock, one convention (story AA-59).
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- The three questions this table gets asked: what happened lately, what
  -- happened to this account, and what happened of this kind.
  INDEX idx_audit_events_time (occurred_at),
  INDEX idx_audit_events_subject (subject_user_id, occurred_at),
  INDEX idx_audit_events_type (event_type, occurred_at),
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  FOREIGN KEY (subject_user_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);

-- The password changes already recorded, moved across so switching the writer
-- does not start the log again from empty. changed_at is carried over rather
-- than defaulted: these events happened when they happened.
--
-- All or nothing, guarded on there being no password.changed row at all. The
-- obvious alternative -- skipping rows that look already copied -- would drop a
-- second change made to the same account in the same second, and an audit
-- migration that quietly loses a row is not worth the tidiness.
INSERT INTO audit_events (event_type, actor_user_id, subject_user_id, detail, occurred_at)
SELECT 'password.changed', pc.changed_by_user_id, pc.user_id,
       CONCAT('method=', pc.method), pc.changed_at
  FROM password_changes pc
 WHERE NOT EXISTS (
         SELECT 1 FROM audit_events ae WHERE ae.event_type = 'password.changed'
       );
