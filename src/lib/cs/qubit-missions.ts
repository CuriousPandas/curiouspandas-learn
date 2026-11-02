// The Qubit Lab's mission. Steps read the states the lab passed through, so any qubit and any
// route that really does the thing counts. Played, with shortcuts, in tests/qubit.test.ts.

import type { Mission } from '../missions.ts';
import { QubitLab, sawBellShots, sawFoundMarked, sawInterference, sawPhase, sawSuperposition } from './qubit.ts';

export type QubitState = { lab: QubitLab };

export const QUBIT_MISSION: Mission<QubitState> = {
  id: 'comp-qubit-lab', title: 'Make the paths cancel', xp: 70,
  // A new marked item each load, since the point of the search is not knowing it.
  setup: () => ({ lab: new QubitLab(Math.floor(Math.random() * 2 ** 31) + 1) }),
  steps: [
    { text: 'Put one qubit into an even split with H, and read the chances', hint: 'Press H on qubit 0', done: (s) => sawSuperposition(s.lab) },
    { text: 'Press H on that same qubit again. It doesn\'t get more random: the paths cancel and it\'s certain again', hint: 'H on qubit 0, a second time', done: (s) => sawInterference(s.lab) },
    { text: 'Start again. H, then Z, then H, all on one qubit. Z changes no chance at all. Read where you end up', hint: 'Reset, then H, Z, H on qubit 0', done: (s) => sawPhase(s.lab) },
    { text: 'Start again and entangle the two: H on qubit 0, then CNOT. Then take at least 20 shots and read what never comes up', hint: 'Reset, H on qubit 0, CNOT 0 to 1, 100 shots', done: (s) => sawBellShots(s.lab) },
    { text: 'Start again. The oracle marks one of the four items, and you don\'t know which. Find it with a single oracle call', hint: 'Reset, H on both qubits, Oracle, Diffusion', done: (s) => sawFoundMarked(s.lab) },
  ],
  debrief: 'Nothing here tried every answer and picked one. An even split read now is just a coin toss. What makes a quantum algorithm work is steering: arranging the amplitudes so that wrong answers cancel and the right one adds up, which is what your Z and your diffusion step did. With four items, one oracle call is enough. That\'s a lucky size: the general result is about π/4 √N calls, a real but modest speedup on a list with no structure at all. Doing better than that takes a problem with a structure to exploit, as factoring has. And this was an ordinary program doing ordinary arithmetic on four numbers. Nothing quantum happened on your device.',
};
