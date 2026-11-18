-- Existing requisitions use unit cost times quantity until a total is entered.
ALTER TABLE requisitions ADD COLUMN total_cost_pence INTEGER
  CHECK (total_cost_pence BETWEEN 0 AND 100000000);
