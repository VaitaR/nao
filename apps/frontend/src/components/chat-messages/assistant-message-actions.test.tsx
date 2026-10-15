// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageActions, FeedbackDialog } from './assistant-message-actions';
import type { UIMessage } from '@nao/backend/chat';

const state = vi.hoisted(() => ({
	agent: { setMessages: vi.fn() },
	onSuccess: undefined as ((...args: unknown[]) => void) | undefined,
}));

vi.mock('@tanstack/react-query', () => ({
	useMutation: () => ({ mutate: vi.fn(), isPending: false }),
	useQuery: () => ({ data: { title: 'Test chat' } }),
}));

vi.mock('@/contexts/agent.provider', () => ({
	useAgentContext: () => state.agent,
	useAgentMessagesGetter: () => () => [],
}));

vi.mock('@/hooks/use-copy-to-clipboard', () => ({
	useCopyToClipboard: () => ({ isCopied: false, copy: vi.fn() }),
}));

vi.mock('@/main', () => ({
	trpc: {
		chat: { get: { queryOptions: () => ({}), queryKey: () => ['chat', 'get'] } },
		project: {
			getChatReplay: { queryKey: () => ['project', 'replay'] },
			getProjectChats: { queryKey: () => ['project', 'chats'] },
		},
		feedback: {
			submit: {
				mutationOptions: (options: { onSuccess: (...args: unknown[]) => void }) => {
					state.onSuccess = options.onSuccess;
					return {};
				},
			},
		},
	},
}));

const message = { id: 'message-1', role: 'assistant', parts: [] } as unknown as UIMessage;

describe('FeedbackDialog', () => {
	afterEach(cleanup);

	it('shows positive feedback wording', () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} isPending={false} vote='up' />);

		expect(screen.getByText('What went well?')).toBeDefined();
		expect(screen.getByPlaceholderText('Tell us what worked well (optional)')).toBeDefined();
	});

	it('preserves negative feedback wording', () => {
		render(<FeedbackDialog open onOpenChange={vi.fn()} onSubmit={vi.fn()} isPending={false} vote='down' />);

		expect(screen.getByText('What went wrong?')).toBeDefined();
		expect(screen.getByPlaceholderText('Tell us what could be better (optional)')).toBeDefined();
	});

	it('submits trimmed text or undefined when empty', () => {
		const onSubmit = vi.fn();
		render(<FeedbackDialog open onOpenChange={vi.fn()} onSubmit={onSubmit} isPending={false} vote='up' />);

		fireEvent.change(screen.getByPlaceholderText('Tell us what worked well (optional)'), {
			target: { value: '  Clear and useful  ' },
		});
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
		fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

		expect(onSubmit).toHaveBeenNthCalledWith(1, 'Clear and useful');
		expect(onSubmit).toHaveBeenNthCalledWith(2, undefined);
	});
});

describe('feedback synchronization', () => {
	afterEach(cleanup);

	it('updates the live agent message after feedback succeeds', () => {
		const agent = { setMessages: vi.fn() };
		state.agent = agent;
		render(<AssistantMessageActions message={message} chatId='chat-1' />);
		const client = { setQueryData: vi.fn(), invalidateQueries: vi.fn() };
		const feedback = { vote: 'up' };

		state.onSuccess!(feedback, {}, undefined, { client });

		expect(agent.setMessages).toHaveBeenCalledOnce();
		const update = agent.setMessages.mock.calls[0][0] as (messages: UIMessage[]) => UIMessage[];
		const other = { id: 'message-2', role: 'assistant', parts: [] } as unknown as UIMessage;
		const result = update([message, other]);

		expect(result[0]).toEqual({ ...message, feedback });
		expect(result[1]).toBe(other);
	});
});
