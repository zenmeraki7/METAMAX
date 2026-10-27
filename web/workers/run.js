import { createReconcileWorker } from "./reconcile.worker.js";
import { startWorkerRuntime } from "./runtime.js";

await startWorkerRuntime({ createWorker: createReconcileWorker });
