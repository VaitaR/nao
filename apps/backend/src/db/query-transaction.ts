import { db, DBTransaction } from './db';
import dbConfig, { Dialect } from './dbConfig';

export type QueryOperation<T> = {
	all?: () => T;
	run?: () => unknown;
	execute?: () => Promise<T>;
};

export type QueryProgram<T> = Generator<QueryOperation<unknown>, T, unknown>;

export function runQueryProgram<T>(program: QueryProgram<T>): T | Promise<T> {
	return dbConfig.dialect === Dialect.Sqlite ? runSyncQueryProgram(program) : runAsyncQueryProgram(program);
}

export function runTransaction<T>(program: (transaction: DBTransaction) => QueryProgram<T>): T | Promise<T> {
	if (dbConfig.dialect === Dialect.Sqlite) {
		return db.transaction((transaction) => runSyncQueryProgram(program(transaction)));
	}

	return db.transaction(async (transaction) => await runAsyncQueryProgram(program(transaction)));
}

function runSyncQueryProgram<T>(program: QueryProgram<T>): T {
	let step = program.next();
	while (!step.done) {
		const operation = step.value;
		const result = operation.all ? operation.all() : operation.run ? operation.run() : undefined;
		if (result === undefined && !operation.run && !operation.all) {
			throw new Error('SQLite query programs require .all() or .run() operations');
		}
		step = program.next(result);
	}
	return step.value;
}

async function runAsyncQueryProgram<T>(program: QueryProgram<T>): Promise<T> {
	let step = program.next();
	while (!step.done) {
		if (!step.value.execute) {
			throw new Error('Postgres query programs require .execute() operations');
		}
		step = program.next(await step.value.execute());
	}
	return step.value;
}
