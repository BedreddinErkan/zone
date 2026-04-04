export const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",

  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  orange: "\x1b[38;5;208m",

  bgGreen: "\x1b[42m",
  bgRed: "\x1b[41m",
  bgBlue: "\x1b[44m",
};

export function colorize(text: string, ...codes: string[]): string {
  return codes.join("") + text + c.reset;
}

export function badge(text: string, color: string): string {
  return colorize(` ${text} `, c.bold, color);
}
