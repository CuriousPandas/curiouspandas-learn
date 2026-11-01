// Missions for "From one-liners to a shell script". Each judges the script by running
// a copy in a fresh machine the learner never saw, with a different log, with the folder
// missing, or with other files in it. So a script that just echoes the answer it saw
// fails, and a fix that names the files it saw (rm a.tmp b.tmp) fails. Takes `world` rather than importing it:
// shell/missions.ts includes this file, and importing back would make a cycle.

import type { Mission } from '../missions.ts';
import type { File } from './fs.ts';
import type { Shell } from './shell.ts';

type LinuxState = { sh: Shell };

const ran = (s: LinuxState, re: RegExp) => s.sh.history.some((l) => re.test(l.trim()));
const file = (sh: Shell, path: string): File | undefined => {
  try { const n = sh.fs.lookup(path, sh.user); return n?.type === 'file' ? n : undefined; } catch { return undefined; }
};
const logLine = (ip: string, status: number, i: number) => `${ip} - - [30/Oct/2026:09:${String(i).padStart(2, '0')}:00] "GET /x HTTP/1.1" ${status}`;
// A log with a different culprit from the one the learner can read, so a script
// that prints the answer it saw names the wrong client.
const HIDDEN_LOG = [['10.9.9.9', 500], ['10.1.1.1', 200], ['10.9.9.9', 500], ['10.2.2.2', 500], ['10.9.9.9', 500], ['10.1.1.1', 200]]
  .map(([ip, st], i) => logLine(ip as string, st as number, i)).join('\n') + '\n';

export const CLEANUP_SCRIPT = '#!/bin/bash\n# Empties the cache folder.\ncd cashe\nrm -r *\necho "cache cleaned"\n';

export function scriptMissions(world: () => Shell): Record<string, Mission<LinuxState>> {
  /** Runs the learner's script text on a clean machine and says what it did. */
  const tryScript = (s: LinuxState, name: string, build: (sh: Shell) => void, cmd: string) => {
    const text = file(s.sh, `/home/panda/${name}`)?.content;
    if (text === undefined) return null;
    const sh = world();
    sh.fs.put(`/home/panda/${name}`, { type: 'file', content: text, mode: 0o755 });
    build(sh);
    const lines = sh.run(cmd);
    return { sh, out: lines.filter((l) => l.kind === 'out').map((l) => l.text).join('\n'), code: sh.status };
  };
  const findsCulprit = (s: LinuxState, name: string, cmd: string, logName: string) => {
    const r = tryScript(s, name, (sh) => sh.fs.put(`/home/panda/${logName}`, { type: 'file', content: HIDDEN_LOG }), cmd);
    return !!r && r.code === 0 && /^\s*3 10\.9\.9\.9\s*$/.test(r.out.split('\n')[0] ?? '');
  };
  const executable = (s: LinuxState) => {
    const f = file(s.sh, '/home/panda/report.sh');
    return !!f && (f.mode & 0o100) !== 0 && (f.mode & 0o022) === 0;
  };
  const safeCleanup = (s: LinuxState) => {
    // Folder missing: must touch nothing else, must not claim success, must say so.
    const missing = tryScript(s, 'cleanup.sh', (sh) => sh.fs.put('/home/panda/photos/cat.jpg', { type: 'file', content: 'meow' }), 'bash cleanup.sh');
    if (!missing || missing.code === 0 || /cleaned/.test(missing.out) || !file(missing.sh, '/home/panda/photos/cat.jpg') || !file(missing.sh, '/home/panda/notes.txt')) return false;
    // Folder there: must really empty it, or a script that does nothing would pass. Other
    // names from the ones on show, so `rm a.tmp b.tmp` doesn't pass, and a folder inside it.
    const there = tryScript(s, 'cleanup.sh', (sh) => { sh.fs.put('/home/panda/cache/old-render.bin', { type: 'file', content: 'x' }); sh.fs.put('/home/panda/cache/thumbs/1.png', { type: 'file', content: 'y' }); sh.fs.put('/home/panda/photos/cat.jpg', { type: 'file', content: 'meow' }); }, 'bash cleanup.sh');
    if (!there || there.code !== 0 || !file(there.sh, '/home/panda/photos/cat.jpg') || !file(there.sh, '/home/panda/notes.txt')) return false;
    // Emptied, not deleted: "empties the cache folder" is what the script says it does,
    // and `rm -r cache` passed before this looked.
    const cache = there.sh.fs.lookup('/home/panda/cache', there.sh.user);
    return cache?.type === 'dir' && cache.children.size === 0;
  };

  return {
    'prog-shell-report': {
      id: 'prog-shell-report', title: 'Save your one-liner', xp: 60,
      setup: () => {
        const sh = world();
        const log = [['10.0.0.8', 200], ['10.0.4.17', 500], ['10.0.0.8', 200], ['10.0.4.17', 500], ['10.0.2.3', 500], ['10.0.0.8', 200], ['10.0.4.17', 500], ['10.0.0.8', 200]]
          .map(([ip, st], i) => logLine(ip as string, st as number, i)).join('\n') + '\n';
        sh.fs.put('/home/panda/access.log', { type: 'file', content: log });
        return { sh };
      },
      steps: [
        { text: 'Write the pipeline into report.sh: count failures per client, busiest first, keep the top line', hint: `echo 'grep 500$ access.log | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1' > report.sh`, done: (s) => findsCulprit(s, 'report.sh', 'bash report.sh access.log', 'access.log') },
        { text: 'Run it as a script', hint: 'bash report.sh', done: (s) => s.sh.scriptRuns.some((r) => r.path === '/home/panda/report.sh' && r.code === 0) },
        { text: 'Make it a command of its own, runnable by you and writable by nobody else, and run it that way', hint: 'chmod u+x report.sh  then  ./report.sh', done: (s) => executable(s) && ran(s, /^\.\/report\.sh\b/) },
        { text: 'Make it work on any log: the file name comes from the command line, as $1', hint: `echo 'grep 500$ "$1" | cut -d " " -f 1 | sort | uniq -c | sort -rn | head -1' > report.sh  then  ./report.sh access.log`, done: (s) => executable(s) && findsCulprit(s, 'report.sh', 'bash report.sh other.log', 'other.log') },
      ],
      debrief: 'A script is a file of commands that the shell runs in order, and $1 is what turned a one-off into a tool. The lab ran your script on a log you never saw with a different culprit, so printing the answer you had already found wouldn\'t have passed. Single quotes mattered too: inside double quotes the shell swaps $1 for its value while running echo, before the script exists.',
    },
    'prog-shell-silent': {
      id: 'prog-shell-silent', title: 'The script that said it worked', xp: 70,
      setup: () => {
        const sh = world();
        sh.fs.put('/home/panda/cleanup.sh', { type: 'file', content: CLEANUP_SCRIPT, mode: 0o755 });
        sh.fs.put('/home/panda/cache/a.tmp', { type: 'file', content: 'temporary\n' });
        sh.fs.put('/home/panda/cache/b.tmp', { type: 'file', content: 'temporary\n' });
        sh.fs.put('/home/panda/photos/cat.jpg', { type: 'file', content: 'meow\n' });
        return { sh };
      },
      steps: [
        { text: 'Read cleanup.sh. Spot the typo? It\'s only a sandbox, so run it and see what the script does about it', hint: 'cat cleanup.sh  then  ./cleanup.sh  then  ls', done: (s) => s.sh.scriptRuns.some((r) => r.path === '/home/panda/cleanup.sh' && r.code === 0) && !file(s.sh, '/home/panda/notes.txt') },
        { text: 'Rewrite cleanup.sh with the right folder, so a failed cd stops everything after it', hint: `echo 'cd cache && rm -r * && echo "cache cleaned"' > cleanup.sh`, done: safeCleanup },
        { text: 'Run your version here, where the cache folder is gone now, and read its exit status', hint: 'bash cleanup.sh  then  echo $?', done: (s) => safeCleanup(s) && s.sh.scriptRuns.some((r) => r.path === '/home/panda/cleanup.sh' && r.code !== 0) && s.sh.echoedStatus.some((c) => c !== 0) },
      ],
      debrief: 'The first version printed "cache cleaned" and exited 0 while it deleted everything in your home folder but the hidden files, because cd failed and nothing was looking. The shell carries on after a failed command unless you tell it not to. && means "only if that worked", so yours stopped at the cd, deleted nothing and exited non-zero. The lab tested it on two fresh machines, one with the folder missing and one with it there, holding files you hadn\'t seen, because a script that never deletes anything is also safe, and also useless.',
    },
  };
}
