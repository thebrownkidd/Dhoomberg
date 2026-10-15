# Security

## Scope

Dhoomberg is a local desktop application. The server binds to `127.0.0.1` and is not exposed to your network or the internet. Security issues that apply:

- Authentication bypass for the local API
- Secret leakage (plaintext API keys in logs, responses or exports)
- Injection via plugin inputs or news content
- Privilege escalation via Python plugins

Issues that are out of scope:
- Attacks requiring physical access to the machine
- Attacks requiring the user to install a malicious plugin themselves (plugins run with the user's own permissions by design; only install trusted plugins)

## Known design decisions

**Python plugins run with your permissions.** The `plugins/` directory is loaded automatically. Only put plugins you trust there. This is documented in the README.

**The Yahoo Finance endpoint is unofficial.** It may stop working at any time or change its format. It is provided for convenience, not reliability.

**The master key is a local file.** If you lose `.dhoomberg/master.key` (or the `DHOOMBERG_MASTER_KEY` environment variable), all stored secrets are unrecoverable. Back it up.
