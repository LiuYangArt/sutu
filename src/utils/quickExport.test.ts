import { describe, expect, it } from 'vitest';
import {
  buildDefaultQuickExportPath,
  isLikelyValidQuickExportPath,
  replacePathExtension,
  resolveQuickExportBackgroundColor,
} from './quickExport';

describe('quickExport utils', () => {
  it('replaces extension and appends when missing', () => {
    expect(replacePathExtension('C:\\Exports\\image.png', 'jpg')).toBe('C:\\Exports\\image.jpg');
    expect(replacePathExtension('C:\\Exports\\image', 'webp')).toBe('C:\\Exports\\image.webp');
  });

  it('builds default quick export path from document path', () => {
    expect(buildDefaultQuickExportPath('D:\\Projects\\sample.psd', 'png')).toBe(
      'D:\\Projects\\sample.png'
    );
    expect(buildDefaultQuickExportPath('/tmp/sample.ora', 'jpg')).toBe('/tmp/sample.jpg');
  });

  it('resolves background preset color', () => {
    expect(resolveQuickExportBackgroundColor('white', '#123456')).toBe('#ffffff');
    expect(resolveQuickExportBackgroundColor('black', '#123456')).toBe('#000000');
    expect(resolveQuickExportBackgroundColor('current-bg', '#123456')).toBe('#123456');
  });

  it('checks basic path validity', () => {
    expect(isLikelyValidQuickExportPath('C:\\Exports\\image.png')).toBe(true);
    expect(isLikelyValidQuickExportPath('')).toBe(false);
    expect(isLikelyValidQuickExportPath('C:\\Exports\\')).toBe(false);
  });
});
