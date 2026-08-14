# Keep-awake

How the monitor stops the machine from idle-sleeping while a live watch is
running, and how to turn that off.

For usage and flags see [README.md](README.md). For how the displayed numbers are
derived see [metrics.md](metrics.md).

## What it does

While the live view runs, the machine is kept from **idle-sleeping**, so a long
watch isn't cut short mid-session.

What is *not* affected:

- **The display is still free to turn off.** Only system sleep is inhibited.
- **Closing a laptop lid still sleeps as usual.** Lid close is an explicit sleep
  action on a hardware path that no application-level request overrides.

Scope:

- Engaged for the whole lifetime of the live view, released on exit.
- **`--once` never engages it** — a single snapshot takes a second and has
  nothing to keep awake for.
- **`--no-keep-awake`** starts the monitor with it off, so the machine idles to
  sleep on its usual schedule.

```bash
node src/index.js --no-keep-awake
```

## Toggling it from the TUI

Press **`k`** while the live TUI is running to turn keep-awake on or off. The
footer reports the current state:

```
  k keep-awake on  ·  Ctrl-C to exit
```

`--no-keep-awake` only sets the *starting* state — `k` still works either way, so
you can leave it off for a routine check and switch it on when a watch turns into
a long one. Turning it off releases the inhibitor immediately rather than waiting
for the lease to lapse.

The footer shows `unavailable` if the platform helper could not be started (see
[Caveats](#caveats)), so a press that cannot take effect says so instead of
silently doing nothing.

### Where the shortcut is unavailable

Reading a single keypress without waiting for Enter needs `setRawMode`, which is
not available in every terminal — notably MinTTY / Git Bash without a pty. There,
the key is not offered at all: the footer drops the `k` and shows the state
alone, and the rest of the monitor is unchanged. `--no-keep-awake` remains the
way to control it. The plain renderer (`--plain`, or any piped output) has no key
handling either.

Because raw mode also stops `Ctrl-C` from raising `SIGINT` — the byte arrives as
input data instead — the key handler watches for it explicitly so exiting keeps
working.

## How it works

**Keep-awake is a spawned helper process, not a native binding**, so the
project's zero-dependency rule still holds — no FFI library, no compiled addon,
nothing to `npm install`. `src/keep-awake.js` spawns one short-lived platform
helper and re-spawns it on a timer.

| Platform | Helper | Assertion |
|---|---|---|
| macOS | `caffeinate -i -t 300` | idle system sleep |
| Windows | hidden PowerShell host calling `PowerCreateRequest` | `PowerRequestExecutionRequired` + `PowerRequestSystemRequired` |
| Linux | `systemd-inhibit --what=idle --mode=block` | idle system sleep |

All three block *idle* sleep only, never display sleep.

### Why Windows does not use `SetThreadExecutionState`

The obvious call is `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`,
and it does not work on a current laptop. Check what your machine supports:

```bash
powercfg -a
```

If that reports **`Standby (S0 Low Power Idle)`** and shows S3 as disabled, the
machine uses **Modern Standby**. On Modern Standby, entry into standby is gated
on *the screen turning off*, not on a classic system idle timer, and "Sleep
after" is typically set to the same value as "Turn off display after":

```bash
powercfg -q SCHEME_CURRENT SUB_SLEEP    # STANDBYIDLE
powercfg -q SCHEME_CURRENT SUB_VIDEO    # VIDEOIDLE
```

A system-required assertion resets the idle timer but does not hold a process
through that transition, so the display times out, the machine drops into S0ix,
and the watch ends anyway — while the API call itself reports success, which
makes it look like the feature is working.

`PowerRequestExecutionRequired` is the request type meant for this: it keeps the
requesting process running rather than letting it be suspended, which is what
allows work to continue with the display off. It needs the handle-based API
(`PowerCreateRequest` / `PowerSetRequest`), not `SetThreadExecutionState`. Both
request types are asserted — execution-required for Modern Standby, and
system-required, which is what older S3 machines respond to.

This matches the reference implementation: the Claude desktop app's binary
imports `PowerCreateRequest`, `PowerSetRequest` and `PowerClearRequest`, and
contains no reference to `SetThreadExecutionState` at all.

### Lease and renewal

The helper is given a **300 s lease** and renewed every **240 s** while the
monitor lives. That pairing is deliberate: if the monitor is force-killed and its
cleanup never runs, the lease lapses on its own within five minutes instead of
pinning the machine awake forever.

Renewal *starts the replacement before retiring the old helper* and overlaps them
for 5 s. A fresh PowerShell host needs a second or two to compile its `Add-Type`
member and register the request, so killing the old one first would drop the
assertion for exactly as long as the new one takes to come up.

This matters most on Windows, where signals are not real — a `kill()` from a
parent process is `TerminateProcess`, so `SIGTERM` / `exit` handlers in the
helper do not get a chance to run. The self-expiring lease is the actual
guarantee; the cleanup handlers are just the fast path.

### Windows specifics

The PowerShell script is passed via `-EncodedCommand` (base64 of UTF-16LE), which
sidesteps every layer of shell quoting between Node and PowerShell. All P/Invoke
and struct marshalling lives inside the C# `Add-Type` member rather than in
PowerShell, which avoids PowerShell's own numeric-conversion quirks entirely — a
hex literal that fits in 32 bits is parsed there as a *signed* `Int32`, so a flag
like `0x80000001` arrives as `-2147483647` and fails to convert to a `uint`.

`PreventIdleSleep` returns a bitmask of which requests were granted, so a partial
success is distinguishable from total failure; `0` makes the script exit non-zero
and the monitor reports `unavailable` rather than pretending. The script also sets
`$ErrorActionPreference = 'Stop'` so a failed call terminates instead of sleeping
out its lease while asserting nothing.

No display-required request is made, so the screen can still power down.

## Caveats

- **Non-systemd Linux has no inhibitor available.** The monitor runs normally and
  simply doesn't hold one. The same applies if the platform helper is missing for
  any other reason — the spawn failure is swallowed and monitoring continues.
- **No application-level request can guarantee the machine stays awake.** Windows
  and macOS can still suspend for a user-selected sleep, critical battery,
  thermal protection, or system policy.
- **The state shown is the state actually held.** If the helper dies — a blocked
  PowerShell host, a failed request — the footer reports `unavailable` instead of
  `on`. The renewal timer retries, so a transient failure clears within 240 s.

Background on the underlying Windows APIs — including `PowerCreateRequest`, lid
policy, and why a handle-based request is safer for async code — is in
[windows-sleep-control-node.md](windows-sleep-control-node.md).

## Verifying it

On Windows the authoritative check is the OS request list. It needs an
**elevated** prompt:

```powershell
powercfg /requests
```

With the monitor running and keep-awake on, an entry should appear under both
`EXECUTION` and `SYSTEM`, attributed to `powershell.exe` with the reason string
`Local LLM Monitor is watching a local LLM server`. Toggle with `k` and re-run;
the entry should disappear. Seeing it under `EXECUTION` is the part that matters
on a Modern Standby machine — that is what a `SetThreadExecutionState` assertion
could never produce.

To confirm the machine really stops entering standby, leave it idle past the
display timeout and check for fresh Modern Standby transitions (event **506** is
entry, **507** is exit; classic S3 sleep would be event 42):

```powershell
Get-WinEvent -LogName System -MaxEvents 400 | Where-Object { $_.ProviderName -eq 'Microsoft-Windows-Kernel-Power' -and $_.Id -in 42,506,507 } | Select-Object -First 10 TimeCreated, Id
```

A cheaper smoke test on any platform is that a helper exists as a child of the
monitor process — present while it runs, absent with `--no-keep-awake`, and gone
within the lease window after it exits:

```powershell
Get-CimInstance Win32_Process -Filter "ParentProcessId=<monitor-pid>" | Select-Object ProcessId, Name
```

```bash
pgrep -P <monitor-pid> -l
```
