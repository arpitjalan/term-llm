import { render, screen } from '@testing-library/preact';
import { expect, it } from 'vitest';
import { PendingLabel } from './PendingLabel';

it('announces only the current button label as work starts and finishes', () => {
  const button = (pending: boolean) => (
    <button disabled={pending}>
      <PendingLabel pending={pending} label="Use connection" pendingLabel="Connecting…" />
    </button>
  );
  const { rerender } = render(button(false));
  expect(screen.getByRole('button', { name: 'Use connection', exact: true })).toBeEnabled();
  rerender(button(true));
  expect(screen.getByRole('button', { name: 'Connecting…', exact: true })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'Use connection', exact: true })).toBeNull();
  rerender(button(false));
  expect(screen.getByRole('button', { name: 'Use connection', exact: true })).toBeEnabled();
});
