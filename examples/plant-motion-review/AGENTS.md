# Plant motion review

This directory is an intentionally isolated review experiment, not the production renderer. V1 is a byte-for-byte accepted standalone artifact plus its original modules; never edit or format v1.html or v1/*.js. Verify its documented digest.

Why separate: the user explicitly requested preserving V1 next to experimental V2 and forbade silently replacing production avatars. V2 reuses V1 SVG geometry, palettes and the SVG renderer scaffolding. Only its reusable pure motion controller and the comparison harness are new. Production integration requires a later reviewed change; do not update production golden digests here.

Use node server.mjs from this directory (or the root package script). Keep the review offline, mobile friendly, state labels textual, one active state per instance and interruptible transitions. Test actual browser visuals, reduced motion, pause/resume and hidden/offscreen scheduling. A page parameter test alone is not visual QA. Keep compact, non-sensitive browser evidence in evidence/ and raw test output out of Git.
