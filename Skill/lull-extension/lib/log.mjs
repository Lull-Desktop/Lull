/**
 * Output conventions: human-readable output goes to stdout, diagnostics and errors to stderr.
 *
 * The prefixes are a stable contract (scripts and AI can parse them):
 *   [info] [ok] [warn] [error] [step] [item] [next]
 */
const isTty = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

const wrap = (code) => (text) => (isTty ? `\u001b[${code}m${text}\u001b[0m` : text);

export const paint = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  cyan: wrap("36"),
};

function write(stream, prefix, message) {
  stream.write(`${prefix} ${message}\n`);
}

export const log = {
  info(message) {
    write(process.stdout, paint.cyan("[info]"), message);
  },
  ok(message) {
    write(process.stdout, paint.green("[ok]"), message);
  },
  warn(message) {
    write(process.stderr, paint.yellow("[warn]"), message);
  },
  error(message) {
    write(process.stderr, paint.red("[error]"), message);
  },
  step(message) {
    process.stdout.write(`${paint.bold("==>")} ${message}\n`);
  },
  /** Indented detail line, for file lists and diagnostics. */
  item(message) {
    process.stdout.write(`    ${message}\n`);
  },
  next(message) {
    process.stdout.write(`${paint.dim("[next]")} ${message}\n`);
  },
  /** Raw output (tables, help text and anything already laid out). */
  raw(text) {
    process.stdout.write(`${text}\n`);
  },
};

/** Usage error: exit code 2, so it is distinguishable from a validation failure. */
export function usageError(message) {
  const error = new Error(message);
  error.exitCode = 2;
  return error;
}
