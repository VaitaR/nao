import { describe, expect, it, vi } from 'vitest';

import { buildTranscriptionUsage, transcribeAudio } from '../src/services/transcribe.service';

const mocks = vi.hoisted(() => ({
	insertLlmInference: vi.fn(),
	transcribe: vi.fn(),
}));

vi.mock('ai', () => ({ experimental_transcribe: mocks.transcribe }));
vi.mock('../src/queries/llm-inference', () => ({ insertLlmInference: mocks.insertLlmInference }));
vi.mock('../src/queries/project.queries', () => ({ getAgentSettings: async () => undefined }));
vi.mock('../src/queries/project-llm-config.queries', () => ({
	getProjectLlmConfigByProvider: async () => ({ apiKey: 'sk-test', baseUrl: null }),
}));
vi.mock('../src/agents/transcribe.providers', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/agents/transcribe.providers')>();
	return {
		...actual,
		// Stands in for the provider's HTTP call, so the capturing fetch sees a real Response.
		createTranscribeModel: (_p: unknown, _s: unknown, _m: unknown, fetchFn?: typeof fetch) =>
			({ fetchFn }) as never,
	};
});

describe('buildTranscriptionUsage', () => {
	it('maps token usage of token-billed models', () => {
		expect(
			buildTranscriptionUsage(
				'openai',
				'gpt-4o-mini-transcribe',
				{ type: 'tokens', input_tokens: 120, output_tokens: 30 },
				undefined,
			),
		).toEqual({
			inputTotalTokens: 120,
			inputNoCacheTokens: 120,
			outputTotalTokens: 30,
			outputTextTokens: 30,
			totalTokens: 150,
		});
	});

	it('records whisper as one input unit per started second', () => {
		const expected = { inputTotalTokens: 13, inputNoCacheTokens: 13, totalTokens: 13 };
		expect(buildTranscriptionUsage('openai', 'whisper-1', undefined, 12.2)).toEqual(expected);
		expect(buildTranscriptionUsage('openai', 'whisper-1', { type: 'duration', seconds: 12.2 }, undefined)).toEqual(
			expected,
		);
	});

	it('returns nothing when the response carried no usable usage', () => {
		expect(buildTranscriptionUsage('openai', 'gpt-4o-transcribe', undefined, 12)).toBeUndefined();
		expect(buildTranscriptionUsage('openai', 'whisper-1', undefined, undefined)).toBeUndefined();
	});
});

describe('transcribeAudio usage recording', () => {
	it('records the usage read from the raw response body, attributed to the user', async () => {
		mocks.insertLlmInference.mockReset();
		mocks.transcribe.mockImplementation(async ({ model }: { model: { fetchFn: typeof fetch } }) => {
			vi.stubGlobal(
				'fetch',
				async () =>
					new Response(
						JSON.stringify({
							text: 'hello',
							usage: { type: 'tokens', input_tokens: 10, output_tokens: 2, total_tokens: 12 },
						}),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					),
			);
			await model.fetchFn('https://api.openai.test/v1/audio/transcriptions');
			vi.unstubAllGlobals();
			return { text: 'hello', durationInSeconds: undefined };
		});

		await expect(transcribeAudio('project-1', 'user-1', 'AAAA')).resolves.toBe('hello');

		expect(mocks.insertLlmInference).toHaveBeenCalledWith({
			projectId: 'project-1',
			userId: 'user-1',
			type: 'transcription',
			llmProvider: 'openai',
			llmModelId: 'gpt-4o-mini-transcribe',
			inputTotalTokens: 10,
			inputNoCacheTokens: 10,
			outputTotalTokens: 2,
			outputTextTokens: 2,
			totalTokens: 12,
		});
	});

	it('records usage the provider billed even when the SDK rejects an empty transcript', async () => {
		mocks.insertLlmInference.mockReset();
		mocks.transcribe.mockImplementation(async ({ model }: { model: { fetchFn: typeof fetch } }) => {
			vi.stubGlobal(
				'fetch',
				async () =>
					new Response(
						JSON.stringify({ text: '', usage: { type: 'tokens', input_tokens: 10, output_tokens: 2 } }),
						{ status: 200, headers: { 'content-type': 'application/json' } },
					),
			);
			await model.fetchFn('https://api.openai.test/v1/audio/transcriptions');
			vi.unstubAllGlobals();
			throw new Error('No transcript generated.');
		});

		await expect(transcribeAudio('project-1', 'user-1', 'AAAA')).rejects.toThrow('No transcript generated.');
		expect(mocks.insertLlmInference).toHaveBeenCalledWith(
			expect.objectContaining({ type: 'transcription', inputNoCacheTokens: 10, outputTotalTokens: 2 }),
		);
	});

	it('records nothing when the request failed before any usage came back', async () => {
		mocks.insertLlmInference.mockReset();
		mocks.transcribe.mockRejectedValue(new Error('network down'));

		await expect(transcribeAudio('project-1', 'user-1', 'AAAA')).rejects.toThrow('network down');
		expect(mocks.insertLlmInference).not.toHaveBeenCalled();
	});

	it('still returns the transcript when recording usage fails', async () => {
		mocks.insertLlmInference.mockReset().mockRejectedValue(new Error('db down'));
		mocks.transcribe.mockResolvedValue({ text: 'hello', durationInSeconds: 3 });

		await expect(transcribeAudio('project-1', 'user-1', 'AAAA', { modelId: 'whisper-1' })).resolves.toBe('hello');
		expect(mocks.insertLlmInference).toHaveBeenCalledTimes(1);
	});
});
