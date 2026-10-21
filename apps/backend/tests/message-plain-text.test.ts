import { SlackFormatConverter } from '@chat-adapter/slack';
import { TeamsAdapter } from '@chat-adapter/teams';
import type { Message } from 'chat';
import { describe, expect, it } from 'vitest';

import { plainTextWithLinks } from '../src/utils/message-plain-text';

const LONG_URL = 'https://explorer.example.com/address/0x8f3a1c9e2b7d4f6a0c5e8b1d3f7a9c2e4b6d8f0a';

describe('plainTextWithLinks: Slack', () => {
	const converter = new SlackFormatConverter();
	/** Mirrors the adapter: `Message.formatted` is `toAst` of the event text after mention resolution. */
	const agentText = (mrkdwn: string) => plainTextWithLinks(converter.toAst(mrkdwn));

	it('keeps the URL of a link Slack shortened to a truncated label', () => {
		const raw = `<${LONG_URL}|explorer.example.com/address/0x8f3a…>\nwhat do we know about this address?`;

		expect(converter.extractPlainText(raw)).not.toContain(LONG_URL);
		expect(agentText(raw)).toBe(`${LONG_URL}\nwhat do we know about this address?`);
	});

	it('keeps label and URL when the label is not part of the URL', () => {
		expect(agentText('see <https://example.com/docs?a=1&amp;b=2|the docs> please')).toBe(
			'see the docs (https://example.com/docs?a=1&b=2) please',
		);
	});

	it('keeps resolved user mentions and bare links', () => {
		expect(agentText(`<@U0BOT> ask <@U123|Ada> about <${LONG_URL}> and https://example.com/x`)).toBe(
			`@U0BOT ask @Ada about ${LONG_URL} and https://example.com/x`,
		);
	});

	it('does not mutate the message AST', () => {
		const formatted = converter.toAst(`<${LONG_URL}|explorer.example.com/…>`);
		plainTextWithLinks(formatted);
		expect(JSON.stringify(formatted)).toContain('"type":"link"');
	});
});

describe('plainTextWithLinks: Teams', () => {
	const adapter = new TeamsAdapter({ appId: 'bot-app-id', appPassword: 'test' });
	const parse = (html: string): Message =>
		(adapter as unknown as { parseTeamsMessage(activity: object, threadId: string): Message }).parseTeamsMessage(
			{ id: 'm1', type: 'message', text: html, from: { id: 'u1', name: 'Ada' }, conversation: { id: 'c1' } },
			'teams:c1',
		);

	it('keeps the URL of an anchor whose label is not the URL', () => {
		const message = parse(`<at>nao</at> what is in <a href="${LONG_URL}">this address</a>?`);

		expect(message.text).not.toContain(LONG_URL);
		expect(plainTextWithLinks(message.formatted)).toBe(`@nao what is in this address (${LONG_URL})?`);
	});

	it('shows an auto-linked URL once', () => {
		expect(plainTextWithLinks(parse(`check <a href="${LONG_URL}">${LONG_URL}</a>`).formatted)).toBe(
			`check ${LONG_URL}`,
		);
	});
});
