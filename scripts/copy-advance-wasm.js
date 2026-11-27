// Keep the packaged Token Usage module in step with the Cargo build.
//
// `media/advance_usage.wasm` is committed so a packaged extension is self-contained. When this
// checkout sits beside the Advance checkout (`advance`, or its rename `zero-dx`), refresh it from
// the newest build output; otherwise keep the packaged copy. Like the harness copy, never package a
// stale artifact: if the build is gone, the existing media file still wins.

const fs = require("node:fs");
const path = require("node:path");

const NAME = "advance_usage.wasm";
const extension = path.resolve(__dirname, "..");
const destination = path.join(extension, "media", NAME);

const bases = [
  path.join(extension, "..", "advance", "advance"),
  path.join(extension, "..", "advance"),
  path.join(extension, "..", "..", "advance", "advance"),
  path.join(extension, "..", "zero-dx", "components", "advance-usage"),
  path.join(extension, "..", "..", "zero-dx", "components", "advance-usage"),
  extension,
];

/** The newest `advance_usage.wasm` under any base, mirroring the harness copy. */
function newest() {
  let best;
  for (const profile of ["release", "debug"]) {
    for (const base of bases) {
      const candidate = path.join(base, "target", "wasm32-unknown-unknown", profile, NAME);
      let stamp;
      try {
        stamp = fs.statSync(candidate).mtimeMs;
      } catch {
        continue;
      }
      if (best === undefined || stamp > best.stamp) {
        best = { candidate, stamp };
      }
    }
  }
  return best;
}

const found = newest();
if (found === undefined) {
  if (fs.existsSync(destination)) {
    console.log(`keeping the packaged ${NAME}`);
  } else {
    console.warn(
      `${NAME} was not found, so the Token Usage panel will not start. Build it first:\n` +
        "  cargo build -p advance-usage --target wasm32-unknown-unknown --release",
    );
  }
  process.exit(0);
}

fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.copyFileSync(found.candidate, destination);
const kilobytes = (fs.statSync(destination).size / 1024).toFixed(0);
console.log(`copied ${NAME} (${kilobytes} kB) from ${found.candidate}`);
