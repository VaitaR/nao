// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSyncMessages } from './use-agent';
import type { AgentState } from './use-agent';
import type { UIChat, UIMessage } from '@nao/backend/chat';

const state = vi.hoisted(() => ({
	chatId: undefined as string | undefined,
	chats: new Map<string, UIChat>(),
}));

vi.mock('@/main', () => ({ trpc: {} }));

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

const message = (id: string) => ({ id, role: 'user', parts: [{ type: 'text', text: id }] }) as UIMessage;

const chat = (id: string, messages: UIMessage[]) => ({ id, messages }) as UIChat;

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
}) =>
	({
		chatId,
		agentInstanceId,
		messages,
		isRunning,
		setMessages: vi.fn(),
	}) as unknown as AgentState;

describe('useSyncMessages', () => {
	beforeEach(() => {
		state.chatId = undefined;
		state.chats.clear();
		setChat.mockClear();
	});

	afterEach(() => cleanup());

	it('keeps the destination history when switching away from a running chat', () => {
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

	it('hydrates a fresh agent when the cached messages reference is unchanged', () => {
		const cachedMessages = [message('a1')];
		state.chats.set('chat-a', chat('chat-a', cachedMessages));
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

		const freshAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-2',
			messages: [],
			isRunning: false,
		});
		rerender(freshAgent);

		expect(freshAgent.setMessages).toHaveBeenCalledWith(cachedMessages);
	});

	it('keeps the cached history when a run stops with an empty message list', () => {
		state.chats.set('chat-a', chat('chat-a', [message('a1')]));
		state.chatId = 'chat-a';

		const runningAgent = agent({
			chatId: 'chat-a',
			agentInstanceId: 'instance-a',
			messages: [message('a1'), message('latest')],
			isRunning: true,
		});
		const { rerender } = renderHook((currentAgent: AgentState) => useSyncMessages({ agent: currentAgent }), {
			initialProps: runningAgent,
		});

		rerender({ ...runningAgent, messages: [], isRunning: false });

		expect(state.chats.get('chat-a')?.messages.map((item) => item.id)).toEqual(['a1', 'latest']);
	});
});
