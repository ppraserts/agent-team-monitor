// Anthropic plan defaults — these are ROUGH estimates derived from community
// reports and the user's own claude.ai/settings/limits page. Real values vary
// per account; user can override every number in Settings.
//
// Token figures are "non-cache" (input + output) per the displayed period,
// which approximately matches the bars Anthropic shows on the usage page.

export type PlanTier = "pro" | "max-5x" | "max-20x" | "custom";

export interface PlanLimits {
  label: string;
  /// Tokens allowed per 5-hour billing block (Current session).
  sessionLimit: number;
  /// Weekly token allowance — All models combined.
  weeklyAllLimit: number;
  /// Weekly token allowance — Sonnet-class models only.
  weeklySonnetLimit: number;
  /// Weekly token allowance — Opus-class models only.
  weeklyOpusLimit: number;
  /// Monthly extra-usage spend cap in USD (above the flat plan price).
  monthlySpendLimit: number;
}

export const PLAN_DEFAULTS: Record<PlanTier, PlanLimits> = {
  pro: {
    label: "Pro",
    sessionLimit: 50_000,
    weeklyAllLimit: 1_500_000,
    weeklySonnetLimit: 1_500_000,
    weeklyOpusLimit: 50_000,
    monthlySpendLimit: 0,
  },
  "max-5x": {
    label: "Max (5x)",
    sessionLimit: 250_000,
    weeklyAllLimit: 7_500_000,
    weeklySonnetLimit: 7_500_000,
    weeklyOpusLimit: 250_000,
    monthlySpendLimit: 100,
  },
  "max-20x": {
    label: "Max (20x)",
    sessionLimit: 1_000_000,
    weeklyAllLimit: 30_000_000,
    weeklySonnetLimit: 30_000_000,
    weeklyOpusLimit: 1_000_000,
    monthlySpendLimit: 200,
  },
  custom: {
    label: "Custom",
    sessionLimit: 0,
    weeklyAllLimit: 0,
    weeklySonnetLimit: 0,
    weeklyOpusLimit: 0,
    monthlySpendLimit: 0,
  },
};

export interface PlanSettings extends PlanLimits {
  tier: PlanTier;
  /// 0=Sun … 6=Sat — the weekday Anthropic resets your weekly limit on.
  /// Anthropic shows "Resets Fri 7:00 AM" for some accounts.
  weeklyResetDay: number; // default 5 (Friday)
  weeklyResetHour: number; // default 7 (7 AM)
  /// Manual fields — Anthropic doesn't expose extra usage via local files,
  /// so the user copy-pastes them from the claude.ai page.
  extraSpent: number; // USD
  extraResetDate: string; // YYYY-MM-DD (when monthly cap rolls over)
}

export const DEFAULT_PLAN_SETTINGS: PlanSettings = {
  tier: "max-20x",
  ...PLAN_DEFAULTS["max-20x"],
  weeklyResetDay: 5,
  weeklyResetHour: 7,
  extraSpent: 0,
  extraResetDate: "",
};

export function parsePlanSettings(raw: Record<string, string>): PlanSettings {
  const tier = (raw.plan_tier as PlanTier) ?? DEFAULT_PLAN_SETTINGS.tier;
  const tierDefaults =
    tier in PLAN_DEFAULTS ? PLAN_DEFAULTS[tier] : PLAN_DEFAULTS["max-20x"];
  const num = (k: string, fallback: number) =>
    raw[k] != null && raw[k] !== "" ? Number(raw[k]) : fallback;
  return {
    tier,
    label: tierDefaults.label,
    sessionLimit: num("plan_session_limit", tierDefaults.sessionLimit),
    weeklyAllLimit: num("plan_weekly_all_limit", tierDefaults.weeklyAllLimit),
    weeklySonnetLimit: num("plan_weekly_sonnet_limit", tierDefaults.weeklySonnetLimit),
    weeklyOpusLimit: num("plan_weekly_opus_limit", tierDefaults.weeklyOpusLimit),
    monthlySpendLimit: num("plan_monthly_spend_limit", tierDefaults.monthlySpendLimit),
    weeklyResetDay: num("plan_weekly_reset_day", 5),
    weeklyResetHour: num("plan_weekly_reset_hour", 7),
    extraSpent: num("plan_extra_spent", 0),
    extraResetDate: raw.plan_extra_reset_date ?? "",
  };
}

/// "Resets Fri 7:00 AM" — describe the upcoming weekly reset.
export function describeWeeklyReset(day: number, hour: number): string {
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = ((hour + 11) % 12) + 1;
  return `${days[day] ?? "Fri"} ${h12}:00 ${ampm}`;
}

/// Rough remaining time until the next weekly reset.
export function timeUntilWeeklyReset(day: number, hour: number): string {
  const now = new Date();
  const next = new Date(now);
  const diffDays = (day - now.getDay() + 7) % 7;
  next.setDate(now.getDate() + diffDays);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 7);
  const ms = +next - +now;
  const days = Math.floor(ms / (24 * 3600 * 1000));
  const hrs = Math.floor((ms / (3600 * 1000)) % 24);
  if (days > 0) return `in ${days}d ${hrs}h`;
  const mins = Math.floor((ms / 60_000) % 60);
  return `in ${hrs}h ${mins}m`;
}
