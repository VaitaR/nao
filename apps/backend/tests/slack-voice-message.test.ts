import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/db/db', () => ({ db: {} }));

vi.mock('../src/queries/chat.queries', () => ({
	getChatBySlackThread: vi.fn(async () => null),
	createChat: vi.fn(async () => [{ id: 'chat-1' }]),
	upsertMessage: vi.fn(async () => undefined),
}));

vi.mock('../src/queries/project.queries', () => ({
	getAgentSettings: vi.fn(),
}));

vi.mock('../src/services/transcribe.service', () => ({
	transcribeAudio: vi.fn(),
}));

import * as chatQueries from '../src/queries/chat.queries';
import * as projectQueries from '../src/queries/project.queries';
import type { SlackConfig } from '../src/queries/project-slack-config.queries';
import { ProjectSlackBot } from '../src/services/slack';
import * as transcribeService from '../src/services/transcribe.service';

const config: SlackConfig = {
	projectId: 'project-1',
	botToken: 'xoxb-test',
	signingSecret: 'secret',
	redirectUrl: 'http://localhost:3000/',
	autoCreateUsersEnabled: false,
	autoCreateUsersDomains: [],
	transportMode: 'webhook',
	appToken: '',
	replyMode: 'mention',
	dmScopeMissing: false,
};

const voiceClip = {
	id: 'F1',
	subtype: 'slack_audio',
	mimetype: 'audio/webm',
	size: 4,
	url_private: 'https://files.slack.com/files-pri/T1-F1/audio_message.webm',
};

function makeCtx(raw: unknown, text = '') {
	return {
		thread: { id: 'slack:C1:1760000000.000100' },
		userMessage: { id: '1760000000.000100', text, raw, author: { userId: 'U1' } },
		user: { id: 'user-1' },
	};
}

async function saveUserMessage(ctx: ReturnType<typeof makeCtx>): Promise<string> {
	const bot = new ProjectSlackBot(config) as unknown as {
		_saveOrUpdateUserMessage: (ctx: unknown, fetchUnseen: boolean) => Promise<void>;
	};
	await bot._saveOrUpdateUserMessage(ctx, false);
	const [, firstMessage] = vi.mocked(chatQueries.createChat).mock.calls[0];
	return firstMessage.text;
}

describe('Slack voice messages', () => {
	const fetchMock = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', fetchMock);
		fetchMock.mockImplementation(
			async () =>
				new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), { headers: { 'content-type': 'audio/webm' } }),
		);
		vi.mocked(projectQueries.getAgentSettings).mockResolvedValue({ transcribe: { enabled: true } } as never);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('saves the transcript of a voice clip as the user message', async () => {
		vi.mocked(transcribeService.transcribeAudio).mockResolvedValue('  How many new users yesterday?  ');

		const text = await saveUserMessage(makeCtx({ files: [voiceClip] }));

		expect(text).toBe('How many new users yesterday?');
		expect(fetchMock).toHaveBeenCalledWith(voiceClip.url_private, {
			headers: { Authorization: 'Bearer xoxb-test' },
		});
		expect(transcribeService.transcribeAudio).toHaveBeenCalledWith(
			'project-1',
			Buffer.from([0x1a, 0x45, 0xdf, 0xa3]).toString('base64'),
		);
		expect(vi.mocked(chatQueries.createChat).mock.calls[0][0].title).toContain('How many new');
	});

	it('keeps typed text before the transcript', async () => {
		vi.mocked(transcribeService.transcribeAudio).mockResolvedValue('by day');

		const text = await saveUserMessage(makeCtx({ files: [voiceClip] }, 'Retention for September'));

		expect(text).toBe('Retention for September\n\nby day');
	});

	it('reports disabled transcription to the model instead of an empty turn', async () => {
		vi.mocked(projectQueries.getAgentSettings).mockResolvedValue({ transcribe: { enabled: false } } as never);

		const text = await saveUserMessage(makeCtx({ files: [voiceClip] }));

		expect(text).toContain('voice transcription is not enabled for this project');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(transcribeService.transcribeAudio).not.toHaveBeenCalled();
	});

	it('reports a missing files:read scope when Slack answers with its login page', async () => {
		fetchMock.mockResolvedValue(new Response('<html></html>', { headers: { 'content-type': 'text/html' } }));

		const text = await saveUserMessage(makeCtx({ files: [voiceClip] }));

		expect(text).toContain('files:read is missing');
		expect(transcribeService.transcribeAudio).not.toHaveBeenCalled();
	});

	it('reports a transcription error and an empty transcript', async () => {
		vi.mocked(transcribeService.transcribeAudio).mockRejectedValueOnce(
			new Error('No API key configured for openai'),
		);
		expect(await saveUserMessage(makeCtx({ files: [voiceClip] }))).toContain(
			'the transcription service failed (No API key configured for openai)',
		);

		vi.clearAllMocks();
		vi.mocked(projectQueries.getAgentSettings).mockResolvedValue({ transcribe: { enabled: true } } as never);
		vi.mocked(transcribeService.transcribeAudio).mockResolvedValue('   ');
		expect(await saveUserMessage(makeCtx({ files: [voiceClip] }))).toContain(
			'no speech was recognized in the recording',
		);
	});

	it('leaves a text-only message untouched', async () => {
		const text = await saveUserMessage(makeCtx({ text: 'hello' }, 'hello'));

		expect(text).toBe('hello');
		expect(projectQueries.getAgentSettings).not.toHaveBeenCalled();
	});
});
