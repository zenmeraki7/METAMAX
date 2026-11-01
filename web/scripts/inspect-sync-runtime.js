import {loadMigrationEnvironment} from '../security/migration-environment.server.js';
import 'dotenv/config';
import pg from 'pg';
const pool=new pg.Pool({connectionString:process.env.DIRECT_DATABASE_URL||loadMigrationEnvironment().DIRECT_DATABASE_URL||process.env.DATABASE_URL,max:1,connectionTimeoutMillis:15000,query_timeout:15000});
try{
  const c=await pool.connect();
  try{
    await c.query('BEGIN READ ONLY');
    console.log(JSON.stringify({executions:(await c.query(`SELECT j.id,j.shop_id,j.status,j.execution_mode,e.phase,e.attempt,e.recovery_attempts,
      e.outcome_uncertain,e.review_required,e.last_error,e.lease_until,e.next_eligible_at,g.status AS generation_status,
      r.bulk_operation_id,r.processed_lines::text,r.expected_lines::text FROM mirror.catalog_import_jobs j
      LEFT JOIN mirror.catalog_import_executions e ON e.id=j.id AND e.shop_id=j.shop_id
      LEFT JOIN mirror.generations g ON g.id=j.generation_id AND g.shop_id=j.shop_id
      LEFT JOIN mirror.ingestion_runs r ON r.id=j.run_id AND r.shop_id=j.shop_id ORDER BY j.created_at DESC LIMIT 10`)).rows,
      intents:(await c.query('SELECT run_id,state,operation_id FROM mirror.sync_external_operations ORDER BY created_at DESC LIMIT 10')).rows,
      activity:(await c.query(`SELECT pid,state,wait_event_type,wait_event,round(extract(epoch from clock_timestamp()-xact_start)::numeric,2) AS transaction_seconds,
        left(query,160) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state<>'idle' ORDER BY xact_start`)).rows}));
    await c.query('ROLLBACK');
  }finally{c.release();}
}catch(e){console.error(e.message);process.exitCode=1;}finally{await pool.end();}
