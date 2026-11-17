-- aa-55 the audit log: password changes, driver application decisions, and
-- account changes (role, status, sponsorship)
-- sign-ins, point changes and unlocks are audited from login_attempts,
-- point_transactions and login_unlocks, so nothing is stored twice
-- runs after 023 (npm run db:migrate), safe to rerun

CREATE TABLE IF NOT EXISTS audit_events (
  id INT AUTO_INCREMENT PRIMARY KEY,
  event_type VARCHAR(48) NOT NULL,
  -- who did it, NULL when nobody was signed in (a reset or setup link)
  actor_user_id INT NULL,
  -- whose account it was about
  subject_user_id INT NULL,
  -- aa-57 NULL is normal, a password change has no sponsor
  sponsor_id INT NULL,
  -- fits a sponsor_applications.rejection_reason (2000) whole
  detail VARCHAR(2048) NULL,
  -- aa-59 set by the database, never by the app
  occurred_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_audit_events_time (occurred_at),
  INDEX idx_audit_events_subject (subject_user_id, occurred_at),
  INDEX idx_audit_events_type (event_type, occurred_at),
  FOREIGN KEY (actor_user_id) REFERENCES users(id),
  FOREIGN KEY (subject_user_id) REFERENCES users(id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);

-- carries the old password_changes rows across with their original times
-- all or nothing, so a rerun can't duplicate a row or drop one
INSERT INTO audit_events (event_type, actor_user_id, subject_user_id, detail, occurred_at)
SELECT 'password.changed', pc.changed_by_user_id, pc.user_id,
       CONCAT('method=', pc.method), pc.changed_at
  FROM password_changes pc
 WHERE NOT EXISTS (
         SELECT 1 FROM audit_events ae WHERE ae.event_type = 'password.changed'
       );

-- the earlier admin-only log, replaced by this table before it held any rows
DROP TABLE IF EXISTS admin_actions;
