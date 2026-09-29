// The argv parser behind `defineArgs` / `defineSubcommands`.
//
// Rules (CORE-7, AD-29/37, TW-3/5, MG-1/6, PD-16/23, F34):
//   - `--flag value` and `--flag=value`; `-x value` for declared short aliases.
//   - A value that looks like a flag (`--body --yes`) is MISSING_VALUE, not a value.
//     Negative numbers (`-5`) and a bare `-` are values / positionals, never flags.
//   - Unknown flags are UNKNOWN_FLAG with a did-you-mean suggestion.
//   - Booleans take no value: `--dry-run=true` is INVALID_VALUE.
//   - `--` ends flag parsing; everything after it is positional.
//   - Global runner flags (--llm, --env, -v …) are skipped unless the spec declares them.

import { CliError } from "../command";
import {
  ARG_ERROR_CODES,
  GLOBAL_FLAGS,
  type AnyArgsDef,
  type ArgErrorCode,
  type ArgsDef,
  type ArgsSpec,
  type FlagSpec,
  type ParsedArgs,
  type ParsedSubcommand,
  type SubcommandsDef,
  type SubcommandsOptions,
  type SubcommandsSpec,
} from "./spec";
import { levenshtein } from "../search";

const FLAG_LIKE = /^-{1,2}[A-Za-z]/;

function camelCase(key: string): string {
  return key.replace(/-([a-zA-Z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** Closest known spelling to `input`, or undefined when nothing is close. */
export function suggest(input: string, known: readonly string[]): string | undefined {
  const norm = (f: string) => f.replace(/^-+/, "").replace(/[-_]/g, "").toLowerCase();
  const n = norm(input);
  let best: { value: string; d: number } | undefined;
  for (const k of known) {
    const d = levenshtein(n, norm(k));
    if (!best || d < best.d) best = { value: k, d };
  }
  if (!best) return undefined;
  return best.d <= Math.max(2, Math.floor(norm(best.value).length / 3)) ? best.value : undefined;
}

/** Every spelling of a flag: `--key` plus its aliases. */
function flagSpellings(key: string, flag: FlagSpec): string[] {
  return [`--${key}`, ...(flag.alias ?? [])];
}

/** A token as shown in an error message: single line, at most `max` chars (SQL/free text can be huge). */
function shownToken(token: string, max = 40): string {
  const flat = token.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function label(spec: { command?: string }): string {
  return spec.command ? ` for '${spec.command}'` : "";
}

function argError(
  spec: { codes?: Partial<Record<ArgErrorCode, string>> },
  code: ArgErrorCode,
  message: string,
  details: Record<string, unknown>,
): CliError {
  return new CliError(message, { code: spec.codes?.[code] ?? ARG_ERROR_CODES[code], details });
}

function convert(spec: ArgsSpec, key: string, flag: FlagSpec, raw: string, shown: string): unknown {
  const invalid = (why: string) =>
    argError(spec, "INVALID_VALUE", `Invalid value '${raw}' for ${shown}${label(spec)}: ${why}.`, {
      flag: shown,
      value: raw,
    });
  switch (flag.type) {
    case "boolean":
      throw invalid("it is a switch and takes no value");
    case "number": {
      const n = raw.trim() === "" ? NaN : Number(raw);
      if (!Number.isFinite(n)) throw invalid("expected a number");
      if (flag.integer && !Number.isInteger(n)) throw invalid("expected an integer");
      if (flag.min !== undefined && n < flag.min) throw invalid(`must be ≥ ${flag.min}`);
      if (flag.max !== undefined && n > flag.max) throw invalid(`must be ≤ ${flag.max}`);
      return n;
    }
    case "enum": {
      const ci = flag.caseInsensitive !== false;
      const match = flag.values.find(v => (ci ? v.toLowerCase() === raw.trim().toLowerCase() : v === raw));
      if (match === undefined) throw invalid(`expected one of ${flag.values.join(", ")}`);
      return match;
    }
    case "string":
      if (raw.trim() === "" && flag.allowEmpty !== true) {
        throw argError(spec, "MISSING_VALUE", `${shown} requires a non-empty value${label(spec)}.`, { flag: shown });
      }
      return raw;
  }
}

/** Parse argv against one spec. Throws CliError on any problem. */
function parseWithSpec<S extends ArgsSpec>(spec: S, argv: readonly string[]): ParsedArgs<S> {
  const flags = (spec.flags ?? {}) as Record<string, FlagSpec>;
  const byToken = new Map<string, string>();
  for (const [key, flag] of Object.entries(flags)) {
    for (const t of flagSpellings(key, flag)) byToken.set(t, key);
  }
  const known = [...byToken.keys()];

  const values: Record<string, unknown> = {};
  const provided = new Set<string>();
  const positionals: string[] = [];
  const afterDoubleDash: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      afterDoubleDash.push(...argv.slice(i + 1));
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!FLAG_LIKE.test(token)) {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const key = byToken.get(name);

    if (key === undefined) {
      if ((GLOBAL_FLAGS as readonly string[]).includes(name)) {
        // The runner normally strips these; tolerate them if they reach us.
        if ((name === "--env" || name === "-e") && inline === undefined) i++;
        continue;
      }
      const suggestion = suggest(name, known);
      throw argError(
        spec,
        "UNKNOWN_FLAG",
        `Unknown flag '${shownToken(name)}'${label(spec)}.` +
          (suggestion ? ` Did you mean '${suggestion}'?` : "") +
          (known.length ? ` Known: ${known.join(", ")}.` : " This command takes no flags.") +
          " If this is a value that starts with '-', pass it as --flag=<value> or after '--'.",
        { flag: shownToken(name, 200), suggestion: suggestion ?? null, known },
      );
    }

    const flag = flags[key]!;
    if (flag.type === "boolean") {
      if (inline !== undefined) convert(spec, key, flag, inline, name); // always throws
      values[key] = true;
      provided.add(key);
      continue;
    }

    let raw: string;
    if (inline !== undefined) {
      raw = inline;
    } else {
      const next = argv[i + 1];
      const takesDash = flag.type === "string" && flag.allowDashValue;
      if (next === undefined || next === "--" || (!takesDash && FLAG_LIKE.test(next))) {
        const gotFlag = next !== undefined && next !== "--";
        throw argError(
          spec,
          "MISSING_VALUE",
          `${name} requires a value${label(spec)}` +
            (gotFlag
              ? ` (got flag '${shownToken(next)}'). If the value itself starts with '-', use ${name}=<value>` +
                ` (e.g. ${name}=${shownToken(next, 20)}).`
              : "."),
          { flag: name, next: next === undefined ? null : shownToken(next, 200), ...(gotFlag ? { hint: `${name}=<value>` } : {}) },
        );
      }
      raw = next;
      i++;
    }

    const value = convert(spec, key, flag, raw, name);
    if (flag.repeatable) {
      ((values[key] ??= []) as unknown[]).push(value);
    } else {
      if (provided.has(key)) {
        const prev = values[key];
        throw argError(
          spec,
          "DUPLICATE_FLAG",
          `--${key} given more than once${label(spec)} ('${shownToken(String(prev))}' then '${shownToken(String(value))}'); it takes a single value — pass it once.`,
          { flag: `--${key}`, values: [prev, value] },
        );
      }
      values[key] = value;
    }
    provided.add(key);
  }

  // Positionals
  const named: Record<string, unknown> = {};
  const specs = spec.positionals ?? [];
  let p = 0;
  for (const pos of specs) {
    if (pos.variadic) {
      const rest = positionals.slice(p);
      p = positionals.length;
      if (pos.required && rest.length === 0) {
        throw new CliError(pos.missingMessage ?? `Missing <${pos.name}>${label(spec)}.`, {
          code: pos.missingCode ?? spec.codes?.MISSING_ARGUMENT ?? ARG_ERROR_CODES.MISSING_ARGUMENT,
          details: { argument: pos.name },
        });
      }
      named[camelCase(pos.name)] = rest;
      continue;
    }
    const v = positionals[p];
    if (v === undefined) {
      if (pos.required) {
        throw new CliError(pos.missingMessage ?? `Missing <${pos.name}>${label(spec)}.`, {
          code: pos.missingCode ?? spec.codes?.MISSING_ARGUMENT ?? ARG_ERROR_CODES.MISSING_ARGUMENT,
          details: { argument: pos.name },
        });
      }
      named[camelCase(pos.name)] = undefined;
    } else {
      named[camelCase(pos.name)] = v;
      p++;
    }
  }
  const extra = positionals.slice(p);
  if (extra.length > 0 && !spec.allowExtraPositionals) {
    throw argError(
      spec,
      "UNEXPECTED_ARGUMENT",
      `Unexpected argument '${extra[0]}'${label(spec)}.` +
        (specs.length ? ` Expected: ${specs.map(s => `<${s.name}>`).join(" ")}.` : " This command takes no arguments.") +
        (extra.length > 1 ? ` (quote values that contain spaces)` : ""),
      { argument: extra[0], extra },
    );
  }

  // Required flags, defaults
  const out: Record<string, unknown> = {};
  for (const [key, flag] of Object.entries(flags)) {
    if (flag.required && !provided.has(key)) {
      throw new CliError(flag.missingMessage ?? `Missing required flag --${key}${label(spec)}.`, {
        code: flag.missingCode ?? spec.codes?.MISSING_FLAG ?? ARG_ERROR_CODES.MISSING_FLAG,
        details: { flag: `--${key}` },
      });
    }
    let v = values[key];
    if (v === undefined) {
      if (flag.type === "boolean") v = false;
      else if (flag.repeatable) v = [];
      else if ("default" in flag) v = flag.default;
    }
    out[camelCase(key)] = v;
  }

  for (const group of spec.exclusive ?? []) {
    const given = group.filter(k => provided.has(k));
    if (given.length > 1) {
      throw argError(
        spec,
        "CONFLICTING_FLAGS",
        `${given.map(k => `--${k}`).join(" and ")} cannot be combined${label(spec)}.`,
        { flags: given.map(k => `--${k}`) },
      );
    }
  }
  for (const group of spec.requireOneOf ?? []) {
    if (!group.some(k => provided.has(k))) {
      throw argError(spec, "MISSING_FLAG", `Provide one of ${group.map(k => `--${k}`).join(", ")}${label(spec)}.`, {
        flags: group.map(k => `--${k}`),
      });
    }
  }

  return {
    flags: out as ParsedArgs<S>["flags"],
    positionals: named as ParsedArgs<S>["positionals"],
    extra: spec.allowExtraPositionals ? extra : [],
    afterDoubleDash,
    provided,
  };
}

function checkSpec(spec: ArgsSpec): void {
  const seen = new Map<string, string>();
  for (const [key, flag] of Object.entries(spec.flags ?? {})) {
    if (key.startsWith("-")) throw new Error(`defineArgs: flag key '${key}' must not start with '-'`);
    if (flag.type === "boolean" && (flag.required || flag.repeatable)) {
      throw new Error(`defineArgs: boolean flag '${key}' cannot be required or repeatable`);
    }
    for (const t of flagSpellings(key, flag)) {
      if (!/^-{1,2}[A-Za-z][A-Za-z0-9-]*$/.test(t)) throw new Error(`defineArgs: bad flag spelling '${t}'`);
      if (seen.has(t)) throw new Error(`defineArgs: '${t}' declared by both '${seen.get(t)}' and '${key}'`);
      seen.set(t, key);
    }
  }
  const pos = spec.positionals ?? [];
  pos.forEach((p, i) => {
    if (p.variadic && i !== pos.length - 1) throw new Error(`defineArgs: variadic '${p.name}' must be last`);
  });
  for (const g of [...(spec.exclusive ?? []), ...(spec.requireOneOf ?? [])]) {
    for (const k of g) if (!(k in (spec.flags ?? {}))) throw new Error(`defineArgs: group names unknown flag '${k}'`);
  }
}

/** Declare a command's arguments. `parse(argv)` returns typed values or throws a CliError. */
export function defineArgs<const S extends ArgsSpec>(spec: S): ArgsDef<S> {
  checkSpec(spec);
  return {
    kind: "args",
    spec,
    parse: (argv: readonly string[]) => parseWithSpec(spec, argv),
  };
}

/**
 * Declare a command with sub-actions (`history list|show|restore`). argv[0]
 * selects the sub-spec; the rest is parsed against it.
 */
export function defineSubcommands<const M extends SubcommandsSpec>(
  subcommands: M,
  options: SubcommandsOptions<M> = {},
): SubcommandsDef<M> {
  for (const [name, s] of Object.entries(subcommands)) {
    checkSpec(s);
    if (options.command && !s.command) (s as ArgsSpec).command = `${options.command} ${name}`;
    if (options.codes && !s.codes) (s as ArgsSpec).codes = options.codes;
  }
  const names = Object.keys(subcommands);
  return {
    kind: "subcommands",
    subcommands,
    options,
    parse(argv: readonly string[]): ParsedSubcommand<M> {
      const first = argv[0];
      const resolved =
        first === undefined ? undefined : Object.hasOwn(subcommands, first) ? first : options.aliases?.[first];
      if (resolved !== undefined) {
        return { subcommand: resolved, ...parseWithSpec(subcommands[resolved]!, argv.slice(1)) } as ParsedSubcommand<M>;
      }
      if (options.default !== undefined) {
        return { subcommand: options.default, ...parseWithSpec(subcommands[options.default]!, argv) } as ParsedSubcommand<M>;
      }
      const where = options.command ? ` for '${options.command}'` : "";
      if (first === undefined || FLAG_LIKE.test(first)) {
        throw argError(
          options,
          "MISSING_SUBCOMMAND",
          options.missingMessage ?? `Missing subcommand${where}. Expected one of: ${names.join(", ")}.`,
          { expected: names },
        );
      }
      const suggestion = suggest(first, names);
      throw argError(
        options,
        "UNKNOWN_SUBCOMMAND",
        `Unknown subcommand '${first}'${where}.` +
          (suggestion ? ` Did you mean '${suggestion}'?` : "") +
          ` Expected one of: ${names.join(", ")}.`,
        { subcommand: first, suggestion: suggestion ?? null, expected: names },
      );
    },
  };
}

/** Every ArgsSpec inside a def (one, or one per subcommand). */
export function specsOf(def: AnyArgsDef): ArgsSpec[] {
  return def.kind === "args" ? [def.spec] : Object.values(def.subcommands);
}

/** Every flag spelling a def accepts (union over subcommands). */
export function acceptedFlags(def: AnyArgsDef): Set<string> {
  const out = new Set<string>();
  for (const s of specsOf(def)) {
    for (const [key, flag] of Object.entries(s.flags ?? {})) for (const t of flagSpellings(key, flag)) out.add(t);
  }
  return out;
}

/** True when the def declares `flag` (e.g. `--verbose`) itself, so the runner must not strip it. */
export function declaresFlag(def: AnyArgsDef | undefined, flag: string): boolean {
  return def ? acceptedFlags(def).has(flag) : false;
}
