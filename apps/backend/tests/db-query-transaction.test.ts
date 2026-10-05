import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('query transaction runner', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.doMock('../src/db/db', () => ({ db: { transaction: vi.fn() } }));
	});

	it('runs SQLite programs synchronously with all and run', async () => {
		vi.doMock('../src/db/dbConfig', () => ({ default: { dialect: 'sqlite' }, Dialect: { Sqlite: 'sqlite' } }));
		const { runQueryProgram } = await import('../src/db/query-transaction');
		const events: string[] = [];

		const result = runQueryProgram(
			(function* () {
				const rows = (yield { all: () => (events.push('all'), [{ id: 'row-1' }]) }) as Array<{ id: string }>;
				yield { run: () => events.push('run') };
				return rows[0].id;
			})(),
		);

		expect(result).toBe('row-1');
		expect(events).toEqual(['all', 'run']);
	});

	it('awaits Postgres programs with execute', async () => {
		vi.doMock('../src/db/dbConfig', () => ({
			default: { dialect: 'postgres' },
			Dialect: { Postgres: 'postgres' },
		}));
		const { runQueryProgram } = await import('../src/db/query-transaction');
		const events: string[] = [];

		const result = await runQueryProgram(
			(function* () {
				const rows = (yield {
					execute: async () => (events.push('execute'), [{ id: 'row-1' }]),
				}) as Array<{ id: string }>;
				return rows[0].id;
			})(),
		);

		expect(result).toBe('row-1');
		expect(events).toEqual(['execute']);
	});
	it('keeps the SQLite transaction callback synchronous', async () => {
		vi.doMock('../src/db/dbConfig', () => ({ default: { dialect: 'sqlite' }, Dialect: { Sqlite: 'sqlite' } }));
		const { db } = await import('../src/db/db');
		const transaction = vi.mocked(db.transaction);
		transaction.mockImplementation(((callback: (t: unknown) => unknown) => {
			const result = callback({});
			expect(result).not.toBeInstanceOf(Promise);
			return result;
		}) as never);
		const { runTransaction } = await import('../src/db/query-transaction');
		expect(
			runTransaction(() =>
				(function* () {
					yield { run: () => undefined };
					return 'committed';
				})(),
			),
		).toBe('committed');
	});

	it('propagates rejected Postgres writes through the transaction callback', async () => {
		vi.doMock('../src/db/dbConfig', () => ({
			default: { dialect: 'postgres' },
			Dialect: { Postgres: 'postgres' },
		}));
		const { db } = await import('../src/db/db');
		vi.mocked(db.transaction).mockImplementation(((callback: (t: unknown) => Promise<unknown>) =>
			callback({})) as never);
		const { runTransaction } = await import('../src/db/query-transaction');
		const events: string[] = [];
		await expect(
			runTransaction(() =>
				(function* () {
					yield {
						execute: async () => {
							await Promise.resolve();
							events.push('first');
							return [];
						},
					};
					yield {
						execute: async () => {
							events.push('failed');
							throw new Error('write failed');
						},
					};
					events.push('after-failure');
				})(),
			),
		).rejects.toThrow('write failed');
		expect(events).toEqual(['first', 'failed']);
	});
});
