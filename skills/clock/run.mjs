// clock — committed-skill entry. Args arrive as JSON on stdin (unused here);
// the JSON result on stdout is returned to the model verbatim.
const now = new Date();
process.stdout.write(
  JSON.stringify({
    iso: now.toISOString(),
    local: now.toString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }),
);
