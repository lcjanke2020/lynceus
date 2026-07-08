# Chromium sandboxing

**Last updated: 2026-07-07**

This project launches Chromium in two different contexts:

- L3 e2e tests and L4 evals launch a real browser through `launch_chrome`.
- Agents then control that browser through CDP, including `Runtime.evaluate`,
  `Debugger.*`, DOM interaction, console inspection, and network inspection.

That makes sandboxing a host setup and threat-model decision, not just a
Chrome flag. This document is the canonical reference for `--no-sandbox`,
AppArmor, unprivileged user namespaces, snap confinement, and Bubblewrap.

## Current default

`launch_chrome` defaults to `sandbox: false`, which adds `--no-sandbox`.

The default exists because Ubuntu 23.10+ and 24.04 commonly restrict
unprivileged user namespaces through AppArmor. Playwright-bundled Chromium
does not ship with a SUID `chrome_sandbox` helper. On those hosts, launching
Chromium without `--no-sandbox` can fail before the DevTools port opens:

```text
zygote_host_impl_linux.cc: No usable sandbox!
```

From `chrome-launcher`, that often surfaces as a startup port poll timeout or
`ECONNREFUSED`.

Other Linux distributions may allow Chromium's unprivileged user namespace
sandbox path by default. Validate the actual host before assuming the Ubuntu
automation default is necessary there.

Use `sandbox: true` only when the host has a working Chromium sandbox path:

- An AppArmor policy that permits the specific Chromium binary to create the
  unprivileged user namespace it needs.
- Or a working SUID `chrome_sandbox` helper installed alongside that binary.

## L4 eval harness: auto-detect and `EVAL_SANDBOX`

The `launch_chrome` **server default** stays `sandbox: false` (above). The **L4
eval harness** does not blindly inherit that: it auto-detects whether the
resolved Chromium binary has a usable sandbox path on the host and, by default,
runs the model-driven Chromium **sandbox-on when the host supports it** — so a
normal `npm run eval` on a capable host exercises the representative sandboxed
launch path instead of silently going `--no-sandbox`.

Detection (`detectSandboxCapability` in `src/util/browser-resolve.ts`) is static
— it reads sysctls and AppArmor profiles, it does not launch Chromium — and is
deliberately conservative (a false negative degrades to the working
`--no-sandbox` default rather than a hard launch failure). A host is reported
**capable** when, for the *resolved* binary:

- non-Linux (macOS/Windows) — the sandbox works natively; or
- a SUID-root `chrome_sandbox`/`chrome-sandbox` helper sits next to the binary
  (works even when unprivileged userns is locked down); or
- unprivileged user namespaces are usable: `user.max_user_namespaces` is nonzero
  **and** either `kernel.apparmor_restrict_unprivileged_userns` is `0`/absent, or
  it is `1` but a loaded AppArmor profile both **attaches to the resolved binary
  path** (glob-matched — the profile's path glob must cover the *actual* path,
  the failure mode that bit the multi-account eval hosts) **and** grants `userns`.

`EVAL_SANDBOX` is a tri-state intent control (browser scenarios only):

| `EVAL_SANDBOX` | Behavior |
|---|---|
| unset / `auto` | auto-detect: sandbox **on** if capable, else **off** with a logged reason |
| `true` / `1` / `on` | force **on** — fails fast (aborts the run) if the host is incapable, never silently downgrades. Back-compat alias for the pre-existing opt-in |
| `false` / `0` / `off` | force **off** (`--no-sandbox`) |

The decision is resolved once per run and its posture + source is printed in the
run header unconditionally, e.g.:

```text
[eval] sandbox: on (source=auto-capable; AppArmor restricts unprivileged userns, but profile 'cdp-mcp-chromium' grants userns to /home/.../chrome-linux/chrome)
[eval] sandbox: off (source=auto-fallback; AppArmor restricts unprivileged user namespaces (kernel.apparmor_restrict_unprivileged_userns=1) and no loaded profile grants 'userns' to /home/.../chrome)
```

Under the hood the harness plumbs the decision to the spawned server via
`CDP_SANDBOX` (`true`/`false`), which `launch_chrome` uses as its launch default.

## Why the Chromium sandbox still matters

The MCP caller is already highly privileged relative to the page. It can ask
the server to evaluate JavaScript, drive the DOM, set breakpoints, inspect
scopes, and read browser-observed network activity. For that caller, the
Chromium renderer sandbox is not the primary trust boundary.

The Chromium sandbox still matters for hostile page content and browser
exploitation risk. With the sandbox enabled, Chromium isolates renderer, GPU,
and utility child processes from the browser process using mechanisms such as
namespaces, seccomp filters, brokered filesystem access, and per-process
capability reduction. With `--no-sandbox`, a compromised renderer has a much
larger blast radius inside the browser process tree.

So the project default is a pragmatic automation default, not a claim that
`--no-sandbox` is equally safe.

## How the mechanisms relate

These mechanisms solve different problems:

- Chromium sandbox: Chromium's internal process sandbox. It is the boundary
  between web content renderer processes and the rest of the browser.
- AppArmor: host-enforced mandatory access control. It can confine Chromium,
  and on recent Ubuntu systems it can also restrict whether an unprivileged
  process may create user namespaces.
- Snap confinement: the packaging sandbox used by snap-installed Chromium.
  It can hide or remap filesystem locations and has caused DevTools port and
  `userDataDir` friction in local runs.
- Bubblewrap (`bwrap`): a small Linux sandboxing tool that starts a process in
  new namespaces with a controlled filesystem, process, and optional network
  view.

Bubblewrap is useful defense-in-depth around a browser or eval job. For
example, it can run the whole MCP server plus browser process tree with only
the repository and selected temp/profile directories writable. That helps
prevent accidental or malicious access to unrelated files such as SSH keys,
cloud credentials, or the rest of the home directory.

Bubblewrap is not a clean substitute for Chromium's own sandbox. If Chromium
runs with `--no-sandbox` inside Bubblewrap, the entire browser process tree is
inside an outer container-like boundary, but Chromium's internal renderer
isolation is still disabled. A renderer compromise may be contained by the
outer Bubblewrap filesystem or network policy, but it is not contained in the
same way as Chromium's per-renderer sandbox.

## Recommended posture

Local development:

- Treat the current default, `sandbox: false`, as a host-capability fallback:
  it keeps work moving when Chromium sandbox setup is the blocker.
- Prefer `sandbox: true` once the host has a known-good Chromium sandbox path.

CI and L4 eval hosts:

- Keep the default working and deterministic. If `--no-sandbox` is needed for
  Playwright-bundled Chromium on Ubuntu, document that in the host setup.
- Consider running the whole job inside an outer sandbox, VM, container, or
  Bubblewrap profile with a throwaway browser profile and limited writable
  paths.

Untrusted browsing:

- Prefer Chromium's sandbox on.
- Use a throwaway `userDataDir`.
- Add host-level confinement such as AppArmor, a container, VM, or Bubblewrap.
- Do not treat `bwrap + --no-sandbox` as equivalent to Chromium sandboxing.

This outer containment also pairs with the agent-operator threat (prompt-injected
page content steering the agent into actions or unscoped filesystem writes); see
the agent-operator threat model and deployment hardening in
[SECURITY.md](../SECURITY.md). A containerized outer-sandbox run mode that would
make this contained posture the default is a direction under consideration.

## Validated hosts

Hosts where `sandbox: true` has been verified working against this project, with the supporting posture:

| Host | OS | Arch | `sandbox: true` | AppArmor profile | Notes |
|---|---|---|---|---|---|
| Ubuntu 24.04 arm64 (Parallels VM) | Ubuntu 24.04 | arm64 | ✓ | `/etc/apparmor.d/lynceus-chromium` (named-unconfined, mirrors Ubuntu's stock `chrome` / `msedge` / `brave`) | `kernel.apparmor_restrict_unprivileged_userns = 0` was set as a side effect of enabling Bubblewrap, so the kernel-level userns restriction is already off system-wide. The AppArmor profile gives Playwright Chromium a stable named label (instead of `unconfined`) and grants `userns,` explicitly, so `sandbox: true` keeps working even if a future kernel/package update flips the global knob back to `1`. |
| Fedora 43 (Qubes AppVM) | Fedora 43 | x86_64 | ✓ | none — SELinux is the MAC (AppArmor not present) | Unprivileged user namespaces are unrestricted by default (`user.max_user_namespaces` nonzero; neither `kernel.unprivileged_userns_clone` nor `kernel.apparmor_restrict_unprivileged_userns` exists), so `sandbox: true` works with **no host-side profile**. Confirmed the renderers run in a separate user namespace from the browser process, and `npm run test:e2e` passes with the real sandbox (no `--no-sandbox`). Inside Qubes the qube is itself a VM boundary, so this is defense-in-depth on top of strong VM isolation. |

When adding a new host to this table:

1. Run the smoke tests below and capture the values.
2. If `kernel.apparmor_restrict_unprivileged_userns` is `1` (Ubuntu's stock default) and `sandbox: true` is desired, install a profile under `/etc/apparmor.d/` mirroring Ubuntu's stock `chrome` / `msedge` / `brave` shape:
   ```apparmor
   abi <abi/4.0>,
   include <tunables/global>

   profile lynceus-chromium /path/to/chromium flags=(unconfined) {
     userns,
     include if exists <local/lynceus-chromium>
   }
   ```
   Load with `sudo apparmor_parser -r /etc/apparmor.d/lynceus-chromium`. The profile auto-loads at boot from `/etc/apparmor.d/`.
3. Verify the running browser process is labelled correctly:
   ```sh
   cat /proc/<chromium-pid>/attr/current
   ```
   Expect the profile name (e.g. `lynceus-chromium (unconfined)`), not `unconfined` alone.
4. Add a row to the table above.

### Fedora and Qubes

Fedora (verified on Fedora 43) needs none of the AppArmor setup above — steps 2–3
do not apply:

- **MAC system.** Fedora uses **SELinux**, not AppArmor. The
  `apparmor_restrict_unprivileged_userns` knob does not exist, and SELinux's
  targeted policy does not block a Chromium launched from a user shell (it runs in
  an unconfined domain). There is no profile to write for `sandbox: true`.
- **User namespaces.** Unprivileged user namespaces are enabled by default
  (`user.max_user_namespaces` nonzero), so Chromium's namespace sandbox works out
  of the box.
- **Bubblewrap** is first-class: `sudo dnf install bubblewrap` (Flatpak depends on
  it, so it is effectively a system component).
- **Qubes.** Each qube is a Xen VM with strong dom0/inter-qube isolation, so even an
  unsandboxed Chromium in a dev qube cannot reach dom0 or sibling qubes; Chromium's
  own sandbox (kept on) is defense-in-depth on top of that. On x86_64 the Playwright
  Chromium binary is at `~/.cache/ms-playwright/chromium*/chrome-linux64/chrome` and
  the default-headless binary is `chrome-headless-shell` — this differs from the
  arm64 `chrome-linux/{chrome,headless_shell}` layout if you script the path.

## Smoke tests

Check whether unprivileged user namespaces are enabled:

```sh
cat /proc/sys/kernel/unprivileged_userns_clone
cat /proc/sys/user/max_user_namespaces
```

Expected working values are usually `1` for
`kernel.unprivileged_userns_clone` and a nonzero number for
`user.max_user_namespaces`.

On Fedora (and other non-Debian distros) `kernel.unprivileged_userns_clone` does
not exist — it is a Debian/Ubuntu patch — so rely on `user.max_user_namespaces`
being nonzero. `kernel.apparmor_restrict_unprivileged_userns` also does not exist
on Fedora, since SELinux (not AppArmor) is the MAC.

On Ubuntu, AppArmor may still restrict unprivileged user namespaces:

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns
```

Minimal Bubblewrap smoke tests:

```sh
bwrap --unshare-user --uid 0 --gid 0 --ro-bind / / /usr/bin/true
bwrap --unshare-user --uid 0 --gid 0 --unshare-net --ro-bind / / /usr/bin/true
```

If the first command fails with `setting up uid map: Permission denied`, the
host still blocks the user namespace setup Bubblewrap needs.

If the second command fails with `loopback: Failed RTM_NEWADDR: Operation not
permitted`, the network namespace setup is still blocked.

Project-level browser check:

```sh
npm run test:e2e
```

For a direct MCP check, call `launch_chrome` with `sandbox: true` on the host
you want to validate. If Chromium cannot create a usable sandbox, it will fail
before exposing its DevTools target.

## Decision summary

- `--no-sandbox` remains the automation default because it keeps Ubuntu
  Playwright-Chromium runs working.
- `sandbox: true` is the preferred security posture when the host supports it.
- AppArmor is the long-term host policy path for allowing Chromium's needed
  user namespace behavior narrowly.
- Bubblewrap is an outer containment layer and is valuable defense-in-depth.
- Bubblewrap does not replace Chromium's internal renderer sandbox.
