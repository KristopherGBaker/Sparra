export interface Args {
  positionals: string[];
  // A flag repeated on the command line (e.g. `--prior-critique a --prior-critique b`) accumulates
  // its string values into an array; single flags stay `string | boolean` as before.
  flags: Record<string, string | boolean | string[]>;
}

export function parse(argv: string[]): Args {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-k") {
      flags.k = argv[++i] ?? "";
    } else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      let value: string | boolean = true;
      if (next !== undefined && !next.startsWith("-")) {
        value = next;
        i++;
      }
      const prior = flags[key];
      if (prior === undefined || typeof value !== "string") {
        flags[key] = value; // first occurrence, or a bare boolean flag
      } else {
        // Repeated with a value → accumulate into an array (a first string becomes a 2-element array),
        // so a repeatable flag like `--prior-critique` collects every path in given order.
        flags[key] = Array.isArray(prior) ? [...prior, value] : typeof prior === "string" ? [prior, value] : value;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}
