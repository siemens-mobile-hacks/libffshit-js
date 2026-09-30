# libffshit-js

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
import { FFS } from "@sie-js/libffshit-js";

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

`FFS.open()` takes options:

- `platform`, when it is not to be detected: `"SGOLD"`, `"SGOLD2"`, `"SGOLD2_ELKA"` or `"EGOLD_CE"`.
- `codepage`, the codepage SGOLD and EGOLD names are in, by any name iconv knows it by: CP1252 by
  default, CP1251 for Cyrillic languages, CP1250 for Central European ones.
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
any: `FFSHIT_TEST_FULLFLASHES` lists the directories holding them, else `tests/fullflashes`, their
subdirectories included.

- `tests/scenarios.test.ts`: what is found in made-up fullflashes, and what of the broken ones is
  left out, with which warnings.
- `tests/write.test.ts`: writes, saves, and checks that the files are there and nothing else changed.
- `tests/model.test.ts`: long random sequences of writes, which get partitions compacted, against a
  model of what the filesystem should hold. `FFSHIT_MODEL_SEEDS` sets how many per fullflash.
- `tests/fuzz.test.ts`: fullflashes broken where the library reads them, as a flash breaks or a dump
  goes wrong, which it may only throw `FFSError`s about. `FFSHIT_FUZZ_CASES` sets the cases per
  fullflash, `FFSHIT_FUZZ_SEED` the first seed.
- `tests/fullflashes.test.ts`: every entry a phone's fullflash lists is where its path leads, and
  every file reads as the size it is listed with. The known phones' open without anything broken.
  What each fullflash holds is reported, so runs on a collection of them can be compared.
- `tests/ffs.test.ts` and `tests/unit`: the API, name hashes, codepages, FAT timestamps.

`scripts/gen-codepages.c` generates `src/filesystem/codepages.ts` from glibc's iconv.

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
