import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SUB_BUTTONS = '4f971e89-eebd-4455-a8de-9e59040e7347';
const LIDACTION = '5ca83367-6e45-459f-a27b-476b1d01c936';
const DO_NOTHING = 0;

// Presence of this file is the durable "override active" flag: it survives a
// crash or Ctrl-C, so a restart still knows there is an original value to
// restore instead of re-saving an already-overridden 0 as if it were real.
const STATE_FILE = join(homedir(), '.llm-monitor-lid-action.json');

function readSaved() {
  try {
    const data = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (Number.isInteger(data.ac) && Number.isInteger(data.dc)) return data;
  } catch {}
  return null;
}

function writeSaved(state) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function clearSaved() {
  try {
    unlinkSync(STATE_FILE);
  } catch {}
}

function powershell(script) {
  return new Promise((resolve) => {
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    let out = '';
    let child;
    try {
      child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
        { windowsHide: true }
      );
    } catch {
      return resolve(null);
    }
    child.stdout.on('data', (d) => (out += d));
    // Progress records are serialised to stderr as CLIXML noise; it is ignored
    // rather than merged, so only the final line below has to be parsed.
    child.stderr.resume();
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0 ? out : null));
  });
}

// powercfg /query omits the lid and power-button settings entirely on at least
// some machines — they are flagged hidden, so only "Start menu power button"
// comes back even though the Settings UI shows all three. The CIM power
// namespace reports every setting including the hidden ones, and needs no
// elevation to read, so it is the source of truth for the current values.
const QUERY_SCRIPT = [
  `$ErrorActionPreference = 'Stop'`,
  `$ProgressPreference = 'SilentlyContinue'`,
  `$scheme = ((powercfg /getactivescheme) -split '\\s+')[3]`,
  `$s = Get-CimInstance -Namespace root\\cimv2\\power -ClassName Win32_PowerSettingDataIndex |`,
  `  Where-Object { $_.InstanceID -like "*$scheme*${LIDACTION}*" }`,
  `$ac = ($s | Where-Object { $_.InstanceID -like '*\\AC\\*' }).SettingIndexValue`,
  `$dc = ($s | Where-Object { $_.InstanceID -like '*\\DC\\*' }).SettingIndexValue`,
  `if ($null -eq $ac -or $null -eq $dc) { exit 1 }`,
  `"ac=$ac;dc=$dc"`,
].join('\n');

async function queryLidAction() {
  if (process.platform !== 'win32') return null;
  const out = await powershell(QUERY_SCRIPT);
  if (out === null) return null;
  const m = out.match(/ac=(\d+);dc=(\d+)/);
  if (!m) return null;
  return { ac: Number(m[1]), dc: Number(m[2]) };
}

function runPowercfg(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('powercfg', args, { stdio: 'ignore', windowsHide: true });
    } catch {
      return resolve(false);
    }
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

function setValueArgs(flag, value) {
  return [flag, 'SCHEME_CURRENT', SUB_BUTTONS, LIDACTION, String(value)];
}

async function applyUnelevated(ac, dc) {
  if (!(await runPowercfg(setValueArgs('/setacvalueindex', ac)))) return false;
  if (!(await runPowercfg(setValueArgs('/setdcvalueindex', dc)))) return false;
  return runPowercfg(['/setactive', 'SCHEME_CURRENT']);
}

// Windows normally lets an authenticated user change power policy, so the plain
// attempt above usually succeeds and no UAC prompt is needed. Group Policy or a
// custom security descriptor can deny it, and only then is an admin shell worth
// the interruption. An elevated child cannot report back to its unelevated
// parent, so the outer process launches the real one with -Wait -PassThru and
// forwards its ExitCode as its own.
function elevatedScript(ac, dc) {
  const inner = [
    `powercfg /setacvalueindex SCHEME_CURRENT ${SUB_BUTTONS} ${LIDACTION} ${ac}`,
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
    `powercfg /setdcvalueindex SCHEME_CURRENT ${SUB_BUTTONS} ${LIDACTION} ${dc}`,
    `if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`,
    `powercfg /setactive SCHEME_CURRENT`,
    `exit $LASTEXITCODE`,
  ].join('\n');
  const encoded = Buffer.from(inner, 'utf16le').toString('base64');
  return [
    `$ErrorActionPreference = 'Stop'`,
    `$ProgressPreference = 'SilentlyContinue'`,
    `$a = @('-NoProfile','-NonInteractive','-EncodedCommand','${encoded}')`,
    `$p = Start-Process -FilePath powershell.exe -ArgumentList $a -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
    `exit $p.ExitCode`,
  ].join('\n');
}

// Reports success only when the values actually read back as requested, so the
// footer cannot claim an override that a denied UAC prompt never applied.
async function applyLidAction(ac, dc) {
  if (process.platform !== 'win32') return false;
  if (!(await applyUnelevated(ac, dc))) {
    if ((await powershell(elevatedScript(ac, dc))) === null) return false;
  }
  const now = await queryLidAction();
  return now !== null && now.ac === ac && now.dc === dc;
}

export function isLidActionSupported() {
  return process.platform === 'win32';
}

export function isLidActionDisabled() {
  return existsSync(STATE_FILE);
}

export async function disableLidAction() {
  const current = await queryLidAction();
  if (!current) return false;
  // Already overridden outside this app: there is no meaningful previous value
  // left to save, so refuse rather than record "do nothing" as the original.
  if (current.ac === DO_NOTHING && current.dc === DO_NOTHING) return false;
  if (!writeSaved(current)) return false;
  if (!(await applyLidAction(DO_NOTHING, DO_NOTHING))) {
    clearSaved();
    return false;
  }
  return true;
}

export async function restoreLidAction() {
  const saved = readSaved();
  if (!saved) return false;
  if (!(await applyLidAction(saved.ac, saved.dc))) return false;
  clearSaved();
  return true;
}
