import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { HubAPIError, type PersonalBotClient } from '../../api/hub-client';
import { PersonalBotManagerStore } from '../stores/personal-bot-manager';
import { ConnectAssistant } from './ConnectAssistant';

describe('ConnectAssistant', () => {
  it('keeps entered credentials after failure and submits trimmed values without Docker', async () => {
    const add = vi
      .fn()
      .mockRejectedValueOnce(new HubAPIError(409, 'Choose a different name.'))
      .mockResolvedValueOnce({ id: 'native' });
    const client = {
      config: { basePath: '' },
      addNode: add,
      listNodes: vi.fn(async () => ({ nodes: [] })),
    } as unknown as PersonalBotClient;
    const store = new PersonalBotManagerStore(client);
    const close = vi.fn();
    const { unmount } = render(<ConnectAssistant store={store} close={close} />);
    try {
      const name = screen.getByLabelText('Name');
      const url = screen.getByLabelText('URL');
      const token = screen.getByLabelText(/^Bearer token/);
      expect(name).toHaveFocus();
      expect(token).toHaveAttribute('type', 'password');
      fireEvent.input(name, { target: { value: ' My computer ' } });
      fireEvent.input(url, { target: { value: 'http://computer.test/chat' } });
      fireEvent.input(token, { target: { value: ' fixture-token ' } });
      fireEvent.submit(screen.getByRole('form', { name: 'Connect an existing assistant' }));
      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('Choose a different name.'),
      );
      expect(token).toHaveValue(' fixture-token ');
      expect(name).toHaveValue(' My computer ');
      expect(close).not.toHaveBeenCalled();
      expect(add).toHaveBeenLastCalledWith(
        { name: 'My computer', url: 'http://computer.test/chat', token: 'fixture-token' },
        expect.any(AbortSignal),
      );
      fireEvent.submit(screen.getByRole('form', { name: 'Connect an existing assistant' }));
      await waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(token).toHaveValue('');
      expect(add).toHaveBeenCalledTimes(2);
    } finally {
      unmount();
      store.dispose();
    }
  });
});
