/**
 * Field separator for structured tmux `-F` output, plus an escape-tolerant
 * splitter for parsing it back.
 *
 * We build `-F` format strings by joining field expansions with the ASCII Unit
 * Separator (US, 0x1F): tmux session names cannot contain it, and
 * `pane_current_path` / option values realistically never do, so the parse side
 * can split on an exact field count with no rejoin gymnastics.
 *
 * The catch — and the reason this lives in one shared module — is that tmux does
 * not round-trip a literal non-printable byte through `-F` uniformly across
 * versions. tmux 3.6 passes the raw 0x1F through untouched, but tmux 3.4 (the
 * Ubuntu 24.04 build, among others) escapes it to the 4-character octal text
 * `\037`. A parser that splits on the raw byte alone therefore finds no
 * separator on 3.4 output and silently drops every row — which broke
 * `ctl status`, `ctl agent state`, and the Command Center's auto-pin detection
 * (GitHub issue #7). {@link splitFields} splits on either form so every parse
 * site works on both tmux versions.
 *
 * Note this only normalises the *separator*; field values are passed through
 * verbatim. A value containing a literal backslash-`037` is as unrealistic as
 * one containing a raw 0x1F, so we do not attempt general octal un-escaping
 * (which would corrupt paths that legitimately contain backslashes).
 */
export const US = "\x1f";

/** The raw US byte, or the octal-escaped text tmux 3.4 emits in its place. */
const FIELD_SEP = /\x1f|\\037/;

/**
 * Split one tmux `-F` output line into its fields, tolerant of whether tmux
 * passed the US separator through raw (3.6) or octal-escaped it (3.4).
 */
export function splitFields(line: string): string[] {
  return line.split(FIELD_SEP);
}
