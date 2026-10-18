import { experimental_transcribe as transcribe } from 'ai';
import { z } from 'zod/v4';

import {
	createTranscribeModel,
	getDefaultTranscribeModelId,
	getTranscribeModelDef,
	TRANSCRIBE_PROVIDERS,
	type TranscribeFetch,
	type TranscribeProvider,
} from '../agents/transcribe.providers';
import { insertLlmInference } from '../queries/llm-inference';
import * as projectQueries from '../queries/project.queries';
import * as llmConfigQueries from '../queries/project-llm-config.queries';
import type { TokenUsage } from '../types/chat';
import { getEnvApiKey } from '../utils/llm';
import { logger } from '../utils/logger';

/** The AI SDK drops `usage` from the transcription response, so it is read off the raw HTTP body. */
const rawUsageSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('tokens'), input_tokens: z.number(), output_tokens: z.number() }),
	z.object({ type: z.literal('duration'), seconds: z.number() }),
]);
type RawTranscriptionUsage = z.infer<typeof rawUsageSchema>;

export function buildTranscriptionUsage(
	provider: TranscribeProvider,
	modelId: string,
	rawUsage: RawTranscriptionUsage | undefined,
	durationInSeconds: number | undefined,
): Partial<TokenUsage> | undefined {
	if (getTranscribeModelDef(provider, modelId)?.billing === 'seconds') {
		const seconds = rawUsage?.type === 'duration' ? rawUsage.seconds : durationInSeconds;
		if (seconds === undefined) {
			return undefined;
		}
		const billedSeconds = Math.ceil(seconds);
		return { inputTotalTokens: billedSeconds, inputNoCacheTokens: billedSeconds, totalTokens: billedSeconds };
	}
	if (rawUsage?.type !== 'tokens') {
		return undefined;
	}
	return {
		inputTotalTokens: rawUsage.input_tokens,
		inputNoCacheTokens: rawUsage.input_tokens,
		outputTotalTokens: rawUsage.output_tokens,
		outputTextTokens: rawUsage.output_tokens,
		totalTokens: rawUsage.input_tokens + rawUsage.output_tokens,
	};
}

function createUsageCapturingFetch(onUsage: (usage: RawTranscriptionUsage) => void): TranscribeFetch {
	const capturingFetch = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const response = await fetch(input, init);
		if (response.ok) {
			const body = await response
				.clone()
				.json()
				.catch(() => undefined);
			const parsed = rawUsageSchema.safeParse(body?.usage);
			if (parsed.success) {
				onUsage(parsed.data);
			}
		}
		return response;
	};
	// Bun's `typeof fetch` also requires `preconnect`, which the SDK never calls.
	return capturingFetch as TranscribeFetch;
}

export async function transcribeAudio(
	projectId: string,
	userId: string,
	audio: string,
	overrides?: { provider?: TranscribeProvider; modelId?: string },
): Promise<string> {
	const agentSettings = await projectQueries.getAgentSettings(projectId);
	const savedProvider = agentSettings?.transcribe?.provider as TranscribeProvider | undefined;
	const savedModelId = agentSettings?.transcribe?.modelId;

	const provider: TranscribeProvider = overrides?.provider ?? savedProvider ?? 'openai';
	const modelId = overrides?.modelId ?? savedModelId ?? getDefaultTranscribeModelId(provider);

	const { apiKey, baseURL } = await resolveProviderSettings(projectId, provider);
	if (!apiKey) {
		throw new Error(`No API key configured for ${provider}. Add one in Settings > Models.`);
	}

	let rawUsage: RawTranscriptionUsage | undefined;
	const model = createTranscribeModel(
		provider,
		{ apiKey, baseURL },
		modelId,
		createUsageCapturingFetch((usage) => {
			rawUsage = usage;
		}),
	);
	const audioBuffer = Buffer.from(audio, 'base64');

	let result: Awaited<ReturnType<typeof transcribe>> | undefined;
	try {
		result = await transcribe({ model, audio: audioBuffer });
	} finally {
		// The provider bills the request even when the SDK then rejects it (e.g. an empty transcript).
		await recordTranscriptionUsage({
			projectId,
			userId,
			provider,
			modelId,
			usage: buildTranscriptionUsage(provider, modelId, rawUsage, result?.durationInSeconds),
			expectUsage: result !== undefined,
		});
	}

	return result.text;
}

async function recordTranscriptionUsage(opts: {
	projectId: string;
	userId: string;
	provider: TranscribeProvider;
	modelId: string;
	usage: Partial<TokenUsage> | undefined;
	expectUsage: boolean;
}): Promise<void> {
	const { projectId, userId, provider, modelId, usage, expectUsage } = opts;
	const logOptions = { source: 'agent' as const, projectId, context: { userId, provider, modelId } };

	if (!usage) {
		if (expectUsage) {
			logger.warn('Transcription returned no usable usage; cost not recorded', logOptions);
		}
		return;
	}

	try {
		await insertLlmInference({
			projectId,
			userId,
			type: 'transcription',
			llmProvider: provider,
			llmModelId: modelId,
			...usage,
		});
	} catch (err) {
		logger.error(`Transcription usage was not recorded: ${String(err)}`, logOptions);
	}
}

export async function listAvailableTranscribeModels(projectId: string) {
	const available: Record<
		string,
		{
			models: Array<{ id: string; name: string; default?: boolean; pricePerMinute?: number }>;
			hasKey: boolean;
		}
	> = {};

	for (const [provider, config] of Object.entries(TRANSCRIBE_PROVIDERS)) {
		const llmProvider = provider as 'openai';
		const dbConfig = await llmConfigQueries.getProjectLlmConfigByProvider(projectId, llmProvider);
		const envKey = getEnvApiKey(llmProvider);
		const hasKey = !!(dbConfig?.apiKey || envKey);

		available[provider] = {
			models: config.models.map((m) => ({
				id: m.id,
				name: m.name,
				...(m.default && { default: m.default }),
				...(m.pricePerMinute != null && { pricePerMinute: m.pricePerMinute }),
			})),
			hasKey,
		};
	}

	return available;
}

async function resolveProviderSettings(
	projectId: string,
	provider: TranscribeProvider,
): Promise<{ apiKey: string | undefined; baseURL: string | undefined }> {
	const llmProvider = provider as 'openai';
	const config = await llmConfigQueries.getProjectLlmConfigByProvider(projectId, llmProvider);

	if (config) {
		return { apiKey: config.apiKey, baseURL: config.baseUrl ?? undefined };
	}

	return { apiKey: getEnvApiKey(llmProvider), baseURL: undefined };
}
