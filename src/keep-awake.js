import { spawn } from 'node:child_process';

const INHIBITOR_TTL_SECONDS = 300;
const RENEW_INTERVAL_MS = 240000;
const RENEW_OVERLAP_MS = 5000;
const POWER_REASON = 'Local LLM Monitor is watching a local LLM server';

// SetThreadExecutionState is not enough on a Modern Standby (S0 low power idle)
// machine, which is most current laptops: standby entry there is gated on the
// screen turning off, and a system-required assertion does not hold the process
// through it. PowerRequestExecutionRequired does — it is what keeps work running
// while the display is off — so the handle-based API is used and both request
// types are asserted, matching what the Claude desktop app links against.
const WINDOWS_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `Add-Type -Namespace LlmMonitor -Name Power -MemberDefinition @'`,
  `[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]`,
  `private struct REASON_CONTEXT {`,
  `    public uint Version;`,
  `    public uint Flags;`,
  `    [MarshalAs(UnmanagedType.LPWStr)] public string SimpleReasonString;`,
  `}`,
  `[DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]`,
  `private static extern IntPtr PowerCreateRequest(ref REASON_CONTEXT Context);`,
  `[DllImport("kernel32.dll", SetLastError = true)]`,
  `private static extern bool PowerSetRequest(IntPtr PowerRequest, int RequestType);`,
  `public static int PreventIdleSleep(string reason) {`,
  `    REASON_CONTEXT ctx = new REASON_CONTEXT();`,
  `    ctx.Version = 0;`,
  `    ctx.Flags = 0x00000001;`,
  `    ctx.SimpleReasonString = reason;`,
  `    IntPtr h = PowerCreateRequest(ref ctx);`,
  `    if (h == IntPtr.Zero || h == new IntPtr(-1)) return 0;`,
  `    int held = 0;`,
  `    if (PowerSetRequest(h, 3)) held |= 1;`,
  `    if (PowerSetRequest(h, 1)) held |= 2;`,
  `    return held;`,
  `}`,
  `'@`,
  `if ([LlmMonitor.Power]::PreventIdleSleep('${POWER_REASON}') -eq 0) { exit 1 }`,
  `Start-Sleep -Seconds ${INHIBITOR_TTL_SECONDS}`,
].join('\n');

function inhibitorCommand() {
  if (process.platform === 'darwin') {
    return ['caffeinate', ['-i', '-t', String(INHIBITOR_TTL_SECONDS)]];
  }
  if (process.platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64');
    return ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]];
  }
  return [
    'systemd-inhibit',
    [
      '--what=idle',
      '--mode=block',
      '--who=Local LLM Monitor',
      '--why=Monitoring a local LLM server',
      'sleep',
      String(INHIBITOR_TTL_SECONDS),
    ],
  ];
}

let child = null;
let renewTimer = null;
let cleanupRegistered = false;
let active = false;

function spawnInhibitor() {
  if (child !== null) return;
  const [cmd, cmdArgs] = inhibitorCommand();
  try {
    child = spawn(cmd, cmdArgs, { stdio: 'ignore', windowsHide: true });
  } catch {
    child = null;
    return;
  }
  child.unref();
  const spawned = child;
  spawned.on('error', () => {
    if (child === spawned) child = null;
  });
  spawned.on('exit', () => {
    if (child === spawned) child = null;
  });
}

function killInhibitor() {
  if (child === null) return;
  const spawned = child;
  child = null;
  try {
    spawned.kill();
  } catch {}
}

function registerCleanup() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.on('exit', stopKeepAwake);
  for (const signal of ['SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      stopKeepAwake();
      process.exit(0);
    });
  }
}

// Start the replacement before retiring the old one, so the assertion is never
// dropped for the second or two a fresh helper needs to register it.
function renewInhibitor() {
  const previous = child;
  child = null;
  spawnInhibitor();
  if (child === null) {
    child = previous;
    return;
  }
  if (previous !== null) {
    const timer = setTimeout(() => {
      try {
        previous.kill();
      } catch {}
    }, RENEW_OVERLAP_MS);
    timer.unref();
  }
}

export function isKeepAwakeActive() {
  return active && child !== null;
}

export function startKeepAwake() {
  if (active) return isKeepAwakeActive();
  active = true;
  registerCleanup();
  spawnInhibitor();
  if (child === null) {
    active = false;
    return false;
  }
  renewTimer = setInterval(renewInhibitor, RENEW_INTERVAL_MS);
  renewTimer.unref();
  return true;
}

export function stopKeepAwake() {
  if (renewTimer !== null) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  killInhibitor();
  active = false;
}
