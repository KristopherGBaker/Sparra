// Tiny console logger with ANSI color. No deps.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  dim: c("2"),
  bold: c("1"),
  red: c("31"),
  green: c("32"),
  yellow: c("33"),
  blue: c("34"),
  magenta: c("35"),
  cyan: c("36"),
  gray: c("90"),
};

export function banner(title: string): void {
  const line = "─".repeat(Math.max(8, title.length + 2));
  process.stdout.write(`\n${color.cyan("┌" + line)}\n${color.cyan("│")} ${color.bold(title)}\n${color.cyan("└" + line)}\n`);
}

export function info(msg: string): void {
  process.stdout.write(`${color.blue("›")} ${msg}\n`);
}
export function ok(msg: string): void {
  process.stdout.write(`${color.green("✓")} ${msg}\n`);
}
export function warn(msg: string): void {
  process.stdout.write(`${color.yellow("!")} ${msg}\n`);
}
export function err(msg: string): void {
  process.stderr.write(`${color.red("✗")} ${msg}\n`);
}
export function step(msg: string): void {
  process.stdout.write(`${color.magenta("◆")} ${color.bold(msg)}\n`);
}
export function detail(msg: string): void {
  process.stdout.write(`  ${color.gray(msg)}\n`);
}
