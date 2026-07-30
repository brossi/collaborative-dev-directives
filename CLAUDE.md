# CLAUDE.md — Collaborative Development Directives

## API rate limits are a hard constraint, not a tuning knob

Always adhere to a site's or API's published rate limits — and when limits
are undocumented, default to conservative pacing rather than discovering the
threshold by tripping it. Learned the hard way (2026-07): a bulk Spotify
search job paced at ~7 req/s triggered *extended* rate limiting — a 429 with
a ~22-hour Retry-After scoped beyond the client ID — turning a 30-minute job
into a multi-day recovery.

Rules for any script or feature that calls an external service in bulk:

1. **Look up the documented limits first** and pace below them. No published
   number → start at ≤ 1-2 req/s for bulk jobs and only raise with evidence.
2. **Honor `Retry-After` visibly.** Log every rate-limit sleep with its
   duration; never sleep silently. Cap a single sleep and surface the value
   so a human can decide whether to wait or change approach.
3. **Set network timeouts on every request** and log retries — a stalled job
   must be distinguishable from a slow one.
4. **Design for resume.** Bulk jobs write incremental output and skip
   completed work on restart, so an interruption (or penalty) never loses
   progress.
5. **Assume penalties may outlive the credential.** Extended limiting can be
   scoped to the account or IP, not just the API key — swapping keys is a
   diagnostic, not a fix. The reliable fixes are gentler pacing and time.
6. **Total the request count before running** (items × requests-per-item)
   and sanity-check it against the service's daily quota; split or sample
   the job if it's a meaningful fraction of the quota.
