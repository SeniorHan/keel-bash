# keel-bash

> Fork of [gvanderclay/pi-bg-bash](https://github.com/gvanderclay/pi-bg-bash) (v0.4.1)
> with the `expectedSeconds` safety redesign. Maintained at [SeniorHan/keel-bash](https://github.com/SeniorHan/keel-bash).

A Pi extension that lets the model run shell commands in the background. It
replaces Pi's `bash` tool with the same tool plus a `background` flag: a call
with `background: true` starts the command detached, returns a task id at once,
and wakes the agent with the result when the command exits. A foreground
command that runs for more than two minutes moves to the background on its
own, so a slow build or a dev server never blocks the session.

## Install

You need:

- Pi on macOS or Linux (not Windows). Pi 1.0.0 is the version pi-bg-bash is
  tested with. Pi supplies the peer dependencies
  `@earendil-works/pi-coding-agent` and `typebox`.
- A POSIX `sh`. The command itself runs in Pi's own shell (bash when present).
- No other extension that replaces the `bash` tool or registers `/bg` or
  `ctrl+shift+b`. [pi-bg-tasks](https://www.npmjs.com/package/pi-bg-tasks)
  claims all three, so install only one of the two.

Install the package from npm:

```bash
pi install npm:pi-bg-bash
```

To follow the latest commit instead, install it from GitHub:

```bash
pi install git:github.com/gvanderclay/pi-bg-bash
```

The package has no runtime dependencies and no build step.

## First use

Ask the model for something that keeps running, for example "start the dev
server in the background and tell me when it is up". It calls `bash` with
`background: true` and gets back a task id such as `bg-1`. The footer shows
`bg: 1` while the task runs, and the model can read its output with
`bash_output` while it works on something else. When the command exits, the
agent receives one message with the exit state and the last lines of output,
which starts a turn if it was idle.

Run `/bg` to see every task: enter shows a task's output, and `x` kills it
after you confirm. Press
`ctrl+shift+b` while a foreground command runs to move it to the background
at once instead of waiting.

## What it adds

- The `bash` tool keeps Pi's parameters and adds `expectedSeconds`, `background` and `waitFor`. Every foreground call
  must carry `expectedSeconds`: the model's estimate of how long the command will take, or `0` when it has none. A call
  moves to the background once it outlasts that estimate, or after the default 30 s without one, unless it has an
  explicit `timeout` or starts with `sleep`. Its
  description tells the model to wait for something to finish (a CI run, a
  server coming up) with a blocking command such as `gh run watch <run-id>
  --exit-status` and `background: true`, never `sleep N` and then a check.
  The result of a call that goes on as a task tells the model to end its turn
  if nothing else is left, since the completion message starts its next one.
  `waitFor: "<text>"` (foreground only) returns as soon as the text appears in
  the output while the command keeps running as a task, for a server that
  should stay up.
- A codemode script's `await tools.bash(...)` resolves to Pi's bash object,
  `{ output, truncated, full_output_path?, exit_code?, wall_time_seconds, task_id? }`.
  When the command goes on as a task (`background: true`, a `waitFor` match,
  the threshold move or `ctrl+shift+b`), `task_id` holds its id for `bash_output`
  or `bash_kill`, `exit_code` is absent, `output` holds the output so far (empty
  for `background: true`), and `full_output_path`, when the output was
  truncated, is the task's log.
- `bash_output({ id, latest?, filter? })` reads a task's output from where the
  last read stopped, or only the newest output, optionally filtered by a regex.
- `bash_tasks()` lists every task of the session with its state and runtime.
- `bash_kill({ id })` stops a task and everything it started.
- In a codemode script these three resolve to objects, not text (see
  [Structured results](#structured-results)), and all four tools carry
  annotation hints for permission extensions.
- `/bg` lists the tasks; enter shows the selected task's output and `x` kills
  it after a confirmation.
- `ctrl+shift+b` moves the running foreground command to the background. It
  needs a terminal that reports modified keys (the kitty keyboard protocol or
  `modifyOtherKeys`); inside tmux, also `set -g extended-keys on`.

Tasks belong to the session that started them. `/reload` keeps them; quitting
or switching sessions (`new`, `resume`, `fork`) kills them, and if Pi crashes a
watcher process kills them. Logs live under
`$XDG_STATE_HOME/pi-bg/<session-id>/` (default `~/.local/state`) and are
removed after 7 days.

The rest of this README describes the behaviour in detail.

## Background tasks

- **Wrapper:** `sh` spawned `detached`, stdout and stderr on the log's file
  descriptor, the handle `unref()`ed. It runs the command, passed as an
  argument, in Pi's own shell (`getShellConfig`, so bash-only syntax works) with
  Pi's shell environment (`getShellEnv`; where a Pi version lacks an export it
  falls back to `sh -c` and `process.env` plus `<agent dir>/bin` on PATH), plus
  the session variables Pi's bash tool sets, taken from the context:
  `PI_SESSION_ID`, `PI_SESSION_FILE`, `PI_PROVIDER`, `PI_MODEL`,
  `PI_REASONING_LEVEL` (each left out when the context has no value; inherited
  ones are cleared first, as Pi does). When the command exits the wrapper appends
  `__PI_BG_EXIT__:<nonce>:<code>`. The nonce is random per task and passed as an
  argument, so output that looks like a marker is not one. The marker is found
  wherever it sits, since a backgrounded grandchild may write after it, and is
  never shown as output. The wrapper's own stderr is silenced (the command's still
  reaches the log), so a shell job notice like `Killed: 9` for a command that
  killed itself is not output. A separate `sh` watcher, its own detached process
  outside the task's group, is given Pi's pid and the task's group; it exits once
  the group is empty, and when Pi dies first it appends `__PI_BG_GONE__:<nonce>`
  and SIGKILLs whatever is left. A watcher that fails to start leaves the task
  running without a crash watch (fail open).
- **Spawn failures:** a missing working directory is refused with "Working
  directory does not exist"; a failed spawn rejects, and no log is left.
- **Row timer:** the chat row of a `bash` call that started a task or was
  promoted to one replaces Pi's `Took Ns` line with when the task started,
  such as `Running since 2:14:13 PM` in the local time format, then, redrawn
  once when the task ends, how it ended, such as `Exited (code 0) after 4m 10s`
  or `Killed (timed out) after 2m 0s`. The row never counts up: redrawing a
  row that has scrolled off screen makes Pi clear and repaint the whole
  screen and scrollback, which flickers. A row
  whose task this Pi process does not know, such as one in a session resumed
  after a restart, keeps Pi's line.
- **Logs:** `$XDG_STATE_HOME/pi-bg/<session-id>/<id>.log` (default
  `~/.local/state`), directory `0o700`, file `0o600`, created exclusively. The
  session directory carries an `owner.pid` marker naming the Pi process that
  owns it, so another Pi's cleanup never deletes a live task's log. A pid the
  OS has reused can keep a dead owner's directory out of reach for one session
  start, but the next start re-checks and removes it once the pid is gone. Ids restart
  at `bg-1` per Pi process, so a resumed session skips any id whose `.log` or
  `.log.gz` already exists. Once a task's completion message is confirmed in the transcript, the
  log is streamed through `node:zlib` to `<id>.log.gz` (0600) and the plain file
  is deleted; `bash_output` and the completion tail read it transparently. A
  task is killed, with the message `killed (log limit passed)` and a
  `__PI_BG_LIMIT__` marker ending its log, once its log passes 100 MiB; the size
  is checked four times a second, so a runaway is stopped just past the limit.
  `PI_BG_BASH_LOG_LIMIT_BYTES` lowers the limit for the contract test. At
  `session_start`, logs and emptied session directories older than 7 days are
  removed — never a running task's log or a directory owned by a live Pi, and
  never anything but the extension's own `bg-<n>.log` / `.log.gz` files.
- **Not honoured:** Pi's `shellPath` and `shellCommandPrefix` settings. An
  extension cannot read them, so neither background nor foreground commands
  use them.
- **Registry:** on `globalThis` under `Symbol.for("pi-bg-bash.registry")`, with
  one 2 s poller and a 250 ms stat-only log-limit check. A task ends when its
  marker appears, or when its pid is gone
  with no marker (exit unknown). A log that is missing also means exit unknown.
  Any other read error is retried on later ticks; once the pid is dead and five
  reads in a row have failed, the exit is unknown too. A single failure never
  hides a real exit. One task's failure, a stale footer context or a throwing
  `sendMessage` never stops the poller; a message that failed to send is
  retried on a later tick. A task is registered only after its spawn resolves.
- **Completion message:** a custom message (`pi.sendMessage`) carrying the id,
  the command (on one line, newlines shown as ` ⏎ `, cut to 200 characters), exit state
  (`exited (code N)`, `killed (timed out)`, `killed (killed by user)`,
  `killed (log limit passed)`, or `exit unknown`, the same wording as
  `bash_tasks`), runtime and the last 20 lines of output, capped at 4 KiB.
  When the cap cut the output, its label says so and names `bash_output <id>`,
  which reads the whole log since the completion message never moves the read
  position. A command that pipes its output and exits 0 also says that the code
  is the last stage's and quotes the first line of the log that reads as a
  failure, since `cmd | tail` hides the command's own exit code.
- **Delivery is a transaction, not a send.** The notice is written to
  `<state>/<session>/pending/<id>.json` before it is sent, and that record is
  deleted only once the transcript holds it: the message is considered delivered
  when an entry carries its `Background task <id> finished:` phrase (in the
  session's entries first, then in the tail of the session file). Until then it
  is retried, so a send that Pi accepts and silently drops — a steer queued as
  the turn ends, a settle-window deferral, a run that would not start — cannot
  lose a notice. The first retry 2 s later goes out as a user message
  (`sendUserMessage`, the one channel that always starts a turn); after that the
  user channel is retried with backoff (8 s, 30 s, 1 min, then every 2 min).
  Notices that end together share one message and one wake. Records a session
  leaves behind (a crash, a switch, Pi exiting) are replayed as user messages on
  the next `session_start`; records of a session that ends normally are dropped,
  so nothing leaks into the session that follows. A send that *throws* is
  retried on the same channel rather than escalated: a Pi that is not ready is
  not a message lost.
- **`guaranteedWake`:** `guaranteedWake` in the project's
  `.pi/pi-bg-bash.json`, then the user's `~/.pi/pi-bg-bash.json`, then
  `PI_BG_BASH_GUARANTEED_WAKE` (`1`/`0`), then on; `false` keeps delivery on the
  custom channel only, so a notice then waits for the next turn instead of
  starting one.
- **Nothing is reported as undelivered:** from the agent's side a task is
  finished or it is not; a notice still pending is the plugin's bookkeeping, not
  a state of the task, and never appears in `bash_tasks` or `bash_output`.
- **Footer:** `ctx.ui.setStatus("bg", "bg: N")` while N tasks run.
- A call without `background` is a foreground call; see below.
- **Stripped output:** what the agent reads (the foreground result, `bash_output`
  and the completion message's tail) has ANSI escape codes, carriage returns and
  other control characters except newline and tab removed, the pipeline Pi
  applies to the user's `!` commands (`stripAnsi`, `sanitizeBinaryOutput`, then
  `\r` dropped; `sanitize.ts` carries an own copy, since Pi does not export
  them). Pi's own `bash` tool hands its output on unstripped, so the foreground
  result is stripped here too. The logs on disk stay raw, byte for byte.

## Foreground calls and promotion

A call without `background` runs Pi's own `bash` (`createBashToolDefinition`'s
`execute`, built per call for the session's cwd) over a custom `operations.exec`
(`foreground.ts`). That `exec` launches the command through the same wrapper as
a background task, with Pi's shell, environment and `PI_*` variables as the
delegate resolved them, and feeds the log to `onData` (polled every 50 ms; a
trailing partial exit marker is held back, never shown). Output, truncation,
the error texts (`Command exited with code N`, `Command aborted`, `Command timed
out after N seconds`) and the `timeout` checks (`Invalid timeout: ...` for a value
that is not above 0 or exceeds 2147483.647 s) are Pi's. A `timeout` or an abort of
the turn, including one that lands while the process is being spawned, sends
SIGKILL to the command's process group at once, as Pi's bash does; only
`bash_kill` and `/bg` use SIGTERM, then SIGKILL after the grace period. A
foreground command that ends leaves no task and no log, and its id is given back.
After the exit marker the call keeps reading the log until it has been idle for
100 ms (reset on new output), so a short-lived background child's last writes are
kept, as Pi's bash keeps inherited-pipe output. A command that vanishes without an
exit marker ends the call with `Command terminated without an exit code`, its last
output kept.

- **Promotion:** a foreground command still running past the call's `expectedSeconds` — or past the default threshold
  (30 s) when it declared `0` — becomes a task, unless it starts with `sleep` or its explicit `timeout` is at or below
  the expectation: the same live wrapper is registered (id, footer `bg: N`, `bash_tasks`, one completion message,
  runtime counted from the start), and `exec` then ends as if the command had exited 0, so Pi's bash closes its output and returns; the extension
  keeps that result's text and structured output (its `exit_code` dropped, `task_id` added) and wraps the text as
  `Command still running after N s; moved to the background as task <id>. ...` — or, when the call declared an
  expectation, `Command still running after N s, past your <expected> s expectation; moved to the background as task
  <id>. ...`, which tells the model how far off its estimate was. The default threshold is the `promoteMs` of
  `.pi/pi-bg-bash.json` in the project, then the user's `~/.pi/pi-bg-bash.json`, then 30 s, then whatever
  `PI_BG_BASH_PROMOTE_MS` is set to, in that order. Nothing in Pi's bash is left pending. After promotion the
  turn's abort signal no longer reaches the process and no output flows to the
  finished call. A command that ends in the same instant ends normally.
  The task's `bash_output` continues after the output the promoted call showed
  (never re-read). A truncated output's "Full output" footer points at the task's
  log, not at Pi's temp file, which is deleted; the result carries no `details`.
  The text says how long the command had actually run.
- **`waitFor`:** a plain substring (not a regex) matched against the stripped
  output as it arrives, including across two reads and inside a line that has
  no newline yet. On a match the call is promoted through the same `promote()`,
  at once, even for a command starting with `sleep` or with an explicit
  `timeout`, and answers `"<text>" appeared after N s; the command keeps running
  as background task <id>. ... Output so far: ...`. An explicit `timeout` then
  becomes the task's deadline (`startedAt` plus `timeout`, as for
  `background: true`); until a match it still kills the foreground call at the
  `timeout`. If the call ends without a match (the command exits, the threshold
  promotion or `ctrl+shift+b` fires, or it fails), the result also says
  `"<text>" never appeared in the output.`. `waitFor` with `background: true`
  and an empty `waitFor` are tool errors before anything starts. A match sends
  no message of its own; the completion message comes when the task ends. An
  escape sequence split across two reads is not stripped before matching.
- **Not promoted:** a command whose explicit `timeout` is at or below its `expectedSeconds` (killed at it) or one
  starting with `sleep`. The default threshold and `PI_BG_BASH_PROMOTE_MS` (the
  contract test's override) are covered under Promotion.
- **Shortcut:** `ctrl+shift+b` moves the running foreground command to the
  background at once, without waiting for the threshold. It applies to any command,
  including `sleep` and ones with an explicit `timeout`. The call answers
  `The user pressed ctrl+shift+b after N s: this command was deliberately
  moved to the background as task <id>, so you are not blocked on it. Do not
  run it again or start a sleep in its place. ...`. With no foreground
  command running it does nothing. `ctrl+b` is left to Pi as cursor-left. When
  several foreground commands run at once (parallel tool calls), one press
  promotes every one of them, since the turn stays blocked until they all
  finish. `ctrl+shift+b` needs a terminal that reports modified keys, through
  the kitty keyboard protocol or `modifyOtherKeys`; inside tmux it needs
  `extended-keys on` as well (`set -g extended-keys on`).
- **Hint:** 2 s into a foreground command, a widget below the editor shows
  "(ctrl+shift+b to background)", so fast commands never flash it. The moment
  the command's exit marker is seen the hint timer is cancelled and a shown
  hint is cleared, before the 100 ms late-output grace; it is also cleared when
  the command is promoted, aborted, or times out. No widget is set when there is
  no UI. The show and clear are best-effort: a stale context's `hasUI`/`ui`
  getters throwing is ignored, and the call still ends.
- The one promotion path is
  `promote()` on each entry of `foregroundRuns()` (`foreground.ts`), the set of
  foreground calls in flight; the threshold timer and the shortcut both call it.

## Debug log

Set `PI_BG_BASH_DEBUG=1` (the value `1` exactly, read on every write) to append
diagnostics to `$XDG_STATE_HOME/pi-bg/debug.log` (default
`~/.local/state/pi-bg/debug.log`, mode `0o600`). Without it nothing is written
and nothing else changes. A failed write to the log is dropped, never raised.

- **Format:** JSON Lines. Every line has `t` (ISO timestamp) and `event`;
  task lines add `task`, `session`, `pid` and `command` (on one line, as in
  `bash_tasks`).
- **Events:** `task-start`, `task-exit` (`state`, `exitCode`), `kill-request`
  and `kill` (`reason`, `outcome`; a log-limit kill has that `reason`),
  `deadline`, `promote` (`by: "timer"`, `"shortcut"` or `"waitFor"`, `elapsedMs`),
  `session-end` (the task count and the groups it kills, with an `error` line
  for each kill that fails) and `rotate`.
- **Errors:** every error the extension swallows or downgrades is an `error`
  line with `where` (a short tag), `error` (the message), `code` and `stack`.
  Two expected cases are not logged: ESRCH/EPERM from signalling a group that
  is gone, and a missing file where absence is ordinary (the owner marker, the
  log-size check of a deleted log).
- **Rotation:** at `session_start`, a `debug.log` over 5 MiB is renamed aside
  (so only one Pi process rotates it), gzipped to `debug.log.1.gz`, and the
  older generations shift up; five are kept, `debug.log.5.gz` the oldest. The
  7-day cleanup never touches these files.

## `bash_output`

`bash_output({ id, latest?, filter? })` reads a task's log — plain or gzipped,
running or finished.

- Returns the oldest unread output from the task's read position, capped like
  Pi's `truncateHead` (`DEFAULT_MAX_LINES`, `DEFAULT_MAX_BYTES`), counted in raw bytes. When more
  is left it says "More remaining" and how many bytes; call again for the next
  page. The position moves only past what was returned, so calls never overlap.
- A running task's half-written last line waits for its newline.
- `latest: true` returns the newest *unread* output (`truncateTail` limits; the
  window never starts before the read position) and moves the position to the
  end, noting any unread bytes it skipped. With nothing unread it returns
  "(no new output)".
- The position counts raw log bytes, so invalid UTF-8 does not lose lines. The
  text returned is stripped (see above) after the page is cut from the raw log.
- `filter` is a regex applied to the stripped lines returned, so escape codes
  do not break a match; the position still moves past every line read,
  matching or not.
- The exit marker is never output. The first line reports the task, worded as
  in `bash_tasks`: `running`, `exited (code N)`, `killed (reason)` or `exit unknown`.
- An unknown id, or an invalid filter, throws, which Pi reports as an error
  result.
- The completion message's tail is separate and never moves the position.

## Structured results

`bash_output`, `bash_tasks` and `bash_kill` declare an `outputSchema` and return
a matching `structuredContent`, so a codemode script gets an object; the model
still reads the text. A task is described by `task_id`, `state` (`running`,
`exited`, `killed` or `exit-unknown`), `exit_code` only when `exited` and
`reason` only when `killed`, the same state the text reports.

- `bash_output`: the state fields plus `output` (the text returned, after
  `filter`; empty when nothing was), `truncated` (more is left, or `latest`
  skipped some) and `unread_bytes` (raw log bytes not yet read). `state` comes
  from the exit marker this read saw, so a task is done when `state` is not
  `running` and `unread_bytes` is 0.
- `bash_tasks`: `{ tasks }`, each with the state fields, the full `command`,
  `started_at_ms`, `ended_at_ms` once ended, and `runtime_ms`.
- `bash_kill`: one such task plus `outcome`: `killed`, `finished` (had already
  ended), `gone` (had already ended, exit unknown), `cleared` (had ended; what it
  left running was stopped), or `stuck` / `leftover-stuck` (survived SIGKILL).

Annotations: `bash` is destructive and open-world; `bash_output` changes only
the read position (not read-only, not destructive); `bash_tasks` is read-only
and idempotent; `bash_kill` is destructive and idempotent. None but `bash`
is open-world.

## Killing, listing and deadlines

- **Group kill** (`kill.ts`): SIGTERM the task's process group (the wrapper
  leads it, so the command and everything it started), wait about 3 s, then
  SIGKILL the group if anything is left. It signals only pids this registry
  launched, and refuses a pid of 1 or below. A group that is already gone is not
  an error. After SIGKILL it waits 1 s; a group still there then is reported as
  such (`bash_kill` says the group is still running), never as gone. The grace
  period is 3 s; `PI_BG_BASH_GRACE_MS` overrides it, for the tests.
- **The process port** (`port.ts`): the extension's only contact with real
  processes, with four operations: launch a task, signal a group, check whether a
  group is alive, check whether a pid is. It owns the errno mapping: ESRCH and
  EPERM both mean "gone". EPERM is what macOS answers for a group of only
  zombies, and for a pid that now belongs to someone else. The escalation above
  runs on timers, so tests can drive it. Tests replace the port through the test
  harness only; there is no option or setting for it.
- **How a kill is recorded:** a killed task has state `killed` and a `reason`
  (`killed by agent`, `killed by user`, `timed out`, `log limit passed`) kept in the registry, and
  reported as `killed (reason)` by `bash_tasks`, `bash_output` and the completion
  message. The group kill also takes the wrapper down, so no exit marker is
  written and the log's exit marker stays digits-only; the log-limit kill appends
  a `__PI_BG_LIMIT__` marker instead, hidden from output like the exit marker.
  A task whose command exits while the limit kill is in flight is reported as
  `exited` with its code. Session end reports nothing (the tasks
  are forgotten), and Pi-gone is written by the watcher as `__PI_BG_GONE__:`,
  not as a registry reason.
- `bash_tasks()`: one line per task, `id | state | runtime | command`. State is
  `running`, `exited (code N)`, `killed (reason)` or `exit unknown`. Says "No
  background tasks." when there are none.
- `bash_kill({ id })`: kills as above, reports no completion message
  follows, and reports the final state. An unknown id throws; a task that
  already ended (even if the poller had not yet noticed) is reported as
  already finished; a "running" task whose group is already gone is settled as
  exit unknown. Two kills of one task share the same kill.
- **Deadline:** `bash` with `background: true` and an explicit `timeout`
  (seconds) records `startedAt + timeout` as the task's deadline. The poller,
  on the first tick after it, runs the group kill and sends the completion
  message saying `timed out`. Without a `timeout` a background task has none.
- `/bg`: in the terminal UI, a list of every task (same line as `bash_tasks`),
  running tasks first, then the most recently started.
  Enter shows the end of the selected task's log, stripped like `bash_output`
  and capped like it (2000 lines or 50 KiB), opened at the bottom and scrolled
  with the arrows, page up/down, home and end; it re-reads the log every second
  and follows new output while it is at the bottom (scrolled up, it keeps its
  place), and never moves `bash_output`'s read position. The list refreshes
  every second too, keeping the selected task. `x` asks `Kill <id>?` (for a
  finished task, `Stop what <id> left running?`), showing the command on one
  line (newlines as `⏎`, cut to 200 characters), and on yes runs the group kill:
  a running task gets the completion message saying `killed by user`, a finished
  one has what it left running stopped, and you are told what happened. Esc in
  the output goes back to the list, which comes back after a kill too, with the
  tasks' current state; `q` or esc in the list closes it. In RPC mode, which has no
  custom components, `ctx.ui.select` over the tasks, and a pick asks the same
  confirmation before the kill. Without a UI it prints the list with
  `ctx.ui.notify` and kills nothing.

## Session lifetime

Tasks belong to the session that started them.

- **`/reload` keeps them.** Pi loads extensions with `moduleCache: false`, so a
  reload runs a fresh copy of the extension. It finds the `globalThis` registry,
  refreshes its `pi` reference and replaces the poller, so one poller runs and
  completions go through the newest registration, once. A foreground command in
  flight is left running too, and is still in `foregroundRuns()` (kept in the
  registry, not in module state); when it outlasts the threshold it is promoted
  as usual.
- **`quit`, `new`, `resume` and `fork` kill everything** (`session_shutdown`,
  awaited by Pi): the group kill (SIGTERM, grace, SIGKILL) on every task's group,
  finished ones too since a `server &` outlives its command, on every foreground
  command in flight, and on a spawn still under way, once it resolves. The
  tasks are then forgotten and their completion is never reported, since the
  session that wanted it is over.
- **A crash or hard kill of Pi** is caught by a separate watcher, its own `sh`
  process spawned detached outside the task's group right after the wrapper. It
  is given Pi's pid and the task's group, checks both about once a second, and
  exits when the group has emptied; when Pi is gone first and the group still
  has members, it appends `__PI_BG_GONE__:<nonce>` to the log and SIGKILLs them.
  So a `server &` a finished command left behind is covered here too, as well as
  by session end and `bash_kill`/`/bg`. No Pi is left to read the GONE marker, so
  `bash_output` does not know it. A watcher that fails to start leaves the task
  running without a crash watch (fail open).
- **`bash_kill` and a `/bg` kill on a task whose command has exited** run the
  group kill when anything is left in its group and say so (`had already
  finished: exited (code 0); stopped the processes it left running`, or that
  they survived SIGKILL). An empty group gives "already finished" as before.
  The task's state is not changed.

Uses no `pi.events` hook.
