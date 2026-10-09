# Changelog

## Unreleased

- Repair generated API inputs, required paths and meaningful tool names for all vendors.
- Keep nested input fields and real optional fields compact, with local API validation.
- Bound Vercel live logs, skip malformed records and honor cancellation.
- Preserve useful vendor errors, redact secrets and let fetch manage controlled headers.
- Add runtime dependencies `ajv` and `ajv-formats` for input validation and API formats.
