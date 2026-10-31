-- Extend the installed ledger and reuse the existing shop scheduling authority.
-- Requires the reconciled schema from 20261029000300_sync_dispatch_ledger.
BEGIN;
LOCK TABLE mirror.publications IN ACCESS EXCLUSIVE MODE;

ALTER TABLE mirror.sync_dispatches DROP CONSTRAINT sync_dispatches_state_check;
ALTER TABLE mirror.sync_dispatches ADD CONSTRAINT sync_dispatches_state_check CHECK(state IN (
  'PENDING','RESERVED','UNKNOWN','ENQUEUED','RECONCILING','RETRY_ELIGIBLE','CONSUMED','REVIEW_REQUIRED','CANCELLED'
));
ALTER TABLE mirror.sync_dispatches
  ADD COLUMN recovery_token text,
  ADD COLUMN recovery_until timestamptz(3),
  ADD COLUMN recovery_reason text,
  ADD COLUMN consumed_at timestamptz(3),
  ADD COLUMN reviewed_at timestamptz(3);
UPDATE mirror.sync_dispatches SET reviewed_at=updated_at WHERE state='REVIEW_REQUIRED';

CREATE INDEX sync_dispatch_recovery_idx ON mirror.sync_dispatches(updated_at,id)
  WHERE state IN ('UNKNOWN','ENQUEUED','RESERVED','RECONCILING');
CREATE INDEX sync_dispatch_due_idx ON mirror.sync_dispatches(next_attempt_at,shop_id)
  WHERE state IN ('PENDING','RETRY_ELIGIBLE');

-- Keep the monotonic fairness cursor in the same table. A second independent
-- scheduling table would allow two incompatible sources of eligibility.
ALTER TABLE mirror.sync_dispatch_shops RENAME TO sync_dispatch_schedule;
ALTER TABLE mirror.sync_dispatch_schedule
  ADD COLUMN last_dispatched_at timestamptz(3),
  ADD COLUMN next_eligible_at timestamptz(3) NOT NULL DEFAULT now();
ALTER TABLE mirror.sync_dispatch_schedule RENAME CONSTRAINT sync_dispatch_shops_pkey TO sync_dispatch_schedule_pkey;
ALTER TABLE mirror.sync_dispatch_schedule DROP CONSTRAINT sync_dispatch_shops_shop_id_fkey;
ALTER TABLE mirror.sync_dispatch_schedule ADD CONSTRAINT sync_dispatch_schedule_shop_fk
  FOREIGN KEY(shop_id) REFERENCES mirror.shops(id) ON DELETE CASCADE ON UPDATE RESTRICT;

INSERT INTO mirror.sync_dispatch_schedule(shop_id)
  SELECT id FROM mirror.shops ON CONFLICT(shop_id) DO NOTHING;
UPDATE mirror.sync_dispatch_schedule schedule SET last_dispatched_at=history.last_dispatch
  FROM (SELECT shop_id,max(COALESCE(enqueued_at,created_at)) AS last_dispatch FROM mirror.sync_dispatches GROUP BY shop_id) history
  WHERE history.shop_id=schedule.shop_id;
UPDATE mirror.sync_dispatch_schedule schedule SET next_eligible_at='infinity'::timestamptz
  FROM mirror.shops s WHERE s.id=schedule.shop_id AND s.uninstalled_at IS NOT NULL;
CREATE INDEX sync_dispatch_schedule_due_idx ON mirror.sync_dispatch_schedule(next_eligible_at,last_dispatched_at,shop_id);

-- Existing shops are backfilled above. Future installs/reinstalls reopen
-- scheduling; soft removal disables it while retaining the ledger history.
-- Physical deletion (where other retention FKs allow it) cascades the cursor.
CREATE FUNCTION mirror.maintain_sync_dispatch_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF (OLD.installation_version,OLD.uninstalled_at) IS NOT DISTINCT FROM (NEW.installation_version,NEW.uninstalled_at) THEN
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO mirror.sync_dispatch_schedule(shop_id,next_eligible_at)
    VALUES(NEW.id,CASE WHEN NEW.uninstalled_at IS NULL THEN now() ELSE 'infinity'::timestamptz END)
    ON CONFLICT(shop_id) DO UPDATE SET next_eligible_at=EXCLUDED.next_eligible_at;
  RETURN NEW;
END $$;
CREATE TRIGGER maintain_sync_dispatch_schedule AFTER INSERT OR UPDATE ON mirror.shops
  FOR EACH ROW EXECUTE FUNCTION mirror.maintain_sync_dispatch_schedule();
COMMIT;
