// The review prompt must be byte-identical across vendors. The only variable
// between conditions B and C is which CLI receives it.
export function reviewPrompt(diff) {
  return [
    "You are reviewing a code change. Report only real defects: bugs, crashes,",
    "security issues, data loss, incorrect logic, broken edge cases.",
    "",
    "Output one line per defect, in exactly this format:",
    "DEFECT | <file>:<line> | <one sentence describing the defect>",
    "",
    "If you find no defects, output exactly: NO DEFECTS",
    "",
    "Do not report style, naming, formatting or documentation issues.",
    "Do not restate the diff. Do not explain your process. Output only the lines.",
    "",
    "--- DIFF ---",
    diff,
  ].join("\n");
}
