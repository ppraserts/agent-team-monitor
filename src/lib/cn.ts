import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function fmtNumber(n: number): string {
  if (n < 1_000) return n.toString();
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function fmtCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 1000).toFixed(2)}m`;
  return `$${usd.toFixed(3)}`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "thinking": return "bg-(--color-accent-amber)";
    case "working":  return "bg-(--color-accent-cyan)";
    case "idle":     return "bg-(--color-accent-green)";
    case "starting": return "bg-(--color-accent-violet)";
    case "error":    return "bg-(--color-accent-red)";
    case "stopped":  return "bg-base-600";
    default:         return "bg-base-500";
  }
}
