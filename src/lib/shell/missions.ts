// Missions for the Linux track. Like the git and cluster missions, they check
// the state the learner produced, so any correct route counts, and each has a
// tempting wrong fix that does not pass: chmod 777, kill -9 first, counting
// every request instead of the failed ones.

import type { Mission } from '../missions.ts';
import { Shell } from './shell.ts';
import type { File } from './fs.ts';

export type LinuxState = { sh: Shell };

const ran = (s: LinuxState, re: RegExp) => s.sh.history.some((l) => re.test(l.trim()));
const lastIndex = (s: LinuxState, re: RegExp) => { for (let i = s.sh.history.length - 1; i >= 0; i--) if (re.test(s.sh.history[i].trim())) return i; return -1; };
const file = (s: LinuxState, path: string): File | undefined => {
  try { const n = s.sh.fs.lookup(path, s.sh.user); return n?.type === 'file' ? n : undefined; } catch { return undefined; }
};

/** The machine every mission starts from. */
export function world(): Shell {
  const sh = new Shell();
  const fs = sh.fs;
  fs.put('/etc/hostname', { type: 'file', content: 'bamboo\n' }, 'root');
  fs.put('/etc/passwd', { type: 'file', content: 'root:x:0:0:root:/root:/bin/bash\nweb:x:33:33:web:/var/www:/usr/sbin/nologin\npanda:x:1000:1000:Curious Panda:/home/panda:/bin/bash\n' }, 'root');
  // The password hashes live here, readable by root and the shadow group only.
  fs.put('/etc/shadow', { type: 'file', content: 'root:*:20000:0:99999:7:::\n', mode: 0o640, group: 'shadow' }, 'root');
  fs.put('/dev/null', { type: 'file', device: 'null', mode: 0o666 }, 'root');
  fs.put('/tmp', { type: 'dir', mode: 0o777 }, 'root');
  fs.put('/var/log/syslog', { type: 'file', content: 'Oct 30 09:00:01 bamboo systemd[1]: Started Daily cleanup.\n', mode: 0o640, group: 'adm' }, 'root');
  fs.put('/home', { type: 'dir' }, 'root');
  fs.put('/home/panda', { type: 'dir' });
  fs.put('/home/panda/.bashrc', { type: 'file', content: '# panda\'s shell settings\nexport EDITOR=nano\n' });
  fs.put('/home/panda/notes.txt', { type: 'file', content: 'bamboo grows up to 90cm a day\npandas eat for 12 hours a day\n' });
  fs.put('/home/panda/projects/bamboo/README.md', { type: 'file', content: '# bamboo\nA tiny shop for a tiny panda.\n' });
  return sh;
}

// 28 requests. 10.0.0.8 makes the most requests, all fine; 10.0.4.17 makes
// the most failing ones. Counting every request names the wrong client.
const LOG: [string, string, number][] = [
  ['10.0.0.8', '/', 200], ['10.0.4.17', '/cart', 500], ['10.0.0.8', '/shop', 200], ['10.0.2.3', '/', 200],
  ['10.0.0.8', '/shop', 200], ['10.0.4.17', '/cart', 500], ['10.0.2.3', '/cart', 500], ['10.0.0.8', '/', 200],
  ['10.0.9.9', '/', 200], ['10.0.0.8', '/img', 200], ['10.0.4.17', '/cart', 500], ['10.0.0.8', '/shop', 200],
  ['10.0.2.3', '/shop', 200], ['10.0.4.17', '/', 200], ['10.0.0.8', '/img', 200], ['10.0.9.9', '/cart', 500],
  ['10.0.0.8', '/', 200], ['10.0.4.17', '/cart', 500], ['10.0.2.3', '/cart', 500], ['10.0.0.8', '/shop', 200],
  ['10.0.4.17', '/', 200], ['10.0.0.8', '/img', 200], ['10.0.2.3', '/', 200], ['10.0.9.9', '/', 200],
  ['10.0.0.8', '/shop', 200], ['10.0.4.17', '/cart', 500], ['10.0.2.3', '/', 200], ['10.0.0.8', '/', 200],
];
export const ACCESS_LOG = LOG.map(([ip, path, st], i) => `${ip} - - [30/Oct/2026:09:${String(i).padStart(2, '0')}:00] "GET ${path} HTTP/1.1" ${st}`).join('\n') + '\n';
export const NOISY = { ip: '10.0.4.17', failures: LOG.filter(([ip, , st]) => ip === '10.0.4.17' && st === 500).length };
const answerLine = new RegExp(`^\\s*${NOISY.failures} ${NOISY.ip.replace(/\./g, '\\.')}$`);

export const LINUX_MISSIONS: Record<string, Mission<LinuxState>> = {
  'linux-paths': {
    id: 'linux-paths', title: 'Find your way around', xp: 40,
    setup: () => ({ sh: world() }),
    steps: [
      { text: 'Find out where you are', hint: 'pwd', done: (s) => ran(s, /^pwd\b/) },
      { text: 'List everything here - hidden files too', hint: 'ls -a', done: (s) => ran(s, /^ls\b.*\s-\w*a/) },
      { text: 'Read the machine\'s name with an absolute path', hint: 'cat /etc/hostname', done: (s) => ran(s, /^cat\s+\/etc\/hostname\b/) },
      { text: 'Walk into projects/bamboo with a relative path', hint: 'cd projects/bamboo', done: (s) => s.sh.cwd === '/home/panda/projects/bamboo' && ran(s, /^cd\s+(?!\/|~)\S/) },
      { text: 'Back up README.md as README.bak', hint: 'cp README.md README.bak', done: (s) => file(s, '/home/panda/projects/bamboo/README.bak')?.content === file(s, '/home/panda/projects/bamboo/README.md')?.content },
      { text: 'Throw some output into /dev/null - then read it back', hint: 'echo "gone" > /dev/null  then  cat /dev/null', done: (s) => { const w = lastIndex(s, />\s*\/dev\/null/), r = lastIndex(s, /^cat\s+\/dev\/null/); return w >= 0 && r > w; } },
    ],
    debrief: '/dev/null took your text and kept none of it, yet you wrote to it and read it with the same tools as any file. That is the idea: devices, processes and settings all look like files, so cat, echo and > work on all of them.',
  },
  'linux-signals': {
    id: 'linux-signals', title: 'Stop it the right way', xp: 50,
    setup: () => {
      const sh = world();
      sh.spawnDaemon({ pid: 311, name: 'orders', cmd: 'orders --listen :8080', owner: 'panda', onTerm: 'graceful',
        cleanup: ['SIGTERM received - finishing 3 orders in flight', 'saved 3 orders, closed 12 connections, exiting 0'], unsaved: '3 orders in flight were never saved' });
      sh.spawnDaemon({ pid: 312, name: 'stuck', cmd: 'stuck --ignore-term', owner: 'panda', onTerm: 'ignore' });
      return { sh };
    },
    steps: [
      { text: 'List every process on the machine', hint: 'ps -e', done: (s) => ran(s, /^ps\s+(-e|-A|-ef|aux|ax)\b/) },
      { text: 'Ask orders (PID 311) to stop politely - SIGTERM is the default', hint: 'kill 311', done: (s) => s.sh.signals.some((g) => g.pid === 311 && g.outcome === 'graceful') },
      { text: 'Ask stuck (PID 312) politely too, then check whether it listened', hint: 'kill 312  then  ps -e', done: (s) => s.sh.signals.some((g) => g.pid === 312 && g.outcome === 'ignored') && lastIndex(s, /^ps\b/) > lastIndex(s, /^kill\s+(-TERM\s+|-15\s+|-s\s+TERM\s+)?312\b/) },
      { text: 'Now force it: SIGKILL cannot be caught or ignored', hint: 'kill -9 312', done: (s) => s.sh.signals.some((g) => g.pid === 312 && g.sig === 'KILL') && s.sh.signals.some((g) => g.pid === 312 && g.outcome === 'ignored') },
      { text: 'Start a job, stop it with SIGTERM, and read its exit status', hint: 'sleep 300 &  then  kill %1  then  wait %1  then  echo $?', done: (s) => s.sh.echoedStatus.includes(143) },
    ],
    debrief: 'orders heard SIGTERM and saved its work. stuck ignored it, so only SIGKILL ended it, and the kernel gives a killed process no chance to clean up. 143 is 128 + 15 (TERM) and 137 is 128 + 9 (KILL). Kubernetes stops a container exactly this way: SIGTERM, a grace period (30 seconds by default), then SIGKILL.',
  },
  'linux-perms': {
    id: 'linux-perms', title: 'Just enough permission', xp: 50,
    setup: () => {
      const sh = world();
      sh.fs.put('/home/panda/deploy.sh', { type: 'file', content: '#!/bin/bash\necho "deploying bamboo v2..."\necho "done"\n', mode: 0o644 });
      return { sh };
    },
    steps: [
      { text: 'Try to run ./deploy.sh', hint: './deploy.sh', done: (s) => ran(s, /^\.\/deploy\.sh\b/) },
      { text: 'Read its permissions', hint: 'ls -l deploy.sh', done: (s) => ran(s, /^ls\b.*\s-\w*l/) },
      { text: 'Let yourself run it - without letting anyone else change it', hint: 'chmod u+x deploy.sh', done: (s) => safeExec(s) },
      { text: 'Run it', hint: './deploy.sh', done: (s) => safeExec(s) && s.sh.scriptRuns.some((r) => r.path === '/home/panda/deploy.sh' && r.code === 0) },
      { text: 'Try to read /etc/shadow - then try to chmod your way in', hint: 'cat /etc/shadow  then  chmod 644 /etc/shadow', done: (s) => ran(s, /^cat\s+\/etc\/shadow/) && ran(s, /^chmod\s+\S+\s+\/etc\/shadow/) },
    ],
    debrief: 'chmod u+x added one bit: execute, for you. chmod 777 would also have made it run - and let every user on the machine rewrite what it does the next time you run it. And no mode you type changes a file you do not own: only its owner, or root, may chmod it.',
  },
  'linux-pipes': {
    id: 'linux-pipes', title: 'Find the noisy client', xp: 60,
    setup: () => {
      const sh = world();
      sh.fs.put('/home/panda/access.log', { type: 'file', content: ACCESS_LOG });
      return { sh };
    },
    steps: [
      { text: 'Count the requests in access.log', hint: 'wc -l access.log', done: (s) => s.sh.outputs.some((o) => /^\s*28(\s+access\.log)?$/.test(o)) },
      { text: 'Show only the failed requests (status 500)', hint: "grep ' 500$' access.log", done: (s) => s.sh.outputs.some((o) => o.split('\n').length >= 2 && o.split('\n').every((l) => /" 500$/.test(l))) },
      { text: 'Count failures per client, busiest first', hint: "grep ' 500$' access.log | cut -d ' ' -f 1 | sort | uniq -c | sort -rn", done: (s) => s.sh.outputs.some((o) => answerLine.test(o.split('\n')[0] ?? '')) },
      { text: 'Save just the top line to noisy.txt', hint: "grep ' 500$' access.log | cut -d ' ' -f 1 | sort | uniq -c | sort -rn | head -1 > noisy.txt", done: (s) => answerLine.test((file(s, '/home/panda/noisy.txt')?.content ?? '').trim()) },
    ],
    debrief: `Five small tools, each doing one job, joined by pipes: grep kept the failures, cut kept the address, sort put equal lines together, uniq -c counted them, and sort -rn put the busiest first. Counting every request would have blamed 10.0.0.8, which never failed once. And uniq only merges lines that are next to each other - which is why sort comes first.`,
  },
};

function safeExec(s: LinuxState): boolean {
  const f = file(s, '/home/panda/deploy.sh');
  // Runnable by the owner, writable by nobody else.
  return !!f && (f.mode & 0o100) !== 0 && (f.mode & 0o022) === 0;
}

