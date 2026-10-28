# Media source validation — 2026-11-01

Rebased onto canonical `upstream/main` at `d60f736`; local `main` was not moved.
Checks used anonymous access and yt-dlp **2026.10.29.232701**. Results are per URL,
not a guarantee for every video on a provider. Test URLs are kept in
[`scripts/fixtures/media-sources.json`](../scripts/fixtures/media-sources.json).

The local fixtures are generated three-second recordings. The Spaces row exercises the
storage routing and HTTP fetch locally, not a real DigitalOcean account. Each completed
transfer was measured with ffprobe and its second call checked for cache reuse. Remote
inspection-only rows establish extraction, not a completed download.

| Case | Observed result | Duration (s) | Bytes |
|---|---|---:|---:|
| interrupted | Interrupted-transfer recovery passed |  |  |
| file | Full download and cache reuse passed | 3 | 258847 |
| audio | Full download and cache reuse passed | 3.018594 | 24779 |
| redirect | Full download and cache reuse passed | 3 | 258847 |
| octet | Full download and cache reuse passed | 3 | 258847 |
| html5 | Full download and cache reuse passed | 3 | 258847 |
| hls | Full download and cache reuse passed | 3.041814 | 259586 |
| dash | Full download and cache reuse passed | 3 | 258848 |
| multiple | Refused: playlist |  |  |
| empty | Refused: unsupported |  |  |
| 404 | Refused: not_found |  |  |
| spaces | Full download and cache reuse passed | 3 | 258847 |
| youtube | Full download and cache reuse passed | 213.089524 | 33905184 |
| wistia | Refused: error |  |  |
| peertube | Full download and cache reuse passed | 114.062675 | 16815344 |
| dailymotion | Refused: error |  |  |
| kextv-page | Metadata resolved; no full transfer in this run |  |  |
| vimeo-event-embed-only | Refused: embed_only |  |  |
| vimeo-video | Refused: login_required |  |  |
| facebook | Refused: error |  |  |
| youtube-channel | Refused: playlist |  |  |
| krakow-file | Metadata resolved; final CLI full transfer verified separately | 2625.77 | 363179660 |
| krakow-rss | Refused: unsupported |  |  |
| wistia-channel-media | Refused: error |  |  |
| dailymotion-player | Metadata resolved; full transfer deliberately stopped (2 GB sample) |  |  |

The full matrix started during review, before the final cache-key and input-handling fixes.
Targeted reruns verified the final HTML5 cache path, malformed-ID route handling, and updater
termination. The Dailymotion transfer was stopped explicitly; its incomplete transfer is
not counted as a successful download or a provider failure. A later inspection-only run
resolved it as a 2,756-second recording. The fixture now disables full transfer for that
sample, and the runner skips any requested sample longer than ten minutes.

Additional checks:

- A dropped connection reproduced cache poisoning: the old code reused a 4,096-byte partial
  instead of fetching the 258,847-byte recording. The corrected path publishes only a
  completed file and passed the recovery test.
- Cache unit tests reproduced collisions between HTML5 videos on different councils' pages
  and between distinct ids that sanitize to the same filename. The corrected keys passed.
- HTML5 download/cache reuse was rerun with the final URL-scoped cache key.
- Both normal updater completion and a stuck updater ignoring SIGTERM were tested with a
  deterministic binary fixture. Inspection waited safely; timeout killed the updater and
  waited for its close event before permitting reads.
- A malformed YouTube id reproduced an Express unhandled rejection. The corrected endpoint
  returned a handled refusal and stayed available. HTTP(S) validation and valid inspection
  responses were also checked through the local route.
- Final required checks: typecheck, build, and **1,637 tests in 114 files passed**.

Known limits:

- Facebook still fails extraction with `Cannot parse data` for the tested share URL.
- Both Wistia samples fail inside its extractor (`Error while getting the playlist: True`).
  This is evidence about these URLs with this binary and network, not a site-wide verdict.
- Bare Vimeo event/video URLs require an embedding page or credentials. KEX TV's actual
  programme page resolves correctly. Its full 39:52 recording and the Kraków MP4 were
  downloaded in the earlier validation. This matrix rechecked their metadata, and the
  final built `download-ytv --download-only` command also downloaded the entire Kraków
  part again: 363,179,660 bytes and 2,625.77 seconds.
- A just-ended real livestream was not available for testing. Completeness and retry
  transitions remain covered by the injected-clock unit tests.
- Authentication cookies, password-protected recordings, browser impersonation, explicit
  referers and provider-specific extractor arguments are not an end-to-end tested contract.
  In particular the plain HTTP file downloader does not inherit yt-dlp cookie/proxy config.
- Inspection does not prove media-fragment access or DRM-free transfer, and Spaces inspection
  does not check object existence. Source timestamps are not proof of meeting dates.

The source-resolution and application integration flow is documented in
[`media-sources.md`](media-sources.md). No app code was changed.
