// Mutation testing in miniature, for "Write the test that could fail". The learner's
// tests run against a correct function and against versions broken on purpose. A
// test suite is only worth anything if it passes on the first and fails on the rest.
//
// The function lives outside the learner's code, as a lab's given code, so swapping
// it needs no reading of their text. Tests written as top-level asserts, as test_
// functions they call, or in any other shape are judged the same way: did the
// program finish? Redefining the function in their own code can't help, since then
// every version behaves alike and nothing is caught. tests/prog-practice-missions.test.ts
// plays the shortcuts: assert True, a test never called, an assert inside a
// try/except that swallows it, comparing the answer with itself.

import { PyProgram } from '../py/vm.ts';

export type SuiteRun = { passed: boolean; error?: string };

export function runSuite(tests: string, impl: string): SuiteRun {
  // Tests are expected to be small, and a mutant can make one loop forever. Running
  // out of steps is a failure of that suite on that version, not a crash of the page.
  const p = new PyProgram(tests, { maxOps: 500_000, given: impl });
  p.run();
  return { passed: p.status === 'done', error: p.error ? `${p.error.type}: ${p.error.message}` : p.status === 'done' ? undefined : p.status };
}

export type SuiteReport = { passesOnCorrect: boolean; callsIt: boolean; caught: Record<string, boolean> };
export type UnderTest = { name: string; params: string; correct: string; broken: Record<string, string> };

export function judgeSuite(tests: string, fn: UnderTest): SuiteReport {
  const passesOnCorrect = runSuite(tests, fn.correct).passed;
  // A version where every call fails, so a program that still finishes never called
  // the function. Without this, an empty editor counts as "tests that pass", which
  // is exactly the failure being taught.
  const callsIt = !runSuite(tests, `def ${fn.name}(${fn.params}):\n    raise RuntimeError("called")\n`).passed;
  const caught: Record<string, boolean> = {};
  for (const [label, impl] of Object.entries(fn.broken)) caught[label] = !runSuite(tests, impl).passed;
  return { passesOnCorrect, callsIt, caught };
}
