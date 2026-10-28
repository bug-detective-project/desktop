/** Parses unified diffs (git diff, reference.patch) for DiffView. */

export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk';
  text: string;
  oldNumber?: number;
  newNumber?: number;
}

export interface DiffFile {
  /** Path on the new side (the old one for a deleted file). */
  path: string;
  oldPath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  binary: boolean;
  lines: DiffLine[];
}

/** Parses a unified diff (git diff / reference.patch) into files and lines. */
export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      file = { path: header[2], oldPath: header[1], status: 'modified', binary: false, lines: [] };
      files.push(file);
      continue;
    }
    if (!file) {
      continue;
    }
    if (file.lines.length === 0) {
      if (line.startsWith('new file mode')) {
        file.status = 'added';
      } else if (line.startsWith('deleted file mode')) {
        file.status = 'deleted';
      } else if (line.startsWith('rename from ')) {
        file.status = 'renamed';
      } else if (line.startsWith('Binary files ')) {
        file.binary = true;
      }
    }
    if (/^(index |--- |\+\+\+ |new file mode|deleted file mode|similarity|rename |old mode|new mode|Binary files |\\ No newline)/.test(line)) {
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      file.lines.push({ kind: 'hunk', text: line });
    } else if (line.startsWith('+')) {
      file.lines.push({ kind: 'add', text: line.slice(1), newNumber: newLine++ });
    } else if (line.startsWith('-')) {
      file.lines.push({ kind: 'del', text: line.slice(1), oldNumber: oldLine++ });
    } else if (line.startsWith(' ')) {
      file.lines.push({ kind: 'context', text: line.slice(1), oldNumber: oldLine++, newNumber: newLine++ });
    }
  }
  return files;
}

export function changedLines(file: DiffFile): { added: number; removed: number } {
  return {
    added: file.lines.filter((line) => line.kind === 'add').length,
    removed: file.lines.filter((line) => line.kind === 'del').length,
  };
}

export interface SplitCell {
  number?: number;
  text: string;
  /** del and add are the changed lines of each side; empty fills the side without a counterpart. */
  kind: 'context' | 'del' | 'add' | 'empty';
}

export type SplitRow = { kind: 'hunk'; text: string } | { kind: 'line'; left: SplitCell; right: SplitCell };

const EMPTY: SplitCell = { text: '', kind: 'empty' };

/**
 * Aligns a file's unified diff in two columns, like a split pull-request view: context lines on
 * both sides, and each run of removed lines paired with the added lines that follow it.
 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let removed: DiffLine[] = [];
  let added: DiffLine[] = [];
  const flush = () => {
    for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
      const left = removed[index];
      const right = added[index];
      rows.push({
        kind: 'line',
        left: left ? { number: left.oldNumber, text: left.text, kind: 'del' } : EMPTY,
        right: right ? { number: right.newNumber, text: right.text, kind: 'add' } : EMPTY,
      });
    }
    removed = [];
    added = [];
  };
  for (const line of lines) {
    if (line.kind === 'del') {
      if (added.length > 0) flush();
      removed.push(line);
    } else if (line.kind === 'add') {
      added.push(line);
    } else {
      flush();
      rows.push(
        line.kind === 'hunk'
          ? { kind: 'hunk', text: line.text }
          : {
              kind: 'line',
              left: { number: line.oldNumber, text: line.text, kind: 'context' },
              right: { number: line.newNumber, text: line.text, kind: 'context' },
            },
      );
    }
  }
  flush();
  return rows;
}

/** Files to list: a file whose remaining differences were all whitespace (no hunks left) is hidden. */
export function visibleFiles(files: DiffFile[]): DiffFile[] {
  return files.filter((file) => file.status !== 'modified' || file.binary || file.lines.length > 0);
}
