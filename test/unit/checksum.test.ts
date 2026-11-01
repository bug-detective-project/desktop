import { describe, expect, it } from 'vitest';
import { readTar, readZip, safeRelativePath, sha256Hex, textFile, treeDigest, UnsafeArchiveError, writeTar, writeZip } from '../../src/main/services/content/archive.ts';
import { ContentVerificationError } from '../../src/main/services/content/manifest.ts';
import type { TicketEntry } from '../../src/main/services/content/manifest.ts';
import { verifyTicket } from '../../src/main/services/content/source.ts';

const packageFiles = [textFile('ticket.en.md', '# SD-214\n'), textFile('gate2/ticket-1.spec.ts', 'test()\n')];
const codeFiles = [textFile('package.json', '{}\n'), textFile('client/src/App.tsx', 'export {}\n')];

const entry: TicketEntry = {
  id: 'front-1',
  track: 'front',
  order: 1,
  branch: 'front-1',
  tag: 'front-1-v1.0.0',
  commit: 'a'.repeat(40),
  commitMessage: 'SupportDesk release front-1',
  codeDigest: treeDigest(codeFiles),
  codeFiles: codeFiles.length,
  package: { path: 'tickets/front-1', files: packageFiles.length, digest: treeDigest(packageFiles) },
};
const ticket = { counts: { front: 4, back: 0 }, manifestVersion: '1.0.0', entry, packageFiles, codeFiles };

describe('tree digest', () => {
  it('does not depend on file order or archive format', async () => {
    expect(treeDigest([...codeFiles].reverse())).toBe(treeDigest(codeFiles));
    expect(treeDigest(await readTar(await writeTar(codeFiles)))).toBe(treeDigest(codeFiles));
    expect(treeDigest(readZip(writeZip(codeFiles)))).toBe(treeDigest(codeFiles));
  });

  it('changes when a byte, a path or a line ending changes', () => {
    const digest = treeDigest(codeFiles);
    expect(treeDigest([textFile('package.json', '{} \n'), codeFiles[1]])).not.toBe(digest);
    expect(treeDigest([textFile('package.json', '{}\r\n'), codeFiles[1]])).not.toBe(digest);
    expect(treeDigest([textFile('package2.json', '{}\n'), codeFiles[1]])).not.toBe(digest);
  });

  it('writes deterministic zips', () => {
    expect(sha256Hex(writeZip(packageFiles))).toBe(sha256Hex(writeZip([...packageFiles].reverse())));
  });
});

describe('verification', () => {
  it('accepts content that matches the manifest', () => {
    expect(() => verifyTicket(ticket)).not.toThrow();
  });

  it('rejects ticket code that differs from the manifest', () => {
    const changed = [codeFiles[0], textFile('client/src/App.tsx', 'export const x = 1;\n')];
    expect(() => verifyTicket({ ...ticket, codeFiles: changed })).toThrow(/ticket code/);
    expect(() => verifyTicket({ ...ticket, codeFiles: [codeFiles[0]] })).toThrow(/ticket code/);
  });

  it('rejects package contents that differ from the manifest', () => {
    expect(() => verifyTicket({ ...ticket, packageFiles: [textFile('ticket.en.md', '# changed\n'), packageFiles[1]] })).toThrow(ContentVerificationError);
    expect(() => verifyTicket({ ...ticket, packageFiles: [packageFiles[0]] })).toThrow(/package/);
  });
});

describe('archive path safety', () => {
  it('rejects paths that could escape the target folder', () => {
    for (const path of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/Windows/x', 'a\\b', 'a//b', '']) {
      expect(() => safeRelativePath(path), path).toThrow(UnsafeArchiveError);
    }
    expect(safeRelativePath('./client/src/App.tsx')).toBe('client/src/App.tsx');
  });

  it('strips the single top-level folder of GitHub archives', () => {
    const github = writeZip(codeFiles.map((file) => ({ ...file, path: `supportdesk-stage-1/${file.path}` })));
    expect(readZip(github, { stripTopDirectory: true }).map((file) => file.path).sort()).toEqual(['client/src/App.tsx', 'package.json']);
    expect(() => readZip(writeZip(codeFiles), { stripTopDirectory: true })).toThrow(UnsafeArchiveError);
  });
});

describe('zip bombs', () => {
  const bomb = () => writeZip([{ path: 'zeros.bin', data: new Uint8Array(10 * 1024 * 1024), executable: false }]);

  it('refuses an archive larger than the limit when extracted, before inflating it', () => {
    const zip = bomb();
    expect(zip.length).toBeLessThan(100 * 1024);
    expect(() => readZip(zip, { maxBytes: 1024 * 1024 })).toThrow(UnsafeArchiveError);
    expect(readZip(zip)[0].data.length).toBe(10 * 1024 * 1024);
  });

  it('refuses an archive with too many files', () => {
    const zip = writeZip([1, 2, 3].map((n) => textFile(`file-${n}.txt`, 'x')));
    expect(() => readZip(zip, { maxEntries: 2 })).toThrow(/too large when extracted/);
  });

  it('trusts no declared size: a header claiming 4 GB is refused, not allocated', () => {
    const zip = new Uint8Array(writeZip([textFile('a.txt', 'hello')]));
    const view = new DataView(zip.buffer);
    // The central directory entry (signature 0x02014b50) keeps the uncompressed size at offset 24.
    const central = zip.findIndex((_, index) => index + 4 <= zip.length && view.getUint32(index, true) === 0x02014b50);
    view.setUint32(central + 24, 0xf0000000, true);
    expect(() => readZip(zip)).toThrow(UnsafeArchiveError);
  });
});
