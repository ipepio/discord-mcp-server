# Security policy

This project is a self-hosted MCP server: it holds a Discord bot token, OAuth client credentials, a
PostgreSQL connection string and the mirrored message content of one Discord guild. A vulnerability here
can therefore expose a private server's history or grant someone else's permissions, so reports are
taken seriously.

## Reporting a vulnerability

**Do not open a public issue, pull request or discussion for a suspected vulnerability.**

Report it privately to the address below. If this repository is published on GitHub with private
vulnerability reporting enabled, that form is equally acceptable.

> **Maintainer: replace this placeholder with the private contact before publishing.**
> Security contact: `<add-a-private-address-here>`

Please include:

- what an attacker gains (data exposure, privilege escalation, denial of service, credential leak);
- the affected version or commit, and the deployment shape (compose, container image, bare Node);
- reproduction steps or a proof of concept, as small as you can make it;
- anything you already know about the fix or the affected configuration.

Never include real bot tokens, client secrets, database credentials, message content or a real guild
id in a report. Redact them; a description of the mechanism is enough.

## What to expect

- An acknowledgement, best effort, within a few days. This is a volunteer-run project with no
  on-call rotation and no bug bounty.
- An assessment: whether it is in scope, how it is rated, and roughly when a fix can land.
- Credit in the release notes for the fix, unless you prefer to stay anonymous.
- No public detail before a fixed release exists. If a report is not going to be fixed, that will be
  said plainly instead of being left open silently.

## Supported versions

Only the latest released version receives fixes. The default branch is development: it is not a
supported release, and a report against an unmerged change may be answered with "reproduce on the
latest release".

## In scope

- Authentication and session handling for the MCP and REST surfaces: token issuance, session
  lifetime and revocation, client registration, redirect handling.
- Authorization and data filtering: a caller reading a channel, thread or message their Discord
  permissions do not allow, or a registry snapshot being served after it was known to be stale.
- Secret handling: a bot token, client secret, database URL or session token appearing in a log, an
  error message, an HTTP response or a repository file.
- SQL injection, unsafe identifier interpolation, and anything that escapes the repository layer.
- Role or permission state being attributed to the wrong guild, channel or member.
- Unsafe defaults in the shipped compose file or container image that expose the database or the
  application on a wider interface than documented.

## Out of scope

- Vulnerabilities in Discord itself, in PostgreSQL or in an upstream dependency: report those
  upstream. A dependency version this project pins is still worth mentioning here if it is known to
  be affected.
- Findings that require an already-compromised host, an operator's own leaked `.env`, or physical
  access to the deployment.
- Missing security headers, scanner output with no demonstrated impact, and best-practice opinions
  without a mechanism to exploit.
- Denial of service by brute volume against your own deployment, when no documented rate limit is
  bypassed.
- Anything that needs a real Discord installation's credentials or member data. Do not test against a
  guild you do not own or administer.

## Safeguards for reporters

This repository never contains a credential, a real guild id or production infrastructure detail, so a
report can be reproduced against a throwaway Discord application and a local PostgreSQL container.
Please work that way, and stop at the first demonstration that a boundary is crossed.
