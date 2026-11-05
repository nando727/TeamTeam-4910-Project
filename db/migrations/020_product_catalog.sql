-- Sponsor selections shared by sponsor editing and driver browsing.
CREATE TABLE IF NOT EXISTS catalog_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  sponsor_id INT NOT NULL,
  product_id INT NOT NULL,
  title VARCHAR(500) NOT NULL,
  category VARCHAR(100) NULL,
  image_url VARCHAR(1000) NULL,
  price_value DECIMAL(10,2) NOT NULL,
  points_cost INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY unique_sponsor_product (sponsor_id, product_id),
  FOREIGN KEY (sponsor_id) REFERENCES sponsors(id)
);
