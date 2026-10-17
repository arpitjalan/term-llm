import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { readInjectedConfig } from '../app/config';
import { APIError } from '../api/client';
import type { BotJob, BotRun } from '../api/personal-bot-jobs';
import { AppStore } from '../stores/app-store';
import { Routines } from './Routines';

const job: BotJob = {
  id: 'job-1',
  name: 'Morning briefing',
  enabled: true,
  runner_type: 'llm',
  runner_config: { instructions: 'Summarize company notes.' },
  trigger_type: 'manual',
  trigger_config: {},
};
const run: BotRun = {
  id: 'run-1',
  job_id: 'job-1',
  status: 'running',
  created_at: '2026-10-16T09:00:00Z',
};

function setup(jobs: BotJob[] = [], runs: BotRun[] = []) {
  const store = new AppStore({
    ...readInjectedConfig(),
    agentName: 'jarvis',
    agentNames: ['jarvis'],
  });
  store.startupDone.value = true;
  store.projects.value = [{ id: 'workspace', name: 'Company workspace', path: '/company' }];
  store.activeProjectId.value = 'workspace';
  const get = vi.spyOn(store.api, 'get').mockImplementation(async (path) => {
    if (path === '/v1/capabilities') return { jobs: { enabled: true } };
    if (path.startsWith('/v2/jobs?')) return { data: jobs, total: jobs.length };
    if (path.startsWith('/v2/runs?')) return { data: runs, total: runs.length };
    return {
      ...run,
      status: 'succeeded',
      response: 'The company notes are ready.',
      session_id: 'session-one',
    };
  });
  const json = vi.spyOn(store.api, 'json').mockResolvedValue(job);
  return { store, get, json };
}

describe('assistant routines', () => {
  it('waits for authoritative startup and authentication before reading routines', async () => {
    const { store, get } = setup();
    store.startupDone.value = false;
    const { unmount } = render(<Routines store={store} />);
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'New routine' })).toBeDisabled();
    await act(() => {
      store.startupDone.value = true;
      store.authRequired.value = true;
    });
    expect(get).not.toHaveBeenCalled();
    await act(() => {
      store.authRequired.value = false;
    });
    await screen.findByText('Your first routine starts here');
    expect(get).toHaveBeenCalledTimes(3);
    expect(screen.getByRole('button', { name: 'New routine' })).toBeEnabled();
    unmount();
    store.dispose();
  });

  it('aborts result reads, stops polling, and disables mutations when authentication expires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { store, get, json } = setup([job], [run]);
      const { unmount } = render(<Routines store={store} />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {});
      let detailSignal: AbortSignal | undefined;
      get.mockImplementationOnce((_path, signal) => {
        detailSignal = signal;
        return new Promise(() => {});
      });
      fireEvent.click(screen.getByRole('button', { name: 'View result for Morning briefing' }));
      await act(async () => {});
      expect(detailSignal?.aborted).toBe(false);
      await act(() => {
        store.authRequired.value = true;
      });
      expect(detailSignal?.aborted).toBe(true);
      for (const name of [
        'New routine',
        'Run now',
        'Pause',
        'Cancel run',
        'View result for Morning briefing',
      ]) {
        expect(screen.getByRole('button', { name })).toBeDisabled();
      }
      fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
      expect(json).not.toHaveBeenCalled();
      expect(get).toHaveBeenCalledTimes(4);
      await act(() => {
        unmount();
      });
      store.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('creates a daily routine from a selected server workspace and shows confirmation', async () => {
    const { store, json } = setup();
    const { unmount } = render(<Routines store={store} />);
    await screen.findByText('Your first routine starts here');
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
    fireEvent.input(screen.getByLabelText('Routine name'), {
      target: { value: 'Morning briefing' },
    });
    fireEvent.input(screen.getByLabelText('Instructions'), {
      target: { value: 'Summarize company notes.' },
    });
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: 'daily' } });
    fireEvent.input(screen.getByLabelText('Time'), { target: { value: '09:30' } });
    fireEvent.input(screen.getByLabelText('Timezone'), { target: { value: 'Asia/Kolkata' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create routine' }));
    await screen.findByText('Routine created. You can run it now or wait for its schedule.');
    expect(json).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(json.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      runner_config: { cwd: '/company', agent_name: 'jarvis', persist_session: true },
      trigger_type: 'cron',
      trigger_config: { expression: '30 9 * * *', timezone: 'Asia/Kolkata' },
    });
    expect(body.runner_config.read_dir).toBeUndefined();
    expect(body.runner_config.write_dir).toBeUndefined();
    expect(body.runner_config.tools).toBeUndefined();
    unmount();
    store.dispose();
  });

  it('requires a server-confirmed workspace before allowing creation', async () => {
    const { store, json } = setup();
    store.projects.value = [];
    const { unmount } = render(<Routines store={store} />);
    await screen.findByText('Your first routine starts here');
    fireEvent.click(screen.getByRole('button', { name: 'New routine' }));
    expect(screen.getByRole('button', { name: 'Create routine' })).toBeDisabled();
    expect(
      screen.getByText(/Start a new conversation, then use its Chat or project picker/),
    ).toBeInTheDocument();
    expect(json).not.toHaveBeenCalled();
    unmount();
    store.dispose();
  });

  it('shows server failures, never repeats failed mutations, and keeps pause separate from cancel', async () => {
    const { store, json } = setup([job], [run]);
    json.mockRejectedValueOnce(new APIError('Permission denied', 403));
    const { unmount } = render(<Routines store={store} />);
    const card = await screen.findByRole('article', { name: 'Morning briefing' });
    fireEvent.click(within(card).getByRole('button', { name: 'Pause' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Permission denied')).toBeInTheDocument();
    expect(json).toHaveBeenCalledTimes(1);
    expect(json.mock.calls[0][0]).toBe('/v2/jobs/job-1/pause');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    await screen.findByText('Cancellation requested.');
    expect(json.mock.calls[1][0]).toBe('/v2/runs/run-1/cancel');
    unmount();
    store.dispose();
  });

  it('triggers a routine, resumes a paused routine, and fetches the full saved result', async () => {
    const { store, json, get } = setup(
      [job, { ...job, id: 'job-2', name: 'Weekly notes', enabled: false }],
      [{ ...run, status: 'succeeded' }],
    );
    const openSession = vi.fn();
    const { unmount } = render(<Routines store={store} onOpenSession={openSession} />);
    const card = await screen.findByRole('article', { name: 'Morning briefing' });
    fireEvent.click(within(card).getByRole('button', { name: 'Run now' }));
    await screen.findByText('Morning briefing is queued. You can close this tab.');
    expect(json.mock.calls[0][0]).toBe('/v2/jobs/job-1/trigger');
    const paused = screen.getByRole('article', { name: 'Weekly notes' });
    expect(within(paused).getByRole('button', { name: 'Run now' })).toBeDisabled();
    fireEvent.click(within(paused).getByRole('button', { name: 'Resume' }));
    await screen.findByText('Routine resumed.');
    expect(json.mock.calls[1][0]).toBe('/v2/jobs/job-2/resume');
    fireEvent.click(screen.getByRole('button', { name: 'View result for Morning briefing' }));
    await screen.findByText('The company notes are ready.');
    expect(get).toHaveBeenCalledWith('/v2/runs/run-1', expect.any(AbortSignal), { retries: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Open conversation' }));
    expect(openSession).toHaveBeenCalledWith('session-one');
    unmount();
    store.dispose();
  });

  it('opens each result beside its run and collapses the previous result when switching runs', async () => {
    const { store, get } = setup(
      [job],
      [
        { ...run, status: 'succeeded' },
        { ...run, id: 'run-2', status: 'succeeded', created_at: '2026-10-15T09:00:00Z' },
      ],
    );
    const { unmount } = render(<Routines store={store} />);
    const [firstButton, secondButton] = await screen.findAllByRole('button', {
      name: 'View result for Morning briefing',
    });
    const firstRow = firstButton.closest<HTMLElement>('.pb-routine-run')!;
    const secondRow = secondButton.closest<HTMLElement>('.pb-routine-run')!;
    expect(firstButton).toHaveAttribute('aria-expanded', 'false');
    expect(secondButton).toHaveAttribute('aria-expanded', 'false');

    get.mockResolvedValueOnce({ ...run, status: 'succeeded', response: 'Today’s briefing.' });
    fireEvent.click(firstButton);
    const firstResult = await within(firstRow).findByRole('region', { name: 'Routine result' });
    expect(firstResult).toHaveTextContent('Today’s briefing.');
    expect(firstButton).toHaveAttribute('aria-expanded', 'true');
    const controlledResult = document.getElementById(firstButton.getAttribute('aria-controls')!);
    expect(firstRow).toContainElement(controlledResult);
    expect(controlledResult).toContainElement(firstResult);
    expect(within(secondRow).queryByRole('region', { name: 'Routine result' })).toBeNull();

    get.mockResolvedValueOnce({
      ...run,
      id: 'run-2',
      status: 'succeeded',
      response: 'Yesterday’s briefing.',
    });
    fireEvent.click(secondButton);
    const secondResult = await within(secondRow).findByRole('region', { name: 'Routine result' });
    expect(secondResult).toHaveTextContent('Yesterday’s briefing.');
    expect(firstButton).toHaveAttribute('aria-expanded', 'false');
    expect(secondButton).toHaveAttribute('aria-expanded', 'true');
    expect(within(firstRow).queryByRole('region', { name: 'Routine result' })).toBeNull();
    expect(screen.queryByText('Today’s briefing.')).toBeNull();
    expect(get).toHaveBeenCalledWith('/v2/runs/run-2', expect.any(AbortSignal), { retries: 0 });

    fireEvent.click(within(secondResult).getByRole('button', { name: 'Close result' }));
    expect(screen.queryByRole('region', { name: 'Routine result' })).toBeNull();
    expect(secondButton).toHaveAttribute('aria-expanded', 'false');
    unmount();
    store.dispose();
  });

  it('keeps result loading and failures beside the selected run', async () => {
    const { store, get } = setup(
      [job],
      [
        { ...run, status: 'succeeded' },
        { ...run, id: 'run-2', status: 'succeeded', created_at: '2026-10-15T09:00:00Z' },
      ],
    );
    const { unmount } = render(<Routines store={store} />);
    const [firstButton, secondButton] = await screen.findAllByRole('button', {
      name: 'View result for Morning briefing',
    });
    const firstRow = firstButton.closest<HTMLElement>('.pb-routine-run')!;
    const secondRow = secondButton.closest<HTMLElement>('.pb-routine-run')!;
    let rejectDetail: (error: Error) => void = () => {};
    get.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDetail = reject;
        }),
    );
    fireEvent.click(secondButton);
    expect(await within(secondRow).findByRole('status')).toHaveTextContent('Loading result…');
    expect(within(firstRow).queryByRole('status')).toBeNull();

    await act(async () => {
      rejectDetail(new APIError('Result unavailable', 503));
    });
    expect(await within(secondRow).findByRole('alert')).toHaveTextContent(
      'Could not load result: Result unavailable',
    );
    expect(within(firstRow).queryByRole('alert')).toBeNull();
    expect(within(secondRow).queryByRole('status')).toBeNull();

    get.mockResolvedValueOnce({ ...run, status: 'succeeded', response: 'Today’s briefing.' });
    fireEvent.click(firstButton);
    expect(await within(firstRow).findByText('Today’s briefing.')).toBeInTheDocument();
    expect(within(secondRow).queryByRole('alert')).toBeNull();
    unmount();
    store.dispose();
  });

  it('does not offer to resume a consumed one-time schedule', async () => {
    const { store } = setup([
      {
        ...job,
        enabled: false,
        trigger_type: 'once',
        trigger_config: { run_at: '2026-10-16T09:00:00Z' },
      },
    ]);
    const { unmount } = render(<Routines store={store} />);
    const card = await screen.findByRole('article', { name: 'Morning briefing' });
    expect(within(card).getByText('Schedule finished')).toBeInTheDocument();
    expect(within(card).queryByRole('button', { name: 'Resume' })).not.toBeInTheDocument();
    unmount();
    store.dispose();
  });

  it('explains when background jobs are unavailable and disables creation', async () => {
    const { store, get } = setup();
    get.mockResolvedValue({ jobs: { enabled: false } });
    const { unmount } = render(<Routines store={store} />);
    await screen.findByText('Routines are not enabled yet');
    expect(screen.getByRole('button', { name: 'New routine' })).toBeDisabled();
    expect(get).toHaveBeenCalledTimes(1);
    unmount();
    store.dispose();
  });

  it('aborts pending reads on unmount and stops polling', async () => {
    const { store, get } = setup();
    const signals: AbortSignal[] = [];
    get.mockImplementation((path, signal) => {
      if (signal) signals.push(signal);
      if (path === '/v1/capabilities') return Promise.resolve({ jobs: { enabled: true } });
      return new Promise(() => {});
    });
    const { unmount } = render(<Routines store={store} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    await act(() => {
      unmount();
    });
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    store.dispose();
  });

  it('refreshes live state at a bounded interval and stops after leaving routines', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { store, get } = setup([job]);
    const { unmount } = render(<Routines store={store} />);
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(3);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(get).toHaveBeenCalledTimes(5);
    await act(() => {
      unmount();
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(get).toHaveBeenCalledTimes(5);
    store.dispose();
    vi.useRealTimers();
  });
});
