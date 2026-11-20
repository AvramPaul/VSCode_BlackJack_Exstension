import { describe, expect, it } from 'vitest';
import { isInside, normalizePath, Router } from '../../src/claude/router';

describe('normalizePath (win32)', () => {
  it('folds drive-letter case, separators, trailing separators and case', () => {
    // The panel sends `c:\…`, the CLI `C:\…` (spike).
    expect(normalizePath('c:\\Users\\Me\\Proj\\', 'win32')).toBe(normalizePath('C:/users/me/proj', 'win32'));
    expect(normalizePath('C:\\', 'win32')).toBe('c:\\');
    expect(normalizePath('C:\\a\\..\\b', 'win32')).toBe('c:\\b');
  });
  it('keeps non-ASCII paths', () => {
    expect(normalizePath("C:\\Users\\Ana Ștefan\\proiect 'x", 'win32')).toBe("c:\\users\\ana ștefan\\proiect 'x");
  });
});

describe('isInside', () => {
  it('win32: case-insensitive, separator-agnostic, no prefix tricks', () => {
    expect(isInside('c:\\Users\\me\\proj\\spike', 'C:\\Users\\me\\proj', 'win32')).toBe(true);
    expect(isInside('C:\\Users\\me\\proj', 'c:/users/me/proj/', 'win32')).toBe(true);
    expect(isInside('C:\\Users\\me\\project2', 'C:\\Users\\me\\proj', 'win32')).toBe(false);
    expect(isInside('D:\\Users\\me\\proj', 'C:\\Users\\me\\proj', 'win32')).toBe(false);
  });
  it('linux: case-sensitive', () => {
    expect(isInside('/home/me/proj/a', '/home/me/proj', 'linux')).toBe(true);
    expect(isInside('/home/me/Proj/a', '/home/me/proj', 'linux')).toBe(false);
    expect(isInside('/home/me/proj2', '/home/me/proj', 'linux')).toBe(false);
  });
  it('darwin: case-insensitive', () => {
    expect(isInside('/Users/Me/Proj/a', '/Users/me/proj', 'darwin')).toBe(true);
  });
});

describe('Router', () => {
  const id = (p: string) => p;
  const make = (folders: string[]) => new Router('aa11', () => folders, 'win32', id);

  it('rule 1: our window id wins, even outside our folders', () => {
    expect(make([]).decide({ sessionId: 's', window: 'aa11', cwd: 'Z:\\elsewhere' })).toEqual({ mine: true, rule: 'window' });
  });
  it('rule 2: start directory inside a workspace folder', () => {
    const r = make(['C:\\Users\\me\\proj']);
    expect(r.decide({ sessionId: 's', window: '', cwd: 'c:\\Users\\me\\proj' })).toEqual({ mine: true, rule: 'cwd' });
    expect(r.decide({ sessionId: 't', window: 'bb22', cwd: 'C:\\other' })).toEqual({ mine: false, rule: 'none' });
  });
  it('caches per session: a later `cd` out of the workspace keeps the owner', () => {
    const r = make(['C:\\Users\\me\\proj']);
    r.decide({ sessionId: 's', window: '', cwd: 'C:\\Users\\me\\proj' });
    expect(r.decide({ sessionId: 's', window: '', cwd: 'C:\\Users\\me' })).toEqual({ mine: true, rule: 'cached' });
  });
  it('prefers the registry start directory over the current cwd', () => {
    const r = make(['C:\\Users\\me\\proj']);
    expect(r.decide({ sessionId: 's', window: '', cwd: 'C:\\Users\\me', startCwd: 'c:\\Users\\me\\proj' }).mine).toBe(true);
  });
  it('without any cwd, decides nothing and caches nothing', () => {
    const r = make(['C:\\p']);
    expect(r.decide({ sessionId: 's', window: '' })).toEqual({ mine: false, rule: 'none' });
    expect(r.decide({ sessionId: 's', window: '', cwd: 'C:\\p\\x' }).mine).toBe(true);
  });
  it('resetNegative: a folder added later can claim an undecided session', () => {
    const folders: string[] = [];
    const r = new Router('aa11', () => folders, 'win32', id);
    expect(r.decide({ sessionId: 's', window: '', cwd: 'C:\\p' }).mine).toBe(false);
    folders.push('C:\\p');
    r.resetNegative();
    expect(r.decide({ sessionId: 's', window: '', cwd: 'C:\\p' }).mine).toBe(true);
  });
});
