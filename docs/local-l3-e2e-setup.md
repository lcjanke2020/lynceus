# Local L3 e2e setup (Playwright Chromium + AppArmor)

**Last updated: 2026-06-09**

A step-by-step runbook for getting `npm run test:e2e` (the L3 real-browser
suite) passing on a local Linux machine **with Chromium's sandbox on**. This is
the practical companion to [`chromium-sandboxing.md`](./chromium-sandboxing.md);
read that for the full `--no-sandbox` / `sandbox: true` threat model and the
validated-hosts table.

Assumes Ubuntu (23.10+/24.04). Other distributions may need no host-side work at
all — see "Other distributions" below.

## Why this is needed on Ubuntu

The L3 e2e harness launches Chromium with the sandbox **on** when running
locally; it only adds `--no-sandbox` when the `CI` env var is set
(`test/e2e/setup/global.ts`). That is deliberate — locally we want the sandbox
when the host can provide it.

But recent Ubuntu releases ship:

```sh
kernel.apparmor_restrict_unprivileged_userns = 1
```

which blocks the unprivileged **user namespace** that Chromium's sandbox needs.
Playwright-bundled Chromium does not ship a SUID `chrome_sandbox` helper, so on a
stock Ubuntu host a sandbox-on launch fails before the DevTools port opens:

```text
zygote_host_impl_linux.cc: No usable sandbox!
```

From `chrome-launcher` this usually surfaces as a startup port-poll timeout or
`ECONNREFUSED`.

The fix is an AppArmor profile that grants `userns,` to the Playwright Chromium
binary, giving it a stable named label that is allowed to create the user
namespace. The steps below install Chromium, confirm the resolver finds it,
attach the profile, and run the suite.

## 1. Install Playwright Chromium

From the repo:

```sh
npx --yes playwright install chromium
```

This drops a managed Chromium into the per-user cache:

```text
~/.cache/ms-playwright/chromium-<rev>/chrome-linux*/chrome
```

The leaf directory varies by Playwright version and arch — `chrome-linux` on
ARM64 and older builds, `chrome-linux64` on x86_64 with the newer
Chrome-for-Testing layout (the resolver and the AppArmor glob below cover both).
Install it for **each OS user** that will run the suite — the cache is
per-`$HOME`.

## 2. Verify the resolver finds it

The launcher resolver (`src/util/browser-resolve.ts`) finds Chromium in this
order: an explicit `CDP_TEST_BROWSER_PATH`, then a system `chromium` on `PATH`,
then the Playwright cache. After a build, confirm what it picks:

```sh
npm run build
node --input-type=module \
  -e "import('./dist/util/browser-resolve.js').then(m => console.log(JSON.stringify(m.resolveBrowser(), null, 2)))"
```

This runbook targets the **Playwright-cache** binary, so expect
`source: "playwright-cache"` and a `binaryPath` under `~/.cache/ms-playwright/`:

```json
{
  "binaryPath": "/home/<user>/.cache/ms-playwright/chromium-<rev>/chrome-linux/chrome",
  "choice": "chromium",
  "snapConfined": false,
  "source": "playwright-cache"
}
```

If you have a system Chromium on `PATH` (apt `/usr/bin/chromium`, snap
`/snap/bin/chromium`), the resolver returns that first with
`source: "which-chromium"` — that binary is *not* covered by the AppArmor
profile below (snap brings its own confinement; apt Chromium is a separate
sandbox story). To exercise the Playwright binary under this profile, point the
suite at it explicitly:

```sh
export CDP_TEST_BROWSER_PATH="$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)"
```

## 3. Attach the AppArmor profile

First confirm the kernel knob is the restrictive default:

```sh
sysctl kernel.apparmor_restrict_unprivileged_userns   # = 1 on stock Ubuntu 24.04
```

If it is `0` (some hosts turn it off system-wide), Chromium's sandbox already
works and you can skip to step 5.

Create a profile that grants `userns,` to the Playwright Chromium binary path.
This mirrors the shape of Ubuntu's stock `chrome` / `msedge` / `brave` profiles
(a named-unconfined profile that opts into user namespaces):

```apparmor
# /etc/apparmor.d/lynceus-chromium
abi <abi/4.0>,
include <tunables/global>

profile lynceus-chromium /home/*/.cache/ms-playwright/chromium-*/chrome-linux*/chrome flags=(unconfined) {
  userns,

  include if exists <local/lynceus-chromium>
}
```

The `chrome-linux*` component matches both the `chrome-linux` (ARM64/older) and
`chrome-linux64` (x86_64 Chrome-for-Testing) layouts — in AppArmor `*` matches
within a single path segment, so a too-specific `chrome-linux` would silently
fail to attach on x86_64. The `/home/*/` glob matches any user's Playwright
cache; if you prefer to scope it to specific accounts, replace `*` with a brace
list of usernames, e.g. `/home/{alice,bob}/.cache/...`.

Load it (profiles in `/etc/apparmor.d/` also auto-load at boot):

```sh
sudo apparmor_parser -r /etc/apparmor.d/lynceus-chromium
```

## 4. Verify the label attaches

Launch the bundled Chromium sandbox-on and read its AppArmor label — it must be
the named profile, not bare `unconfined`:

```sh
BIN=$(ls -d ~/.cache/ms-playwright/chromium-*/chrome-linux*/chrome | head -1)
"$BIN" --headless=new --no-startup-window --remote-debugging-port=0 \
       --user-data-dir=$(mktemp -d) about:blank & pid=$!
sleep 3; cat /proc/$pid/attr/current   # -> lynceus-chromium (unconfined)
kill $pid
```

If this prints `lynceus-chromium (unconfined)`, the profile is attached. A bare
`unconfined` means the binary path didn't match the profile's glob — re-check
the cache path against the profile.

## 5. Run L3

```sh
npm run test:e2e
```

With the sandbox on and the profile attached, the suite should pass, e.g.:

```text
Test Files  10 passed (10)
Tests       29 passed (29)
```

## Fallback (before AppArmor is configured)

The L3 harness adds `--no-sandbox` when `CI` is set, so you can run the suite
without the profile as a lower-security stopgap:

```sh
env CI=1 npm run test:e2e
```

This keeps work moving, but the AppArmor profile is the desired long-term
posture so that plain `npm run test:e2e` exercises sandbox-on Chromium. See
[`chromium-sandboxing.md`](./chromium-sandboxing.md) for why `--no-sandbox`
widens the blast radius of a compromised renderer.

## Other distributions

This profile work is Ubuntu-specific. Distributions that don't restrict
unprivileged user namespaces by default (or use SELinux instead of AppArmor,
e.g. Fedora) generally run sandbox-on Chromium without a host-side profile.
Validate the actual host before assuming the Ubuntu steps are required — check
`sysctl kernel.apparmor_restrict_unprivileged_userns` (absent or `0` means no
AppArmor userns restriction to work around).

## Related

- [`docs/chromium-sandboxing.md`](./chromium-sandboxing.md) — the canonical
  `--no-sandbox` / `sandbox: true` threat model, the AppArmor / userns / snap /
  Bubblewrap mechanism map, and the validated-hosts table.
- [`docs/known-chromium-gaps.md`](./known-chromium-gaps.md) — per-spec
  Chromium-vs-Chrome gaps and host-OS workarounds.
- [docs/test-eval-plan.md §Layer 3](./test-eval-plan.md) — browser selection,
  `CDP_TEST_BROWSER_PATH`, and the per-platform support matrix.
