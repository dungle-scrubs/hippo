# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do not** open a public GitHub issue
2. Email: kevin@dungle-scrubs.dev
3. Include: description, reproduction steps, impact assessment

You should receive a response within 48 hours.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | ✅ Latest only |

## Scope

Hippo stores data in local SQLite databases. The MCP server exposes
tools over HTTP/SSE or STDIO. Security concerns include:

- SQL injection via tool parameters
- Unauthorized access to the MCP server
- Secrets in environment variables or git history
- Denial of service via large inputs
