/** One bounded maintenance pass for an external scheduler. No HTTP listener. */
import 'dotenv/config';
import {createHistorySecurityRuntime} from '../security/history-security-runtime.server.js';
import {historyMaintenanceFailure} from '../security/history-maintenance-policy.server.js';

let runtime;
try {
  runtime=await createHistorySecurityRuntime({env:{...process.env,HISTORY_MAINTENANCE_ENABLED:'true'}});
  const result=await runtime.runOnce();
  console.log(JSON.stringify({code:'HISTORY_MAINTENANCE_COMPLETED',...result}));
  if(result.reviewRequired)process.exitCode=2;
} catch (error) {
  // Avoid serializing pool configuration, key material or snapshot values.
  console.error(JSON.stringify({code:'HISTORY_MAINTENANCE_FAILED',failure:runtime?.status?.().lastFailure??historyMaintenanceFailure(error,'startup')}));
  process.exitCode=1;
} finally {
  try {await runtime?.stop();} catch {console.error(JSON.stringify({code:'HISTORY_MAINTENANCE_SHUTDOWN_FAILED'}));process.exitCode=1;}
}
