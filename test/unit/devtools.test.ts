import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ session: {} }));
const { isDevToolsShortcut } = await import('../../src/main/devtools.ts');

const key = (key: string, modifiers: Partial<{ control: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}, type = 'keyDown') => ({
  type,
  key,
  control: false,
  meta: false,
  shift: false,
  alt: false,
  ...modifiers,
});

describe('DevTools shortcuts', () => {
  it('opens DevTools with F12, Ctrl+Shift+I and Cmd+Option+I', () => {
    expect(isDevToolsShortcut(key('F12'))).toBe(true);
    expect(isDevToolsShortcut(key('I', { control: true, shift: true }))).toBe(true);
    expect(isDevToolsShortcut(key('i', { meta: true, alt: true }))).toBe(true);
  });

  it('ignores other keys, plain I, Ctrl+I and key releases', () => {
    expect(isDevToolsShortcut(key('i'))).toBe(false);
    expect(isDevToolsShortcut(key('i', { control: true }))).toBe(false);
    expect(isDevToolsShortcut(key('F11'))).toBe(false);
    expect(isDevToolsShortcut(key('F12', {}, 'keyUp'))).toBe(false);
  });
});
