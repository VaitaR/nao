import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const backendRoot = path.resolve(import.meta.dirname, '..');
const bunCommand = process.env.BUN_BIN ?? 'bun';
const hasBun = spawnSync(bunCommand, ['--version'], { encoding: 'utf8' }).status === 0;

describe.skipIf(!hasBun)('chat persistence atomicity with Bun SQLite', () => {
	it('rolls back deliberate partial writes and commits successful writes', async () => {
		const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'nao-chat-atomicity-'));
		const databasePath = path.join(tempRoot, 'chat.sqlite');
		const fixturePath = path.join(tempRoot, 'chat-persistence-fixture.ts');

		try {
			await writeFile(fixturePath, fixtureSource(backendRoot));
			const result = spawnSync(bunCommand, ['run', fixturePath, databasePath], {
				cwd: backendRoot,
				encoding: 'utf8',
				maxBuffer: 10 * 1024 * 1024,
				env: { ...process.env, DB_URI: `sqlite:${databasePath}`, MODE: 'test' },
			});

			expect(result.status, result.stderr).toBe(0);
			expect(JSON.parse(result.stdout.trim().split('\n').at(-1)!)).toEqual({
				createChatFailure: { chats: 0, messages: 0, parts: 0 },
				createChatSuccess: { chats: 1, messages: 1, parts: 1 },
				createForkedChatFailure: { chats: 1, messages: 1, parts: 1 },
				createForkedChatSuccess: { chats: 2, messages: 2, parts: 2 },
				upsertMessageFailure: { chats: 2, messages: 2, parts: 2 },
				upsertMessageSuccess: { chats: 2, messages: 3, parts: 3 },
				upsertExistingFailure: { chats: 2, messages: 3, parts: 3, text: 'success' },
			});
		} finally {
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});

function fixtureSource(root: string): string {
	const sourceRoot = JSON.stringify(root);
	return `
process.env.DB_URI = \`sqlite:\${process.argv[2]}\`;
process.env.MODE = 'test';

const { db } = await import(${sourceRoot} + '/src/db/db.ts');
const { migrate } = await import(${sourceRoot} + '/../../node_modules/drizzle-orm/bun-sqlite/migrator.js');
migrate(db, { migrationsFolder: ${sourceRoot} + '/migrations-sqlite' });
const database = db.$client;
const { createChat, createForkedChat, upsertMessage } = await import(${sourceRoot} + '/src/queries/chat.queries.ts');
database.exec(\`
CREATE TRIGGER fail_message_part BEFORE INSERT ON message_part
WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END;
\`);
database.run(\`INSERT INTO user (id, name, email) VALUES ('user-1', 'Test User', 'test@example.com')\`);
database.run(\`INSERT INTO project (id, name, type, path) VALUES ('project-1', 'Test', 'local', '/tmp/nao-project-test')\`);

const query = (table: string) => database.query(\`SELECT count(*) AS count FROM \${table}\`).get().count;
const snapshot = () => ({ chats: query('chat'), messages: query('chat_message'), parts: query('message_part') });
const assert = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const chat = (id: string) => ({ id, userId: 'user-1', projectId: 'project-1', title: id });
const textMessage = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] });
const expectFailure = async (operation: () => Promise<unknown>) => {
  try { await operation(); } catch (error) { if (!String(error).includes('deliberate test failure')) throw error; return; }
  throw new Error('expected deliberate failure');
};
const output: Record<string, unknown> = {};

await expectFailure(() => createChat(chat('create-failure'), { text: 'fail' }));
output.createChatFailure = snapshot();
database.exec('DROP TRIGGER fail_message_part');
await createChat(chat('create-success'), { text: 'success' });
assert(database.query(\`SELECT id FROM chat WHERE id = 'create-success'\`).get()?.id === 'create-success', 'createChat chat missing');
assert(database.query(\`SELECT text FROM message_part WHERE text = 'success'\`).get()?.text === 'success', 'createChat part missing');
output.createChatSuccess = snapshot();

database.exec(\`CREATE TRIGGER fail_message_part BEFORE INSERT ON message_part
WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END\`);
await expectFailure(() => createForkedChat(chat('fork-failure'), [textMessage('fail')]));
output.createForkedChatFailure = snapshot();
database.exec('DROP TRIGGER fail_message_part');
await createForkedChat(chat('fork-success'), [textMessage('success')]);
assert(database.query(\`SELECT id FROM chat WHERE id = 'fork-success'\`).get()?.id === 'fork-success', 'fork chat missing');
assert(database.query(\`SELECT isForked FROM chat_message WHERE chat_id = (SELECT id FROM chat WHERE id = 'fork-success')\`).get()?.isForked === 1, 'fork message missing');
output.createForkedChatSuccess = snapshot();

database.exec(\`CREATE TRIGGER fail_message_part BEFORE INSERT ON message_part
WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END\`);
await expectFailure(() => upsertMessage({ ...textMessage('fail'), chatId: 'create-success', id: 'upsert-failure' }));
output.upsertMessageFailure = snapshot();
database.exec('DROP TRIGGER fail_message_part');
await upsertMessage({ ...textMessage('success'), chatId: 'create-success', id: 'upsert-success' });
assert(database.query(\`SELECT id FROM chat_message WHERE id = 'upsert-success'\`).get()?.id === 'upsert-success', 'upsert message missing');
assert(database.query(\`SELECT text FROM message_part WHERE message_id = 'upsert-success'\`).get()?.text === 'success', 'upsert part missing');
output.upsertMessageSuccess = snapshot();

database.exec(\`CREATE TRIGGER fail_message_part BEFORE INSERT ON message_part
WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END\`);
await expectFailure(() => upsertMessage({ ...textMessage('fail'), chatId: 'create-success', id: 'upsert-success' }));
output.upsertExistingFailure = { ...snapshot(), text: database.query(\`SELECT text FROM message_part WHERE message_id = 'upsert-success'\`).get()?.text };
database.close();
console.log(JSON.stringify(output));
`;
}
