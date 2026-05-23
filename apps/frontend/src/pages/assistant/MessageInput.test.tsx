import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageInput } from './MessageInput';

describe('MessageInput', () => {
  it('calls onSend with trimmed text when Enter is pressed', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    const textarea = screen.getByLabelText('AI yordamchiga xabar');
    await user.type(textarea, '   Salom   ');
    await user.keyboard('{Enter}');
    expect(onSend).toHaveBeenCalledExactlyOnceWith('Salom');
  });

  it('inserts a newline on Shift+Enter without sending', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    const textarea = screen.getByLabelText(
      'AI yordamchiga xabar',
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'Birinchi');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(textarea, 'Ikkinchi');
    expect(onSend).not.toHaveBeenCalled();
    expect(textarea.value).toContain('Birinchi');
    expect(textarea.value).toContain('Ikkinchi');
    expect(textarea.value).toContain('\n');
  });

  it('does not send when the message is only whitespace', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    await user.type(screen.getByLabelText('AI yordamchiga xabar'), '   ');
    await user.keyboard('{Enter}');
    expect(onSend).not.toHaveBeenCalled();
  });

  it('disables the textarea and send button while sending', () => {
    render(<MessageInput onSend={() => {}} isSending />);
    expect(screen.getByLabelText('AI yordamchiga xabar')).toBeDisabled();
    expect(screen.getByLabelText('Yuborish')).toBeDisabled();
  });

  it('clears the textarea after a successful send', async () => {
    const onSend = vi.fn();
    const user = userEvent.setup();
    render(<MessageInput onSend={onSend} isSending={false} />);
    const textarea = screen.getByLabelText(
      'AI yordamchiga xabar',
    ) as HTMLTextAreaElement;
    await user.type(textarea, 'test');
    await user.click(screen.getByLabelText('Yuborish'));
    expect(onSend).toHaveBeenCalledWith('test');
    expect(textarea.value).toBe('');
  });
});
