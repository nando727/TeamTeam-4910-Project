// Vitest setup (see vitest.config.mjs). Every supertest request starts and
// stops its own tiny HTTP server, and Node keeps client sockets alive by
// default, so under parallel test files a pooled socket can outlive the server
// it was opened to and a request lands on the wrong server or gets reset.
// Turning keep-alive off for the test client makes each request self-contained.
import http from 'node:http';
import https from 'node:https';

http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
