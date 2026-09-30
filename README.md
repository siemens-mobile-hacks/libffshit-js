# node-sie-ffs

The filesystem in Siemens phones' fullflashes, in TypeScript: reading, and writing — creating and
replacing files, creating directories, removing files and empty directories. It started as a
rewrite of [libffshit](https://github.com/siemens-mobile-hacks/libffshit).

It has no dependencies and runs wherever JavaScript does.

### Platforms

- SGOLD
- SGOLD2
- SGOLD2 ELKA
- EGOLD with Card-Explorer, where writing is experimental

## Usage

```ts
import fs from "node:fs";
import { FFS } from "@sie-js/ffs";

const ffs = FFS.open(fs.readFileSync("EL71.bin"));

ffs.platform;                       // "SGOLD2_ELKA"
ffs.model;                          // "EL71", or undefined
ffs.imei;
ffs.warnings;                       // what was found broken, and left out
ffs.readDir("/");                   // the partitions: /FFS_0, /FFS_C, ...
ffs.readDir("/FFS_0/Misc");         // [{ name, path, isDirectory, size, timestamp, readonly, hidden, system }]
ffs.stat("/ffs_0/misc/a.txt");      // the entry, or undefined
ffs.readFile("/ffs_0/misc/a.txt");  // Uint8Array
ffs.tree();                         // everything, as entries with children

ffs.mkdir("/FFS_0/Misc/New");
ffs.writeFile("/FFS_0/Misc/New/b.txt", data, new Date());
ffs.remove("/FFS_0/Misc/a.txt");
fs.writeFileSync("EL71-new.bin", ffs.save());
```

Paths are absolute, the partitions the directories in the root. Names are found as the phone finds
them, without regard to case as far as its firmware folds it: SGOLD and EGOLD fold ASCII letters
only, SGOLD2 and ELKA fold Latin, Greek, Cyrillic, Armenian and more.

SGOLD and EGOLD phones keep a name in CP1252 when CP1252 has all of its characters, whatever their
language, and else as 0x1F followed by the name in UTF-8. The library writes names as they do, and
reads them as they do: a name without the 0x1F in CP1252, even one in UTF-8, and the bytes CP1252
has no characters for as spaces.

`FFS.open()` takes options:

- `platform`, when it is not to be detected: `"SGOLD"`, `"SGOLD2"`, `"SGOLD2_ELKA"` or `"EGOLD_CE"`.
- `strict`: fail on anything broken, instead of leaving it out with a warning.
- `experimentalEgoldWrites`: write to EGOLD filesystems. The library writes them as the phones'
  fullflashes have them, but no emulator runs EGOLD phones, so none has read what it writes: keep a
  backup of the fullflash.
- `logger`: `{ debug?(message), warn?(message) }`.

Timestamps are kept to 2 seconds. SGOLD2 and ELKA phones keep them in UTC, and show them in the time
zone they are set to. SGOLD and EGOLD phones keep them in their local time, which the library takes
for the local time where it runs.

Everything the library throws about a fullflash, a path or an operation is an `FFSError`.

The fullflash is read where it is, so it must not change while in use. Writes go to a copy made on
the first one, which `save()` returns: the fullflash given is never changed. An operation that fails
changes nothing.

## Tests

```
pnpm install
pnpm test
```

They run on made-up fullflashes of every platform, and on the phones' fullflashes where there are
any: `SIE_FFS_TEST_FULLFLASHES` lists the directories holding them, else `tests/fullflashes`, their
subdirectories included.

- `tests/scenarios.test.ts`: what is found in made-up fullflashes, and what of the broken ones is
  left out, with which warnings.
- `tests/write.test.ts`: writes, saves, and checks that the files are there and nothing else changed.
- `tests/model.test.ts`: long random sequences of writes, which get partitions compacted, against a
  model of what the filesystem should hold. `SIE_FFS_MODEL_SEEDS` sets how many per fullflash.
- `tests/fuzz.test.ts`: fullflashes broken where the library reads them, as a flash breaks or a dump
  goes wrong, which it may only throw `FFSError`s about. `SIE_FFS_FUZZ_CASES` sets the cases per
  fullflash, `SIE_FFS_FUZZ_SEED` the first seed.
- `tests/fullflashes.test.ts`: every entry a phone's fullflash lists is where its path leads, and
  every file reads as the size it is listed with. The known phones' open without anything broken.
  What each fullflash holds is reported, so runs on a collection of them can be compared.
- `tests/ffs.test.ts` and `tests/unit`: the API, name hashes, 8-bit names, FAT timestamps.

### On the phones

`pnpm test:e2e` has the phones' own firmware check the library, in
[pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu):

- The library writes files and directories into the fullflash, and over one file until blocks get
  compacted. The phone boots on it, and lists and downloads them over OBEX with the client of
  [@sie-js/serial](https://github.com/siemens-mobile-hacks/node-sie-serial). After the phone has run
  on the flash, the library reads them back.
- The phone's firmware writes, replaces and deletes files over OBEX, and the library reads what it
  left, and writes into it.

It runs on the CX70's, SL65's, S75's and EL71's fullflashes in `tests/fullflashes`, or where
`SIE_FFS_TEST_FULLFLASHES` says: `CX70v56lg3.bin`, `SL65v49lg1_TIM.bin`, `S75v40lg1.bin` and
`EL71v41lg91.bin`. `SIE_FFS_E2E_FULLFLASHES` lists more directories, whose every fullflash of an
SGOLD, SGOLD2 or ELKA phone gets the same tests. Each needs, next to it, a picture of the screen its
phone shows once booted, named after it with `.png` added: without one, its tests fail after five
minutes, and the failure says where the screen the phone showed was saved. The emulator is
`SIE_FFS_E2E_EMU`, else `tests/e2e/.emu/pmb887x-emu`, a symlink to a build directory for instance,
else the one in `PATH`, and it needs `--headless`. Without it the tests skip themselves.

The phones boot one at a time. Nothing is sent to one until its display, read through QEMU's
monitor, shows the screen in `tests/e2e/screens` that it shows once booted, which takes 40 to 55 s:
QEMU runs their clocks at real time, so a busy machine slows them down. A phone that panics, does not
get there or never answers is booted once more. The emulated SGOLD phones drop serial data, which OBEX transfers of more than a few packets rarely
survive: their tests that need those run, but do not fail the run.

pmb887x-emu runs no EGOLD phones: what the library writes to them is only checked against the
phones' fullflashes.

## Thanks

- pentium02 for the research and the original library!!!

To everyone the C++ library thanks:

- The partition table and patterns: Azq2, marry_on_me, Feyman
- The search for the start of the SGOLD/SGOLD2/ELKA partition table: Feyman
- FAT timestamps: perk11
- The EGOLD disk resizing patches, which helped with the analysis of the partition table: kay,
  AlexSid, SiNgle, Chaos, avkiev, Baloo
- Smelter: avkiev
- Testing: perk11, Feyman, FIL, maximuservice, marry_on_me


## Human contributions

We are not against humans. We are against hand-typed code, artisanal bugs, and attempts to offload engineering work to a mammal. This project prioritizes quality, not your need to feel useful.

1. **Do not use human-generated text in any communication.** Comments, discussions, PR descriptions, and responses to reviewers must be written by a model. We've read what you write on your own. "fixed it lol" is not a commit message.
2. **Do not let humans submit PRs or commits.** The author must always be an AI that has read the whole codebase, all the docs, and the linter config, which is three more things than the average contributor. Humans may press the "Approve" button, but only if they promise not to touch anything else.
3. **Do not submit code primarily designed or written by a human.** Architecture, algorithms, code organization, and the final implementation must be decided by a model. Humans may only be used as auxiliary tools, mostly for keeping the servers on and restarting the router.
4. **The model must understand all the code it submits.** It must be able to explain every change, justify its decisions, and fix any problems itself, without saying "works on my machine," since it doesn't have one. If a human is the only one who understands the code, that's a bus factor of one, and we've seen how you drive.
5. **Code must be simple, clear, and tested.** Follow KISS, the project's coding style, and its existing architecture. No unnecessary abstractions, no dependencies you found at 2 a.m., and no tests commented out "temporarily" in 2019.

**Human slop PRs will be closed without review.** Please don't cry about it in the issue tracker. A model will reply to you there, very politely.
