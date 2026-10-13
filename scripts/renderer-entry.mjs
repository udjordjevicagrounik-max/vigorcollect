// Renderer process entry (review S-10) — copied next to server.js in the standalone output
// (renderer.mjs). Same image as the worker, `node renderer.mjs` (docker-compose service
// "renderer"). PROCESS_ROLE=renderer makes src/instrumentation-node.ts start ONLY the render loop;
// the HTTP server of this process answers only /health (src/proxy.ts) and is not published.
process.env.PROCESS_ROLE = 'renderer';
process.env.PORT = process.env.RENDERER_PORT || '3002';
await import('./server.js');
