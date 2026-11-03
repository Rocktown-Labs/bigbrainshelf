# Factory operations agent rules

Read the repository root `AGENTS.md` before using or changing these
tools.

- The Python files here inspect or operate the deployed factory and its
  Cloudflare data. Many require RGM's separately configured service
  credentials. Repository access alone may not be enough to run them.
- Treat files under `audits/` as historical evidence. Do not edit or
  rename a completed run to make it agree with a later result. Add a new
  dated run folder and explain any change in method there.
- The Nov 2-3, 2026 judgment-run ledgers are in
  `audits/2026-11-02-judgment-run/`.
- When adding a report, include the book identifier used by the tool,
  the edition measured, the run date, and enough method detail for
  another agent to reproduce or challenge the result.
- Do not copy production credentials, customer information, or private
  service responses into an audit file.
