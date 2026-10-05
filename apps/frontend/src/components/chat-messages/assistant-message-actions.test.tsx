// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageActions } from './assistant-message-actions';

import type { UIMessage } from '@nao/backend/chat';

const state = vi.hoisted(() => ({
	agent: null as { setMessages: ReturnType<typeof vi.fn> } | null,
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
	trpcClient: {},
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

describe('feedback synchronization', () => {
	beforeEach(() => {
		state.agent = { setMessages: vi.fn() };
		state.onSuccess = undefined;
	});

	afterEach(cleanup);

	it('updates the live message store as well as the persisted query cache', () => {
		render(<AssistantMessageActions message={message} chatId='chat-1' />);
		const vote = { vote: 'up', messageId: message.id };
		const client = { setQueryData: vi.fn(), invalidateQueries: vi.fn() };
		state.onSuccess!(vote, {}, undefined, { client });

		expect(client.setQueryData).toHaveBeenCalledOnce();
		expect(state.agent!.setMessages).toHaveBeenCalledOnce();
		const update = state.agent!.setMessages.mock.calls[0][0] as (messages: UIMessage[]) => UIMessage[];
		const other = { id: 'message-2', role: 'assistant', parts: [] } as unknown as UIMessage;
		const result = update([message, other]);
		expect(result[0]).toEqual({ ...message, feedback: vote });
		expect(result[1]).toBe(other);
	});

	it('still updates persisted feedback when no live agent is mounted', () => {
		state.agent = null;
		render(<AssistantMessageActions message={message} chatId='chat-1' />);
		const client = { setQueryData: vi.fn(), invalidateQueries: vi.fn() };
		expect(() => state.onSuccess!({ vote: 'down' }, {}, undefined, { client })).not.toThrow();
		expect(client.setQueryData).toHaveBeenCalledOnce();
	});
});
