/** Pure helpers of the review technique: commit messages, the read-only VS Code settings and names. */
import type { Language } from '../../../shared/types.ts';

/** Fixed (not translated): it is a technical commit the player normally never sees. */
export const WIP_MESSAGE = 'Bug Detective: work in progress saved automatically';

const MESSAGES: Record<Language, { approved: string; reference: string; snapshot: string; edits: string }> = {
  en: {
    approved: 'Approved by QA — ticket {n}',
    reference: 'Reference — ticket {n}',
    snapshot: 'Your approved solution — ticket {n}',
    edits: 'Changes made while viewing the review — ticket {n}',
  },
  pt: {
    approved: 'Aprovada no QA — ticket {n}',
    reference: 'Referência — ticket {n}',
    snapshot: 'Sua solução aprovada — ticket {n}',
    edits: 'Alterações feitas durante o review — ticket {n}',
  },
};

export function reviewMessages(language: Language, ticket: number) {
  const fill = (template: string) => template.replace('{n}', String(ticket));
  const messages = MESSAGES[language];
  return { approved: fill(messages.approved), reference: fill(messages.reference), snapshot: fill(messages.snapshot), edits: fill(messages.edits) };
}

const READ_ONLY = { 'files.readonlyInclude': { '**': true } };

/** Removes // and /* *\/ comments and trailing commas outside strings (VS Code settings are JSONC). */
function stripJsonc(text: string): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = /"(?:[^"\\]|\\.)*"/y;
      end.lastIndex = index;
      const match = end.exec(text);
      const literal = match ? match[0] : text.slice(index);
      out += literal;
      index += literal.length - 1;
    } else if (text.startsWith('//', index)) {
      const newline = text.indexOf('\n', index);
      index = newline === -1 ? text.length : newline - 1;
    } else if (text.startsWith('/*', index)) {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? text.length : close + 1;
    } else {
      out += char;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * The .vscode/settings.json of both review commits: the project's own settings (from the reference),
 * if any and readable, with every file made read-only in the editor.
 */
export function readOnlySettings(projectSettings: string | null): string {
  let settings: Record<string, unknown> = {};
  if (projectSettings) {
    try {
      const parsed: unknown = JSON.parse(stripJsonc(projectSettings));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      }
    } catch {
      // Unreadable settings: the review still opens, read-only, without them.
    }
  }
  return `${JSON.stringify({ ...settings, ...READ_ONLY }, null, 2)}\n`;
}

/** A compact UTC timestamp for review-edits/ticket-N-<stamp>, e.g. 20261028T121500Z. */
export function editsStamp(iso: string): string {
  return iso.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}
