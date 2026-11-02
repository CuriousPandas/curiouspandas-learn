#!/usr/bin/env python3
"""Records what a real RISC-V CPU core does, for tests/riscv.test.ts to replay.

Unicorn is QEMU's CPU emulator and Capstone is LLVM's disassembler. Neither shares a
line with src/lib/cs/riscv.ts, and the encoder below is written from the manual's format
tables, so a misreading of the manual would have to be made twice to pass.

The results are committed because a CI run shouldn't need a native wheel to check them.
To regenerate:
    python -m venv venv && venv/Scripts/python -m pip install unicorn capstone
    venv/Scripts/python scripts/gen-rv32-fixture.py
Recorded with unicorn 2.1.4 and capstone 5.0.7.
"""
import json
import os
import random
import sys

import capstone
import unicorn
from unicorn import Uc, UC_ARCH_RISCV, UC_MODE_RISCV32, UC_PROT_ALL
from unicorn import riscv_const as rc

SEED = 20261101
MEM = 0x10000
rng = random.Random(SEED)

EDGE = [0, 1, 2, 31, 32, 0x7FFFFFFF, 0x80000000, 0xFFFFFFFF, 0xFFFFFFFE, 0x0000FFFF, 0xFFFF0000, 0x00000800, 0xFFFFF800]

R_OPS = {"add": (0, 0), "sub": (32, 0), "sll": (0, 1), "slt": (0, 2), "sltu": (0, 3), "xor": (0, 4), "srl": (0, 5), "sra": (32, 5), "or": (0, 6), "and": (0, 7)}
I_OPS = {"addi": 0, "slti": 2, "sltiu": 3, "xori": 4, "ori": 6, "andi": 7}
SHIFTS = {"slli": (0, 1), "srli": (0, 5), "srai": (32, 5)}
LOADS = {"lb": (0, 1), "lh": (1, 2), "lw": (2, 4), "lbu": (4, 1), "lhu": (5, 2)}
STORES = {"sb": (0, 1), "sh": (1, 2), "sw": (2, 4)}
BRANCHES = {"beq": 0, "bne": 1, "blt": 4, "bge": 5, "bltu": 6, "bgeu": 7}


def enc_r(op, rd, rs1, rs2):
    f7, f3 = R_OPS[op]
    return (f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | 0x33


def enc_i(opcode, f3, rd, rs1, imm):
    return ((imm & 0xFFF) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | opcode


def enc_s(f3, rs1, rs2, imm):
    imm &= 0xFFF
    return ((imm >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((imm & 31) << 7) | 0x23


def enc_b(f3, rs1, rs2, imm):
    imm &= 0x1FFF
    return (((imm >> 12) & 1) << 31) | (((imm >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (((imm >> 1) & 0xF) << 8) | (((imm >> 11) & 1) << 7) | 0x63


def enc_j(rd, imm):
    imm &= 0x1FFFFF
    return (((imm >> 20) & 1) << 31) | (((imm >> 1) & 0x3FF) << 21) | (((imm >> 11) & 1) << 20) | (((imm >> 12) & 0xFF) << 12) | (rd << 7) | 0x6F


def value():
    return rng.choice(EDGE) if rng.random() < 0.4 else rng.getrandbits(32)


def reg_id(i):
    return rc.UC_RISCV_REG_X0 + i


def fresh():
    uc = Uc(UC_ARCH_RISCV, UC_MODE_RISCV32)
    uc.mem_map(0, MEM, UC_PROT_ALL)
    return uc


def step_once(word, pc, regs, mem=None):
    """One instruction on a fresh core. Returns every register, the pc, and the watched memory."""
    uc = fresh()
    uc.mem_write(pc, word.to_bytes(4, "little"))
    if mem:
        uc.mem_write(mem[0], bytes(mem[1]))
    for i, v in regs.items():
        uc.reg_write(reg_id(i), v)
    uc.emu_start(pc, 0xFFFFFFF0, count=1)
    after = {}
    for i in range(1, 32):
        v = uc.reg_read(reg_id(i)) & 0xFFFFFFFF
        if v:
            after[str(i)] = v
    out = {"r": after, "pc": uc.reg_read(rc.UC_RISCV_REG_PC) & 0xFFFFFFFF}
    if mem:
        out["m"] = list(uc.mem_read(mem[0], len(mem[1])))
    return out


md = capstone.Cs(capstone.CS_ARCH_RISCV, capstone.CS_MODE_RISCV32)


def text_of(word):
    got = list(md.disasm(word.to_bytes(4, "little"), 0))
    if not got:
        return None
    return f"{got[0].mnemonic} {got[0].op_str}".strip()


def regs3():
    rd, rs1, rs2 = rng.randrange(32), rng.randrange(32), rng.randrange(32)
    regs = {}
    if rs1:
        regs[rs1] = value()
    if rs2:
        regs[rs2] = value() if rs2 != rs1 else regs[rs1]
    return rd, rs1, rs2, regs


PER_OP = int(os.environ.get("PER_OP", "60"))
cases = []


def add(op, word, pc, regs, mem=None):
    case = {"op": op, "w": word, "pc": pc, "r": {str(k): v for k, v in regs.items()}, "text": text_of(word), "after": step_once(word, pc, regs, mem)}
    if mem:
        case["m"] = [mem[0], list(mem[1])]
    cases.append(case)


for op in R_OPS:
    for _ in range(PER_OP):
        rd, rs1, rs2, regs = regs3()
        add(op, enc_r(op, rd, rs1, rs2), 0x1000, regs)
for op, f3 in I_OPS.items():
    for _ in range(PER_OP):
        rd, rs1, _, regs = regs3()
        imm = rng.choice([-2048, 2047, -1, 0, 1, rng.randint(-2048, 2047)])
        add(op, enc_i(0x13, f3, rd, rs1, imm), 0x1000, regs)
for op, (f7, f3) in SHIFTS.items():
    for _ in range(PER_OP):
        rd, rs1, _, regs = regs3()
        add(op, enc_i(0x13, f3, rd, rs1, (f7 << 5) | rng.randrange(32)), 0x1000, regs)
for op, (f3, size) in LOADS.items():
    for _ in range(PER_OP):
        rd, rs1, _, _ = regs3()
        rs1 = rs1 or 5
        imm = rng.randint(-2048, 2047)
        addr = rng.randrange(0x3000, 0x6000, size)
        base = (addr - imm) & 0xFFFFFFFF
        add(op, enc_i(0x03, f3, rd, rs1, imm), 0x1000, {rs1: base}, (addr, [rng.getrandbits(8) for _ in range(size)]))
for op, (f3, size) in STORES.items():
    for _ in range(PER_OP):
        rs1, rs2 = rng.randint(1, 31), rng.randint(1, 31)
        imm = rng.randint(-2048, 2047)
        addr = rng.randrange(0x3000, 0x6000, size)
        regs = {rs2: value(), rs1: (addr - imm) & 0xFFFFFFFF}
        if rs1 == rs2:
            # The address and the data are the same register here, so this case has to use it for both.
            regs = {rs1: 0x3000}
            imm = 0
            addr = 0x3000
        add(op, enc_s(f3, rs1, rs2, imm), 0x1000, regs, (addr, [0xAA] * size))
for op, f3 in BRANCHES.items():
    for _ in range(PER_OP):
        _, rs1, rs2, regs = regs3()
        imm = rng.randrange(-1024, 1024) * 4
        add(op, enc_b(f3, rs1, rs2, imm), 0x4000, regs)
for _ in range(PER_OP):
    rd = rng.randrange(32)
    add("jal", enc_j(rd, rng.randrange(-4000, 4000) * 4), 0x8000, {})
for _ in range(PER_OP):
    rd, rs1 = rng.randrange(32), rng.randint(1, 31)
    imm = rng.randint(-2048, 2047)
    target = rng.randrange(0x3000, 0x6000, 4)
    # The low bit of the sum is cleared by jalr, so it's sometimes set here to check that.
    base = (target - imm + rng.randrange(2)) & 0xFFFFFFFF
    add("jalr", enc_i(0x67, 0, rd, rs1, imm), 0x1000, {rs1: base})
for _ in range(PER_OP):
    rd, _, _, _ = regs3()
    add("lui", (rng.getrandbits(20) << 12) | (rd << 7) | 0x37, 0x1000, {})
for _ in range(PER_OP):
    rd, _, _, _ = regs3()
    add("auipc", (rng.getrandbits(20) << 12) | (rd << 7) | 0x17, rng.randrange(0x1000, 0xF000, 4), {})


def random_program(n):
    """Straight-line work with forward branches, run to its end on one core."""
    words = []
    for i in range(n):
        kind = rng.random()
        # x1 stays the base of a scratch area, so loads and stores can't wander off it.
        rd, rs1, rs2 = rng.randint(2, 31), rng.randint(1, 31), rng.randint(1, 31)
        if kind < 0.45:
            words.append(enc_r(rng.choice(list(R_OPS)), rd, rs1, rs2))
        elif kind < 0.65:
            words.append(enc_i(0x13, rng.choice(list(I_OPS.values())), rd, rs1, rng.randint(-2048, 2047)))
        elif kind < 0.75:
            f7, f3 = SHIFTS[rng.choice(list(SHIFTS))]
            words.append(enc_i(0x13, f3, rd, rs1, (f7 << 5) | rng.randrange(32)))
        elif kind < 0.85:
            f3, size = rng.choice(list(LOADS.values()))
            words.append(enc_i(0x03, f3, rd, 1, rng.randrange(0, 256, size)))
        elif kind < 0.93:
            f3, size = rng.choice(list(STORES.values()))
            words.append(enc_s(f3, 1, rs2, rng.randrange(0, 256, size)))
        else:
            left = n - i - 1
            skip = rng.randint(1, max(1, min(left, 5)))
            words.append(enc_b(rng.choice(list(BRANCHES.values())), rs1, rs2, 4 * skip))
    return words


programs = []
for _ in range(int(os.environ.get("PROGRAMS", "40"))):
    words = random_program(60)
    code = b"".join(w.to_bytes(4, "little") for w in words)
    init = {i: value() for i in range(2, 32)}
    init[1] = 0x3000
    mem = [rng.getrandbits(8) for _ in range(256)]
    uc = fresh()
    uc.mem_write(0x1000, code)
    uc.mem_write(0x3000, bytes(mem))
    for i, v in init.items():
        uc.reg_write(reg_id(i), v)
    end = 0x1000 + len(code)
    uc.emu_start(0x1000, end)
    regs_after = [uc.reg_read(reg_id(i)) & 0xFFFFFFFF for i in range(32)]
    programs.append({"words": words, "regs": [0] + [init[i] for i in range(1, 32)], "mem": mem, "after": regs_after, "memAfter": list(uc.mem_read(0x3000, 256))})

out = {
    "tool": {"unicorn": unicorn.__version__, "capstone": capstone.__version__, "seed": SEED},
    "cases": cases,
    "programs": programs,
}
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures", "rv32-unicorn.json")
with open(path, "w", encoding="utf-8") as f:
    json.dump(out, f, separators=(",", ":"))
    f.write("\n")
print(f"{len(cases)} single-instruction cases, {len(programs)} programs, {os.path.getsize(path)} bytes", file=sys.stderr)
print(sorted({c['op'] for c in cases}), file=sys.stderr)
print([c["text"] for c in cases[::240]][:24], file=sys.stderr)
