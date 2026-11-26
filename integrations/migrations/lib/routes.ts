// The migration routes a Jenkins client has, for the error when a requested
// profile (or env pair) has none. A profile is `<source>_<target>`; the routes
// are its client group's profiles, labelled without the group's shared suffix
// (`devacme_qaacme` → dev→qa). Nothing about clients is hard-coded: the groups
// come from the job's PROFILE_NAME dividers.

import { CliError, Config, isObj } from "@belzabar/core";
import { assertJenkinsAuth } from "./jenkins";
import { discoverProfiles } from "./profiles";
import type { ProfilesByClient } from "./types";

/** Migration profile segment → wi-impl env, from config `jenkins.profileEnvs` (lowercase keys). */
export function profileSegmentEnvs(): Record<string, string> {
  return Config.getJenkins().profileEnvs;
}

/** The wi-impl env a profile segment maps to in config `jenkins.profileEnvs` (keys lower-case). */
export function segmentEnv(segment: string | undefined): string | undefined {
  if (!segment) return undefined;
  const map = profileSegmentEnvs();
  return Object.hasOwn(map, segment) ? map[segment] : undefined;
}

/** `<source>_<target>` → its two segments (lower-case); null for any other shape. */
export function profileSegments(profile: string): [string, string] | null {
  const parts = profile.trim().toLowerCase().split("_");
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : null;
}

interface RouteGroup {
  client: string;
  /** `<source>→<target>` per profile, shared suffix stripped. */
  routes: string[];
  profiles: string[];
}

interface RouteHint {
  /** One sentence per matching client group, plus a two-build path when one exists. */
  text: string;
  groups: RouteGroup[];
  /** Two profiles that get from the source to the target through one env. */
  via?: [string, string];
  /** The one profile whose ends match the requested env pair. */
  suggested?: string;
}

/** The longest suffix every segment shares, when each keeps a non-empty rest. */
function sharedSuffix(segments: string[]): string {
  if (segments.length < 2) return "";
  let suffix = segments[0]!;
  for (const s of segments) {
    while (suffix && !s.endsWith(suffix)) suffix = suffix.slice(1);
  }
  return segments.every((s) => s.length > suffix.length) ? suffix : "";
}

/** Matches a segment: an exact segment, or an env name (via jenkins.profileEnvs, else its words all in the segment). */
type SegmentTest = (segment: string) => boolean;

function envTest(env: string): SegmentTest {
  const words = env.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
  return (segment) => {
    const mapped = segmentEnv(segment);
    if (mapped) return mapped === env;
    return words.length > 0 && words.every((w) => segment.includes(w));
  };
}

/**
 * Describe the routes of the client groups that know the requested source or
 * target. Null when no group (or too many to be useful) matches.
 */
export function routeHint(
  groups: readonly ProfilesByClient[],
  wanted: { profile: string } | { sourceEnv: string; targetEnv: string },
): RouteHint | null {
  const segs = "profile" in wanted ? profileSegments(wanted.profile) : null;
  if ("profile" in wanted && !segs) return null;
  const isSource: SegmentTest = segs ? (s) => s === segs[0] : envTest((wanted as { sourceEnv: string }).sourceEnv);
  const isTarget: SegmentTest = segs ? (s) => s === segs[1] : envTest((wanted as { targetEnv: string }).targetEnv);

  const matched = groups
    .map((g) => {
      const pairs = g.profiles.map((p) => ({ profile: p, ends: profileSegments(p) })).filter((x) => x.ends !== null) as Array<{ profile: string; ends: [string, string] }>;
      const all = pairs.flatMap((x) => x.ends);
      const score = (all.some(isSource) ? 1 : 0) + (all.some(isTarget) ? 1 : 0);
      return { g, pairs, score };
    })
    .filter((m) => m.score > 0)
    .sort((a, b) => b.score - a.score);
  const best = matched.filter((m) => m.score === matched[0]?.score);
  if (best.length === 0 || best.length > 3) return null;

  const out: RouteHint = { text: "", groups: [] };
  const sentences: string[] = [];
  for (const { g, pairs } of best) {
    const suffix = sharedSuffix([...new Set(pairs.flatMap((x) => x.ends))]);
    const label = (s: string) => (suffix && s.endsWith(suffix) && s.length > suffix.length ? s.slice(0, -suffix.length) : s);
    const routes = pairs.map((x) => `${label(x.ends[0])}→${label(x.ends[1])}`);
    out.groups.push({ client: g.client, routes, profiles: pairs.map((x) => x.profile) });

    const direct = pairs.filter((x) => isSource(x.ends[0]) && isTarget(x.ends[1]));
    let sentence = `${g.client} has ${routes.join(", ")}`;
    if (direct.length === 1 && !segs) {
      out.suggested = direct[0]!.profile;
      sentence += `; use --profile ${direct[0]!.profile}`;
    } else if (direct.length === 0) {
      const from = segs ? label(segs[0]) : (wanted as { sourceEnv: string }).sourceEnv;
      const to = segs ? label(segs[1]) : (wanted as { targetEnv: string }).targetEnv;
      sentence += `; no ${from}→${to}`;
      for (const first of pairs.filter((x) => isSource(x.ends[0]))) {
        const second = pairs.find((x) => x.ends[0] === first.ends[1] && isTarget(x.ends[1]));
        if (second && !out.via) {
          out.via = [first.profile, second.profile];
          sentence += `. Two builds get there: ${label(first.ends[0])}→${label(first.ends[1])} (${first.profile}), ` +
            `then ${label(second.ends[0])}→${label(second.ends[1])} (${second.profile})`;
        }
      }
    }
    sentences.push(`${sentence}.`);
  }
  out.text = sentences.join(" ");
  return out;
}

/**
 * `routeHint` over the job's profile list (cached 24 h), for an error that is
 * already being thrown: null when Jenkins is not configured or cannot be read.
 */
export async function knownRouteHint(wanted: Parameters<typeof routeHint>[1]): Promise<RouteHint | null> {
  try {
    const { groups } = await discoverProfiles(assertJenkinsAuth(Config.getJenkins()));
    return routeHint(groups, wanted);
  } catch {
    return null;
  }
}

/** `e` with the route hint appended to its message and `details.routes` (plus `via` / `suggestedProfile`). */
export function withRouteHint(e: CliError, hint: RouteHint | null): CliError {
  if (!hint) return e;
  return new CliError(`${e.message} ${hint.text}`, {
    code: e.code,
    exitCode: e.exitCode,
    details: {
      ...(isObj(e.details) ? e.details : {}),
      routes: hint.groups,
      ...(hint.via ? { via: hint.via } : {}),
      ...(hint.suggested ? { suggestedProfile: hint.suggested } : {}),
    },
  });
}
