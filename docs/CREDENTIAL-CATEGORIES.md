# Credential categories

Which credentials an agent might come near, what type each one is, and which
kind of brokering would keep it out of the agent's reach. The type matters
more than the product: it decides whether a proxy, a host-side helper or a
signing agent can cover it.

**Status: survey, not implemented.** The kit brokers SSH signing today and
nothing else on this page. The tables are from general knowledge and were not
checked against vendor documentation. Verify a row before designing around it.

For the brokering shapes themselves, see [BROKERING.md](BROKERING.md), and
[Beyond the model token](BROKERING.md#beyond-the-model-token) for how the
options surveyed there measure up against these types. For the
credentials this kit handles now, see [CREDENTIALS.md](CREDENTIALS.md).

## Types and what covers them

| Type | How it is used | Brokering that covers it |
|---|---|---|
| Static bearer token or API key | sent in an HTTP header on every request | injecting proxy (placeholder swapped on the way out), or a gateway that holds the key |
| Basic auth | username and password in an HTTP header | injecting proxy |
| OAuth client credentials | client ID and secret exchanged for a short-lived token | host-side helper does the exchange and hands over only the short-lived token, or an injecting proxy |
| OAuth refresh token | long-lived token granted by a user, exchanged for short-lived access tokens | host-side helper or gateway holds the refresh token and hands over access tokens |
| Request-signing key | private key signs a short-lived JWT or each request | host-side helper mints the JWT or re-signs; the key stays on the host |
| Artifact- or challenge-signing key | private key signs a binary, a commit or a login challenge | signing agent or signing service; only signatures cross. An HTTP proxy does not help |
| Client certificate (mutual TLS) | private key proves identity in the TLS handshake | TLS-terminating proxy on the host that holds the certificate |
| Password over a non-HTTP protocol | database or mail login inside the protocol's own handshake | protocol-aware proxy on the host, or short-lived credentials issued per session. An HTTP proxy does not help |
| Browser session cookie | a signed-in browser profile the agent drives | none; use a separate profile holding only the logins the task needs |
| Unlocking secret | passphrase or export that decrypts other keys | treat as the keys it unlocks |
| Human, interactive credential | password, 2FA code, recovery key | none; keep it away from agents and have a person do the step |
| Server-held token | long-lived token that belongs inside a server | none needed; it should not be on a developer machine |

An HTTP-level broker covers bearer tokens, basic auth and both OAuth types,
and request-signing keys if it can mint or re-sign. Signing keys need the
pattern this kit already uses for SSH: the key stays on the host and only
signatures cross. Non-HTTP passwords and browser sessions are outside what an
HTTP broker can reach.

## Apple-specific targets

Credentials used to build, sign, ship and manage software for Apple platforms.

| Credential | Used for | Type |
|---|---|---|
| Developer ID Application and Installer certificates | signing Mac apps and packages for distribution outside the App Store | artifact-signing key |
| Apple Development and Apple Distribution certificates | signing iOS and Mac App Store builds | artifact-signing key |
| `.p12` export of a signing identity | moving a certificate and key between machines or into CI | unlocking secret |
| `fastlane match` passphrase | decrypting the shared certificate repository | unlocking secret |
| App Store Connect API key (`.p8`) | TestFlight, App Store uploads, `notarytool` | request-signing key |
| Apple ID with app-specific password | `notarytool` and uploads without an API key | basic-auth-style secret tied to a human account |
| Apple ID with 2FA | developer portal, App Store Connect web, Xcode account sign-in | human, interactive credential |
| APNs auth key (`.p8`) | sending push notifications | request-signing key |
| APNs provider certificate | sending push notifications, older method | client certificate |
| Sparkle EdDSA key | signing Mac app updates | artifact-signing key |
| Jamf Pro API client | managing devices through the Jamf API | OAuth client credentials |
| Workspace ONE UEM OAuth client | managing devices and apps through the UEM API | OAuth client credentials |
| Workspace ONE UEM basic auth with tenant code | the same, older method | basic auth plus static API key |
| Kandji API token | managing devices through the Kandji API | static bearer token |
| Intune app registration (Microsoft Graph) | managing Apple devices through Intune | OAuth client credentials, with a secret or a certificate |
| Munki repository credentials | reading or publishing packages | basic auth, client certificate, or cloud storage keys |
| MDM push certificate | the MDM server's channel to Apple's push service | server-held token |
| Apple Business Manager or School Manager server token | automated device enrolment sync | server-held token |
| Apps and Books (VPP) content token | licence assignment | server-held token |
| FileVault recovery key | unlocking an encrypted disk | human, interactive credential |
| Local admin password | `sudo`, installs, system settings | human, interactive credential |

Notes on the rows that do not fit a broker:

- **Code signing and notarization.** The usual answer is to run that step on
  the host or in CI, outside the agent's environment. The agent produces the
  build; something else signs it.
- **Apple ID sign-in.** Prefer an App Store Connect API key, which a helper can
  broker. An Apple ID session cannot be scoped or brokered in the same way.
- **Server-held tokens.** If one of these is on a developer machine, the fix is
  to move it, not to broker it.

## Other likely use cases

Where a Mac user running a coding agent is likely to want the agent to act
with their credentials, beyond Apple platform work.

| Use case | Typical credentials | Type | Why separation helps |
|---|---|---|---|
| Other git hosts and commit signing | GitLab, Bitbucket, Azure DevOps tokens; GPG or SSH signing keys | static bearer token; artifact-signing key | a token usually reaches every repository you can; a signing key vouches for you |
| Publishing packages | npm, PyPI, crates.io, Docker Hub, CocoaPods tokens | static bearer token | a leaked token lets someone publish malware under your name |
| Cloud and deployment | AWS, GCP, Azure credentials; kubeconfig; Terraform, Cloudflare, Vercel, Fly tokens | request-signing key; static bearer token; client certificate | high blast radius and real cost; short-lived, scoped credentials are available |
| Other model and tool APIs | OpenAI, Anthropic, Hugging Face keys; search API keys | static bearer token | billable from anywhere if leaked, as with the Copilot token |
| MCP servers and SaaS tools | Slack, Jira, Linear, Notion, Google Workspace, Microsoft 365 | OAuth refresh token | grants are often broad and long-lived, and cover private data |
| Databases | Postgres or MySQL connection strings, Supabase service keys, Redis passwords | password over a non-HTTP protocol; static bearer token | direct read and write of production data |
| Payments and billing | Stripe, Paddle keys | static bearer token | live keys move money; test keys are safe to hand over |
| Remote machines | SSH to servers or a home lab, Tailscale or VPN auth keys, remote `sudo` | challenge-signing key; static bearer token; human credential | lateral movement beyond the Mac |
| Secrets managers | 1Password CLI sessions and service-account tokens | unlocking secret | one credential that unlocks all the others |
| Browser automation | signed-in sessions in a browser the agent drives | browser session cookie | the agent acts as you on every signed-in site, past any 2FA |
| Monitoring and CI | Sentry, Datadog tokens; CI secrets settings | static bearer token | read access to logs that often contain other secrets |
| Home and personal | Home Assistant tokens, DNS registrar APIs, email (IMAP/SMTP) | static bearer token; password over a non-HTTP protocol | email access can reset most other accounts |

Notes:

- **Scope before brokering.** Many of these services issue narrower
  credentials: per-project tokens, read-only keys, test-mode keys, short-lived
  cloud sessions. A scoped credential limits damage from use, which brokering
  does not.
- **Secrets managers.** Giving the agent a session to the manager undoes the
  separation for everything stored in it. Fetch the one secret on the host and
  pass only that, or broker it.
- **SSH to remote machines.** The kit's forwarded agent already covers this,
  with the same caveat as for GitHub: the key is safe, but what the agent does
  on the remote machine during the session is not undone.
