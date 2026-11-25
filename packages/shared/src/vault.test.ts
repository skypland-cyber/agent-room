import { describe, expect, it } from 'vitest';
import {
  clampVaultText,
  formatVaultBytes,
  normalizeVaultTags,
  sanitizeVaultFileName,
  vaultCategoryFor,
  vaultFileMatches,
  vaultFileSummary,
  vaultMatchSnippet,
  vaultPreviewKind,
  vaultVersionLabel,
  type VaultFile,
} from './vault.js';

function file(overrides: Partial<VaultFile> = {}): VaultFile {
  return {
    id: 'vf_0011223344556677',
    kind: 'material',
    code: 'ABC-DEF-GHJ',
    name: 'quote.xlsx',
    size: 2048,
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    category: 'spreadsheet',
    storageKey: 'vault/material/ABC-DEF-GHJ/vf_0011223344556677/v1/quote.xlsx',
    tags: ['quote', 'acme'],
    createdAt: 1,
    updatedAt: 2,
    uploadedBy: 'Host',
    uploadedByClient: 'web',
    version: 1,
    versions: [],
    ...overrides,
  };
}

describe('vaultCategoryFor', () => {
  it('classifies by MIME first', () => {
    expect(vaultCategoryFor('image/png', 'x.bin')).toBe('image');
    expect(vaultCategoryFor('video/mp4')).toBe('video');
    expect(vaultCategoryFor('application/pdf', 'scan')).toBe('pdf');
    expect(vaultCategoryFor('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(vaultCategoryFor('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document');
    expect(vaultCategoryFor('application/zip')).toBe('archive');
    expect(vaultCategoryFor('application/json')).toBe('data');
  });

  it('falls back to the extension when a client sends octet-stream', () => {
    expect(vaultCategoryFor('application/octet-stream', 'budget.xlsx')).toBe('spreadsheet');
    expect(vaultCategoryFor('application/octet-stream', 'main.ts')).toBe('code');
    expect(vaultCategoryFor('application/octet-stream', '안내문.pdf')).toBe('pdf');
    expect(vaultCategoryFor('application/octet-stream', 'unknown.bin')).toBe('other');
  });
});

describe('vaultPreviewKind', () => {
  it('picks a renderer the browser actually has', () => {
    expect(vaultPreviewKind('image/png', 'a.png')).toBe('image');
    expect(vaultPreviewKind('image/heic', 'a.heic')).toBe('none');
    expect(vaultPreviewKind('application/pdf')).toBe('pdf');
    expect(vaultPreviewKind('video/mp4')).toBe('video');
    expect(vaultPreviewKind('text/markdown')).toBe('markdown');
    expect(vaultPreviewKind('application/json', 'data.json')).toBe('text');
    expect(vaultPreviewKind('application/octet-stream', 'a.py')).toBe('code');
    expect(vaultPreviewKind('application/zip', 'a.zip')).toBe('none');
  });
});

describe('sanitizeVaultFileName', () => {
  it('keeps a readable name but removes anything that could escape its key', () => {
    const traversal = sanitizeVaultFileName('../../etc/passwd');
    expect(traversal).not.toContain('../');
    expect(traversal).not.toMatch(/^\./);
    expect(traversal.endsWith('etc_passwd')).toBe(true);
    expect(sanitizeVaultFileName('a\\b.txt')).toBe('a_b.txt');
    expect(sanitizeVaultFileName('.hidden')).toBe('hidden');
    expect(sanitizeVaultFileName('quote "2026".xlsx')).toBe('quote "2026".xlsx');
    expect(sanitizeVaultFileName('bad\u0000name\n.txt')).toBe('badname.txt');
  });

  it('trims long names but keeps the extension', () => {
    const long = `${'가'.repeat(300)}.xlsx`;
    const out = sanitizeVaultFileName(long);
    expect(out.length).toBeLessThanOrEqual(160);
    expect(out.endsWith('.xlsx')).toBe(true);
  });

  it('never returns an empty name', () => {
    expect(sanitizeVaultFileName('')).toBe('file');
    expect(sanitizeVaultFileName(undefined)).toBe('file');
    expect(sanitizeVaultFileName('///')).toBe('file');
  });
});

describe('normalizeVaultTags', () => {
  it('lower-cases, de-duplicates, drops empties and caps the list', () => {
    expect(normalizeVaultTags([' Quote ', '#acme', 'quote', '', 'ACME'])).toEqual(['quote', 'acme']);
    expect(normalizeVaultTags('a, b ,,c')).toEqual(['a', 'b', 'c']);
    expect(normalizeVaultTags([1, null, 'ok'])).toEqual(['ok']);
    expect(normalizeVaultTags(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(8);
  });
});

describe('clampVaultText', () => {
  it('cuts to the budget without splitting a surrogate pair', () => {
    const text = `${'a'.repeat(9)}😀`;
    const clamped = clampVaultText(text, 10);
    expect(clamped).toBe('a'.repeat(9));
    expect(clampVaultText('short', 100)).toBe('short');
    expect(clampVaultText('a\u0000b')).toBe('ab');
  });
});

describe('listing helpers', () => {
  it('summarizes without carrying the text blob', () => {
    const summary = vaultFileSummary(file({ extractedText: 'x'.repeat(100) }));
    expect(summary).toMatchObject({ id: 'vf_0011223344556677', kind: 'material', hasText: true, version: 1 });
    expect('extractedText' in summary).toBe(false);
  });

  it('matches name, tags, description, producer, task and content', () => {
    const record = file({ description: '거래처 견적', producer: 'Alpha', taskId: 'T-03', extractedText: 'Total 1,200,000 KRW' });
    expect(vaultFileMatches(record, 'quote')).toBe(true);
    expect(vaultFileMatches(record, '견적')).toBe(true);
    expect(vaultFileMatches(record, 'alpha')).toBe(true);
    expect(vaultFileMatches(record, 'T-03')).toBe(true);
    expect(vaultFileMatches(record, '1,200,000')).toBe(true);
    expect(vaultFileMatches(record, 'nothing-here')).toBe(false);
    expect(vaultFileMatches(record, '')).toBe(true);
  });

  it('quotes the place the query hit', () => {
    const record = file({ extractedText: `${'가'.repeat(80)}합계 1,200,000원${'나'.repeat(80)}` });
    const snippet = vaultMatchSnippet(record, '1,200,000');
    expect(snippet).toContain('합계 1,200,000원');
    expect(snippet?.startsWith('…')).toBe(true);
    expect(vaultMatchSnippet(record, '없는단어')).toBeUndefined();
  });
});

describe('formatting', () => {
  it('labels versions and sizes the way the UI does', () => {
    expect(vaultVersionLabel(1)).toBe('v1');
    expect(vaultVersionLabel(7)).toBe('v7');
    expect(vaultVersionLabel(0)).toBe('v1');
    expect(formatVaultBytes(0)).toBe('0 B');
    expect(formatVaultBytes(1536)).toBe('1.5 KB');
    expect(formatVaultBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatVaultBytes(2.5 * 1024 * 1024 * 1024)).toBe('2.50 GB');
  });
});
