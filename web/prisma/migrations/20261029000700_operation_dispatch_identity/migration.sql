-- One command per immutable approved operation, even when clients change keys.
-- Existing duplicates cause migration failure for deliberate operator review;
-- no historical operations are silently removed.
CREATE UNIQUE INDEX job_commands_approved_operation_key
  ON mirror.job_commands(shop_id,kind,contract_id);
