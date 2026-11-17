-- aa-58 audit rows can't be changed or deleted once written
-- a trigger on each of the four audited tables refuses UPDATE and DELETE, so
-- the rule holds for anything using the database, not only the app
-- inserts are untouched... TRUNCATE and DROP are not row changes, not covered
-- runs after 024 (npm run db:migrate), safe to rerun

DROP TRIGGER IF EXISTS audit_events_no_update;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be changed (audit_events)';
DROP TRIGGER IF EXISTS audit_events_no_delete;
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be deleted (audit_events)';
DROP TRIGGER IF EXISTS login_attempts_no_update;
CREATE TRIGGER login_attempts_no_update BEFORE UPDATE ON login_attempts FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be changed (login_attempts)';
DROP TRIGGER IF EXISTS login_attempts_no_delete;
CREATE TRIGGER login_attempts_no_delete BEFORE DELETE ON login_attempts FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be deleted (login_attempts)';
DROP TRIGGER IF EXISTS point_transactions_no_update;
CREATE TRIGGER point_transactions_no_update BEFORE UPDATE ON point_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be changed (point_transactions)';
DROP TRIGGER IF EXISTS point_transactions_no_delete;
CREATE TRIGGER point_transactions_no_delete BEFORE DELETE ON point_transactions FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be deleted (point_transactions)';
DROP TRIGGER IF EXISTS login_unlocks_no_update;
CREATE TRIGGER login_unlocks_no_update BEFORE UPDATE ON login_unlocks FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be changed (login_unlocks)';
DROP TRIGGER IF EXISTS login_unlocks_no_delete;
CREATE TRIGGER login_unlocks_no_delete BEFORE DELETE ON login_unlocks FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'audit rows cannot be deleted (login_unlocks)';
