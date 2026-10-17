import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { SelectControl } from '../components/SelectControl';
import { PendingLabel } from '../components/PendingLabel';
import { APIError } from '../api/client';
import {
  personalBotJobs,
  type BotJob,
  type BotRun,
  type RoutineInput,
  type RoutineSchedule,
} from '../api/personal-bot-jobs';
import { errorMessage } from '../domain/text';
import type { AppStore } from '../stores/app-store';
import './routines.css';

const activeRun = (run: BotRun) =>
  ['queued', 'claimed', 'running', 'cancel_requested'].includes(run.status);
const statusLabel = (status: string) =>
  ({ succeeded: 'Finished', cancel_requested: 'Cancelling', timed_out: 'Timed out' })[status] ||
  status.charAt(0).toUpperCase() + status.slice(1).replaceAll('_', ' ');
const dateLabel = (value?: string) => (value ? new Date(value).toLocaleString() : '');
const finishedSchedule = (job: BotJob) =>
  job.trigger_type === 'once' && !job.enabled && !job.next_run_at;

function scheduleLabel(job: BotJob): string {
  if (job.trigger_type === 'manual') return 'Runs when you ask';
  if (job.trigger_type === 'once') return `Once · ${dateLabel(job.trigger_config.run_at)}`;
  const daily = /^(\d+) (\d+) \* \* \*$/.exec(job.trigger_config.expression || '');
  const timezone = job.trigger_config.timezone || job.schedule_timezone || 'UTC';
  return daily
    ? `Daily at ${daily[2].padStart(2, '0')}:${daily[1].padStart(2, '0')} · ${timezone}`
    : `Scheduled · ${timezone}`;
}

function RoutineForm({
  store,
  busy,
  onCreate,
  onClose,
}: {
  store: AppStore;
  busy: boolean;
  onCreate: (input: RoutineInput) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [schedule, setSchedule] = useState<RoutineSchedule>('manual');
  const [time, setTime] = useState('09:00');
  const [runAt, setRunAt] = useState('');
  const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const [timezone, setTimezone] = useState(browserTimezone);
  const [workspaceID, setWorkspaceID] = useState(store.activeProjectId.peek());
  const agents = [...new Set([store.config.agentName, ...store.config.agentNames].filter(Boolean))];
  const [agent, setAgent] = useState(
    store.selectedAgent.peek() || store.config.agentName || agents[0] || '',
  );
  const workspaces = store.projects.value
    .filter((project) => !project.archived && project.available !== false && project.path)
    .map((project) => ({ id: project.id, name: project.name, path: project.path! }));
  const current = store.activeSession.value;
  if (current?.workingDir && !workspaces.some((workspace) => workspace.path === current.workingDir))
    workspaces.push({
      id: 'current-session',
      name: 'Current conversation workspace',
      path: current.workingDir,
    });
  const workspace = workspaces.find((entry) => entry.id === workspaceID);
  const canCreate =
    store.startupDone.value && !store.authRequired.value && !!workspace && agents.includes(agent);

  return (
    <form
      class="pb-panel pb-routine-form"
      aria-label="Create routine"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canCreate || busy) return;
        onCreate({
          name,
          instructions,
          agent,
          cwd: workspace.path,
          schedule,
          timezone,
          time,
          runAt,
        });
      }}
    >
      <div class="pb-routine-heading">
        <h2>Give it a responsibility</h2>
        <button class="pb-button" type="button" disabled={busy} onClick={onClose}>
          Close
        </button>
      </div>
      <label class="pb-field">
        Routine name
        <input
          required
          maxLength={160}
          value={name}
          onInput={(event) => setName(event.currentTarget.value)}
          placeholder="Morning briefing"
        />
      </label>
      <label class="pb-field">
        Instructions
        <textarea
          required
          rows={4}
          value={instructions}
          onInput={(event) => setInstructions(event.currentTarget.value)}
          placeholder="What should your assistant do, and what would a useful result look like?"
        />
      </label>
      <div class="pb-routine-fields">
        <label class="pb-field">
          Workspace
          <SelectControl
            required
            value={workspaceID}
            onChange={(event) => setWorkspaceID(event.currentTarget.value)}
          >
            <option value="">Choose a workspace</option>
            {workspaces.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </SelectControl>
        </label>
        <label class="pb-field">
          Assistant
          <SelectControl
            required
            value={agent}
            onChange={(event) => setAgent(event.currentTarget.value)}
          >
            <option value="">Choose an assistant</option>
            {agents.map((entry) => (
              <option key={entry} value={entry}>
                {entry}
              </option>
            ))}
          </SelectControl>
        </label>
      </div>
      {workspace && (
        <p class="pb-routine-hint">
          Working folder on the server: <code>{workspace.path}</code>
        </p>
      )}
      {!workspaces.length && (
        <p class="pb-error" role="status">
          Start a new conversation, then use its Chat or project picker to choose or add a workspace
          before creating a routine.
        </p>
      )}
      {!agents.length && (
        <p class="pb-error" role="status">
          Ask your administrator to configure an assistant before creating routines.
        </p>
      )}
      <label class="pb-field">
        Schedule
        <SelectControl
          value={schedule}
          onChange={(event) => setSchedule(event.currentTarget.value as RoutineSchedule)}
        >
          <option value="manual">When I run it</option>
          <option value="once">Once</option>
          <option value="daily">Every day</option>
        </SelectControl>
      </label>
      {schedule === 'once' && (
        <label class="pb-field">
          Date and time
          <input
            type="datetime-local"
            required
            value={runAt}
            onInput={(event) => setRunAt(event.currentTarget.value)}
          />
          <span class="pb-routine-hint">Your browser timezone: {browserTimezone}</span>
        </label>
      )}
      {schedule === 'daily' && (
        <div class="pb-routine-fields">
          <label class="pb-field">
            Time
            <input
              type="time"
              required
              value={time}
              onInput={(event) => setTime(event.currentTarget.value)}
            />
          </label>
          <label class="pb-field">
            Timezone
            <input
              required
              value={timezone}
              onInput={(event) => setTimezone(event.currentTarget.value)}
              placeholder="Asia/Kolkata"
            />
          </label>
        </div>
      )}
      <p class="pb-routine-hint">
        Runs on the server, even after you close this tab. Each run has a 10-minute limit and uses
        the assistant’s configured tools and permissions. Results appear here.
      </p>
      <p class="pb-routine-hint">
        Background runs cannot ask for permission. Before scheduling work with files, try the task
        in a conversation and confirm and remember the workspace access your assistant needs.
      </p>
      <button class="pb-button pb-primary" type="submit" disabled={busy || !canCreate}>
        <PendingLabel pending={busy} label="Create routine" pendingLabel="Saving…" />
      </button>
    </form>
  );
}

function RunResult({
  run,
  onClose,
  onOpenSession,
  disabled,
}: {
  run: BotRun;
  onClose: () => void;
  onOpenSession?: (id: string) => void;
  disabled: boolean;
}) {
  return (
    <section class="pb-panel pb-routine-result" aria-label="Routine result">
      <div class="pb-routine-heading">
        <h3>Result · {statusLabel(run.status)}</h3>
        <button class="pb-button" onClick={onClose}>
          Close result
        </button>
      </div>
      {run.error && (
        <p class="pb-error" role="alert">
          {run.error}
        </p>
      )}
      {run.response || run.stdout ? (
        <pre>{run.response || run.stdout}</pre>
      ) : (
        <p>
          {activeRun(run)
            ? 'Your assistant is still working. The result will appear here.'
            : 'No written result was returned.'}
        </p>
      )}
      {run.truncated && (
        <p class="pb-routine-hint">This result is incomplete because the run reached a limit.</p>
      )}
      {run.session_id && onOpenSession && (
        <button
          class="pb-button"
          disabled={disabled}
          onClick={() => onOpenSession(run.session_id!)}
        >
          Open conversation
        </button>
      )}
    </section>
  );
}

export function Routines({
  store,
  onOpenSession,
}: {
  store: AppStore;
  onOpenSession?: (id: string) => void;
}) {
  const api = useMemo(() => personalBotJobs(store.api), [store.api]);
  const [jobs, setJobs] = useState<BotJob[]>([]);
  const [total, setTotal] = useState(0);
  const [runs, setRuns] = useState<BotRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const [selectedRun, setSelectedRun] = useState('');
  const [result, setResult] = useState<BotRun | null>(null);
  const [resultError, setResultError] = useState('');
  const mounted = useRef(true);
  const mutation = useRef(false);
  const ready = store.startupDone.value && !store.authRequired.value;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let available = false;
    const refresh = async () => {
      if (!store.startupDone.peek() || store.authRequired.peek()) return;
      let poll = true;
      try {
        if (!available) available = await api.available(controller.signal);
        if (controller.signal.aborted) return;
        if (!available) {
          setUnavailable(true);
          poll = false;
          return;
        }
        const [jobList, runList] = await Promise.all([
          api.jobs(controller.signal),
          api.runs(controller.signal),
        ]);
        if (controller.signal.aborted) return;
        setJobs(jobList.data || []);
        setTotal(jobList.total);
        setRuns(runList.data || []);
        setUnavailable(false);
        setLoadError('');
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof APIError && error.status === 404) {
          setUnavailable(true);
          poll = false;
        } else setLoadError(errorMessage(error));
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          if (poll) timer = setTimeout(() => void refresh(), 15_000);
        }
      }
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [api, revision, ready, store]);

  useEffect(() => {
    if (!ready || !selectedRun) return;
    const controller = new AbortController();
    setResultError('');
    void api
      .run(selectedRun, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setResult(value);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setResultError(errorMessage(error));
      });
    return () => controller.abort();
  }, [api, selectedRun, runs, ready]);

  const act = async (operation: () => Promise<unknown>, message: string, closeForm = false) => {
    if (mutation.current || !store.startupDone.peek() || store.authRequired.peek()) return;
    mutation.current = true;
    setBusy(true);
    setActionError('');
    setNotice('');
    try {
      await operation();
      if (!mounted.current || !store.startupDone.peek() || store.authRequired.peek()) return;
      setNotice(message);
      if (closeForm) setCreating(false);
      setRevision((value) => value + 1);
    } catch (error) {
      if (mounted.current) setActionError(errorMessage(error));
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section class="pb-routines" aria-label="Routines">
      <div class="pb-routine-heading">
        <div>
          <p class="pb-eyebrow">Your assistant, on a schedule</p>
          <h1>Routines</h1>
          <p>Give recurring work a home. Come back to the results.</p>
        </div>
        <button
          class="pb-button pb-primary"
          disabled={!ready || unavailable || loading || creating || !!loadError}
          onClick={() => setCreating(true)}
        >
          New routine
        </button>
      </div>
      {(loadError || actionError) && (
        <div class="pb-error" role="alert">
          {actionError || `Could not refresh routines: ${loadError}`}
          <button
            class="pb-button"
            disabled={!ready || busy}
            onClick={() => {
              setActionError('');
              setRevision((value) => value + 1);
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {notice && (
        <p role="status" class="pb-routine-notice">
          {notice}
        </p>
      )}
      {unavailable ? (
        <div class="pb-panel">
          <h2>Routines are not enabled yet</h2>
          <p>
            Your administrator needs to enable background jobs on this server. Your conversations
            are still available.
          </p>
          <button
            class="pb-button"
            disabled={!ready}
            onClick={() => setRevision((value) => value + 1)}
          >
            Check again
          </button>
        </div>
      ) : (
        <>
          {creating && (
            <RoutineForm
              store={store}
              busy={busy}
              onClose={() => setCreating(false)}
              onCreate={(input) =>
                void act(
                  () => api.create(input),
                  'Routine created. You can run it now or wait for its schedule.',
                  true,
                )
              }
            />
          )}
          {loading ? (
            <p role="status">Loading routines…</p>
          ) : !jobs.length && !loadError && !creating ? (
            <div class="pb-panel pb-routine-empty">
              <h2>Your first routine starts here</h2>
              <p>
                A daily briefing, a follow-up, or a task for later. Tell your assistant what a
                useful result looks like.
              </p>
              <button class="pb-button" disabled={!ready} onClick={() => setCreating(true)}>
                Create your first routine
              </button>
            </div>
          ) : (
            <div class="pb-routine-list">
              {jobs.map((job) => (
                <article class="pb-panel pb-routine-card" key={job.id} aria-label={job.name}>
                  <div class="pb-routine-heading">
                    <h2>{job.name}</h2>
                    <span class={`pb-routine-status${job.enabled ? '' : ' is-paused'}`}>
                      {finishedSchedule(job)
                        ? 'Schedule finished'
                        : job.enabled
                          ? 'Active'
                          : 'Paused'}
                    </span>
                  </div>
                  <p class="pb-routine-schedule">{scheduleLabel(job)}</p>
                  {job.runner_config.instructions && (
                    <p class="pb-routine-instructions">{job.runner_config.instructions}</p>
                  )}
                  {job.enabled && job.next_run_at && (
                    <p class="pb-routine-hint">Next run: {dateLabel(job.next_run_at)}</p>
                  )}
                  {job.last_run && (
                    <p class="pb-routine-hint">Last run: {statusLabel(job.last_run.status)}</p>
                  )}
                  <div class="pb-routine-actions">
                    {!finishedSchedule(job) && (
                      <>
                        <button
                          class="pb-button"
                          disabled={
                            !ready ||
                            busy ||
                            !job.enabled ||
                            (!!job.last_run && activeRun(job.last_run))
                          }
                          onClick={() =>
                            void act(
                              () => api.trigger(job.id),
                              `${job.name} is queued. You can close this tab.`,
                            )
                          }
                        >
                          Run now
                        </button>
                        <button
                          class="pb-button"
                          disabled={!ready || busy}
                          onClick={() =>
                            void act(
                              () => (job.enabled ? api.pause(job.id) : api.resume(job.id)),
                              job.enabled
                                ? 'Routine paused. Any current run will continue.'
                                : 'Routine resumed.',
                            )
                          }
                        >
                          {job.enabled ? 'Pause' : 'Resume'}
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          )}
          {total > jobs.length && (
            <p class="pb-routine-hint">
              Showing the {jobs.length} most recent routines of {total}.
            </p>
          )}
          {!!runs.length && (
            <section class="pb-routine-history" aria-label="Recent routine runs">
              <h2>Recent runs</h2>
              <p class="pb-routine-hint">
                The latest 20 runs, with times in your browser timezone.
              </p>
              <div class="pb-panel">
                {runs.map((run) => {
                  const name = jobs.find((job) => job.id === run.job_id)?.name || 'Routine';
                  const expanded = selectedRun === run.id;
                  const resultID = `pb-routine-result-${run.id}`;
                  return (
                    <div class="pb-routine-run" key={run.id}>
                      <div class="pb-routine-run-heading">
                        <div>
                          <strong>{name}</strong>
                          <p class="pb-routine-hint">
                            {dateLabel(run.created_at)} · {statusLabel(run.status)}
                          </p>
                        </div>
                        <div class="pb-routine-actions">
                          <button
                            class="pb-button"
                            aria-label={`View result for ${name}`}
                            aria-expanded={expanded}
                            aria-controls={expanded ? resultID : undefined}
                            disabled={!ready}
                            onClick={() => {
                              if (!expanded) {
                                setResult(null);
                                setResultError('');
                              }
                              setSelectedRun(run.id);
                            }}
                          >
                            View result
                          </button>
                          {activeRun(run) && run.status !== 'cancel_requested' && (
                            <button
                              class="pb-button"
                              disabled={!ready || busy}
                              onClick={() =>
                                void act(() => api.cancel(run.id), 'Cancellation requested.')
                              }
                            >
                              Cancel run
                            </button>
                          )}
                        </div>
                      </div>
                      {expanded && (
                        <div id={resultID} aria-live="polite">
                          {resultError ? (
                            <p class="pb-error" role="alert">
                              Could not load result: {resultError}
                            </p>
                          ) : result ? (
                            <RunResult
                              run={result}
                              onClose={() => setSelectedRun('')}
                              onOpenSession={onOpenSession}
                              disabled={!ready}
                            />
                          ) : (
                            <p role="status">Loading result…</p>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
        </>
      )}
    </section>
  );
}
