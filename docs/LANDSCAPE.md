# Sandboxing landscape

How Mac and iOS developers, and coding-agent tools, usually isolate software.
This is background for choosing between approaches, not a claim about how
pi-roost compares. For the head-to-head with Docker Sandboxes, see
[COMPARISON.md](COMPARISON.md). For this kit's own threat model, see
[SECURITY.md](SECURITY.md).

These notes are from general knowledge and were not re-verified against
current vendor documentation while writing. Check specifics before relying on
them, especially anything about agent-tool defaults. The exception is the
`sandbox-exec` deprecation, which is sourced
[below](#the-sandbox-exec-deprecation).

## Apple platform sandboxing

- **App Sandbox (iOS and macOS).** Enforced by the kernel through the
  TrustedBSD MAC framework and Seatbelt profiles. Capabilities are granted
  through entitlements such as `com.apple.security.app-sandbox`,
  `network.client`, and user-selected file read/write. On iOS it is always on
  and cannot be disabled. On macOS it is mandatory for App Store apps.
  Persistent file access uses security-scoped bookmarks.
- **Hardened Runtime and notarization.** Used by most macOS apps distributed
  outside the App Store. It restricts code injection and dynamic library
  loading but is not the same as the App Sandbox.
- **XPC helper services.** The common pattern is to keep the main app lightly
  sandboxed and move risky work, such as parsing untrusted files, into separate
  sandboxed helpers. Safari and Chromium use this design.
- **`sandbox-exec` with custom SBPL profiles.** Apple has deprecated it (see
  [below](#the-sandbox-exec-deprecation)), but it
  is still widely used for build tools, test runners, and CI jobs. Tools such as
  Nix and Bazel use it on macOS.
- **VMs and containers.** Virtualization.framework-based tools (Tart, UTM,
  OrbStack), Docker Desktop, and Apple's `container` CLI give stronger
  isolation for untrusted code and disposable environments.

## Coding agents

- **Seatbelt via `sandbox-exec`.** The most common lightweight option on macOS.
  Claude Code's sandbox mode and OpenAI's Codex CLI both use it to limit file
  writes to the project and restrict network access. It has no VM overhead, but
  profiles are fiddly and the underlying tool is deprecated, with no removal
  date — see [below](#the-sandbox-exec-deprecation).
- **VMs and containers.** Used when agents run arbitrary commands, install
  packages, or work long-term. Stronger isolation and easy reset.
- **Git worktrees or throwaway copies.** The agent works on its own checkout or
  branch, so mistakes are easy to review or revert. This does not isolate the
  process.
- **Supporting controls:** permission prompts and command allowlists, network
  egress filtering through a proxy, and keeping credentials out of reach unless
  a task needs them.
- **Agents built into an app:** App Sandbox plus XPC helpers, with the app
  mediating access to user-selected files.

## IDE extensions (Copilot in VS Code and PyCharm)

IDE extensions run with the user's full permissions and are not sandboxed by
default. VS Code runs extensions in a Node extension host. PyCharm plugins run
inside the IDE's JVM. Both can read any file the user can, use SSH agents and
tokens, and reach the network. On macOS they also inherit the IDE app's
privacy grants.

Main risks:

- **Context leakage.** Copilot sends open files, neighboring tabs, and sometimes
  repository context to a cloud model. Unscrubbed secrets in those files can
  leave the machine.
- **Prompt injection.** Text in a README, comment, dependency, or issue can steer
  the model, most dangerously in agent or chat modes that edit files or run
  commands.
- **Insecure or licensed output.** Suggestions can contain vulnerabilities,
  outdated APIs, or copied code.
- **Supply chain.** Typosquatted or compromised extensions get the same access
  as the official one.
- **Autonomy.** Auto-approve turns a suggestion into real commands and writes.

Built-in controls: VS Code Workspace Trust (restricts extensions and tasks in
untrusted folders), the JetBrains "Trust project" dialog, Copilot content
exclusions for organizations, and tool approval prompts for agent mode.

Practical hardening: use a devcontainer or VM for untrusted repos, keep
long-lived credentials out of the workspace, install only verified extensions
and review updates, and use a proxy if you need to know what leaves the machine.

## Per-process sandboxes: cplt

[navikt/cplt](https://github.com/navikt/cplt) is a single binary that wraps a
coding agent's process instead of running it in a VM. Its README describes:

- **macOS:** Seatbelt via `sandbox-exec`, with a generated SBPL policy.
- **Linux:** Landlock + seccomp-BPF, optionally with Bubblewrap namespaces.
- **Windows:** not supported natively; use WSL2.
- **Agents:** Copilot CLI, OpenCode, Gemini CLI, Claude Code, Pi, goose, or any
  shell.
- **Policy:** `.cplt.toml` in the repo, approved per developer with
  `cplt trust accept`.
- **Other controls:** environment filtering, credential-directory denies,
  outbound domain filtering through a proxy, and command guards that block
  `gh pr merge`, `gh repo delete`, and pushes to `main`/`master`.

How it compares:

- **Raw `sandbox-exec` profiles:** cplt is a maintained, packaged version of
  that approach with extra defaults.
- **Claude Code's sandbox runtime:** the closest peer. cplt turns on more by
  default (env filtering, credential dirs, lifecycle-script blocking); the
  runtime offers SOCKS5, TLS inspection, and a TypeScript library API.
- **Copilot CLI's built-in sandbox:** per the README, GA with an admin-set
  policy, and it runs on Windows. Policy is not stored in the repo, and it
  confines the process without stopping authorised `git`/`gh` calls. cplt's
  README says it guards those commands instead.
- **VMs (pi-roost, Docker Sandboxes):** no VM boundary, so lighter to run, and
  it doesn't replace Docker's full isolation. Credentials stay on the same
  machine as the agent, behind path denies and env filtering, where pi-roost
  keeps them on the host. The exception is GitHub and Copilot tokens, which
  cplt can replace with a placeholder that its proxy swaps on the way out. See
  [BROKERING.md](BROKERING.md#cplt-placeholder-injection-for-github-and-copilot-tokens).

Its README lists its own gaps: weaker file-level enforcement on Linux, no
read-only or workspace-write presets yet, and an all-or-nothing Keychain grant
on macOS. This section is based on the README and docs alone; cplt has not been
installed or tested here.

For pi-roost, cplt supports Pi and could run inside the VM as a second layer.
It would also address the missing egress policy noted in
[COMPARISON.md](COMPARISON.md).

## The `sandbox-exec` deprecation

The per-process agent sandboxes on macOS (cplt, Claude Code's sandbox, Codex
CLI) are built on an interface Apple has deprecated. Checked on 15 November
2026.

What is and is not deprecated:

- **Deprecated:** the `sandbox-exec` command and the C API in `sandbox.h`
  (`sandbox_init` and its named profiles).
- **Never supported:** the profile language, SBPL. Apple does not treat it as
  API.
- **Not deprecated:** the kernel sandbox underneath. App Sandbox runs on the
  same implementation.
- **Not involved:** IDE extensions, which run unsandboxed.

Sources:

- **`man sandbox-exec`** on macOS 26.6.2: *"The sandbox-exec command is
  DEPRECATED. Developers who wish to sandbox an app should instead adopt the
  App Sandbox feature described in the App Sandbox Design Guide."* The page is
  dated March 9, 2017.
- **`sandbox.h`** in the macOS 26.5 SDK: *"This header is deprecated and may be
  removed in a future release."* Each function carries
  `API_DEPRECATED("No longer supported", macos(10.5, 10.8))`, so the API has
  been deprecated since macOS 10.8.
- **Apple Developer Technical Support (DTS)**, forum thread
  [777509](https://developer.apple.com/forums/thread/777509), March 2025:
  *"What you're doing here is unsupported. While there is a public API for
  setting up a custom sandbox, albeit a deprecated one, the sandbox programming
  language (SBPL) has never been documented for third-party use, and thus is
  not considered API."*

Timeline:

- **No removal date.** Apple's only wording is "may be removed in a future
  release". The command is present and runs on macOS 26.6.2.
- **A replacement exists, with a restriction.** In the same thread, September
  2026, DTS says macOS 27 introduced `es_new_descendants_client` in Endpoint
  Security for sandboxing child processes. It needs the privileged Endpoint
  Security entitlement. DTS mentions a request to relax that and adds *"I
  can't make any promises."* Not checked here; this kit's test VM runs
  macOS 26.
- **Supported options today**, per DTS in October 2026: *"ES, App Sandbox, and
  Virtualization."*
- **No answer on timing.** An open issue asking Apple for a timeline,
  [apple/containerization#737](https://github.com/apple/containerization/issues/737),
  has no reply from Apple.

What that means in practice: the risk is not a known end date but an
unsupported interface. DTS notes that platform engineers "regularly have to
make hard choices between improving the implementation and breaking
third-party products", so a profile can break on any macOS update.

## Where pi-roost fits

- The VM is built on Virtualization, which is one of the three options Apple
  DTS lists as supported. It does not depend on `sandbox-exec`.
- The VM is the trust boundary, as in the Mac and agent VM approaches above.
- Credentials stay on the host and are only forwarded during an explicit
  `-git` session, which addresses the "credentials in reach" risk.
- The VM has no egress policy, and the model-provider token is plaintext inside
  it. These are the gaps the sandboxing options above would close. See
  [COMPARISON.md](COMPARISON.md) and [BROKERING.md](BROKERING.md).
- IDE extensions run on the host, outside this VM's boundary. If Copilot or
  another extension runs inside the guest, the threat model above applies to it
  there.
