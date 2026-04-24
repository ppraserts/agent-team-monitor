import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { cn, statusColor } from "../lib/cn";

interface Edge {
  id: string;        // unique key (msg id)
  from: string;
  to: string;
  ts: number;
  hot: boolean;      // recently created -> animate
}

interface Props {
  /// When a new mention happens, we briefly animate that edge.
  mentionPulse?: { from: string; to: string; key: number } | null;
}

const NODE_R = 22;
const SVG_W = 480;
const SVG_H = 480;

export function AgentGraph({ mentionPulse }: Props) {
  const agentsDict = useStore((s) => s.agents);

  const agents = useMemo(
    () => Object.values(agentsDict).map((a) => a.snapshot),
    [agentsDict],
  );

  const totalMessages = useMemo(
    () => Object.values(agentsDict).reduce((n, a) => n + a.messages.length, 0),
    [agentsDict],
  );

  const [edges, setEdges] = useState<Edge[]>([]);
  // Tick to redraw decay opacity over time.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);

  // Re-derive edges from store messages. Each routed message becomes one edge.
  useEffect(() => {
    const newEdges: Edge[] = [];
    const now = Date.now();
    for (const a of Object.values(agentsDict)) {
      for (const m of a.messages) {
        if (m.role === "user" && m.from_agent_id) {
          const ts = +new Date(m.ts);
          newEdges.push({
            id: m.id,
            from: m.from_agent_id,
            to: a.snapshot.id,
            ts,
            hot: now - ts < 4000,
          });
        }
      }
    }
    setEdges(newEdges.slice(-40));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalMessages]);

  // Pulse from mention event (immediate visual feedback before message arrives).
  useEffect(() => {
    if (!mentionPulse) return;
    setEdges((es) => [
      ...es,
      {
        id: `pulse-${mentionPulse.key}`,
        from: mentionPulse.from,
        to: mentionPulse.to,
        ts: Date.now(),
        hot: true,
      },
    ]);
  }, [mentionPulse?.key]);

  const layout = useMemo(
    () => circleLayout(agents.map((a) => a.id), SVG_W / 2, SVG_H / 2, 170),
    [agents.length],
  );

  const idToPos = useMemo(
    () =>
      Object.fromEntries(
        agents.map((a, i) => [a.id, layout[i] ?? { x: SVG_W / 2, y: SVG_H / 2 }]),
      ),
    [agents, layout],
  );

  // Aggregate edge counts per directed pair so duplicates show as thicker arrow + count.
  const edgeAgg = useMemo(() => {
    const map = new Map<string, { from: string; to: string; count: number; lastTs: number }>();
    for (const e of edges) {
      const key = `${e.from}->${e.to}`;
      const ex = map.get(key);
      if (ex) {
        ex.count += 1;
        ex.lastTs = Math.max(ex.lastTs, e.ts);
      } else {
        map.set(key, { from: e.from, to: e.to, count: 1, lastTs: e.ts });
      }
    }
    return [...map.values()];
  }, [edges]);

  const mentionCount = edges.length;

  if (agents.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-base-600 text-xs italic">
        Spawn agents to see the team graph.
      </div>
    );
  }

  return (
    <div className="relative h-full w-full grid-bg">
      <div className="absolute top-2 left-2 text-[10px] text-base-500 font-mono z-10">
        {agents.length} agents · {mentionCount} cross-agent calls
      </div>

      <svg
        viewBox={`0 0 ${SVG_W} ${SVG_H}`}
        className="absolute inset-0 w-full h-full"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker
            id="arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#5ed3ff" />
          </marker>
          <marker
            id="arrow-hot"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="6"
            markerHeight="6"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#dab2ff" />
          </marker>
          <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation="2.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges */}
        {edgeAgg.map((e) => {
          const a = idToPos[e.from];
          const b = idToPos[e.to];
          if (!a || !b) return null;

          // Trim endpoints to node edge so arrow doesn't poke into the circle.
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.sqrt(dx * dx + dy * dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          const x1 = a.x + ux * NODE_R;
          const y1 = a.y + uy * NODE_R;
          const x2 = b.x - ux * (NODE_R + 4);
          const y2 = b.y - uy * (NODE_R + 4);

          const ageSec = (Date.now() - e.lastTs) / 1000;
          const hot = ageSec < 4;
          const opacity = Math.max(0.25, 1 - ageSec / 60);
          const stroke = hot ? "#dab2ff" : "#5ed3ff";
          const widthBase = 1.5 + Math.min(3, e.count - 1);

          return (
            <g key={`${e.from}->${e.to}`} opacity={opacity}>
              {/* glow underline */}
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={stroke}
                strokeWidth={widthBase + 4}
                opacity={0.18}
                filter="url(#glow)"
              />
              {/* main line */}
              <line
                x1={x1} y1={y1} x2={x2} y2={y2}
                stroke={stroke}
                strokeWidth={widthBase}
                strokeLinecap="round"
                markerEnd={`url(#${hot ? "arrow-hot" : "arrow"})`}
                strokeDasharray={hot ? "6 4" : undefined}
              >
                {hot && (
                  <animate
                    attributeName="stroke-dashoffset"
                    from="0"
                    to="-30"
                    dur="0.6s"
                    repeatCount="indefinite"
                  />
                )}
              </line>
              {e.count > 1 && (
                <g>
                  <circle
                    cx={(x1 + x2) / 2}
                    cy={(y1 + y2) / 2}
                    r={9}
                    fill="#0c0d12"
                    stroke={stroke}
                    strokeWidth={1}
                  />
                  <text
                    x={(x1 + x2) / 2}
                    y={(y1 + y2) / 2 + 3}
                    textAnchor="middle"
                    fontSize={9}
                    fontWeight={700}
                    fill={stroke}
                  >
                    {e.count}
                  </text>
                </g>
              )}
            </g>
          );
        })}

        {/* Nodes */}
        {agents.map((a) => {
          const p = idToPos[a.id];
          if (!p) return null;
          const isActive = a.status === "thinking" || a.status === "working";
          return (
            <g key={a.id}>
              {isActive && (
                <circle cx={p.x} cy={p.y} r={NODE_R + 6} fill="#5ed3ff" opacity={0.15}>
                  <animate
                    attributeName="r"
                    values={`${NODE_R};${NODE_R + 16};${NODE_R}`}
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                  <animate
                    attributeName="opacity"
                    values="0.30;0;0.30"
                    dur="1.6s"
                    repeatCount="indefinite"
                  />
                </circle>
              )}
              <circle
                cx={p.x} cy={p.y} r={NODE_R}
                className={cn(
                  "transition",
                  statusColor(a.status).replace("bg-", "fill-"),
                )}
                fill="currentColor"
                stroke="#0c0d12"
                strokeWidth={2}
              />
              <text
                x={p.x} y={p.y + 4}
                textAnchor="middle"
                fontSize={11}
                fontWeight={800}
                fill="#0c0d12"
              >
                {initials(a.spec.name)}
              </text>
              <text
                x={p.x} y={p.y + NODE_R + 14}
                textAnchor="middle"
                fontSize={11}
                fontWeight={600}
                fill="#d8d8e0"
              >
                {a.spec.name}
              </text>
              <text
                x={p.x} y={p.y + NODE_R + 26}
                textAnchor="middle"
                fontSize={9}
                fill="#5a5a66"
              >
                {a.status}
              </text>
            </g>
          );
        })}
      </svg>

      {/* invisible spacer using tick so opacity decay re-renders */}
      <span className="hidden">{tick}</span>
    </div>
  );
}

function circleLayout(ids: string[], cx: number, cy: number, r: number) {
  if (ids.length === 0) return [];
  if (ids.length === 1) return [{ x: cx, y: cy }];
  return ids.map((_, i) => {
    const angle = (i / ids.length) * Math.PI * 2 - Math.PI / 2;
    return { x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r };
  });
}

function initials(name: string): string {
  return name
    .split(/[\s_-]+/)
    .map((s) => s[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
}
