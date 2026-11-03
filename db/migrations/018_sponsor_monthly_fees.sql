-- The 1% monthly fee each sponsor owes (story INF-33), so billing logic lives
-- in the database. Give it the first day of a month and a sponsor id, or NULL
-- for every sponsor. A sponsor with no purchases that month is still returned,
-- owing nothing. Safe to rerun: it replaces the procedure with the same text.
-- No DELIMITER: the body is one statement, and the migrate script could not use
-- DELIMITER anyway because that is a command of the mysql client, not SQL.

DROP PROCEDURE IF EXISTS sponsor_monthly_fees;
CREATE PROCEDURE sponsor_monthly_fees(IN p_month_start DATE, IN p_sponsor_id INT)
  READS SQL DATA
  SELECT s.id, s.name, s.status,
         COUNT(p.id) AS purchases,
         COALESCE(SUM(p.amount_cents), 0) AS totalCents,
         ROUND(COALESCE(SUM(p.amount_cents), 0) * 0.01) AS feeCents
  FROM sponsors s
  LEFT JOIN purchases p ON p.sponsor_id = s.id
    AND p.purchased_at >= p_month_start
    AND p.purchased_at < p_month_start + INTERVAL 1 MONTH
  WHERE p_sponsor_id IS NULL OR s.id = p_sponsor_id
  GROUP BY s.id, s.name, s.status
  ORDER BY s.name, s.id;
