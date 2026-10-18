import { describe, expect, it } from 'vitest';

import { collectSlackAudioFiles, formatSlackAudioFailures } from '../src/utils/slack-message-content';

describe('collectSlackAudioFiles', () => {
	it('collects voice clips by subtype and uploaded audio by MIME type, skipping other files', () => {
		const files = collectSlackAudioFiles({
			files: [
				{ id: 'F1', subtype: 'slack_audio', mimetype: 'audio/webm', url_private: 'https://files.slack.com/F1' },
				{ id: 'F2', subtype: 'slack_audio', mimetype: 'video/mp4', url_private: 'https://files.slack.com/F2' },
				{ id: 'F3', mimetype: 'audio/mpeg', url_private_download: 'https://files.slack.com/F3' },
				{ id: 'F4', mimetype: 'image/png', url_private: 'https://files.slack.com/F4' },
				{ id: 'F5', subtype: 'slack_video', mimetype: 'video/mp4', url_private: 'https://files.slack.com/F5' },
			],
		});
		expect(files.map((file) => file.id)).toEqual(['F1', 'F2', 'F3']);
	});

	it('includes audio from a forwarded message once and skips files without a URL', () => {
		const files = collectSlackAudioFiles({
			files: [{ id: 'F1', mimetype: 'audio/mpeg', url_private: 'https://files.slack.com/F1' }],
			attachments: [
				{
					is_share: true,
					files: [
						{ id: 'F1', mimetype: 'audio/mpeg', url_private: 'https://files.slack.com/F1' },
						{ id: 'F2', mimetype: 'audio/mpeg', url_private: 'https://files.slack.com/F2' },
						{ id: 'F3', mimetype: 'audio/mpeg' },
					],
				},
				{ files: [{ id: 'F4', mimetype: 'audio/mpeg', url_private: 'https://files.slack.com/F4' }] },
			],
		});
		expect(files.map((file) => file.id)).toEqual(['F1', 'F2']);
	});

	it('returns nothing for a text-only message', () => {
		expect(collectSlackAudioFiles({ text: 'hello' })).toEqual([]);
		expect(collectSlackAudioFiles(null)).toEqual([]);
	});
});

describe('formatSlackAudioFailures', () => {
	it('tells the model transcription is off so a voice-only turn is not read as empty', () => {
		const text = formatSlackAudioFailures([{ reason: 'transcription_disabled' }]);
		expect(text).toBe(
			'[1 voice message(s) could not be transcribed: voice transcription is not enabled for this project ' +
				'(an admin can enable it in Settings > Agent > Models); typing the question as text works meanwhile]',
		);
	});

	it('explains a missing files:read scope without leaking the raw detail', () => {
		const text = formatSlackAudioFailures([{ reason: 'missing_files_read_scope', detail: 'HTML page' }]);
		expect(text).toContain('files:read is missing');
		expect(text).toContain('Re-sending the voice message does not help');
		expect(text).not.toContain('HTML page');
	});

	it('returns an empty string without failures', () => {
		expect(formatSlackAudioFailures([])).toBe('');
	});
});
