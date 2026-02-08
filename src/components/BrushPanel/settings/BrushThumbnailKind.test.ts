import { describe, expect, it } from 'vitest';
import { resolveBrushThumbnailKind } from './thumbnailKind';

describe('resolveBrushThumbnailKind', () => {
  it('hasTexture=true 时返回 texture', () => {
    expect(resolveBrushThumbnailKind({ hasTexture: true, isComputed: false })).toBe('texture');
  });

  it('isComputed=true 且 hasTexture=false 时返回 procedural', () => {
    expect(resolveBrushThumbnailKind({ hasTexture: false, isComputed: true })).toBe('procedural');
  });

  it('isComputed=false 且 hasTexture=false 时返回 placeholder', () => {
    expect(resolveBrushThumbnailKind({ hasTexture: false, isComputed: false })).toBe('placeholder');
  });
});
