import { createOpenAI } from '@ai-sdk/openai';
import type { TranscriptionModel } from 'ai';

import type { ModelCosts, ProviderSettings } from '../types/llm';

export type TranscribeProvider = 'openai';

export type TranscribeFetch = NonNullable<Parameters<typeof createOpenAI>[0]>['fetch'];

type TranscribeModelBilling =
	| { billing: 'tokens'; costPerM: ModelCosts }
	// Billed per audio second: usage is recorded as one input "token" per second.
	| { billing: 'seconds'; pricePerMinute: number };

export type TranscribeModelDef = {
	id: string;
	name: string;
	default?: boolean;
	pricePerMinute?: number;
} & TranscribeModelBilling;

export type TranscribeProviderConfig = {
	envVar: string;
	models: readonly TranscribeModelDef[];
};

export const TRANSCRIBE_PROVIDERS: Record<TranscribeProvider, TranscribeProviderConfig> = {
	openai: {
		envVar: 'OPENAI_API_KEY',
		models: [
			{
				id: 'gpt-4o-mini-transcribe',
				name: 'GPT-4o Mini Transcribe',
				default: true,
				pricePerMinute: 0.003,
				billing: 'tokens',
				costPerM: { inputNoCache: 1.25, output: 5 },
			},
			{
				id: 'gpt-4o-transcribe',
				name: 'GPT-4o Transcribe',
				pricePerMinute: 0.006,
				billing: 'tokens',
				costPerM: { inputNoCache: 2.5, output: 10 },
			},
			{ id: 'whisper-1', name: 'Whisper', pricePerMinute: 0.006, billing: 'seconds' },
		],
	},
};

export const KNOWN_TRANSCRIBE_MODELS = Object.fromEntries(
	Object.entries(TRANSCRIBE_PROVIDERS).map(([provider, config]) => [provider, config.models]),
) as Record<TranscribeProvider, readonly TranscribeModelDef[]>;

export function getDefaultTranscribeModelId(provider: TranscribeProvider): string {
	const models = TRANSCRIBE_PROVIDERS[provider].models;
	const defaultModel = models.find((m) => m.default);
	return defaultModel?.id ?? models[0].id;
}

export function getTranscribeModelDef(provider: TranscribeProvider, modelId: string): TranscribeModelDef | undefined {
	return TRANSCRIBE_PROVIDERS[provider].models.find((m) => m.id === modelId);
}

/** Per-1M-unit rates in the same shape as chat models, so the usage cost lookup can price them. */
export function getTranscribeModelCosts(model: TranscribeModelDef): ModelCosts {
	if (model.billing === 'seconds') {
		return { inputNoCache: (model.pricePerMinute * 1_000_000) / 60 };
	}
	return model.costPerM;
}

type TranscribeModelCreator = (
	settings: ProviderSettings,
	modelId: string,
	fetch?: TranscribeFetch,
) => TranscriptionModel;

const TRANSCRIBE_MODEL_CREATORS: Record<TranscribeProvider, TranscribeModelCreator> = {
	openai: (settings, modelId, fetch) => createOpenAI({ ...settings, fetch }).transcription(modelId),
};

export function createTranscribeModel(
	provider: TranscribeProvider,
	settings: ProviderSettings,
	modelId: string,
	fetch?: TranscribeFetch,
): TranscriptionModel {
	return TRANSCRIBE_MODEL_CREATORS[provider](settings, modelId, fetch);
}
