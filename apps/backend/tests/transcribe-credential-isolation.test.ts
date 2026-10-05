import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
	config: null as { apiKey: string; baseUrl?: string } | null,
	projectPath: '',
	create: vi.fn(() => ({ modelId: 'synthetic-model' })),
	transcribe: vi.fn(async () => ({ text: 'synthetic transcript' })),
}));

vi.mock('../src/queries/project.queries', () => ({
	getAgentSettings: vi.fn(async () => null),
	getProjectById: vi.fn(async () => (state.projectPath ? { path: state.projectPath } : null)),
}));
vi.mock('../src/queries/project-llm-config.queries', () => ({
	getProjectLlmConfigByProvider: vi.fn(async () => state.config),
}));
vi.mock('../src/agents/transcribe.providers', () => ({
	createTranscribeModel: state.create,
	getDefaultTranscribeModelId: () => 'whisper-1',
	TRANSCRIBE_PROVIDERS: { openai: { models: [{ id: 'whisper-1', name: 'Whisper' }] } },
}));
vi.mock('ai', async (importOriginal) => ({
	...(await importOriginal<typeof import('ai')>()),
	experimental_transcribe: state.transcribe,
}));

import { env } from '../src/env';
import { listAvailableTranscribeModels, transcribeAudio } from '../src/services/transcribe.service';

describe('transcription credential isolation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.config = null;
		state.projectPath = '';
		vi.stubEnv('OPENAI_API_KEY', 'sk-deployment-test');
		vi.stubEnv('OPENAI_BASE_URL', '');
	});
	const originalDisabledProviders = env.DISABLED_PROVIDERS;
	afterEach(() => {
		vi.unstubAllEnvs();
		env.DISABLED_PROVIDERS = originalDisabledProviders;
		if (state.projectPath) {fs.rmSync(state.projectPath, { recursive: true, force: true });}
	});

	it('rejects unsafe stored credentials before creating a model or sending audio', async () => {
		state.config = { apiKey: 'sk-deployment-test', baseUrl: 'https://gateway.example/v1' };
		await expect(transcribeAudio('project-test', 'c3ludGhldGlj')).rejects.toThrow('needs its own API key');
		expect(state.create).not.toHaveBeenCalled();
		expect(state.transcribe).not.toHaveBeenCalled();
		expect((await listAvailableTranscribeModels('project-test')).openai.hasKey).toBe(false);
	});

	it('allows a separate project key and preserves the custom endpoint', async () => {
		state.config = { apiKey: 'sk-project-test', baseUrl: 'https://gateway.example/v1' };
		await expect(transcribeAudio('project-test', 'c3ludGhldGlj')).resolves.toBe('synthetic transcript');
		expect(state.create).toHaveBeenCalledWith(
			'openai',
			{ apiKey: 'sk-project-test', baseURL: 'https://gateway.example/v1' },
			'whisper-1',
		);
		expect(state.transcribe).toHaveBeenCalledWith({
			model: { modelId: 'synthetic-model' },
			audio: Buffer.from('synthetic'),
		});
	});

	it('keeps the deployment key on the configured deployment endpoint', async () => {
		vi.stubEnv('OPENAI_BASE_URL', 'https://deployment.example/v1');
		await expect(transcribeAudio('project-test', 'c3ludGhldGlj')).resolves.toBe('synthetic transcript');
		expect(state.create).toHaveBeenCalledWith(
			'openai',
			{ apiKey: 'sk-deployment-test', baseURL: 'https://deployment.example/v1' },
			'whisper-1',
		);
	});

	it('uses a YAML-only project key for transcription and availability', async () => {
		vi.stubEnv('OPENAI_API_KEY', '');
		state.projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-transcribe-'));
		fs.writeFileSync(
			path.join(state.projectPath, 'nao_config.yaml'),
			'llm:\n  providers:\n  - provider: openai\n    api_key: sk-yaml-test\n    base_url: https://project.example/v1\n',
		);
		expect((await listAvailableTranscribeModels('project-test')).openai.hasKey).toBe(true);
		await expect(transcribeAudio('project-test', 'c3ludGhldGlj')).resolves.toBe('synthetic transcript');
		expect(state.create).toHaveBeenCalledWith(
			'openai',
			{ apiKey: 'sk-yaml-test', baseURL: 'https://project.example/v1' },
			'whisper-1',
		);
	});

	it('hides a disabled provider and rejects transcription before model creation', async () => {
		env.DISABLED_PROVIDERS = ['openai'];
		expect((await listAvailableTranscribeModels('project-test')).openai.hasKey).toBe(false);
		await expect(transcribeAudio('project-test', 'c3ludGhldGlj')).rejects.toThrow('No API key configured');
		expect(state.create).not.toHaveBeenCalled();
		expect(state.transcribe).not.toHaveBeenCalled();
	});
});
