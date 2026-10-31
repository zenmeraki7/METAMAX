/**
 * METAMAX — Operation Worker Supervisor
 *
 * Runs scheduled checks for due bulk edit and undo jobs in mirror.job_commands,
 * coordinating with operation.worker.js and history execution.
 */

import { randomUUID } from "node:crypto";

export function createOperationSupervisor({
  database,
  worker = null,
  intervalMs = 3000,
  logger = console,
} = {}) {
  let timer = null;
  let running = false;
  let stopped = true;
  const workerId = `op-supervisor-${randomUUID().slice(0, 8)}`;

  async function tick() {
    if (stopped || running || !database) return;
    running = true;
    try {
      // Advisory probe: check if any job is due before acquiring worker lease
      const due = await database.query(`
        SELECT 1 FROM mirror.job_commands
        WHERE kind IN ('bulk_edit', 'undo')
          AND attempts < max_attempts
          AND cancel_requested_at IS NULL
          AND NOT COALESCE((checkpoint->>'review_required')::boolean, false)
          AND (
            (status IN ('PENDING', 'RETRY') AND (available_at IS NULL OR available_at <= clock_timestamp()))
            OR (status = 'RUNNING' AND lease_until <= clock_timestamp())
          )
        LIMIT 1
      `);

      if (due.rowCount > 0 && worker?.claimNext && worker?.process) {
        const claim = await worker.claimNext({ workerId, leaseSeconds: 120 });
        if (claim) {
          logger.info?.(`[operation-supervisor] Processing job ${claim.id} (kind: ${claim.kind})`);
          await worker.process({ claim, workerId });
        }
      }
    } catch (error) {
      logger.error?.({ error: error.message || error }, "[operation-supervisor] Tick failed");
    } finally {
      running = false;
    }
  }

  return Object.freeze({
    start() {
      if (!stopped) return;
      stopped = false;
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
      void tick();
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  });
}
