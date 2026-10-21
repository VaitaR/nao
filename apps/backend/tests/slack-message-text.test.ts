import { describe, expect, it } from 'vitest';

import { expandSlackMrkdwnLinks } from '../src/utils/slack-message-text';

const LONG_URL = 'https://explorer.example.com/address/0x8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e4b6d8f0a';

describe('expandSlackMrkdwnLinks', () => {
	it('expands labelled links in raw mrkdwn', () => {
		expect(
			expandSlackMrkdwnLinks(`check <${LONG_URL}|explorer.example.com/…> and <https://example.com|site>`),
		).toBe(`check ${LONG_URL} and site (https://example.com)`);
	});

	it('leaves mentions, channels and non-http links untouched', () => {
		const text = '<@U123|ada> in <#C1|data> <mailto:a@b.com|a@b.com> <!here>';
		expect(expandSlackMrkdwnLinks(text)).toBe(text);
	});
});
