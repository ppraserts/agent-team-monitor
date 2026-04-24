interface Props {
  size?: number;
  className?: string;
  /// Show animated pulse on satellite nodes.
  animate?: boolean;
}

/// Hi-tech multi-agent orchestrator emblem:
///   - Central hex core (gradient fill, glow)
///   - 3 satellite nodes orbiting (pulse)
///   - Connection lines from core to each satellite
///   - Outer ring (subtle, suggests scope)
export function Logo({ size = 36, className, animate = true }: Props) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="atm-stroke" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="oklch(0.82 0.18 200)" />
          <stop offset="100%" stopColor="oklch(0.70 0.22 295)" />
        </linearGradient>
        <radialGradient id="atm-core" cx="0.5" cy="0.45" r="0.6">
          <stop offset="0%" stopColor="oklch(0.92 0.12 200)" />
          <stop offset="55%" stopColor="oklch(0.62 0.20 240)" />
          <stop offset="100%" stopColor="oklch(0.32 0.12 280)" />
        </radialGradient>
        <filter id="atm-glow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="1.1" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* Outer scope ring */}
      <circle
        cx="32" cy="32" r="29"
        fill="none"
        stroke="url(#atm-stroke)"
        strokeWidth="0.5"
        opacity="0.35"
      />
      <circle
        cx="32" cy="32" r="29"
        fill="none"
        stroke="url(#atm-stroke)"
        strokeWidth="0.5"
        strokeDasharray="2 4"
        opacity="0.5"
      >
        {animate && (
          <animateTransform
            attributeName="transform"
            type="rotate"
            from="0 32 32"
            to="360 32 32"
            dur="40s"
            repeatCount="indefinite"
          />
        )}
      </circle>

      {/* Connection lines core → satellites */}
      <g stroke="url(#atm-stroke)" strokeWidth="1.2" opacity="0.7" filter="url(#atm-glow)">
        <line x1="32" y1="32" x2="32" y2="9" />
        <line x1="32" y1="32" x2="52" y2="44" />
        <line x1="32" y1="32" x2="12" y2="44" />
      </g>

      {/* Central hexagonal core */}
      <polygon
        points="32,19 42.4,25 42.4,37 32,43 21.6,37 21.6,25"
        fill="url(#atm-core)"
        stroke="url(#atm-stroke)"
        strokeWidth="1.5"
        filter="url(#atm-glow)"
      />
      {/* Inner triangle (agent symbol) */}
      <polygon
        points="32,25 38.5,36 25.5,36"
        fill="white"
        opacity="0.85"
      />

      {/* Satellite nodes — equilateral triangle around core (top, lower-right, lower-left) */}
      <Satellite cx={32} cy={9} color="oklch(0.82 0.18 200)" delay={0} animate={animate} />
      <Satellite cx={52} cy={44} color="oklch(0.70 0.22 295)" delay={0.7} animate={animate} />
      <Satellite cx={12} cy={44} color="oklch(0.72 0.24 340)" delay={1.4} animate={animate} />
    </svg>
  );
}

function Satellite({
  cx, cy, color, delay, animate,
}: {
  cx: number; cy: number; color: string; delay: number; animate: boolean;
}) {
  return (
    <g filter="url(#atm-glow)">
      {animate && (
        <circle cx={cx} cy={cy} r={5} fill={color} opacity={0.25}>
          <animate
            attributeName="r"
            values="3.5;6;3.5"
            dur="2s"
            begin={`${delay}s`}
            repeatCount="indefinite"
          />
          <animate
            attributeName="opacity"
            values="0.35;0;0.35"
            dur="2s"
            begin={`${delay}s`}
            repeatCount="indefinite"
          />
        </circle>
      )}
      <circle cx={cx} cy={cy} r={3} fill={color} />
      <circle cx={cx} cy={cy} r={1.2} fill="white" opacity={0.95} />
    </g>
  );
}
