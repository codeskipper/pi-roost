# Roadmap

## Roadmap

**Guest OS is pluggable; the host is not.** macOS host is fixed — the
credential plane is host-side and macOS-specific. The guest half is
`guest/<os>/provision.sh` and `verify.sh` only, which is why they live in
`guest/macos/`.

macOS guest is implemented, and is the case no other tool serves. Linux guest
is planned: the host-side stack is guest-agnostic and would be inherited
unchanged, leaving only a Linux provisioner. **Until that exists, for Linux
guests prefer Docker `sbx`**, which ships credential injection and
network-enforced egress integrated and maintained.

Three gaps against `sbx` have identified paths, none yet implemented or
tested:

| Gap | Path | Status |
|---|---|---|
| Ephemerality | `tart clone` a golden image per task, then `tart delete` | not built; `provision.sh` + `create-vm.sh` are most of it |
| Egress enforcement | `pf` anchor on the vmnet bridge | sketched, untested |
| Provider token | a credential broker via pi's `httpProxy` | researched with a spike plan — [docs/BROKERING.md](BROKERING.md) |

All three are **host-side**, so building them for the macOS guest makes Linux
guest support cheap later. What separates this from `sbx` is not capability but
integration: `sbx` ships these assembled and maintained, while here you would
own the result.

A possible second layer, also untested: run pi under
[cplt](https://github.com/navikt/cplt) inside the VM for egress filtering,
`git`/`gh` command guards, and placeholder injection of the Copilot token. It
is guest-side, so it does not replace the host-side paths above. See
[BROKERING.md](BROKERING.md#cplt-placeholder-injection-for-github-and-copilot-tokens).
