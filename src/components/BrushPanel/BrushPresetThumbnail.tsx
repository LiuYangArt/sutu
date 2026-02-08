import type { CSSProperties } from 'react';
import { BrushPreset } from './types';
import { BrushThumbnail } from './BrushThumbnail';
import { ProceduralBrushThumbnail } from './ProceduralBrushThumbnail';
import { resolveBrushThumbnailKind } from './settings/thumbnailKind';

interface BrushPresetThumbnailProps {
  preset: Pick<BrushPreset, 'id' | 'name' | 'diameter' | 'hardness' | 'roundness' | 'angle'> & {
    hasTexture: boolean;
    isComputed?: boolean;
  };
  size: number;
  className?: string;
  alt?: string;
  placeholderStyle?: CSSProperties;
}

export function BrushPresetThumbnail({
  preset,
  size,
  className = 'abr-preset-texture',
  alt,
  placeholderStyle,
}: BrushPresetThumbnailProps): JSX.Element {
  const resolvedAlt = alt ?? preset.name;

  switch (resolveBrushThumbnailKind(preset)) {
    case 'texture':
      return (
        <BrushThumbnail brushId={preset.id} size={size} alt={resolvedAlt} className={className} />
      );
    case 'procedural':
      return (
        <ProceduralBrushThumbnail
          hardness={preset.hardness}
          roundness={preset.roundness}
          angle={preset.angle}
          size={size}
          alt={resolvedAlt}
          className={className}
        />
      );
    case 'placeholder':
    default:
      return (
        <div className="abr-preset-placeholder" style={placeholderStyle}>
          {Math.round(preset.diameter)}
        </div>
      );
  }
}
