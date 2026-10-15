import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DBMessagePart } from '../src/db/abstractSchema';
import dbConfig, { Dialect } from '../src/db/dbConfig';
import type { UIMessagePart } from '../src/types/chat';
import {
	convertDBPartToUIPart,
	convertUIPartToDBPart,
	mapUIPartsToDBParts,
} from '../src/utils/chat-message-part-mappings';

const asDBPart = (part: Partial<DBMessagePart>): DBMessagePart => {
	return { id: 'part-1', messageId: 'msg-1', order: 0, createdAt: new Date(), ...part } as DBMessagePart;
};

describe('file parts', () => {
	it('stores an image by id and reads it back as an image URL', () => {
		const dbPart = convertUIPartToDBPart(
			{ type: 'file', mediaType: 'image/png', url: '/i/2f1c9b3e-0000-4000-8000-000000000000' },
			'msg-1',
			0,
		);

		expect(dbPart).toMatchObject({
			type: 'file',
			mediaType: 'image/png',
			imageId: '2f1c9b3e-0000-4000-8000-000000000000',
			storagePath: null,
		});
		expect(convertDBPartToUIPart(asDBPart(dbPart))).toEqual({
			type: 'file',
			mediaType: 'image/png',
			url: '/i/2f1c9b3e-0000-4000-8000-000000000000',
		});
	});

	it('stores an uploaded document as a path inside the user space', () => {
		const dbPart = convertUIPartToDBPart(
			{
				type: 'file',
				mediaType: 'text/csv',
				filename: 'sales.csv',
				url: '/home/uploads/2026-08-04/sales.csv',
			},
			'msg-1',
			1,
		);

		expect(dbPart).toMatchObject({
			type: 'file',
			mediaType: 'text/csv',
			imageId: null,
			storagePath: 'uploads/2026-08-04/sales.csv',
			filename: 'sales.csv',
		});
		expect(convertDBPartToUIPart(asDBPart(dbPart))).toEqual({
			type: 'file',
			mediaType: 'text/csv',
			filename: 'sales.csv',
			url: '/home/uploads/2026-08-04/sales.csv',
		});
	});

	it('drops a file part that points at neither an image nor permanent storage', () => {
		const dbPart = convertUIPartToDBPart(
			{ type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,iVBOR' },
			'msg-1',
			0,
		);

		expect(dbPart).toBeUndefined();
	});

	it('drops a stored file part whose columns were cleared', () => {
		const part = asDBPart({ type: 'file', mediaType: 'text/csv', imageId: null, storagePath: null });
		expect(convertDBPartToUIPart(part)).toBeUndefined();
	});
});

describe('compaction parts', () => {
	it('stores a compaction summary and reads it back', () => {
		const dbPart = convertUIPartToDBPart(
			{ type: 'data-compaction', data: { summary: 'Conversation summary' } },
			'msg-1',
			0,
		);

		expect(dbPart).toMatchObject({ type: 'data-compaction', text: 'Conversation summary' });
		expect(convertDBPartToUIPart(asDBPart(dbPart))).toEqual({
			type: 'data-compaction',
			data: { summary: 'Conversation summary' },
		});
	});

	it('stores a compaction error and reads it back', () => {
		const dbPart = convertUIPartToDBPart(
			{ type: 'data-compaction', data: { summary: '', error: 'CompactionError: Failed to resolve LLM.' } },
			'msg-1',
			0,
		);

		expect(dbPart).toMatchObject({
			type: 'data-compaction',
			text: '',
			toolErrorText: 'CompactionError: Failed to resolve LLM.',
		});
		expect(convertDBPartToUIPart(asDBPart(dbPart))).toEqual({
			type: 'data-compaction',
			data: { summary: '', error: 'CompactionError: Failed to resolve LLM.' },
		});
	});
});

describe('database message part sanitization', () => {
	const originalDialect = dbConfig.dialect;

	beforeEach(() => {
		dbConfig.dialect = Dialect.Postgres;
	});
	afterEach(() => {
		dbConfig.dialect = originalDialect;
	});

	it('sanitizes PostgreSQL text, reasoning, and nested tool payloads', () => {
		const toolInput = { [`in\u0000put`]: ['input\u0000\ud800😀'] };
		const toolOutput = { results: [{ [`result\udc00`]: 'value\u0000\ud800𐀀' }] };
		const parts = [
			{ type: 'text', text: 'text\u0000\ud800😀' },
			{ type: 'reasoning', text: 'reasoning\u0000\udc00🌍' },
			{
				type: 'dynamic-tool',
				toolName: 'generic-tool',
				toolCallId: 'call-1',
				state: 'output-available',
				input: toolInput,
				output: toolOutput,
			},
		] as unknown as UIMessagePart[];

		const [textPart, reasoningPart, toolPart] = mapUIPartsToDBParts(parts, 'msg-1');

		expect(textPart.text).toBe('text�😀');
		expect(reasoningPart.reasoningText).toBe('reasoning�🌍');
		expect(toolPart.toolInput).toEqual({ input: ['input�😀'] });
		expect(toolPart.toolOutput).toEqual({ results: [{ 'result�': 'value�𐀀' }] });
	});

	it.each([
		{ [`label\u0000`]: 'first', label: 'second' },
		{ [`label\ud800`]: 'first', ['label�']: 'second' },
	])('rejects PostgreSQL keys that collide after sanitization', (input) => {
		const parts = [
			{
				type: 'dynamic-tool',
				toolName: 'generic-tool',
				toolCallId: 'call-1',
				state: 'output-available',
				input,
				output: null,
			},
		] as unknown as UIMessagePart[];

		expect(() => mapUIPartsToDBParts(parts, 'msg-1')).toThrow(
			'PostgreSQL JSON keys collide after Unicode sanitization',
		);
	});

	it('leaves SQLite payloads unchanged', () => {
		dbConfig.dialect = Dialect.Sqlite;
		const input = { [`label\u0000`]: 'value\ud800' };
		const output = { nested: ['value\u0000\udc00'] };
		const parts = [
			{ type: 'text', text: 'text\u0000\ud800' },
			{
				type: 'dynamic-tool',
				toolName: 'generic-tool',
				toolCallId: 'call-1',
				state: 'output-available',
				input,
				output,
			},
		] as unknown as UIMessagePart[];

		const [textPart, toolPart] = mapUIPartsToDBParts(parts, 'msg-1');

		expect(textPart.text).toBe('text\u0000\ud800');
		expect(toolPart.toolInput).toBe(input);
		expect(toolPart.toolOutput).toBe(output);
	});
});
