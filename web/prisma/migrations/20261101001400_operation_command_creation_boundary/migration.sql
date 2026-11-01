-- Only the merchant dispatch gateway creates commands after current approval.
-- Operation workers discover, claim and update existing commands; queued
-- coordinates and global control-plane access do not grant creation authority.
BEGIN;
REVOKE INSERT ON mirror.job_commands FROM metamax_operation_worker;
COMMIT;
