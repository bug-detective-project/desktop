/**
 * The installation's own secret: 32 random bytes in <userData>/install-key, created on first use.
 * Saves are signed with it (an HMAC in their manifest), so a restore can tell a save made by this
 * installation from one that came from another computer, which brings code that will run in the
 * workspace.
 */
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from './content/store.ts';

export const INSTALL_KEY_FILE = 'install-key';
const KEY_BYTES = 32;

/** Reads the key, creating it the first time. A damaged file is replaced by a new key (older saves then count as foreign). */
export async function loadInstallKey(userData: string): Promise<Uint8Array> {
  const file = join(userData, INSTALL_KEY_FILE);
  try {
    const text = (await readFile(file, 'utf8')).trim();
    if (/^[0-9a-f]{64}$/.test(text)) {
      return Buffer.from(text, 'hex');
    }
  } catch {
    // Not there yet.
  }
  const key = randomBytes(KEY_BYTES);
  await writeFileAtomic(file, `${key.toString('hex')}\n`);
  return key;
}
