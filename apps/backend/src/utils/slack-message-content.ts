/** OpenAI's transcription upload limit. */
export const MAX_SLACK_AUDIO_BYTES = 25 * 1024 * 1024;

export interface SlackRawFile {
	id?: string;
	name?: string;
	mimetype?: string;
	subtype?: string;
	size?: number;
	url_private?: string;
	url_private_download?: string;
}

interface SlackRawAttachment {
	is_share?: boolean;
	is_msg_unfurl?: boolean;
	files?: SlackRawFile[];
}

interface SlackRawMessage {
	files?: SlackRawFile[];
	attachments?: SlackRawAttachment[];
}

/**
 * Slack voice clips carry `subtype: slack_audio`; uploaded audio files only an `audio/*` MIME type.
 * Covers files on the message itself and on any message forwarded into it.
 */
export function collectSlackAudioFiles(raw: unknown): SlackRawFile[] {
	const message = (raw ?? {}) as SlackRawMessage;
	const attachments = Array.isArray(message.attachments) ? message.attachments : [];
	const forwardedFiles = attachments
		.filter((attachment) => attachment.is_share || attachment.is_msg_unfurl)
		.flatMap((attachment) => attachment.files ?? []);
	const seen = new Set<string>();
	return [...(message.files ?? []), ...forwardedFiles].filter((file) => {
		const isAudio = file.subtype === 'slack_audio' || !!file.mimetype?.toLowerCase().startsWith('audio/');
		if (!isAudio || !getSlackFileUrl(file)) {
			return false;
		}
		const key = file.id ?? getSlackFileUrl(file)!;
		if (seen.has(key)) {
			return false;
		}
		seen.add(key);
		return true;
	});
}

export function getSlackFileUrl(file: SlackRawFile): string | undefined {
	return file.url_private_download || file.url_private;
}

export type SlackAudioFailureReason =
	| 'missing_files_read_scope'
	| 'too_large'
	| 'download_failed'
	| 'transcription_disabled'
	| 'transcription_failed'
	| 'empty_transcript';

export class SlackFileLoadError extends Error {
	constructor(
		readonly reason: SlackAudioFailureReason,
		readonly detail?: string,
	) {
		super(detail ? `${reason}: ${detail}` : reason);
		this.name = 'SlackFileLoadError';
	}
}

/** Without this note a voice-only message reaches the model as an empty turn. */
export function formatSlackAudioFailures(failures: { reason: SlackAudioFailureReason; detail?: string }[]): string {
	if (failures.length === 0) {
		return '';
	}
	const byReason = new Map<SlackAudioFailureReason, string[]>();
	for (const failure of failures) {
		const details = byReason.get(failure.reason) ?? [];
		if (failure.detail) {
			details.push(failure.detail);
		}
		byReason.set(failure.reason, details);
	}
	const reasons = [...byReason].map(([reason, details]) => describeSlackAudioFailure(reason, [...new Set(details)]));
	return `[${failures.length} voice message(s) could not be transcribed: ${reasons.join('; ')}]`;
}

function describeSlackAudioFailure(reason: SlackAudioFailureReason, details: string[]): string {
	const detail = details.length > 0 ? ` (${details.join(', ')})` : '';
	switch (reason) {
		case 'transcription_disabled':
			return 'voice transcription is not enabled for this project (an admin can enable it in Settings > Agent > Models); typing the question as text works meanwhile';
		case 'missing_files_read_scope':
			return 'the Slack app has no permission to read files (Slack scope files:read is missing). Re-sending the voice message does not help until a Slack workspace admin grants that permission; typing the question as text works meanwhile';
		case 'too_large':
			return `the recording is larger than ${MAX_SLACK_AUDIO_BYTES / (1024 * 1024)} MB`;
		case 'download_failed':
			return `the download from Slack failed${detail}; this may be temporary, so re-sending can help`;
		case 'transcription_failed':
			return `the transcription service failed${detail}; this may be temporary, so re-sending can help`;
		case 'empty_transcript':
			return 'no speech was recognized in the recording';
	}
}
