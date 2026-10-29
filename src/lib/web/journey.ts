// What one `curl` request looks like when each stage of its journey fails.
//
// Exit codes and message text were captured from real curl on 2026-10-29:
// 8.19 on Windows and 8.11.1 on Linux (OpenSSL backend, whose wording is used
// below because it is what most learners will see), against unresolvable
// names, closed ports, a blackholed address, badssl.com's wrong-host endpoint
// and a GitHub 404. OpenSSL verify codes 62 and 20 were reproduced with
// OpenSSL 3.5.6 s_client. Not captured live: the reset (56), whose meaning is
// from curl's error list and whose text varies by platform, and the exact
// "unable to get local issuer" line, assembled from curl's verified
// "SSL certificate problem: " prefix and OpenSSL's verified error text.
//
// The point of the table is the last three columns. A check on the exit code
// or the status code passes for failures that a check on the body catches.

export type Stage = 'dns' | 'tcp' | 'tls' | 'http';
export const STAGES: { id: Stage; label: string }[] = [
  { id: 'dns', label: 'DNS: name → address' },
  { id: 'tcp', label: 'TCP: open a connection' },
  { id: 'tls', label: 'TLS: prove who you are talking to' },
  { id: 'http', label: 'HTTP: ask and answer' },
];

export type Scenario = {
  id: string;
  title: string;
  /** The stage that failed; null when every stage succeeded. */
  failedAt: Stage | null;
  exit: number;
  status: number | null;
  body: string | null;
  trace: string[];
  verify?: string;
  meaning: string;
};

const HOST = 'shop.bamboo.example';
const GOOD_BODY = '<html><body><h1>Bamboo shop</h1><ul><li>Fresh shoots - 3 coins</li></ul></body></html>';
const resolve = [`* Host ${HOST}:443 was resolved.`, '* IPv4: 203.0.113.10'];
const connect = ['*   Trying 203.0.113.10:443...', `* Connected to ${HOST} (203.0.113.10) port 443`];
const tlsOk = ['* TLS 1.3 handshake complete', `*  subject: CN=${HOST}`, '*  issuer: CN=Bamboo Root CA', '*  SSL certificate verify ok.'];
const ask = ['> GET / HTTP/1.1', `> Host: ${HOST}`, '>'];

export const SCENARIOS: Scenario[] = [
  {
    id: 'ok', title: 'Everything works', failedAt: null, exit: 0, status: 200, body: GOOD_BODY,
    trace: [...resolve, ...connect, ...tlsOk, ...ask, '< HTTP/1.1 200 OK', '< content-type: text/html'],
    meaning: 'Four stages, four successes. Every check passes - and only this time do they all mean the same thing.',
  },
  {
    id: 'dns', title: 'The name does not exist', failedAt: 'dns', exit: 6, status: null, body: null,
    trace: [`curl: (6) Could not resolve host: ${HOST}`],
    meaning: 'Nothing left your machine but a DNS question. A typo, an expired domain or a missing record - not a server problem at all.',
  },
  {
    id: 'refused', title: 'Nothing is listening', failedAt: 'tcp', exit: 7, status: null, body: null,
    trace: [...resolve, '*   Trying 203.0.113.10:443...', `curl: (7) Failed to connect to ${HOST} port 443 after 3 ms: Could not connect to server`],
    meaning: 'The machine answered - fast - to say no program is on that port. The service is down, or on another port. The network is fine.',
  },
  {
    id: 'timeout', title: 'Packets vanish', failedAt: 'tcp', exit: 28, status: null, body: null,
    trace: [...resolve, '*   Trying 203.0.113.10:443...', 'curl: (28) Connection timed out after 10002 milliseconds'],
    meaning: 'No answer at all, not even "no". Typically a firewall silently dropping packets, or a route to nowhere. Slow failure is a clue.',
  },
  {
    id: 'reset', title: 'Connection cut mid-way', failedAt: 'tcp', exit: 56, status: null, body: null,
    trace: [...resolve, ...connect, ...tlsOk, ...ask, 'curl: (56) Recv failure: Connection reset by peer'],
    meaning: 'Something on the path tore the connection down. Your request may never have reached the application - a reset is not an answer from it.',
  },
  {
    id: 'tls-name', title: 'Certificate for a different name', failedAt: 'tls', exit: 60, status: null, body: null,
    trace: [...resolve, ...connect, `*  subject: CN=other.bamboo.example`, '*  issuer: CN=Bamboo Root CA', `curl: (60) SSL: no alternative certificate subject name matches target hostname '${HOST}'`],
    verify: 'Verify return code: 62 (hostname mismatch)',
    meaning: 'The chain is trusted; the name is wrong. Fix the certificate (add the name), not your trust store.',
  },
  {
    id: 'tls-trust', title: 'Certificate from an unknown issuer', failedAt: 'tls', exit: 60, status: null, body: null,
    trace: [...resolve, ...connect, `*  subject: CN=${HOST}`, '*  issuer: CN=Bamboo Root CA', 'curl: (60) SSL certificate problem: unable to get local issuer certificate'],
    verify: 'Verify return code: 20 (unable to get local issuer certificate)',
    meaning: 'The name is right; nothing you trust signed it. Fix the trust store (or the chain the server sends), not the certificate\'s names.',
  },
  {
    id: '401', title: 'The app says "who are you?"', failedAt: 'http', exit: 0, status: 401, body: '{"error":"missing token"}',
    trace: [...resolve, ...connect, ...tlsOk, ...ask, '< HTTP/1.1 401 Unauthorized', '< www-authenticate: Bearer'],
    meaning: 'Your request arrived, was read and was refused by the application. Every network stage worked - compare with the reset, which looks like failure too and means the opposite.',
  },
  {
    id: '500', title: 'The app crashed answering', failedAt: 'http', exit: 0, status: 500, body: '<h1>Internal Server Error</h1>',
    trace: [...resolve, ...connect, ...tlsOk, ...ask, '< HTTP/1.1 500 Internal Server Error'],
    meaning: 'curl exits 0: by default it does not treat HTTP errors as failures. A script that only checks curl\'s exit code calls this a success. Add --fail and it exits 22.',
  },
  {
    id: 'shell', title: 'A 200 with nothing in it', failedAt: 'http', exit: 0, status: 200, body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
    trace: [...resolve, ...connect, ...tlsOk, ...ask, '< HTTP/1.1 200 OK', '< content-type: text/html'],
    meaning: 'The page shell came back fine; the app inside it never loaded (its script failed, its data call failed). Exit code fine, status fine - only reading the body, or rendering it, shows the page is empty.',
  },
];

export const EXPECTED_TEXT = 'Bamboo shop';

export type Check = { id: string; label: string; passes: (s: Scenario) => boolean };
export const CHECKS: Check[] = [
  { id: 'exit', label: 'curl exited 0', passes: (s) => s.exit === 0 },
  { id: 'status', label: 'status is 200', passes: (s) => s.status === 200 },
  { id: 'body', label: `body contains "${EXPECTED_TEXT}"`, passes: (s) => !!s.body && s.body.includes(EXPECTED_TEXT) },
];

/** A check is honest for a scenario when it passes exactly when the site works. */
export const honest = (c: Check, s: Scenario) => c.passes(s) === (s.id === 'ok');
