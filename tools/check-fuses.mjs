/** Fails unless the packaged binary has the fuses tools/after-pack.mjs flips: node tools/check-fuses.mjs <binary>. */
import { FuseState, FuseV1Options, getCurrentFuseWire } from '@electron/fuses';

const expected = {
  RunAsNode: FuseState.DISABLE,
  EnableNodeOptionsEnvironmentVariable: FuseState.DISABLE,
  EnableNodeCliInspectArguments: FuseState.DISABLE,
  EnableCookieEncryption: FuseState.ENABLE,
  OnlyLoadAppFromAsar: FuseState.ENABLE,
};

const [binary] = process.argv.slice(2);
if (!binary) {
  console.error('Usage: node tools/check-fuses.mjs <binary>');
  process.exit(1);
}
const wire = await getCurrentFuseWire(binary);
const wrong = Object.entries(expected).filter(([name, state]) => wire[FuseV1Options[name]] !== state);
for (const [name] of wrong) {
  console.error(`${name} is not set as expected`);
}
if (wrong.length > 0) {
  process.exit(1);
}
console.log(`${Object.keys(expected).length} fuses as expected in ${binary}`);
