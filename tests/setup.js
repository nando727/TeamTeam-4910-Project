// Vitest setup (see vitest.config.mjs). Every supertest request starts and
// stops its own tiny HTTP server, and Node keeps client sockets alive by
// default, so under parallel test files a pooled socket can outlive the server
// it was opened to and a request lands on the wrong server or gets reset.
// Turning keep-alive off for the test client makes each request self-contained.
import http from 'node:http';
import https from 'node:https';

// Story AA-71: the app stores sessions in MySQL by default. The tests mock the
// database query by query, so they use express-session's in-process store and
// leave the store itself to tests/session-store.test.js.
process.env.SESSION_STORE = 'memory';

// Mail never leaves the test run. src/db.js loads .env, so a developer who has
// filled in real SMTP settings for local testing would otherwise have the
// suite pick them up: the smtp transport would be chosen, every test that
// reads a link out of the log would find nothing, and the suite would try to
// send mail through somebody's real account. Pinning the transport here keeps
// the run the same on every machine. Files that test the transports themselves
// set this per test and restore it afterwards.
process.env.MAIL_TRANSPORT = 'console';

http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
