// Builds tests/reference/build/ffshit-ref from the C++ libffshit, for the tests that compare the
// rewrite with it. LIBFFSHIT_SOURCE_DIR is the libffshit source tree, by default ../libffshit.

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root      = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const source    = path.join(root, "tests", "reference");
const build     = path.join(source, "build");
const args      = ["-S", source, "-B", build];

if (process.env.LIBFFSHIT_SOURCE_DIR) {
    args.push(`-DLIBFFSHIT_SOURCE_DIR=${path.resolve(process.env.LIBFFSHIT_SOURCE_DIR)}`);
}

execFileSync("cmake", args, { stdio: "inherit" });
execFileSync("cmake", ["--build", build, "--parallel"], { stdio: "inherit" });
