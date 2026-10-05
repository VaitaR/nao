import { experimental_transcribe as transcribe } from 'ai';

import {
	createTranscribeModel,
	getDefaultTranscribeModelId,
	TRANSCRIBE_PROVIDERS,
	type TranscribeProvider,
} from '../agents/transcribe.providers';
import * as projectQueries from '../queries/project.queries';
import { HandlerError } from '../utils/error';
import { resolveProviderSettings } from '../utils/llm';

export async function transcribeAudio(
	projectId: string,
	audio: string,
	overrides?: { provider?: TranscribeProvider; modelId?: string },
): Promise<string> {
	const agentSettings = await projectQueries.getAgentSettings(projectId);
	const savedProvider = agentSettings?.transcribe?.provider as TranscribeProvider | undefined;
	const savedModelId = agentSettings?.transcribe?.modelId;

	const provider: TranscribeProvider = overrides?.provider ?? savedProvider ?? 'openai';
	const modelId = overrides?.modelId ?? savedModelId ?? getDefaultTranscribeModelId(provider);

	const settings = await resolveProviderSettings(projectId, provider);
	if (!settings?.apiKey) {
		throw new Error(`No API key configured for ${provider}. Add one in Settings > Models.`);
	}

	const model = createTranscribeModel(provider, settings, modelId);
	const audioBuffer = Buffer.from(audio, 'base64');

	const result = await transcribe({ model, audio: audioBuffer });
	return result.text;
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
		let hasKey = false;
		try {
			hasKey = !!(await resolveProviderSettings(projectId, llmProvider))?.apiKey;
		} catch (error) {
			if (!(error instanceof HandlerError)) {
				throw error;
			}
		}

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
