// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { publishAgentMessages, useSyncMessages } from './use-agent';
import type { AgentState } from './use-agent';
import type { UIChat, UIMessage } from '@nao/backend/chat';

const state = vi.hoisted(() => ({
	chatId: undefined as string | undefined,
	chats: new Map<string, UIChat>(),
}));

vi.mock('@/main', () => ({
	trpc: {
		chat: {
			get: { queryKey: vi.fn(() => ['chat', 'get']) },
			stop: { mutationOptions: vi.fn(() => ({})) },
			cancel: { mutationOptions: vi.fn(() => ({})) },
			switchMessageVersion: { mutationOptions: vi.fn(() => ({})) },
		},
	},
}));

vi.mock('./use-chat-id', () => ({
	useChatId: () => state.chatId,
}));

vi.mock('@/queries/use-chat-query', () => ({
	useChatQuery: ({ chatId }: { chatId?: string }) => ({
		data: chatId ? state.chats.get(chatId) : undefined,
		isLoading: false,
	}),
	useSetChat: () => setChat,
}));

const setChat = vi.fn(({ chatId }: { chatId?: string }, updater: (prev: UIChat | undefined) => UIChat | undefined) => {
	if (!chatId) {
		return;
	}
	const next = updater(state.chats.get(chatId));
	if (next) {
		state.chats.set(chatId, next);
	}
});

const message = (id: string): UIMessage =>
	({ id, role: 'user', parts: [{ type: 'text', text: id }] }) as unknown as UIMessage;

const chat = (id: string, messages: UIMessage[]): UIChat =>
	({
		id,
		projectId: 'project',
		title: id,
		isStarred: false,
		createdAt: 0,
		updatedAt: 0,
		messages,
	}) as UIChat;

const agent = ({
	chatId,
	agentInstanceId,
	messages,
	isRunning,
}: {
	chatId: string;
	agentInstanceId: string;
	messages: UIMessage[];
	isRunning: boolean;
}) => {
	const helpers = {
		chatId,
		agentInstanceId,
		messages,
		isRunning,
		setMessages: vi.fn((next: UIMessage[]) => {
			helpers.messages = [...next];
		}),
	};
	return helpers as unknown as AgentState;
};

beforeEach(() => {
	state.chatId = undefined;
	state.chats = new Map();
	setChat.mockClear();
});

afterEach(cleanup);

describe('useSyncMessages', () => {
	it('preserves the next chat when switching away mid-generation', () => {
		state.chats.set('chat-a', chat('chat-a', [message('a1')]));
		state.chats.set('chat-b', chat('chat-b', [message('b1')]));
		state.chatId = 'chat-a';

		const runningAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-a',
			messages: [message('a1'), message('a2')],
			isRunning: true,
		});
		const { rerender } = renderHook((currentAgent: AgentState) => useSyncMessages({ agent: currentAgent }), {
			initialProps: runningAgent,
		});

		state.chatId = 'chat-b';
		const freshAgent = agent({
			chatId: 'chat-b',
			agentInstanceId: 'instance-b',
			messages: [],
			isRunning: false,
		});
		rerender(freshAgent);

		expect(state.chats.get('chat-b')?.messages).toHaveLength(1);
		expect(freshAgent.messages).toHaveLength(1);
		expect(setChat).not.toHaveBeenCalledWith({ chatId: 'chat-b' }, expect.any(Function));
	});

	it('seeds a new agent instance when the cached array reference is unchanged', () => {
		const cachedChat = chat('chat-a', [message('a1')]);
		state.chats.set('chat-a', cachedChat);
		state.chatId = 'chat-a';

		const firstAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-1',
			messages: [],
			isRunning: false,
		});
		const { rerender } = renderHook((currentAgent: AgentState) => useSyncMessages({ agent: currentAgent }), {
			initialProps: firstAgent,
		});
		expect(firstAgent.messages).toHaveLength(1);

		const secondAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-2',
			messages: [],
			isRunning: false,
		});
		rerender(secondAgent);

		expect(state.chats.get('chat-a')?.messages).toBe(cachedChat.messages);
		expect(secondAgent.messages).toHaveLength(1);
	});

	it('preserves the latest streamed response when the run stops', () => {
		const cachedMessages = [message('a1')];
		state.chats.set('chat-a', chat('chat-a', cachedMessages));
		state.chatId = 'chat-a';

		const runningAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-a',
			messages: [message('a1'), message('answer')],
			isRunning: true,
		});
		const { rerender } = renderHook((currentAgent: AgentState) => useSyncMessages({ agent: currentAgent }), {
			initialProps: runningAgent,
		});

		const finishedAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-a',
			messages: [message('a1'), message('answer')],
			isRunning: false,
		});
		rerender(finishedAgent);

		expect(state.chats.get('chat-a')?.messages.map((item) => item.id)).toEqual(['a1', 'answer']);
	});

	it('does not publish chat A completion data into chat B', () => {
		state.chats.set('chat-a', chat('chat-a', [message('a1')]));
		state.chats.set('chat-b', chat('chat-b', [message('b1')]));
		state.chatId = 'chat-a';

		const runningAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-a',
			messages: [message('a1'), message('answer')],
			isRunning: true,
		});
		const { rerender } = renderHook((currentAgent: AgentState) => useSyncMessages({ agent: currentAgent }), {
			initialProps: runningAgent,
		});

		state.chatId = 'chat-b';
		rerender({ ...runningAgent, chatId: 'chat-b', isRunning: false });

		expect(state.chats.get('chat-b')?.messages.map((item) => item.id)).toEqual(['b1']);
	});
});

describe('publishAgentMessages', () => {
	const base = chat('chat-a', [message('a1')]);

	it('does not replace a stored history with an empty agent store', () => {
		expect(publishAgentMessages({ chatId: 'chat-a', base, messages: [] })(base)).toBe(base);
	});

	it('does not use a fallback cache entry belonging to another chat', () => {
		expect(publishAgentMessages({ chatId: 'chat-b', base, messages: [message('b1')] })(undefined)).toBeUndefined();
	});
});
