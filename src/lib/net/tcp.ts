// What happens to one TCP connection attempt, as the packets a capture would
// show. Three outcomes, told apart by how they end and how long it takes:
//   connected  SYN, SYN+ACK, ACK                         (RFC 9293 3.5)
//   refused    SYN answered by RST - fast "no"           curl exit 7
//   timeout    SYN, then silence and retransmissions     curl exit 28
// Retransmits wait 1 s, then double (RFC 6298: initial RTO 1 s, then x2).

export type Bind = '0.0.0.0' | '127.0.0.1';
export type Firewall = 'allow' | 'drop' | 'reject';
export type From = 'same' | 'other';

export type Server = { running: boolean; bind: Bind; port: number; firewall: Firewall };
export type Packet = { t: number; dir: 'out' | 'in'; flags: string; note?: string };
export type Attempt = {
  outcome: 'connected' | 'refused' | 'timeout';
  packets: Packet[];
  ms: number;
  curl: string;
  exit: number;
  why: string;
};

export const SERVER_IP = '10.0.0.5';
const RTT = { same: 0.1, other: 2 }; // ms: loopback vs one LAN hop

export function connect(s: Server, from: From, port: number, connectTimeoutS = 5): Attempt {
  const host = from === 'same' ? '127.0.0.1' : SERVER_IP;
  const rtt = RTT[from];
  const syn: Packet = { t: 0, dir: 'out', flags: 'SYN', note: `to ${host}:${port}` };
  // A host firewall filters what arrives from the network; loopback traffic
  // never crosses it in the usual setup, so only "other machine" is affected.
  const filtered = from === 'other' && s.firewall !== 'allow';
  if (filtered && s.firewall === 'drop') {
    const packets: Packet[] = [syn];
    let wait = 1000, t = 0;
    while (t + wait < connectTimeoutS * 1000) { t += wait; packets.push({ t, dir: 'out', flags: 'SYN', note: 'retransmit - no reply yet' }); wait *= 2; }
    const ms = connectTimeoutS * 1000 + 2;
    return {
      outcome: 'timeout', packets, ms, exit: 28,
      curl: `curl: (28) Connection timed out after ${ms} milliseconds`,
      why: 'Nothing came back - not even a "no". A firewall dropped the SYN. curl gave up at --connect-timeout; left alone, Linux keeps retransmitting for about two minutes.',
    };
  }
  if (filtered && s.firewall === 'reject') {
    const ms = Math.round(rtt) + 1;
    return {
      outcome: 'refused', packets: [syn, { t: rtt, dir: 'in', flags: 'ICMP port unreachable', note: 'from the firewall' }], ms, exit: 7,
      curl: `curl: (7) Failed to connect to ${host} port ${port} after ${ms} ms: Could not connect to server`,
      why: 'The firewall answered for the program: a REJECT rule replies "port unreachable", which looks exactly like nothing listening. Refused is not always the app.',
    };
  }
  const reachable = s.running && s.port === port && (s.bind === '0.0.0.0' || from === 'same');
  if (!reachable) {
    const ms = Math.round(rtt) + 1;
    const reason = !s.running ? 'the program is not running'
      : s.port !== port ? `the program listens on ${s.port}, not ${port}`
      : 'the program listens on 127.0.0.1 - only connections from the same machine reach it';
    return {
      outcome: 'refused', packets: [syn, { t: rtt, dir: 'in', flags: 'RST, ACK', note: 'nothing listening here' }], ms, exit: 7,
      curl: `curl: (7) Failed to connect to ${host} port ${port} after ${ms} ms: Could not connect to server`,
      why: `The machine answered at once with a reset: ${reason}. A fast no means the network is fine.`,
    };
  }
  return {
    outcome: 'connected',
    packets: [syn, { t: rtt, dir: 'in', flags: 'SYN, ACK' }, { t: rtt, dir: 'out', flags: 'ACK', note: 'connected - data can flow' }],
    ms: Math.max(1, Math.round(rtt)), exit: 0,
    curl: `* Connected to ${host} (${host}) port ${port}`,
    why: 'Three packets and the connection is open. Anything that goes wrong after this is HTTP or TLS, not TCP.',
  };
}

// `ss -tln`: the listening sockets, as the server's own machine sees them.
export function ssListen(s: Server): string[] {
  const head = 'State   Recv-Q  Send-Q  Local Address:Port   Peer Address:Port';
  if (!s.running) return [head];
  return [head, `LISTEN  0       4096    ${`${s.bind}:${s.port}`.padEnd(21)}0.0.0.0:*`];
}
