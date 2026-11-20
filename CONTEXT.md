# Discord MCP Server — Domain Glossary

Ubiquitous language for Discord MCP Server: a self-hosted MCP server that syncs Discord messages
into PostgreSQL and lets authenticated users query exactly what their Discord permissions allow.

## Language

**Installation**:
One self-hosted deployment of the hub, with its own Discord application/bot, database and
configuration, serving exactly one guild. The unit an operator deploys and owns. A client may
connect to several installations to work across guilds.
_Avoid_: instance, deployment, tenant

**Guild**:
The single Discord server an installation ingests. Cross-guild breadth comes from a client
connecting to several installations, never from one installation serving multiple guilds.
_Avoid_: server (ambiguous), workspace

**User**:
A person who authenticates through Discord OAuth2 and queries an installation. Their access is
bounded by their Discord permissions, never by tool arguments.
_Avoid_: account, member (that is the per-guild relationship)

**Membership**:
A user's relationship to the installation's guild. A user holds zero or one; only members of the
installation's guild are queryable.
_Avoid_: subscription, access
