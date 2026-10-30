import { describe, expect, it } from 'vitest';
import { readTar, readZip, safeRelativePath, sha256Hex, textFile, treeDigest, UnsafeArchiveError, writeTar, writeZip } from '../../src/main/services/content/archive.ts';
import { ContentVerificationError } from '../../src/main/services/content/manifest.ts';
import type { StageEntry } from '../../src/main/services/content/manifest.ts';
import { verifyPackageZip, verifyStage } from '../../src/main/services/content/source.ts';

const packageFiles = [textFile('ticket.en.md', '# SD-214\n'), textFile('gate2/ticket-1.spec.ts', 'test()\n')];
const codeFiles = [textFile('package.json', '{}\n'), textFile('client/src/App.tsx', 'export {}\n')];
const zip = writeZip(packageFiles);

const entry: StageEntry = {
  stage: 1,
  branch: 'stage-1',
  commit: 'a'.repeat(40),
  commitMessage: 'SupportDesk release 1.1',
  codeDigest: treeDigest(codeFiles),
  codeFiles: codeFiles.length,
  package: { file: 'stage-1-v1.0.0.zip', sha256: sha256Hex(zip), size: zip.length, digest: treeDigest(packageFiles) },
};

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
    expect(() => verifyStage({ entry, packageZip: zip, packageFiles: readZip(zip), codeFiles })).not.toThrow();
  });

  it('rejects a package whose bytes differ, before parsing it', () => {
    const tampered = new Uint8Array(zip);
    tampered[tampered.length - 30] ^= 0xff;
    expect(() => verifyPackageZip(entry, tampered)).toThrow(ContentVerificationError);
    expect(() => verifyPackageZip(entry, zip.subarray(0, zip.length - 1))).toThrow(ContentVerificationError);
  });

  it('rejects stage code that differs from the manifest', () => {
    const changed = [codeFiles[0], textFile('client/src/App.tsx', 'export const x = 1;\n')];
    expect(() => verifyStage({ entry, packageZip: zip, packageFiles: readZip(zip), codeFiles: changed })).toThrow(/stage code/);
    expect(() => verifyStage({ entry, packageZip: zip, packageFiles: readZip(zip), codeFiles: [codeFiles[0]] })).toThrow(/stage code/);
  });

  it('rejects package contents that differ from the manifest', () => {
    const other = writeZip([textFile('ticket.en.md', '# changed\n')]);
    const forged = { ...entry, package: { ...entry.package, sha256: sha256Hex(other), size: other.length } };
    expect(() => verifyStage({ entry: forged, packageZip: other, packageFiles: readZip(other), codeFiles })).toThrow(/package contents/);
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
