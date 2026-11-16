-- No row means the default: 10 points per dollar.
CREATE TABLE IF NOT EXISTS sponsor_point_rates (
  sponsor_id INT PRIMARY KEY,
  points_per_dollar INT NOT NULL DEFAULT 10,
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id),
  CHECK (points_per_dollar BETWEEN 1 AND 10000)
);
