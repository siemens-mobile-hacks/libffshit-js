# libffshit-js

A TypeScript rewrite of [libffshit](https://github.com/siemens-mobile-hacks/libffshit), the library
for the filesystem in Siemens phones' fullflashes: reading, and writing — creating and replacing
files, creating directories, removing files and empty directories.

It has no dependencies and runs wherever JavaScript does. Next to the WebAssembly build of the C++
library it replaces, it opens a fullflash 4 to 14 times faster in a fraction of the memory.

### Platforms

- SGOLD
- SGOLD2
- SGOLD2 ELKA
- EGOLD with Card-Explorer, read only

## Usage

`FFS` is the API of `@sie-js/libffshit`, the WebAssembly build: paths are absolute and found
without regard to the case of ASCII letters.

```ts
import fs from "node:fs";
import { FFS } from "@sie-js/libffshit-js";

const ffs = new FFS();

await ffs.open(fs.readFileSync("EL71.bin"));

ffs.getPlatform();                  // "SGOLD2_ELKA"
ffs.getModel();                     // "EL71"
ffs.getWarnings();                  // what was skipped as broken
ffs.readDir("/FFS_0/Misc");         // [{ name, path, size, timestamp, isFile, isDirectory, ... }]
ffs.readFile("/ffs_0/misc/a.txt");  // Buffer, or undefined
ffs.getFilesTree();

// Writing, which the WebAssembly build does not offer
ffs.mkdir("/FFS_0/Misc/New");
ffs.writeFile("/FFS_0/Misc/New/b.txt", data, new Date());
ffs.remove("/FFS_0/Misc/a.txt");
fs.writeFileSync("EL71-new.bin", ffs.getFullflash());
```

`open()` takes the options of the WebAssembly build — `platform`, `skipBroken`, `skipDuplicates`,
`isOldSearchAlgorithm`, `searchStartAddress`, `debug`, `verbose*` — and `codepage`, the codepage
SGOLD names are in: CP1252 by default, CP1251 for Cyrillic languages, CP1250 for Central European
ones.

The buffer is used as it is, so it must not change while it is open. Writes go to a copy made on
the first one: the buffer passed in is never changed. `FFS` returns files as `Buffer`s, as the
WebAssembly build does, which in a browser takes a `Buffer` polyfill; the classes below use
`Uint8Array` only.

The classes of the C++ library are there too, for more control:

```ts
import { FullFlash, buildFilesystem, Logger } from "@sie-js/libffshit-js";

Logger.init({ onInfo: console.log, onWarning: console.warn, onError: console.error, onDebug() {} });

const fullflash = new FullFlash(data);          // or new FullFlash(data, "SGOLD2")

fullflash.loadPartitions();

const partitions = fullflash.getPartitions()!;
const filesystem = buildFilesystem(partitions.getFsPlatform(), partitions);

filesystem.setCodepage("CP1251");
filesystem.load(/* skipBroken */ true, /* skipDup */ true);

filesystem.getRoot().getSubdirs();              // the partitions: FFS_0, FFS_1, ...
filesystem.writeFile("FFS_0/Misc/a.txt", bytes, new Date());
fullflash.save();                               // the fullflash, as it was read in
```

Errors are `FullflashError`, `PartitionsError` and `FilesystemError`, all `BaseError`s, as the
C++ library's exceptions are.

## Behavior

The rewrite does what the C++ library at
[`79d0702`](https://github.com/siemens-mobile-hacks/libffshit/commit/79d0702) does, down to the
messages it logs and throws: the same partitions and blocks, the same files with the same names,
attributes, timestamps and content, the same broken files skipped with the same warnings, and on
writing, a byte for byte identical fullflash. Its C++ quirks included: e.g. ids keyed as 16 bits,
names that `iconv` fails to convert because the C++ library gives it too small a buffer, ELKA
headers without a name failing to read.

It differs where the C++ library's behavior is undefined, or glibc's is not reproducible:

- Codepages are glibc's single-byte ones (CP1250–CP1254, CP1256, CP1257, CP874, ISO-8859-*,
  KOI8-R, KOI8-U, CP437, CP850, CP852, CP855, CP857, CP866, ASCII) and UTF-8, by the names `iconv`
  knows them by. `iconv` knows more, e.g. multi-byte ones, and CP1255 and CP1258, which it composes
  combining marks in.
- A FAT timestamp in the hour that repeats when daylight saving time ends is taken for its first
  occurrence. glibc's `mktime()` takes it for either, depending on what it was asked before.
- Where the C++ library reads memory it does not own, the rewrite reads zeros or fails: blocks
  past the end of a cut fullflash, and the model of a fullflash taken for EGOLD_CE, which the C++
  library reads through an uninitialized offset, and the rewrite where the detection finds it.
- The hex dump of a name that does not convert shows the name; the C++ library's shows freed memory.
- A file whose parts loop throws a `RangeError`, where the C++ library overflows its stack.
- An empty partition last in the map after one that is not is dropped; the C++ library's
  `inspect()` iterates past the end then.
- `Logger.init()` takes effect every time, not only the first.
- `FFS.open()` with a platform that does not exist throws `Unknown platform <name>`.

Strings the C++ library keeps as bytes, e.g. names that do not decode, are read as UTF-8 with
U+FFFD for invalid sequences, as the WebAssembly build returns them.

## Tests

```
pnpm install
pnpm test
```

The tests compare the rewrite with the C++ library and with its WebAssembly build:

- `tests/differential/load.test.ts` loads every fullflash there is in every way — skipping broken
  files or not, with the old search algorithm, from another address, taken for every platform, in
  another codepage, logging verbosely — and compares everything: detection, partitions and their
  blocks, the whole tree with every file's content, every message logged, the errors.
- `tests/differential/write.test.ts` runs the C++ library's write tests and long random sequences
  of writes, which get partitions compacted, and compares the saved fullflashes byte for byte, and
  what every operation threw and logged.
- `tests/differential/fuzz.test.ts` breaks fullflashes where the loaders read — FIT entries,
  records, block headers, the partition table, cut dumps, flipped bits — and compares what both make
  of them.
- `tests/differential/units.test.ts` compares the helpers on large sets of inputs: FAT timestamps
  in time zones with daylight saving time, the name hashes, every codepage, the conversion of UTF-16
  names.
- `tests/differential/synthetic.test.ts` does the same on made-up fullflashes of every platform,
  EGOLD included, with the breakage the loaders cope with. What the C++ library did with them is
  kept in `tests/fixtures/synthetic`, so these run without it.
- `tests/compat/wasm.test.ts` compares `FFS` with the WebAssembly build call by call.
- `tests/write.test.ts`, `tests/ffs.test.ts` and `tests/unit` test the rewrite on its own; the
  first is the C++ library's write tests.

What they need, and skip without:

| | |
|-|-|
| The fullflashes, which are not part of the repository | `FFSHIT_TEST_FULLFLASHES`: directories holding them, or `tests/fullflashes` |
| The C++ library | `pnpm build:reference` builds it from `LIBFFSHIT_SOURCE_DIR`, by default `../libffshit`, into `tests/reference/build`; or `LIBFFSHIT_REF`: `ffshit-ref` built elsewhere |
| The WebAssembly build | `LIBFFSHIT_WASM`: the `@sie-js/libffshit` package, by default `../libffshit` |

`FFSHIT_WRITE_SEEDS` sets how many random sequences of writes the write test runs on each
fullflash, `FFSHIT_FUZZ_CASES` how many broken fullflashes the fuzz test makes of each one,
`FFSHIT_FUZZ_SEED` the first seed, `FFSHIT_FUZZ_KEEP` where to keep those it fails on.
`FFSHIT_UPDATE_GOLDEN=1` updates `tests/fixtures/synthetic` from the C++ library.

`scripts/gen-codepages.c` generates `src/filesystem/codepages.ts` from glibc.

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
