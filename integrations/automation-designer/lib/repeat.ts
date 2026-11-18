// `--repeat N` (`ad test`, `ad run`): one timing is misleading (a cold first run can take 1.2 s
// where later runs take 50–150 ms), so the same run is repeated and its times summarised.

export interface RepeatStats {
  min: number;
  median: number;
  max: number;
  /** Every run's time, in run order. */
  values: number[];
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export function repeatStats(values: number[]): RepeatStats {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { min: round(sorted[0]!), median: round(median), max: round(sorted[sorted.length - 1]!), values: values.map(round) };
}
