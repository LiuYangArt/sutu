import type { LucideProps } from 'lucide-react';

export function GradientToolIcon({
  color = 'currentColor',
  size = 24,
  strokeWidth = 1.5,
  ...props
}: LucideProps): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="3.5" y="7.5" width="17" height="9" rx="2.5" />
      <line x1="7" y1="12" x2="17" y2="12" opacity="0.85" />
      <line x1="8" y1="10" x2="8" y2="14" opacity="0.55" />
      <line x1="10" y1="10" x2="10" y2="14" opacity="0.45" />
      <line x1="12" y1="10" x2="12" y2="14" opacity="0.35" />
      <line x1="14" y1="10" x2="14" y2="14" opacity="0.25" />
      <line x1="16" y1="10" x2="16" y2="14" opacity="0.15" />
    </svg>
  );
}
