import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const backendRoot = path.resolve(import.meta.dirname, '..');
const bunCommand = process.env.BUN_BIN ?? 'bun';

describe('chat persistence atomicity with Bun SQLite', () => {
	it('rolls back failed chat creation and message replacement, and commits a successful chat', async () => {
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

			expect(result.status, result.stderr || result.error?.message).toBe(0);
			const output = JSON.parse(result.stdout.trim().split('\n').at(-1)!);
			expect.soft(output.createFailure).toEqual({ chat: 0, messages: 0 });
			expect.soft(output.success).toEqual({ chat: 'replace-chat', messages: 1, parts: 1 });
			expect.soft(output.replacementFailure).toEqual({
				chat: 1,
				messages: 1,
				parts: 1,
				role: 'user',
				text: 'before',
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
const { createChat, upsertMessage } = await import(${sourceRoot} + '/src/queries/chat.queries.ts');
const failMessagePart = () => database.exec(\`
CREATE TRIGGER fail_message_part BEFORE INSERT ON message_part
WHEN NEW.text = 'fail' BEGIN SELECT RAISE(ABORT, 'deliberate test failure'); END;
\`);
database.run(\`INSERT INTO user (id, name, email) VALUES ('user-1', 'Test User', 'test@example.com')\`);
database.run(\`INSERT INTO project (id, name, type, path) VALUES ('project-1', 'Test', 'local', '/tmp/nao-project-test')\`);

const count = (query: string, ...values: unknown[]) => database.query(query).get(...values).count;
const chat = (id: string) => ({ id, userId: 'user-1', projectId: 'project-1', title: id });
const textMessage = (text: string) => ({ role: 'user', parts: [{ type: 'text', text }] });
const expectFailure = async (operation: () => Promise<unknown>) => {
  try { await operation(); } catch (error) { if (!String(error).includes('deliberate test failure')) throw error; return; }
  throw new Error('expected deliberate test failure');
};

failMessagePart();
await expectFailure(() => createChat(chat('create-failure'), { text: 'fail' }));
const createFailure = {
  chat: count(\`SELECT count(*) AS count FROM chat WHERE id = ?\`, 'create-failure'),
  messages: count(\`SELECT count(*) AS count FROM chat_message WHERE chat_id = ?\`, 'create-failure'),
};

database.exec('DROP TRIGGER fail_message_part');
const [savedChat, savedMessage] = await createChat(chat('replace-chat'), { text: 'before' });
const success = {
  chat: database.query(\`SELECT id FROM chat WHERE id = ?\`).get(savedChat.id)?.id,
  messages: count(\`SELECT count(*) AS count FROM chat_message WHERE chat_id = ?\`, savedChat.id),
  parts: count(\`SELECT count(*) AS count FROM message_part WHERE message_id = ?\`, savedMessage.id),
};

failMessagePart();
await expectFailure(() => upsertMessage({
  ...textMessage('fail'),
  role: 'assistant',
  chatId: savedChat.id,
  id: savedMessage.id,
}));
const replacementFailure = {
  chat: count(\`SELECT count(*) AS count FROM chat WHERE id = ?\`, savedChat.id),
  messages: count(\`SELECT count(*) AS count FROM chat_message WHERE chat_id = ?\`, savedChat.id),
  parts: count(\`SELECT count(*) AS count FROM message_part WHERE message_id = ?\`, savedMessage.id),
  role: database.query(\`SELECT role FROM chat_message WHERE id = ?\`).get(savedMessage.id)?.role,
  text: database.query(\`SELECT text FROM message_part WHERE message_id = ?\`).get(savedMessage.id)?.text,
};

database.close();
console.log(JSON.stringify({ createFailure, success, replacementFailure }));
`;
}
