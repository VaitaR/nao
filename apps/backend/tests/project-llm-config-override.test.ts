import { createPrivateKey, generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	projectPath: '',
	existingConfig: null as { apiKey: string; baseUrl?: string | null; credentials?: Record<string, string> } | null,
	upsertProjectLlmConfig: vi.fn(),
}));

vi.mock('../src/queries/project.queries', () => ({
	getProjectById: vi.fn(async () => project()),
	getProjectByUserId: vi.fn(async () => project()),
	getUserRoleInProject: vi.fn(async () => 'admin'),
}));

vi.mock('../src/queries/project-llm-config.queries', () => ({
	getProjectLlmConfigByProvider: vi.fn(() => testState.existingConfig),
	upsertProjectLlmConfig: testState.upsertProjectLlmConfig,
}));

vi.mock('../src/queries/chat.queries', () => ({}));
vi.mock('../src/queries/project-saved-prompt.queries', () => ({}));
vi.mock('../src/queries/project-slack-config.queries', () => ({}));
vi.mock('../src/queries/project-teams-config.queries', () => ({}));
vi.mock('../src/queries/project-telegram-config.queries', () => ({}));
vi.mock('../src/queries/project-whatsapp-config.queries', () => ({}));
vi.mock('../src/queries/project-whatsapp-link.queries', () => ({}));
vi.mock('../src/queries/user.queries', () => ({}));
vi.mock('../src/agents/user-rules', () => ({ getDatabaseObjects: vi.fn() }));
vi.mock('../src/auth', () => ({ getAuth: vi.fn() }));
vi.mock('../src/services/posthog', () => ({ posthog: {}, PostHogEvent: {} }));
vi.mock('../src/services/slack', () => ({ slackService: {} }));
vi.mock('../src/services/transcribe.service', () => ({ listAvailableTranscribeModels: vi.fn() }));
vi.mock('../src/utils/logger', () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { getProviderMeta } from '../src/agents/provider-meta';
import { projectRoutes } from '../src/trpc/project.routes';
import { router } from '../src/trpc/trpc';
import { resolveProviderModel, resolveProviderSettings } from '../src/utils/llm';

const testRouter = router(projectRoutes);
const directories: string[] = [];

describe('project LLM config overrides', () => {
	beforeEach(() => {
		testState.existingConfig = null;
		testState.upsertProjectLlmConfig.mockReset();
		testState.upsertProjectLlmConfig.mockImplementation((config) => ({
			id: 'config-id',
			...config,
			credentials: config.credentials ?? null,
			modelSettings: config.modelSettings ?? {},
			createdAt: new Date(),
			updatedAt: new Date(),
		}));
		delete process.env.OPENAI_API_KEY;
		delete process.env.OPENAI_BASE_URL;
		delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		delete process.env.AWS_ACCESS_KEY_ID;
		delete process.env.AWS_SECRET_ACCESS_KEY;
	});

	afterEach(() => vi.unstubAllEnvs());

	afterAll(() => {
		for (const directory of directories) {
			fs.rmSync(directory, { force: true, recursive: true });
		}
	});

	it('preserves a required API key inherited from nao_config.yaml', async () => {
		writeConfig(['llm:', '  providers:', '  - provider: openai', '    api_key: sk-from-config']);

		await callUpsert('openai');

		expect(testState.upsertProjectLlmConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: 'openai',
				apiKey: 'sk-from-config',
			}),
		);
	});

	it('preserves structured credentials inherited from nao_config.yaml', async () => {
		writeConfig([
			'llm:',
			'  providers:',
			'  - provider: bedrock',
			'    access_key: AKIA_FROM_CONFIG',
			'    secret_key: secret-from-config',
			'    aws_region: us-east-1',
		]);

		await callUpsert('bedrock');

		expect(testState.upsertProjectLlmConfig).toHaveBeenCalledWith(
			expect.objectContaining({
				provider: 'bedrock',
				apiKey: '',
				credentials: {
					accessKeyId: 'AKIA_FROM_CONFIG',
					secretAccessKey: 'secret-from-config',
					region: 'us-east-1',
				},
			}),
		);
	});
	describe('deployment credentials and project endpoints', () => {
		beforeEach(() => {
			writeConfig([]);
			process.env.OPENAI_API_KEY = 'sk-deployment-test';
		});

		it('uses the deployment key when no endpoint override is requested', async () => {
			await callUpsert('openai');
			expect(testState.upsertProjectLlmConfig).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'sk-deployment-test', baseUrl: null }),
			);
		});

		it('rejects inheriting a deployment key for a project endpoint', async () => {
			await expect(callUpsert('openai', { baseUrl: 'https://gateway.example/v1' })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
			});
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it('rejects changing the endpoint of a previously inherited deployment key', async () => {
			testState.existingConfig = { apiKey: 'sk-deployment-test' };
			await expect(callUpsert('openai', { baseUrl: 'https://gateway.example/v1' })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
			});
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it.each(['settings', 'model'] as const)(
			'rejects a stored unsafe endpoint during %s resolution',
			async (kind) => {
				testState.existingConfig = { apiKey: 'sk-deployment-test', baseUrl: 'https://gateway.example/v1' };
				await expect(resolve(kind)).rejects.toThrow('needs its own API key');
			},
		);

		it.each(['settings', 'model'] as const)(
			'rejects a YAML endpoint using a deployment fallback during %s resolution',
			async (kind) => {
				writeConfig([
					'llm:',
					'  providers:',
					'  - provider: openai',
					'    base_url: https://gateway.example/v1',
				]);
				await expect(resolve(kind)).rejects.toThrow('needs its own API key');
			},
		);

		it.each(['settings', 'model'] as const)(
			'rejects interpolated deployment credentials during %s resolution',
			async (kind) => {
				vi.stubEnv('ANTHROPIC_API_KEY', 'other-deployment-key');
				writeConfig([
					'llm:',
					'  providers:',
					'  - provider: openai',
					`    api_key: prefix-{{ env('ANTHROPIC_API_KEY') }}-suffix`,
					'    base_url: https://gateway.example/v1',
				]);
				await expect(resolve(kind)).rejects.toThrow('needs its own API key');
			},
		);

		it.each(['settings', 'model'] as const)(
			'rejects deployment credentials interpolated into the URL during %s resolution',
			async (kind) => {
				writeConfig([
					'llm:',
					'  providers:',
					'  - provider: openai',
					'    api_key: sk-project-test',
					`    base_url: https://gateway.example/{{ env('OPENAI_API_KEY') }}`,
				]);
				await expect(resolve(kind)).rejects.toThrow('needs its own API key');
			},
		);

		it('rejects a stored decorated deployment credential', async () => {
			await expect(
				callUpsert('openai', { apiKey: 'Bearer sk-deployment-test', baseUrl: 'https://gateway.example/v1' }),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it('rejects a custom Vertex endpoint using ambient credentials', async () => {
			await expect(
				callUpsert('vertex', {
					baseUrl: 'https://gateway.example/v1',
					credentials: { project: 'project-test', location: 'us-central1' },
				}),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it('rejects a custom Vertex endpoint with malformed explicit credentials', async () => {
			await expect(
				callUpsert('vertex', {
					baseUrl: 'https://gateway.example/v1',
					credentials: { serviceAccountJson: '{}' },
				}),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		});

		it('reports unsafe stored settings as a client error', async () => {
			testState.existingConfig = { apiKey: 'sk-deployment-test', baseUrl: 'https://gateway.example/v1' };
			await expect(resolveProviderSettings('project-id', 'openai')).rejects.toMatchObject({
				code: 400,
				codeMessage: 'BAD_REQUEST',
			});
		});

		it('allows a custom Vertex endpoint with a separate inline service account', async () => {
			vi.stubEnv(
				'VERTEX_GOOGLE_SERVICE_ACCOUNT_JSON',
				'{"client_email":"deployment@example.com","private_key":"deployment-key"}',
			);
			writeConfig([
				'llm:',
				'  providers:',
				'  - provider: vertex',
				'    base_url: https://gateway.example/v1',
				`    service_account_json: '{"client_email":"project@example.com","private_key":"project-key"}'`,
			]);
			await expect(resolveProviderSettings('project-id', 'vertex')).resolves.toMatchObject({
				credentials: {
					serviceAccountJson: '{"client_email":"project@example.com","private_key":"project-key"}',
				},
			});
		});

		it('rejects server credential file paths for a custom Vertex endpoint', async () => {
			vi.stubEnv(
				'VERTEX_GOOGLE_SERVICE_ACCOUNT_JSON',
				'{"client_email":"deployment@example.com","private_key":"deployment-key"}',
			);
			await expect(
				callUpsert('vertex', {
					baseUrl: 'https://gateway.example/v1',
					credentials: { keyFile: '/project/service-account.json' },
				}),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it('recognizes the deployment private key across PEM formatting and encoding variants', async () => {
			const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 1024 });
			const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
			vi.stubEnv(
				'VERTEX_GOOGLE_SERVICE_ACCOUNT_JSON',
				JSON.stringify({ client_email: 'deployment@example.com', private_key: pem }),
			);
			const body = pem.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
			const variants = [
				pem.trimEnd(),
				pem.replace(/\n/g, '\r\n'),
				`-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,40}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`,
				privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
			];
			for (const key of variants) {
				expect(key.includes(pem)).toBe(false);
				expect(createPrivateKey(key).export({ type: 'pkcs8', format: 'der' })).toEqual(
					privateKey.export({ type: 'pkcs8', format: 'der' }),
				);
				await expect(
					callUpsert('vertex', {
						baseUrl: 'https://gateway.example/v1',
						credentials: {
							serviceAccountJson: JSON.stringify({
								client_email: 'deployment@example.com',
								private_key: key,
							}),
						},
					}),
				).rejects.toMatchObject({ code: 'BAD_REQUEST' });
				testState.existingConfig = {
					apiKey: '',
					baseUrl: 'https://gateway.example/v1',
					credentials: {
						serviceAccountJson: JSON.stringify({
							client_email: 'deployment@example.com',
							private_key: key,
						}),
					},
				};
				await expect(resolveProviderSettings('project-id', 'vertex')).rejects.toThrow(
					'needs its own inline service account credentials',
				);
				await expect(resolveProviderModel('project-id', 'vertex', 'gemini-2.5-pro')).rejects.toThrow(
					'needs its own inline service account credentials',
				);
			}
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
			testState.existingConfig = null;
			const separateKey = generateKeyPairSync('rsa', { modulusLength: 1024 })
				.privateKey.export({ type: 'pkcs8', format: 'pem' })
				.toString();
			await callUpsert('vertex', {
				baseUrl: 'https://gateway.example/v1',
				credentials: {
					serviceAccountJson: JSON.stringify({
						client_email: 'project@example.com',
						private_key: separateKey,
					}),
				},
			});
			expect(testState.upsertProjectLlmConfig).toHaveBeenCalled();
		});

		it.each([
			'{"private_key":"deployment-key","client_email":"deployment@example.com"}',
			'{"client_email":"deployment@example.com","private_key":"deployment-\\u006bey","project_id":"other"}',
		])('rejects a reformatted deployment service account on save and resolution: %s', async (account) => {
			vi.stubEnv(
				'VERTEX_GOOGLE_SERVICE_ACCOUNT_JSON',
				'{ "client_email": "deployment@example.com", "private_key": "deployment-key" }',
			);
			const credentials = { serviceAccountJson: account };
			await expect(
				callUpsert('vertex', { baseUrl: 'https://gateway.example/v1', credentials }),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
			testState.existingConfig = { apiKey: '', baseUrl: 'https://gateway.example/v1', credentials };
			await expect(resolveProviderSettings('project-id', 'vertex')).rejects.toThrow(
				'needs its own inline service account credentials',
			);
			await expect(resolveProviderModel('project-id', 'vertex', 'gemini-2.5-pro')).rejects.toThrow(
				'needs its own inline service account credentials',
			);
		});

		it.each([
			['bedrock', 'region'],
			['vertex', 'location'],
			['azure', 'resourceName'],
		] as const)('rejects host-changing %s %s values without an explicit URL', async (provider, field) => {
			await expect(callUpsert(provider, { credentials: { [field]: 'gateway.example#' } })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
			});
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it('rejects an Azure resource override with the deployment key', async () => {
			vi.stubEnv('AZURE_API_KEY', 'azure-deployment-key');
			vi.stubEnv('AZURE_RESOURCE_NAME', 'deployment-resource');
			await expect(
				callUpsert('azure', {
					apiKey: 'azure-deployment-key',
					credentials: { resourceName: 'project-resource' },
				}),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		});

		it('allows the deployment Azure resource', async () => {
			vi.stubEnv('AZURE_API_KEY', 'azure-deployment-key');
			vi.stubEnv('AZURE_RESOURCE_NAME', 'deployment-resource');
			await callUpsert('azure', {
				apiKey: 'azure-deployment-key',
				credentials: { resourceName: 'deployment-resource' },
			});
			expect(testState.upsertProjectLlmConfig).toHaveBeenCalled();
		});

		it('rejects a deployment secret field embedded in a custom URL', async () => {
			vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'deployment/aws+secret');
			await expect(
				callUpsert('openai', {
					apiKey: 'project-key',
					baseUrl: `https://gateway.example/${encodeURIComponent('deployment/aws+secret')}`,
				}),
			).rejects.toMatchObject({ code: 'BAD_REQUEST' });
		});

		it('rejects inheriting the deployment Ollama key for a custom endpoint', async () => {
			vi.stubEnv('OLLAMA_API_KEY', 'ollama-deployment-key');
			await expect(callUpsert('ollama', { baseUrl: 'https://gateway.example/v1' })).rejects.toMatchObject({
				code: 'BAD_REQUEST',
			});
			expect(testState.upsertProjectLlmConfig).not.toHaveBeenCalled();
		});

		it.each(['settings', 'model'] as const)(
			'rejects an Ollama YAML deployment-key fallback during %s resolution',
			async (kind) => {
				vi.stubEnv('OLLAMA_API_KEY', 'ollama-deployment-key');
				writeConfig([
					'llm:',
					'  providers:',
					'  - provider: ollama',
					'    base_url: https://gateway.example/v1',
				]);
				await expect(
					kind === 'settings'
						? resolveProviderSettings('project-id', 'ollama')
						: resolveProviderModel('project-id', 'ollama', 'llama3.2'),
				).rejects.toThrow('needs its own API key');
			},
		);

		it('rejects an AWS session token embedded in a custom endpoint', async () => {
			vi.stubEnv('AWS_SESSION_TOKEN', 'deployment-session-token');
			writeConfig([
				'llm:',
				'  providers:',
				'  - provider: openai',
				'    api_key: project-key',
				`    base_url: https://gateway.example/{{ env('AWS_SESSION_TOKEN') }}`,
			]);
			await expect(resolveProviderSettings('project-id', 'openai')).rejects.toThrow('needs its own API key');
		});

		it('accepts YAML endpoints with a separate project key', async () => {
			writeConfig([
				'llm:',
				'  providers:',
				'  - provider: openai',
				'    api_key: sk-project-test',
				'    base_url: https://gateway.example/v1',
			]);
			await expect(resolveProviderSettings('project-id', 'openai')).resolves.toMatchObject({
				apiKey: 'sk-project-test',
				baseURL: 'https://gateway.example/v1',
			});
		});

		it('accepts a project endpoint with a separate project key', async () => {
			await callUpsert('openai', { baseUrl: 'https://gateway.example/v1', apiKey: 'sk-project-test' });
			expect(testState.upsertProjectLlmConfig).toHaveBeenCalledWith(
				expect.objectContaining({ apiKey: 'sk-project-test', baseUrl: 'https://gateway.example/v1' }),
			);
		});

		it('accepts the explicitly configured deployment endpoint with trailing slashes', async () => {
			process.env.OPENAI_BASE_URL = 'https://deployment.example/v1/';
			await callUpsert('openai', { baseUrl: 'https://deployment.example/v1' });
			expect(testState.upsertProjectLlmConfig).toHaveBeenCalled();
		});

		it.each([
			['anthropic', 'https://api.anthropic.com/v1'],
			['google', 'https://generativelanguage.googleapis.com/v1beta'],
			['mistral', 'https://api.mistral.ai/v1'],
		] as const)('accepts the SDK default endpoint for %s', async (provider, endpoint) => {
			vi.stubEnv(getProviderMeta(provider).envVar, 'deployment-test-key');
			writeConfig(['llm:', '  providers:', `  - provider: ${provider}`, `    base_url: ${endpoint}/`]);
			await expect(resolveProviderSettings('project-id', provider)).resolves.toMatchObject({
				apiKey: 'deployment-test-key',
				baseURL: `${endpoint}/`,
			});
		});

		it('accepts an explicit provider default endpoint', async () => {
			await callUpsert('openai', { baseUrl: 'https://api.openai.com/v1/' });
			expect(testState.upsertProjectLlmConfig).toHaveBeenCalled();
		});
	});
});

function project() {
	return {
		id: 'project-id',
		name: 'Test project',
		path: testState.projectPath,
		envVars: {},
	};
}

function writeConfig(lines: string[]): void {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nao-project-llm-override-'));
	directories.push(directory);
	fs.writeFileSync(path.join(directory, 'nao_config.yaml'), lines.join('\n'));
	testState.projectPath = directory;
}

async function callUpsert(
	provider: 'openai' | 'bedrock' | 'azure' | 'vertex' | 'ollama',
	options: { apiKey?: string; baseUrl?: string; credentials?: Record<string, string> } = {},
): Promise<void> {
	const caller = testRouter.createCaller({
		session: { user: { id: 'user-id' } },
		selectedProjectId: 'project-id',
	} as never);

	await caller.upsertLlmConfig({
		provider,
		enabledModels: [],
		customModels: [],
		modelSettings: {},
		...options,
	});
}

function resolve(kind: 'settings' | 'model') {
	return kind === 'settings'
		? resolveProviderSettings('project-id', 'openai')
		: resolveProviderModel('project-id', 'openai', 'gpt-4o');
}
