import { useState } from 'react';
import type { RoiProjectionPoint } from '../types';

interface RoiChartProps {
  points: RoiProjectionPoint[];
  principalSol: number;
}

function formatCompactSol(val: number): string {
  if (!Number.isFinite(val)) return '0';
  const abs = Math.abs(val);
  if (abs >= 1e15) return `${(val / 1e15).toFixed(2)}Q`;
  if (abs >= 1e12) return `${(val / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${(val / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(val / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(val / 1e3).toFixed(1)}K`;
  return val.toFixed(abs >= 100 ? 1 : 2);
}

export function RoiChart({ points, principalSol }: RoiChartProps) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (!points || points.length < 2) {
    return (
      <div className="h-64 flex items-center justify-center border border-slate-800 rounded-lg bg-[#0B101B] text-sm text-slate-500">
        Enter principal and APR parameters to generate epoch projection.
      </div>
    );
  }

  const width = 760;
  const height = 270;
  const padLeft = 72;
  const padRight = 20;
  const padTop = 20;
  const padBottom = 36;
  const chartW = width - padLeft - padRight;
  const chartH = height - padTop - padBottom;

  const minVal = Math.min(...points.map((p) => p.totalSol), principalSol) * 0.995;
  const maxVal = Math.max(...points.map((p) => p.totalSol), principalSol * 1.01) * 1.005;
  const span = Math.max(0.001, maxVal - minVal);

  const getX = (idx: number) => padLeft + (idx / (points.length - 1)) * chartW;
  const getY = (val: number) => padTop + chartH - ((val - minVal) / span) * chartH;

  const totalLinePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(p.totalSol).toFixed(1)}`)
    .join(' ');

  const posOnlyPath = points
    .map(
      (p, i) =>
        `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(principalSol + p.posYieldSol).toFixed(1)}`,
    )
    .join(' ');

  const areaPath = `${totalLinePath} L ${getX(points.length - 1).toFixed(1)} ${(padTop + chartH).toFixed(1)} L ${getX(0).toFixed(1)} ${(padTop + chartH).toFixed(1)} Z`;

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minVal + t * span);
  const activePoint = hoverIdx !== null ? points[hoverIdx] : points[points.length - 1];
  const activeIdx = hoverIdx !== null ? hoverIdx : points.length - 1;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-4 text-xs text-slate-400">
        <div className="flex items-center gap-5">
          <span className="flex items-center gap-2 text-slate-200">
            <span className="inline-block w-3 h-0.5 bg-emerald-400" />
            Total Projected SOL
          </span>
          <span className="flex items-center gap-2 text-slate-300">
            <span className="inline-block w-3 h-0.5 bg-blue-400" />
            Native PoS Yield Only
          </span>
          <span className="flex items-center gap-2 text-slate-400">
            <span className="inline-block w-3 h-0.5 border-t border-dashed border-slate-500" />
            Principal Baseline
          </span>
        </div>
        <div className="font-mono tabular-nums text-slate-300">
          Day {activePoint.day} · Epoch +{activePoint.epoch} ·{' '}
          <span className="text-emerald-400 font-medium">
            {activePoint.totalSol >= 1e9
              ? `${formatCompactSol(activePoint.totalSol)} SOL`
              : `${activePoint.totalSol.toLocaleString(undefined, { maximumFractionDigits: 4 })} SOL`}
          </span>{' '}
          ({activePoint.cumulativeRoiPct >= 0 ? '+' : ''}
          {activePoint.cumulativeRoiPct >= 1e6
            ? formatCompactSol(activePoint.cumulativeRoiPct)
            : activePoint.cumulativeRoiPct.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          %)
        </div>
      </div>

      <div className="relative w-full overflow-hidden rounded-lg border border-slate-800 bg-[#0B101B] p-2">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto select-none"
          onMouseLeave={() => setHoverIdx(null)}
        >
          <defs>
            <linearGradient id="roiAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10B981" stopOpacity="0.24" />
              <stop offset="100%" stopColor="#10B981" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {yTicks.map((tick, idx) => {
            const y = getY(tick);
            return (
              <g key={idx}>
                <line
                  x1={padLeft}
                  y1={y}
                  x2={width - padRight}
                  y2={y}
                  stroke="#1E293B"
                  strokeWidth="1"
                />
                <text
                  x={padLeft - 8}
                  y={y + 4}
                  textAnchor="end"
                  className="fill-slate-500 text-[10px] font-mono"
                >
                  {formatCompactSol(tick)}
                </text>
              </g>
            );
          })}

          {/* Principal baseline */}
          <line
            x1={padLeft}
            y1={getY(principalSol)}
            x2={width - padRight}
            y2={getY(principalSol)}
            stroke="#475569"
            strokeWidth="1"
            strokeDasharray="4 4"
          />

          <path d={areaPath} fill="url(#roiAreaGrad)" />
          <path d={posOnlyPath} fill="none" stroke="#3B82F6" strokeWidth="1.75" />
          <path d={totalLinePath} fill="none" stroke="#10B981" strokeWidth="2.25" />

          {/* X-axis labels */}
          {points
            .filter((_, i) => i === 0 || i === Math.floor(points.length / 2) || i === points.length - 1)
            .map((p) => {
              const idx = points.indexOf(p);
              return (
                <text
                  key={p.epoch}
                  x={getX(idx)}
                  y={height - 10}
                  textAnchor="middle"
                  className="fill-slate-500 text-[10px] font-mono"
                >
                  Day {p.day}
                </text>
              );
            })}

          {/* Hover vertical guide */}
          <line
            x1={getX(activeIdx)}
            y1={padTop}
            x2={getX(activeIdx)}
            y2={padTop + chartH}
            stroke="#334155"
            strokeWidth="1"
          />
          <circle
            cx={getX(activeIdx)}
            cy={getY(activePoint.totalSol)}
            r="4"
            fill="#10B981"
            stroke="#090D16"
            strokeWidth="2"
          />

          {/* Interactive hit targets */}
          {points.map((_, i) => {
            const sliceW = chartW / points.length;
            return (
              <rect
                key={i}
                x={getX(i) - sliceW / 2}
                y={padTop}
                width={sliceW}
                height={chartH}
                fill="transparent"
                onMouseEnter={() => setHoverIdx(i)}
              />
            );
          })}
        </svg>
      </div>
    </div>
  );
}
