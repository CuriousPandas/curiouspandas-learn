// The Speculation Lab's mission. The steps read what the lab saw, and step 3 can only be
// passed by reading digits off the probe: the secret is different on every load and the lab
// only ever answers yes or no. Played, with shortcuts, in tests/speculation.test.ts.

import type { Mission } from '../missions.ts';
import { SpecLab, guessedSpectre, sawBlindTimer, sawDefended, sawIsolation, sawMeltdown, sawRecovered, sawRefusal, type SpecState } from './speculation.ts';

export const SPEC_MISSION: Mission<SpecState> = {
  id: 'comp-speculation-lab', title: 'Read what the check refused', xp: 70,
  // Different on every load, because a fixed secret could be read off this page's source.
  setup: () => ({ lab: new SpecLab(Math.floor(Math.random() * 2 ** 31) + 1) }),
  steps: [
    { text: 'Call the victim with x = 16, out of range. Read what it returned: the bounds check did its job', hint: 'Set x to 16 and press Call victim', done: (s) => sawRefusal(s.lab) },
    { text: 'Now teach the predictor, flush the probe, call with x = 16 again, and time the probe. One line should stand out', hint: 'Train, Flush probe, Call victim, Time the probe', done: (s) => sawRecovered(s.lab) },
    { text: 'Do that for x = 16, 17, 18 and 19, and type the four digits you read. The lab never shows you the secret, it only says whether you got it', hint: 'A round for each x. The fast line\'s number is the digit: lines 10 to 15 are a to f', done: (s) => guessedSpectre(s.lab) },
    { text: 'Turn on a defence in the victim, and run the whole attack again: train, flush, call, time', hint: 'Choose the barrier or the mask under "Defence", then a full round', done: (s) => sawDefended(s.lab) },
    { text: 'Set the defence back to none, turn on the coarse timer, and run the attack. Compare what the probe says with what the model knows', hint: 'A full round with "coarse timer" ticked', done: (s) => sawBlindTimer(s.lab) },
    { text: 'Switch to the Meltdown-style read and see it land on the affected CPU, then turn on page table isolation and try again', hint: 'Attack: Meltdown style. Flush probe, Read kernel, Time the probe. Then tick isolation and repeat', done: (s) => sawMeltdown(s.lab) && sawIsolation(s.lab) },
  ],
  debrief: 'The program never saw the secret: every call returned what the code said it should. The secret reached the cache during work the CPU threw away, and throwing it away restored the registers and not the cache. Your defences worked in different ways. The barrier stopped the guess and charged every call for it, the mask let the guess run and kept it in bounds, and isolation removed the kernel from view. The coarse timer did something else again: the mark stayed in the cache and only this probe lost sight of it, so it\'s a defence with a known way round it rather than a fix. And remember this is a model: it shows you the mechanism on invented numbers, and your real CPU took no part.',
};
