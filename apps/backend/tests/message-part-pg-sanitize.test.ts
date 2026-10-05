import { describe, expect, it } from 'vitest';

import type { UIMessagePart } from '../src/types/chat';
import { mapUIPartsToDBParts } from '../src/utils/chat-message-part-mappings';

describe('mapUIPartsToDBParts PostgreSQL string sanitization', () => {
	it('sanitizes text, reasoning, and nested tool payload keys and values', () => {
		const cleanInput = { stable: ['🌍', 7, null] };
		const date = new Date(0);
		const toolInput = {
			clean: cleanInput,
			date,
			[`in\u0000\ud800`]: ['before\u0000', '😀', '\ud800', '\udc00', { [`nested\udc00`]: 'after\u0000' }],
		};
		const toolOutput = {
			[`out\u0000\udc00`]: [{ [`result\ud800`]: 'value\u0000\ud800\udc00' }],
		};
		const parts = [
			{ type: 'text', text: 'text\u0000\ud800😀\udc00' },
			{ type: 'reasoning', text: 'reasoning\u0000\udc00🌍\ud800' },
			{
				type: 'dynamic-tool',
				toolName: 'generic-tool',
				toolCallId: 'call-1',
				state: 'output-available',
				input: toolInput,
				output: toolOutput,
			},
		] as unknown as UIMessagePart[];

		const [textPart, reasoningPart, toolPart] = mapUIPartsToDBParts(parts, 'message-1');

		expect(textPart.text).toBe('text�😀�');
		expect(reasoningPart.reasoningText).toBe('reasoning�🌍�');
		expect(toolPart.toolInput).toEqual({
			clean: { stable: ['🌍', 7, null] },
			date,
			'in�': ['before', '😀', '�', '�', { 'nested�': 'after' }],
		});
		expect(toolPart.toolOutput).toEqual({ 'out�': [{ 'result�': 'value𐀀' }] });
		expect((toolPart.toolInput as { clean: unknown }).clean).toBe(cleanInput);
		expect((toolPart.toolInput as { date: unknown }).date).toBe(date);
	});
});
