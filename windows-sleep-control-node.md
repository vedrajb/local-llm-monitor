# Preventing Windows Sleep from Node.js

## Summary

A normal, unelevated Node.js desktop application can prevent automatic idle sleep by calling Windows power-request APIs through an FFI library or native addon.

Preventing sleep when the laptop lid is closed is a separate concern. Closing the lid is treated as an explicit sleep action, so the application must change the Windows lid-close power policy in addition to holding a runtime power request.

| Requirement | Mechanism | Elevation |
| --- | --- | --- |
| Prevent automatic idle sleep | `PowerCreateRequest` + `PowerSetRequest` | Not required |
| Prevent automatic idle sleep, thread-scoped | `SetThreadExecutionState` | Not required |
| Keep the display on | Display-required power request | Not required |
| Prevent lid-close sleep | Set `LIDACTION` to `0` | Depends on power-policy ACL or Group Policy |

## Recommended API

For asynchronous Node.js applications, prefer:

1. `PowerCreateRequest` to create a request handle with a diagnostic reason.
2. `PowerSetRequest` with `PowerRequestSystemRequired` while work is active.
3. `PowerClearRequest` when the work finishes.
4. `CloseHandle` when the request object is no longer needed.

This handle-based design is safer for asynchronous applications than `SetThreadExecutionState`, whose continuous state belongs to the calling thread.

These APIs are exported by `Kernel32.dll`. Node.js does not expose them directly, so use an FFI library such as Koffi or a custom Node-API addon.

## Node.js and Windows compatibility

The Windows APIs do not impose a Node.js version requirement. Compatibility depends on the binding used to call them.

| Component | Minimum |
| --- | --- |
| Koffi | Node.js 16 or later |
| Custom addon targeting Node-API 3 | Node.js 8.11.2 theoretically |
| `PowerCreateRequest` and `PowerSetRequest` | Windows 7 or later |

Node.js 18 and Node.js 20 can use these APIs through Koffi or a compatible native addon. Both release lines are end-of-life, however, so use a supported LTS release such as Node.js 22 or 24 for a new production application.

Example dependency configuration:

```json
{
  "engines": {
    "node": ">=22"
  },
  "dependencies": {
    "koffi": "^3"
  }
}
```

## Unelevated operation

The following calls can be made from a normal, unelevated desktop process:

- `PowerCreateRequest`
- `PowerSetRequest`
- `PowerClearRequest`
- `CloseHandle`
- `SetThreadExecutionState`

Calling them through Koffi or a native addon does not change their privilege requirements.

Check every native return value:

- `PowerCreateRequest` fails by returning `INVALID_HANDLE_VALUE`.
- `PowerSetRequest` and `PowerClearRequest` fail by returning zero.
- Use `GetLastError` after a failure.

## Evaluating `SetThreadExecutionState`

`SetThreadExecutionState` is appropriate for a small synchronous program or an application with a stable UI thread.

Common flag combinations:

```text
ES_CONTINUOUS | ES_SYSTEM_REQUIRED
```

Keeps the system awake while allowing the display to turn off.

```text
ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED
```

Keeps both the system and display awake.

To clear a continuous request, the same thread should call:

```text
ES_CONTINUOUS
```

Important behavior:

- Without `ES_CONTINUOUS`, the call resets the idle timer only once.
- Continuous execution state is associated with the calling thread.
- An `await` continuation may resume on another thread.
- The API does not prevent lid-close sleep or manually selected sleep.
- `ES_AWAYMODE_REQUIRED` is intended for limited media scenarios and should not be used as a general lid-close workaround.

For asynchronous Node.js code, the explicit handle returned by `PowerCreateRequest` avoids the thread-affinity issue.

## Configuring lid-close behavior

The power-request APIs do not override the lid-close action. Configure the active power scheme so lid closure does nothing:

```powershell
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setdcvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

Values:

| Value | Lid-close action |
| --- | --- |
| `0` | Do nothing |
| `1` | Sleep |
| `2` | Hibernate |
| `3` | Shut down |

`AC` applies while plugged in and `DC` applies while running on battery.

Windows normally grants authenticated users permission to change power-policy objects, so these commands may work without elevation. An administrator, custom security descriptor, or Group Policy can restrict them. The application should try the change unelevated, inspect the exit code, and request elevation only if the operation is necessary and fails due to access restrictions.

Changing `LIDACTION` is persistent and affects behavior outside the application. Consider saving the previous values and restoring them when appropriate.

## Limitations

No application-level request can guarantee that the computer will remain awake in every condition. Windows can still suspend or shut down because of:

- A user explicitly selecting Sleep
- The power button configuration
- Critical battery level
- Thermal protection
- System or organizational policy
- Hardware or firmware behavior
- Modern Standby restrictions, particularly while running on battery

Running a laptop with its lid closed can obstruct cooling. Do not leave a closed, running laptop in a bag or another poorly ventilated space.

## References

- [PowerCreateRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powercreaterequest)
- [PowerSetRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powersetrequest)
- [PowerClearRequest](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-powerclearrequest)
- [SetThreadExecutionState](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-setthreadexecutionstate)
- [Lid switch close action](https://learn.microsoft.com/en-us/windows-hardware/customize/power-settings/power-button-and-lid-settings-lid-switch-close-action)
- [Power policy administrator overrides](https://learn.microsoft.com/en-us/windows/win32/power/administrator-overrides)
- [Powercfg command-line options](https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/powercfg-command-line-options)
- [Koffi requirements](https://koffi.dev/)
- [Node-API compatibility matrix](https://nodejs.org/api/n-api.html)
- [Node.js release status](https://nodejs.org/en/about/previous-releases)
