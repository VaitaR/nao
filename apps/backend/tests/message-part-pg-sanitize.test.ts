import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import dbConfig, { Dialect } from '../src/db/dbConfig';

import type { UIMessagePart } from '../src/types/chat';
import { mapUIPartsToDBParts } from '../src/utils/chat-message-part-mappings';

describe('mapUIPartsToDBParts PostgreSQL string sanitization', () => {
	const originalDialect = dbConfig.dialect;
	beforeEach(() => {
		dbConfig.dialect = Dialect.Postgres;
	});
	afterEach(() => {
		dbConfig.dialect = originalDialect;
	});

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

	it('preserves SQLite strings and distinct JSON keys without modifying the payload', () => {
		dbConfig.dialect = Dialect.Sqlite;
		const input = { ['label\u0000']: 'first', label: 'second' };
		const output = { ['label\ud800']: 'first', ['label\udc00']: 'second' };
		const parts = [
			{ type: 'text', text: 'left\u0000right\ud800' },
			{
				type: 'dynamic-tool',
				toolName: 'generic-tool',
				toolCallId: 'call-1',
				state: 'output-available',
				input,
				output,
			},
		] as unknown as UIMessagePart[];
		const [textPart, toolPart] = mapUIPartsToDBParts(parts, 'message-1');
		expect(textPart.text).toBe(parts[0].type === 'text' ? parts[0].text : undefined);
		expect(toolPart.toolInput).toBe(input);
		expect(toolPart.toolOutput).toBe(output);
		expect(JSON.parse(JSON.stringify(toolPart.toolInput))).toEqual(input);
		expect(JSON.parse(JSON.stringify(toolPart.toolOutput))).toEqual(output);
	});

	it.each([
		{ ['label\u0000']: 'first', label: 'second' },
		{ label: 'first', ['label\u0000']: 'second' },
		{ ['label\ud800']: 'first', ['label\udc00']: 'second' },
		{ ['label\ud800']: 'first', ['label�']: 'second' },
	])('rejects PostgreSQL key collisions before losing either value: %j', (input) => {
		const parts = [
			{
				type: 'dynamic-tool',
				toolName: 'generic-tool',
				toolCallId: 'call-1',
				state: 'output-available',
				input: { nested: [input] },
				output: null,
			},
		] as unknown as UIMessagePart[];
		expect(() => mapUIPartsToDBParts(parts, 'message-1')).toThrow(
			'PostgreSQL JSON keys collide after Unicode sanitization',
		);
		expect(Object.keys(input)).toHaveLength(2);
	});
});
