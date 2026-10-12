// Worker process entry — copied next to server.js in the standalone output (worker.mjs).
// Same image as the app, different command: `node worker.mjs` (docker-compose service "worker").
// PROCESS_ROLE=worker makes src/instrumentation.ts start the job worker; the HTTP server of this
// process answers only /health (src/proxy.ts) on WORKER_PORT and is not published.
process.env.PROCESS_ROLE = 'worker';
process.env.PORT = process.env.WORKER_PORT || '3001';
await import('./server.js');
