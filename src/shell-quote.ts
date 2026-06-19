// mu — shared POSIX single-quote helper.
//
// Wrap a token in single quotes for safe interpolation into a /bin/sh
// command we render for the user to copy-paste (e.g. next-step hints).
// Embedded single-quotes are escaped via the canonical close-reopen
// idiom: ' → '"'"'.

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'"'"'`)}'`;
}
