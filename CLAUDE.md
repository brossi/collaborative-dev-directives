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
5. **Distinguish rate limits from quotas.** A rate limit (rolling window)
   is survived by pacing and short sleeps; a quota (daily/long-term budget)
   is not — a quota 429 means STOP and save state, not sleep-and-retry.
   Spotify marks these with "reason": "QUOTA_EXCEEDED" and a ~24 h
   Retry-After; other services have equivalents. Budget-guard bulk jobs so
   they stop cleanly *before* the quota trips.
6. **Assume penalties/quotas may be scoped wider than the credential** —
   per developer account (all its API keys share one budget; Spotify does
   this as of July 2026) or per IP. Swapping keys within one account is a
   diagnostic, not a fix.
7. **Total the request count before running** (items × requests-per-item)
   and sanity-check it against the service's daily quota; split the job
   across days/accounts if it's a meaningful fraction of the quota.
