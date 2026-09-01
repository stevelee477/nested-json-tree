# Security Policy

## Supported versions

Security fixes are provided for the latest released version of Nested JSON Tree.

## Reporting a vulnerability

Please do not disclose a vulnerability in a public issue. Use GitHub's private
vulnerability reporting for this repository, or email
`hi.whoareyou12@gmail.com` if private reporting is unavailable.

Include the extension version, VS Code version, operating system, impact, and a
minimal sanitized reproduction. Do not attach real logs, credentials, internal
URLs, or personal data.

## Data handling

Nested JSON Tree parses editor content locally in the VS Code Extension Host.
The extension does not send document content over the network and does not
collect telemetry. Opening a parsed value in an editor or copying a value only
uses VS Code's local editor and clipboard APIs.
