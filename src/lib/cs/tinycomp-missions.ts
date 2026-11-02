// Missions for the two tiny compiler lessons. The widget's missions read what the lab saw.
// The code-lab missions call the learner's functions on expressions beyond the visible example,
// and compare with what real Python makes of them, so a program that special-cases that example
// doesn't pass. A failing check names its expression, so a lookup table of all of them could be
// built from the messages: that's real effort that proves nothing, and it's left unblocked on
// purpose. Played start to finish in tests/tinycomp-missions.test.ts.

import type { Mission } from '../missions.ts';
import { checkCases, type GrowthPoint, type GrowthShape, type RunResult } from '../py/lab.ts';
import { GenLab, ParseLab, genCaughtSwap, genFoldKeptError, genFolded, genSawStack, genSpilled, parseCaught, parseHidden, parseSawPointer, parseSawPrecedence } from './tinycomp.ts';

export type ParseState = { lab: ParseLab };
export type GenerateState = { lab: GenLab };

export const PARSE_MISSION: Mission<ParseState> = {
  id: 'comp-parse-lab', title: 'Same text, different tree', xp: 60, setup: () => ({ lab: new ParseLab() }),
  steps: [
    { text: 'With the correct parser, write a sum and a product with no brackets. Read the tree: which one is nearer the top?', hint: '1 + 2 * 3', done: (s) => parseSawPrecedence(s.lab) },
    { text: 'Break the text so it can\'t be read, somewhere after its first character, and see where the parser points', hint: '1 + * 2', done: (s) => parseSawPointer(s.lab) },
    { text: 'Switch to the "no precedence" parser and find an expression where its answer differs from Python\'s', hint: 'Anything with a * after a +', done: (s) => parseCaught(s.lab, 'flat') },
    { text: 'Switch to the "+ and - group from the right" parser and find an expression where its answer differs from Python\'s', hint: 'Two subtractions in a row', done: (s) => parseCaught(s.lab, 'right') },
    { text: 'Stay on that parser and find an expression where the tree is wrong and the answer is still right', hint: 'Two additions in a row: compare the trees', done: (s) => parseHidden(s.lab, 'right') },
  ],
  debrief: 'The tree is the meaning, and every parser here read the same characters. A test that only checks one answer can pass with the wrong tree, because 1 + 2 + 3 comes out the same however you group it. That\'s why this lesson\'s tests compare thousands of generated expressions with real Python, and read the trees as well.',
};

export const GENERATE_MISSION: Mission<GenerateState> = {
  id: 'comp-generate-lab', title: 'Walk the stack, then break the compiler', xp: 60, setup: () => ({ lab: new GenLab() }),
  steps: [
    { text: 'Compile something with at least two operators, then press Step until the program ends. Watch the stack grow and shrink', hint: '1 + 2 * 3, then Step', done: (s) => genSawStack(s.lab) },
    { text: 'Switch on the swapped generator and find an expression where it gets the answer wrong', hint: 'Addition won\'t show it. Try a subtraction', done: (s) => genCaughtSwap(s.lab) },
    { text: 'Back on the correct generator, switch on folding and compile something that gets shorter with the same answer', hint: 'x + 2 * 3', done: (s) => genFolded(s.lab) },
    { text: 'With folding still on, compile a division by zero. The compile has to succeed, and the failure has to wait for the run', hint: '1 / 0 + 2', done: (s) => genFoldKeptError(s.lab) },
    { text: 'Set the registers low and compile something that makes the machine save a value to memory, with the same answer', hint: 'Two registers and (x + 1) * (y + 2). It has names in it, so folding can\'t remove the work', done: (s) => genSpilled(s.lab) },
  ],
  debrief: 'You walked a real compiler\'s output one instruction at a time, then saw three things every real compiler has to get right. Operand order: a wrong one passes on + and * and fails on -. Optimisation: it has to keep the meaning, including a failure that belongs to run time. Registers: there are never enough, so values get saved to memory, and the answer can\'t change. These targets are invented for the lesson, and real ones have far more to deal with.',
};

// ---- Code lab: the learner writes the parser, then the generator, in Python

type CodeRun = { runs: RunResult[]; growth: { src: string; fn: string; points: GrowthPoint[]; shape: GrowthShape }[] };
const blank = (): CodeRun => ({ runs: [], growth: [] });
const last = (s: CodeRun) => s.runs.at(-1);
const passes = (s: CodeRun, fn: string, cases: { args: unknown[]; want: string }[]) => { const r = last(s); return !!r && checkCases(r, fn, cases).ok; };
const why = (s: CodeRun, fn: string, cases: { args: unknown[]; want: string }[]) => { const r = last(s); return r ? checkCases(r, fn, cases).why : 'Press Run first.'; };

// Every want below comes from real Python: tests/tinycomp-missions.test.ts checks each one.
export const LEFT_CASES = [
  { args: ['10 - 3 - 2'], want: '5' },
  { args: ['1 - 1 - 1'], want: '-1' },
  { args: ['100 - 50 - 25 - 5'], want: '20' },
  { args: ['8 + 1 - 2 - 3 + 4'], want: '8' },
  { args: ['7'], want: '7' },
];
export const PRECEDENCE_CASES = [
  { args: ['2 + 3 * 4'], want: '14' },
  { args: ['2 * 3 + 4'], want: '10' },
  { args: ['20 - 2 * 3 - 4'], want: '10' },
  { args: ['2 * 3 * 4'], want: '24' },
  { args: ['20 / 2 / 5'], want: '2.0' },
  { args: ['1 + 6 / 4'], want: '2.5' },
  { args: ['9 - 8 / 2 * 3'], want: '-3.0' },
];
export const BRACKET_CASES = [
  { args: ['(2 + 3) * 4'], want: '20' },
  { args: ['2 * (3 + 4) * 5'], want: '70' },
  { args: ['((7))'], want: '7' },
  { args: ['10 - (3 - 2)'], want: '9' },
  { args: ['(1 + 2) * (3 + 4) / (5 - 3)'], want: '10.5' },
];

const PARSE_STARTER = `# A tree is a tuple: ("+", left, right). A number is just itself.

def tokens(text):
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == " ":
            i += 1
        elif c.isdigit():
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            out.append(int(text[i:j]))
            i = j
        else:
            out.append(c)
            i += 1
    return out

def parse_number(toks):
    return toks.pop(0)

def parse_expr(toks):
    left = parse_number(toks)
    if len(toks) > 0 and toks[0] in ("+", "-"):
        op = toks.pop(0)
        right = parse_expr(toks)
        return (op, left, right)
    return left

def calc(tree):
    if type(tree) == int:
        return tree
    op, left, right = tree
    a = calc(left)
    b = calc(right)
    if op == "+":
        return a + b
    if op == "-":
        return a - b
    if op == "*":
        return a * b
    if op == "/":
        return a / b
    raise ValueError("no such operator: " + op)

def value(text):
    return calc(parse_expr(tokens(text)))

print(parse_expr(tokens("10 - 3 - 2")))
print(value("10 - 3 - 2"))
`;

const GIVEN_COMPILER = `# Reads + - * / and brackets. Names like x are plain strings in the tree.
def tokens(text):
    out = []
    i = 0
    while i < len(text):
        c = text[i]
        if c == " ":
            i += 1
        elif c.isdigit():
            j = i
            while j < len(text) and text[j].isdigit():
                j += 1
            out.append(int(text[i:j]))
            i = j
        else:
            out.append(c)
            i += 1
    return out

def parse_atom(toks):
    t = toks.pop(0)
    if t == "(":
        inner = parse_sum(toks)
        toks.pop(0)
        return inner
    return t

def parse_product(toks):
    left = parse_atom(toks)
    while len(toks) > 0 and toks[0] in ("*", "/"):
        op = toks.pop(0)
        left = (op, left, parse_atom(toks))
    return left

def parse_sum(toks):
    left = parse_product(toks)
    while len(toks) > 0 and toks[0] in ("+", "-"):
        op = toks.pop(0)
        left = (op, left, parse_product(toks))
    return left

def parse(text):
    return parse_sum(tokens(text))

# The machine: PUSH puts a number on the stack, LOAD puts a variable's
# value there, and an operator takes two off and puts one back. x is 10.
def run(program):
    stack = []
    for ins in program:
        if ins[0] == "PUSH":
            stack.append(ins[1])
        elif ins[0] == "LOAD":
            stack.append({"x": 10}[ins[1]])
        else:
            b = stack.pop()
            a = stack.pop()
            if ins[0] == "+":
                stack.append(a + b)
            elif ins[0] == "-":
                stack.append(a - b)
            elif ins[0] == "*":
                stack.append(a * b)
            elif ins[0] == "/":
                stack.append(a / b)
    if len(stack) != 1:
        raise ValueError("the program left " + str(len(stack)) + " values on the stack")
    return stack[0]

def answer(text):
    return run(gen(parse(text)))

def folded_answer(text):
    return run(gen(fold(parse(text))))

def instructions(text):
    return len(gen(fold(parse(text))))
`;

const GEN_STARTER = `# Turn a tree into a list of instructions for the machine above.
def gen(tree):
    if type(tree) == int or type(tree) == float:
        return [("PUSH", tree)]
    if type(tree) == str:
        return [("LOAD", tree)]
    op, left, right = tree
    return gen(right) + gen(left) + [(op,)]

# Replace the parts of a tree that can't change with their answer.
def fold(tree):
    return tree

print(parse("x - 2 * 3"))
print(gen(parse("x - 2 * 3")))
print(answer("10 - 3"))
`;

export const ANSWER_CASES = [
  { args: ['10 - 3'], want: '7' },
  { args: ['2 * 3 + 4'], want: '10' },
  { args: ['20 / 4 - 1'], want: '4.0' },
  { args: ['x - 1 - 2'], want: '7' },
  { args: ['(1 + 2) * (9 - x)'], want: '-3' },
];
export const FOLD_SIZE_CASES = [
  { args: ['2 * 3 + 4'], want: '1' },
  { args: ['(1 + 2) * (3 + 4)'], want: '1' },
  { args: ['x + 2 * 3'], want: '3' },
  { args: ['x + 1'], want: '3' },
  // Reads as (x + 2) + 3, so nothing here is only numbers. Rewriting it to x + 5 passed all
  // three steps before this case, though the lesson's own trap says that rewrite isn't safe.
  { args: ['x + 2 + 3'], want: '5' },
  // Not 1, and not a crash: this has to fail when it runs, not while compiling.
  { args: ['1 / 0'], want: '3' },
  { args: ['1 / 0 + 2'], want: '5' },
];
export const FOLD_VALUE_CASES = [
  { args: ['x - 2 - 3'], want: '5' },
  { args: ['x * 2 + 3 * 4'], want: '32' },
  { args: ['7 / 2'], want: '3.5' },
  { args: ['10 - 3 - 2'], want: '5' },
];

export const COMPILER_CODE_MISSIONS: Record<string, Mission<CodeRun> & { starter?: string; given?: string }> = {
  'comp-parse-fix': {
    id: 'comp-parse-fix', title: 'Write the parser that gets it right', xp: 70, setup: blank, starter: PARSE_STARTER,
    steps: [
      { text: 'Run it. It prints the tree, then an answer. In real Python, 10 - 3 - 2 is 5. What did this say, and how does the tree explain it?', hint: 'Press Run and read the first line of output: where do the brackets fall?', done: (s) => s.runs.some((r) => r.status === 'done') },
      { text: 'Make + and - group from the left: replace the recursive call in parse_expr with a loop that keeps building on left', hint: 'while len(toks) > 0 and toks[0] in ("+", "-"):   then   left = (op, left, parse_number(toks))', done: (s) => passes(s, 'value', LEFT_CASES), why: (s) => why(s, 'value', LEFT_CASES) },
      { text: 'Add * and / so they bind tighter: a new function that parse_expr calls instead of parse_number', hint: 'parse_term reads numbers joined by * or /, in the same kind of loop. parse_expr then joins terms with + or -', done: (s) => passes(s, 'value', LEFT_CASES) && passes(s, 'value', PRECEDENCE_CASES), why: (s) => why(s, 'value', [...LEFT_CASES, ...PRECEDENCE_CASES]) },
      { text: 'Add brackets: wherever a number can go, a whole bracketed expression can go', hint: 'In parse_number: if toks[0] == "(", pop it, call parse_expr, then pop the ")"', done: (s) => passes(s, 'value', LEFT_CASES) && passes(s, 'value', PRECEDENCE_CASES) && passes(s, 'value', BRACKET_CASES), why: (s) => why(s, 'value', [...LEFT_CASES, ...PRECEDENCE_CASES, ...BRACKET_CASES]) },
    ],
    debrief: 'That\'s recursive descent: one function for each level of the grammar, the lowest precedence on the outside, and brackets calling back to the top, because brackets can nest to any depth. Your parser and the one this page\'s Python runs on have the same shape. A loop gives left grouping and a call to itself gives right grouping, so the fix you made in step 2 is exactly the difference between - and **.',
  },
  'comp-gen-stack': {
    id: 'comp-gen-stack', title: 'Tree to instructions, then make them fewer', xp: 70, setup: blank, starter: GEN_STARTER, given: GIVEN_COMPILER,
    steps: [
      { text: 'Run it. The generator runs without an error and says 10 - 3 is -7. Read the instruction list to see why', hint: 'Press Run. Which number goes on the stack first?', done: (s) => s.runs.some((r) => r.status === 'done') },
      { text: 'Fix the order in gen, so that every kind of expression gets Python\'s answer', hint: 'The left side has to be on the stack first: gen(left) + gen(right) + [(op,)]', done: (s) => passes(s, 'answer', ANSWER_CASES), why: (s) => why(s, 'answer', ANSWER_CASES) },
      { text: 'Write fold, so a part of a tree that uses only numbers becomes its answer, while 1 / 0 stays in the program to fail at run time', hint: 'Fold both sides first. If both are int or float, try the sum: in a try block, run(gen((op, left, right))) gives the answer, and on ZeroDivisionError return the tree as it was', done: (s) => passes(s, 'answer', ANSWER_CASES) && passes(s, 'instructions', FOLD_SIZE_CASES) && passes(s, 'folded_answer', FOLD_VALUE_CASES), why: (s) => { const a = checkFold(s); return a; } },
    ],
    debrief: 'You generated code for a machine and then optimised it, and the optimiser had the same duty every real one has: the program must mean the same thing afterwards. Your fold keeps 1 / 0 for run time because that line might never run. Real Python\'s own compiler folds constants and holds back the same way, and its bytecode is a stack machine much like this one.',
  },
};

function checkFold(s: CodeRun): string {
  for (const [fn, cases] of [['answer', ANSWER_CASES], ['instructions', FOLD_SIZE_CASES], ['folded_answer', FOLD_VALUE_CASES]] as const) {
    const w = why(s, fn, cases);
    if (!/^Passed/.test(w)) return w;
  }
  return '';
}
