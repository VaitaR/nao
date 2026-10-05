const fs = require('fs');
const path = require('path');
const net = require('net');
const { createRequire } = require('module');

const BEFORE_ROOT = process.env.NAO_BEFORE_ROOT;
const AFTER_ROOT = process.env.NAO_AFTER_ROOT;
const BEFORE_SHA = '1de3864bfa36d6c58d1e42542eb5e310c77d3752';
const AFTER_SHA = 'd998d0786983a4a06d33f9ed658f9ad8af30a593';
const PLAYWRIGHT_ROOT = process.env.PLAYWRIGHT_MODULE || 'playwright';
const CHROMIUM = process.env.CHROMIUM_EXECUTABLE;
const WORK_ROOT = process.cwd();
const OUTPUT_DIR = process.env.REPRO_OUTPUT_DIR || path.join(WORK_ROOT, 'qa/repro/output');
const CACHE_DIR = process.env.REPRO_CACHE_DIR || path.join(WORK_ROOT, 'qa/repro/cache');

function packageRequire(sourceRoot) {
	return createRequire(path.join(sourceRoot, 'apps/frontend/package.json'));
}

function sourceFile(sourceRoot, relative) {
	return path.join(sourceRoot, 'apps/frontend/src', relative);
}

const APP_SOURCE = `
import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AssistantMessageActions } from '/@repro/assistant-actions';
import { useSyncMessages } from '/@repro/use-agent';
import { useQuery } from '@tanstack/react-query';
import { trpc } from '@/main';
import '/@repro/styles.css';

const h = React.createElement;

function FixtureFrame({ title, children }) {
  return h('main', { className: 'fixture' },
    h('div', { className: 'eyebrow' }, 'Reproduction fixture | Synthetic data'),
    h('h1', null, title), children);
}

function FeedbackFixture() {
  const initial = { id: 'assistant-1', role: 'assistant', parts: [{ type: 'text', text: 'Synthetic answer used for the live vote reproduction.' }] };
  const [liveMessage, setLiveMessage] = useState(initial);
  const [, setCacheVersion] = useState(0);
  const query = globalThis.__reproQuery;
  const agent = useMemo(() => ({
    messages: [initial],
    setMessages(updater) {
      setLiveMessage((current) => {
        const next = typeof updater === 'function' ? updater([current]) : updater;
        return next[0] || current;
      });
    },
  }), []);
  agent.messages = [liveMessage];
  globalThis.__reproAgent = agent;
  useEffect(() => query.subscribe(() => setCacheVersion((value) => value + 1)), [query]);
  const persisted = query.get(['chat.get', 'feedback-chat']);
  const savedVote = persisted?.messages?.[0]?.feedback?.vote || 'none';
  const visibleVote = liveMessage.feedback?.vote || 'none';
  return h(FixtureFrame, { title: 'Feedback should appear immediately' },
    h('p', { className: 'lede' }, 'Submit an upvote. Watch the thumb and the visible vote.'),
    h('section', { className: 'panel' },
      h('div', { className: 'answer' }, h('div', { className: 'label' }, 'Assistant message'), h('p', null, 'Synthetic answer used for the live vote reproduction.')),
      h(AssistantMessageActions, { message: liveMessage, chatId: 'feedback-chat' }),
      h('div', { className: 'status', 'data-testid': 'vote-status' }, 'Saved vote: ',h('span',{'data-testid':'persisted-vote'},savedVote),' | Visible vote: ',h('span',{'data-testid':'live-vote'},visibleVote)),
    ));
}

function ChatFixture() {
  const [chatId, setChatId] = useState('chat-a');
  const [active, setActive] = useState({ chatId: 'chat-a', agentInstanceId: 'instance-a', isRunning: true, messages: [
    { id: 'a-question', role: 'user', parts: [{ type: 'text', text: 'Question from Chat A' }] },
    { id: 'a-partial', role: 'assistant', parts: [{ type: 'text', text: 'Live partial answer from Chat A…' }] },
  ] });
  const [, setCacheVersion] = useState(0);
  const store = globalThis.__reproChat;
  store.currentId = chatId;
  useEffect(() => store.subscribe(() => setCacheVersion((value) => value + 1)), [store]);
  const agent = useMemo(() => ({
    chatId: active.chatId,
    agentInstanceId: active.agentInstanceId,
    isRunning: active.isRunning,
    messages: active.messages,
    setMessages(next) {
      setActive((current) => ({ ...current, messages: typeof next === 'function' ? next(current.messages) : next }));
    },
  }), [active]);
  useSyncMessages({ agent });
  const cached = store.chats.get(chatId);
  const switched = () => {
    store.currentId = 'chat-b';
    setChatId('chat-b');
    setActive({ chatId: 'chat-b', agentInstanceId: 'instance-b', isRunning: false, messages: [] });
  };
  const ids = (items) => items.map((item) => item.id).join(', ') || 'none';
  return h(FixtureFrame, { title: 'Switching chats must preserve history' },
    h('p', { className: 'lede' }, 'Chat A is still answering. Switch to Chat B.'),
    h('button', { className: 'switch-button', onClick: switched, 'data-testid': 'switch-chat' }, 'Switch to Chat B'),
    h('section', { className: 'panel' },
      h('div', { className: 'status', 'data-testid': 'chat-status','data-chat-id':chatId,'data-running':String(agent.isRunning) }, 'Chat '+chatId.slice(-1).toUpperCase()+' | '+(agent.isRunning?'Answer in progress':'Ready')),
      h('div', { className: 'store-grid' },
        h('div', null, h('strong', null, 'Messages on screen (' + agent.messages.length + ')'), h('span', { 'data-testid': 'agent-count' }, ids(agent.messages)), ...agent.messages.map(m=>h('p',{key:m.id,className:'message-copy'},m.parts[0]?.text || ''))),
        h('div', null, h('strong', null, 'Saved history (' + ((cached && cached.messages) || []).length + ')'), h('span', { 'data-testid': 'cache-count' }, ids((cached && cached.messages) || [])), ...((cached && cached.messages) || []).map(m=>h('p',{key:m.id,className:'message-copy'},m.parts[0]?.text || '')), !cached?.messages?.length && h('p',{className:'message-copy'},'No saved messages'))),
      !agent.messages.length && h('p',{className:'small'},'No messages on screen.'),
    ));
}

function App() {
  const scenario = new URLSearchParams(location.search).get('scenario') || 'feedback';
  if (scenario === 'chat') return h(ChatFixture);
  return h(FeedbackFixture);
}

createRoot(document.getElementById('root')).render(h(App));
`;

const STUBS = {
	reactQuery: `
import { useEffect, useState } from 'react';
const cache = () => globalThis.__reproQuery;
export function useQuery(options) {
  const [, force] = useState(0);
  const key = options?.queryKey || ['chat.get', 'feedback-chat'];
  useEffect(() => cache().subscribe(() => force((value) => value + 1)), [String(key)]);
  return { data: cache().get(key) };
}
export function useMutation(options) {
  return { isPending: false, mutate(input) {
    const data = { vote: input.vote, messageId: input.messageId };
    options?.onSuccess?.(data, input, undefined, { client: cache().client });
  } };
}
export function useQueryClient() { return globalThis.__reproQuery.client; }
`,
	main: `
const key = (chatId) => ['chat.get', chatId];
export const trpc = {
  chat: { get: { queryOptions: ({ chatId }) => ({ queryKey: key(chatId) }), queryKey: ({ chatId }) => key(chatId) },
    stop: { mutationOptions: () => ({}) }, cancel: { mutationOptions: () => ({}) }, switchMessageVersion: { mutationOptions: () => ({}) } },
  project: { getChatReplay: { queryKey: () => ['project.replay'] }, getProjectChats: { queryKey: () => ['project.chats'] } },
  feedback: { submit: { mutationOptions: (options) => options } },
};
export const trpcClient = {};
`,
	agentContext: `
export function useAgentContext() { return globalThis.__reproAgent || null; }
export function useAgentMessagesGetter() { return () => globalThis.__reproAgent?.messages || []; }
`,

	copy: `export function useCopyToClipboard() { return { isCopied: false, copy() {} }; }`,

	serialize: `export function getMessageMarkdown() { return ''; } export function getChatMarkdown() { return ''; }`,
	exportChat: `export function downloadBase64File() {} export function downloadTextFile() {} export function toFileSlug(value) { return value; }`,
	aiSdk: `export function useChat() { throw new Error('useChat is not used by this fixture'); } export class Chat {}`,
	ai: `export class DefaultChatTransport {} export const UI_MESSAGE_STREAM = undefined;`,
	router: `export function useNavigate() { return () => {}; } export function useParams() { return {}; }`,
	localStorage: `export function createLocalStorage() { return { get: () => null, set: () => {} }; } export function useLocalStorage() { return [null, () => {}]; }`,
	activeProject: `export function getActiveProjectId() { return undefined; }`,
	aiLib: `export const NEW_CHAT_ID = '__new__'; export const checkIsAgentRunning = ({ status }) => status === 'streaming'; export const getLastUserMessageIdx = () => -1; export const getMessageText = () => ''; export const getMessageImages = () => []; export const getMessageDocuments = () => []; export const getTextFromUserMessageOrThrow = () => ''; export const extractImagesFromMessage = () => []; export const extractDocumentPathsFromMessage = () => []; export const parseBudgetError = () => false; export const resolveImagesFromMessage = async () => [];`,
	agents: `export const agentService = { getAgent: () => undefined, registerAgent: (id, agent) => agent, moveAgent() {}, disposeAgent() {} };`,
	store: `export const chatActivityStore = { setRunning() {}, setUnread() {} }; export const cancellingMessageIdStore = { setCancelling() {} }; export const editedMessageIdStore = { setEditingId() {} }; export const chatInputRestoreStore = { set() {} }; export const messageQueueStore = { moveQueue() {}, dequeue: () => undefined, clear() {}, enqueue() {}, promoteToFront() {} };`,
	attachments: `export {};`,
};

function virtual(name) {
	return `\0repro-${name}`;
}

function virtualSource(name) {
	return STUBS[name];
}

function fixturePlugin(sourceRoot) {
	const packageReq = packageRequire(sourceRoot);
	const sourceAliases = {
		'@/main': 'main',
		'@/contexts/agent.provider': 'agentContext',
		'@/components/ui/button': 'button',
		'@/components/ui/dialog': 'dialog',
		'@/components/ui/textarea': 'textarea',
		'@/components/ui/switch': 'switch',
		'@/components/ui/dropdown-menu': 'dropdown',
		'@/hooks/use-copy-to-clipboard': 'copy',
		'@/lib/utils': 'utils',
		'@/lib/serialize-message': 'serialize',
		'@/lib/export-chat': 'exportChat',
		'@/lib/active-project': 'activeProject',
		'@/lib/ai': 'aiLib',
		'@/lib/local-storage': 'localStorage',
		'@/lib/attachments': 'attachments',
		'@/services/agents': 'agents',
		'@/stores/chat-activity': 'store',
		'@/stores/chat-cancelling-message': 'store',
		'@/stores/chat-edited-message': 'store',
		'@/stores/chat-input-restore': 'store',
		'@/stores/chat-message-queue': 'store',
		'@/queries/use-chat-query': 'chatQuery',
	};
	for (const id of [
		'@/components/ui/button',
		'@/components/ui/dialog',
		'@/components/ui/textarea',
		'@/components/ui/switch',
		'@/components/ui/dropdown-menu',
		'@/lib/utils',
	])
		delete sourceAliases[id];
	return {
		name: 'repro-fixture',
		enforce: 'pre',
		resolveId(id, importer) {
			if (id === '/@repro/app.jsx') return virtual('app');
			if (id === '/@repro/assistant-actions')
				return sourceFile(sourceRoot, 'components/chat-messages/assistant-message-actions.tsx');
			if (id === '/@repro/use-agent') return sourceFile(sourceRoot, 'hooks/use-agent.ts');
			if (id === '/@repro/styles.css')
				return path.join(CACHE_DIR, 'styles-' + path.basename(sourceRoot) + '.css');
			if (id === '@tanstack/react-query') return virtual('reactQuery');
			if (id === '@ai-sdk/react') return virtual('aiSdk');
			if (id === '@tanstack/react-router') return virtual('router');
			if (id === 'ai') return virtual('ai');
			if (sourceAliases[id]) return virtual(sourceAliases[id]);
			if (id === './use-chat-id' && importer && importer.endsWith('/hooks/use-agent.ts'))
				return virtual('chatId');
			if (id === './use-local-storage' && importer && importer.endsWith('/hooks/use-agent.ts'))
				return virtual('localStorage');
			if (id === '@/hooks/use-chat-id') return virtual('chatId');
			if (id === '@/hooks/use-local-storage') return virtual('localStorage');
			if (id.startsWith('@/')) {
				const base = sourceFile(sourceRoot, id.slice(2));
				for (const file of [base, base + '.ts', base + '.tsx', base + '.js', path.join(base, 'index.ts')])
					if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
			}
			if (id.startsWith('@nao/shared/')) {
				const base = path.join(sourceRoot, 'apps/shared/src', id.slice('@nao/shared/'.length));
				for (const file of [base, base + '.ts', base + '.tsx', path.join(base, 'index.ts')])
					if (fs.existsSync(file) && fs.statSync(file).isFile()) return file;
			}
			return undefined;
		},
		load(id) {
			if (id === virtual('app')) return APP_SOURCE;
			if (id === virtual('chatQuery'))
				return `import { useEffect, useState } from 'react'; export function useChatQuery({ chatId }) { const [, force] = useState(0); const store = globalThis.__reproChat; useEffect(() => store.subscribe(() => force((value) => value + 1)), [store]); return { data: store.chats.get(chatId), isLoading: false }; } export function useSetChat() { return globalThis.__reproChat.setChat; }`;
			if (id === virtual('chatId'))
				return `export function useChatId() { return globalThis.__reproChat.currentId; }`;
			if (id === virtual('use-prev')) return `export function usePrevRef(value) { return { current: value }; }`;
			const match = Object.keys(STUBS).find((name) => id === virtual(name));
			return match ? virtualSource(match) : undefined;
		},
		configResolved() {
			for (const name of ['react', 'react-dom/client']) {
				try {
					this.resolveAlias?.(name);
				} catch {}
			}
			void packageReq;
		},
	};
}

function baseCss() {
	return `
 .fixture {width:700px;margin:0 auto;padding:20px;font-family:Arial,sans-serif;}
 .eyebrow {font-size:16px;color:#52637a;} .fixture h1 {font-size:28px;line-height:1.2;margin:12px 0;}
 .lede {font-size:18px;line-height:1.35;margin:0 0 18px;} .panel {padding:18px;border:1px solid #cbd5e1;border-radius:12px;}
 .answer {margin-bottom:12px;} .answer .label {font-size:16px;color:#52637a;} .answer p {font-size:20px;margin:8px 0;}
 .status {font-size:20px;line-height:1.3;padding:12px;background:#e6f5fb;color:#164e63;border-radius:8px;margin-top:16px;}
 .store-grid {display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:14px;}
 .store-grid > div {padding:12px;border:1px solid #dbe4ee;border-radius:8px;}
 .store-grid strong,.store-grid span {display:block;font-size:17px;line-height:1.35;}
 [data-testid='agent-count'],[data-testid='cache-count'] {display:none !important;}
 .message-copy {padding:10px;margin-top:8px;border-radius:6px;background:#f1f5f9;font-size:18px;line-height:1.35;}
 .switch-button {padding:10px 16px;border-radius:8px;background:#2563eb;color:white;font-size:19px;cursor:pointer;}
 .small {font-size:16px;line-height:1.35;color:#52637a;margin-top:14px;}
 `;
}

function html() {
	return (
		'<!doctype html><html><head><meta charset="UTF-8"><title>NAO PR reproductions</title></head><body><div id="root"></div><script type="module" src="/@fs/' +
		CACHE_DIR +
		'/app.jsx"></script></body></html>'
	);
}

function installStores() {
	const listeners = new Set();
	const notify = () => listeners.forEach((listener) => listener());
	const feedbackMessage = {
		id: 'assistant-1',
		role: 'assistant',
		parts: [{ type: 'text', text: 'Synthetic answer used for the live vote reproduction.' }],
	};
	const queryStore = {
		values: new Map([['chat.get|feedback-chat', { title: 'Feedback fixture', messages: [feedbackMessage] }]]),
		get(key) {
			return this.values.get(key.join('|'));
		},
		set(key, updater) {
			const oldValue = this.get(key);
			const next = typeof updater === 'function' ? updater(oldValue) : updater;
			if (next !== oldValue) this.values.set(key.join('|'), next);
			notify();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	queryStore.client = {
		setQueryData: (key, updater) => queryStore.set(key, updater),
		invalidateQueries: () => Promise.resolve(),
	};
	globalThis.__reproQuery = queryStore;

	const chatListeners = new Set();
	const chatStore = {
		currentId: 'chat-a',
		chats: new Map([
			[
				'chat-a',
				{
					id: 'chat-a',
					messages: [
						{ id: 'a-question', role: 'user', parts: [{ type: 'text', text: 'Question from Chat A' }] },
					],
				},
			],
			[
				'chat-b',
				{
					id: 'chat-b',
					messages: [
						{
							id: 'b-question',
							role: 'user',
							parts: [{ type: 'text', text: 'Saved question from Chat B' }],
						},
						{
							id: 'b-answer',
							role: 'assistant',
							parts: [{ type: 'text', text: 'Saved answer from Chat B' }],
						},
					],
				},
			],
		]),
		subscribe(listener) {
			chatListeners.add(listener);
			return () => chatListeners.delete(listener);
		},
		setChat({ chatId }, updater) {
			if (!chatId) return;
			const previous = this.chats.get(chatId);
			const next = updater(previous);
			if (next && next !== previous) {
				this.chats.set(chatId, next);
				chatListeners.forEach((listener) => listener());
			}
		},
	};
	chatStore.setChat = chatStore.setChat.bind(chatStore);
	globalThis.__reproChat = chatStore;
}

async function makeServer(sourceRoot, port) {
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	fs.writeFileSync(path.join(CACHE_DIR, 'app.jsx'), APP_SOURCE);
	fs.writeFileSync(path.join(CACHE_DIR, 'index.html'), html());
	const req = packageRequire(sourceRoot);
	const vite = await import(req.resolve('vite'));
	const react = (await import(req.resolve('@vitejs/plugin-react'))).default;
	const tailwind = (await import(req.resolve('@tailwindcss/vite'))).default;
	const styles = path.join(CACHE_DIR, 'styles-' + path.basename(sourceRoot) + '.css');
	const sourceFiles = [
		'components/chat-messages/assistant-message-actions.tsx',
		'components/ui/button.tsx',
		'components/ui/dialog.tsx',
		'components/ui/textarea.tsx',
		'components/ui/switch.tsx',
		'components/ui/dropdown-menu.tsx',
	];
	const literals = sourceFiles.flatMap((file) =>
		[...fs.readFileSync(sourceFile(sourceRoot, file), 'utf8').matchAll(/(['"])(.*?)\1/g)]
			.map((m) => m[2])
			.filter((v) => v.includes(' ') || v.includes('-')),
	);
	fs.writeFileSync(
		styles,
		'@import ' +
			JSON.stringify(sourceFile(sourceRoot, 'styles.css')) +
			';\n' +
			literals.map((v) => '@source inline(' + JSON.stringify(v) + ');').join('\n') +
			'\n' +
			baseCss(),
	);
	const server = await vite.createServer({
		root: CACHE_DIR,
		cacheDir: path.join(CACHE_DIR, String(port)),
		logLevel: 'error',
		plugins: [fixturePlugin(sourceRoot), react({ exclude: [/node_modules/, /cache/] }), tailwind()],
		resolve: {
			dedupe: ['react', 'react-dom'],
			alias: [
				{ find: /^react$/, replacement: req.resolve('react') },
				{ find: /^react-dom\/client$/, replacement: req.resolve('react-dom/client') },
				{ find: /^react\/jsx-runtime$/, replacement: req.resolve('react/jsx-runtime') },
				{ find: /^react\/jsx-dev-runtime$/, replacement: req.resolve('react/jsx-dev-runtime') },
			],
		},
		optimizeDeps: { exclude: ['@tanstack/react-query', '@ai-sdk/react', '@tanstack/react-router', 'ai'] },
		server: {
			host: '127.0.0.1',
			port,
			strictPort: true,
			fs: { allow: [WORK_ROOT, CACHE_DIR, sourceRoot, BEFORE_ROOT, AFTER_ROOT] },
		},
	});

	await server.listen();
	return server;
}

function measured(page, scenario) {
	return page.evaluate((kind) => {
		if (kind === 'feedback') {
			const good = document.querySelector('[aria-label="Good response"]');
			const bad = document.querySelector('[aria-label="Bad response"]');
			return {
				savedVote: document.querySelector('[data-testid="persisted-vote"]')?.textContent,
				visibleVote: document.querySelector('[data-testid="live-vote"]')?.textContent,
				status: document.querySelector('[data-testid="vote-status"]')?.textContent,
				goodClass: good?.className,
				badClass: bad?.className,
				goodSvgPaths: good?.querySelectorAll('svg path,svg polyline').length,
				goodOpacity: good ? getComputedStyle(good).opacity : null,
			};
		}
		return {
			activeChat:
				document.querySelector('[data-testid="chat-status"]')?.dataset.chatId +
				' | running:' +
				document.querySelector('[data-testid="chat-status"]')?.dataset.running,
			agentMessages: document.querySelector('[data-testid="agent-count"]')?.textContent,
			cachedMessages: document.querySelector('[data-testid="cache-count"]')?.textContent,
		};
	}, scenario);
}

async function replay(sourceRoot, port, label, scenario, sourceSha) {
	const { chromium } = require(PLAYWRIGHT_ROOT);
	await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once('error', reject);
		probe.listen(port, '127.0.0.1', () => probe.close(resolve));
	});
	const server = await makeServer(sourceRoot, port);
	const browserErrors = [];
	const blockedErrors = [];
	let recordingStarted;
	const context = await chromium
		.launch({
			headless: true,
			executablePath: CHROMIUM,
		})
		.then((browser) =>
			browser
				.newContext({
					viewport: { width: 720, height: 640 },
					recordVideo: { dir: CACHE_DIR, size: { width: 720, height: 640 } },
				})
				.then((ctx) => ({ browser, ctx })),
		);
	const { browser, ctx } = context;
	await ctx.addInitScript(installStores);
	const page = await ctx.newPage();
	recordingStarted = Date.now();
	await page.route('**/*', async (route) => {
		const url = new URL(route.request().url());
		if (['fonts.googleapis.com', 'fonts.gstatic.com'].includes(url.hostname)) {
			await route.fulfill({ status: 200, contentType: 'text/css', body: '' });
			return;
		}
		if (['http:', 'https:'].includes(url.protocol) && !['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
			blockedErrors.push('blocked external request: ' + url.href);
			await route.abort();
		} else await route.continue();
	});
	page.on('pageerror', (error) => browserErrors.push(error.message));
	page.on('console', (message) => {
		if (message.type() === 'error') browserErrors.push(message.text());
	});
	const startedAt = new Date().toISOString();
	const url = 'http://127.0.0.1:' + port + '/?scenario=' + scenario;
	let before;
	let after;
	let readyAt, actionAt, resultAt, endedAtVideo, preconditionState;
	try {
		await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
		await page.getByText('Reproduction fixture | Synthetic data', { exact: true }).waitFor();
		readyAt = (Date.now() - recordingStarted) / 1000;
		await page.waitForTimeout(5000);
		before = await measured(page, scenario);
		preconditionState = await page.evaluate(() => ({
			bMessages: globalThis.__reproChat.chats.get('chat-b').messages.length,
			currentId: globalThis.__reproChat.currentId,
		}));
		actionAt = (Date.now() - recordingStarted) / 1000;
		await page.locator('main.fixture').screenshot({ path: path.join(OUTPUT_DIR, label + '-before.png') });
		if (scenario === 'feedback') {
			await page.getByRole('button', { name: 'Good response' }).click();
			await page.waitForTimeout(2000);
			await page.getByRole('button', { name: 'Submit', exact: true }).click();
		} else {
			await page.getByTestId('switch-chat').click();
		}
		await page.waitForTimeout(1000);
		resultAt = (Date.now() - recordingStarted) / 1000;
		await page.waitForTimeout(5000);
		after = await measured(page, scenario);
		await page.locator('main.fixture').screenshot({ path: path.join(OUTPUT_DIR, label + '-after.png') });
	} finally {
		endedAtVideo = (Date.now() - recordingStarted) / 1000;
		const video = page.video();
		await ctx.close();
		if (video) {
			const videoPath = await video.path();
			fs.renameSync(videoPath, path.join(OUTPUT_DIR, label + '.webm'));
		}
		await browser.close();
		await server.close();
	}
	const endedAt = new Date().toISOString();
	const evidence = [label + '-before.png', label + '-after.png', label + '.webm'];
	const reproduced =
		scenario === 'feedback'
			? before?.savedVote === 'none' &&
				before?.visibleVote === 'none' &&
				before?.goodClass?.includes('opacity-50') &&
				after?.savedVote === 'up' &&
				after?.visibleVote === 'none' &&
				after?.goodClass?.includes('opacity-50')
			: before?.activeChat?.includes('chat-a') &&
				before?.activeChat?.includes('true') &&
				before?.agentMessages?.includes('a-question') &&
				preconditionState?.bMessages === 2 &&
				after?.activeChat?.includes('chat-b') &&
				after?.cachedMessages === 'none';
	const fixed =
		scenario === 'feedback'
			? after?.savedVote === 'up' &&
				after?.visibleVote === 'up' &&
				after?.goodClass?.includes('text-primary') &&
				after?.goodSvgPaths > 0
			: after?.activeChat?.includes('chat-b') &&
				after?.cachedMessages?.includes('b-question') &&
				after?.agentMessages?.includes('b-question');
	return {
		scenario,
		source: { label, sha: sourceSha },
		fixture: true,
		precondition:
			scenario === 'feedback'
				? 'Live agent message and persisted query cache start without feedback; real Good response UI is clickable.'
				: 'Chat A is running with a partial answer; Chat B has two cached messages; switch creates a fresh B agent instance.',
		reproduced: Boolean(reproduced),
		fixed: Boolean(fixed),
		before,
		after,
		timestamps: { startedAt, endedAt },
		durationMs: Math.round(endedAtVideo * 1000),
		timeline: { readyAt, actionAt, resultAt, endedAtVideo },
		preconditionState,
		evidence,
		browserErrors,
		blockedErrors,
	};
}

async function run() {
	if (!BEFORE_ROOT || !AFTER_ROOT)
		throw new Error('Set NAO_BEFORE_ROOT and NAO_AFTER_ROOT to the pinned source checkouts.');
	fs.mkdirSync(OUTPUT_DIR, { recursive: true });
	fs.mkdirSync(CACHE_DIR, { recursive: true });
	installStores();
	const results = [];
	const attempt = async (sourceRoot, port, label, scenario, sourceSha) => {
		try {
			return await replay(sourceRoot, port, label, scenario, sourceSha);
		} catch (error) {
			console.error(label, error.message);
			return {
				scenario,
				fixture: true,
				precondition:
					scenario === 'feedback'
						? 'Live agent message and persisted query cache start without feedback; real Good response UI is clickable.'
						: 'Chat A is running with a partial answer; Chat B has two cached messages; switch creates a fresh B agent instance.',
				reproduced: false,
				fixed: false,
				before: null,
				after: null,
				source: { label, sha: sourceSha },
				timestamps: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString() },
				durationMs: 0,
				evidence: [],
				browserErrors: [],
				blockedErrors: ['capture blocked: ' + (error.stack || error.message || String(error))],
			};
		}
	};
	results.push(await attempt(BEFORE_ROOT, 3061, 'feedback-before-source', 'feedback', BEFORE_SHA));
	installStores();
	results.push(await attempt(AFTER_ROOT, 3062, 'feedback-after-source', 'feedback', AFTER_SHA));
	installStores();
	results.push(await attempt(BEFORE_ROOT, 3061, 'chat-before-source', 'chat', BEFORE_SHA));
	installStores();
	results.push(await attempt(AFTER_ROOT, 3062, 'chat-after-source', 'chat', AFTER_SHA));
	fs.writeFileSync(path.join(OUTPUT_DIR, 'raw-results.json'), JSON.stringify(results, null, 2) + '\n');
	const scenarios = [
		{
			...results[0],
			before: results[0].after,
			after: results[1].after,
			source: { before: results[0].source, after: results[1].source },
			evidence:
				results[0].reproduced && results[1].fixed
					? [
							'feedback-before-source-after.png',
							'feedback-after-source-after.png',
							'feedback-before-source.webm',
							'feedback-after-source.webm',
						]
					: [],
			reproduced: results[0].reproduced,
			fixed: results[1].fixed,
			blockedErrors: [...results[0].blockedErrors, ...results[1].blockedErrors],
		},
		{
			...results[2],
			before: results[2].after,
			after: results[3].after,
			source: { before: results[2].source, after: results[3].source },
			evidence:
				results[2].reproduced && results[3].fixed
					? [
							'chat-before-source-after.png',
							'chat-after-source-after.png',
							'chat-before-source.webm',
							'chat-after-source.webm',
						]
					: [],
			reproduced: results[2].reproduced,
			fixed: results[3].fixed,
			blockedErrors: [...results[2].blockedErrors, ...results[3].blockedErrors],
		},
	].map(
		({
			scenario,
			fixture,
			precondition,
			reproduced,
			fixed,
			before,
			after,
			timestamps,
			durationMs,
			evidence,
			browserErrors,
			blockedErrors,
			source,
		}) => ({
			scenario,
			fixture,
			precondition,
			reproduced,
			fixed,
			before,
			after,
			source,
			timestamps,
			durationMs,
			evidence,
			browserErrors,
			blockedErrors,
		}),
	);
	fs.writeFileSync(path.join(OUTPUT_DIR, 'results.json'), JSON.stringify(scenarios, null, 2) + '\n');
	console.log(JSON.stringify(scenarios));
	if (
		!scenarios.every(
			(result) =>
				result.reproduced && result.fixed && !result.blockedErrors.length && !result.browserErrors.length,
		)
	)
		process.exitCode = 2;
	return scenarios;
}

module.exports = { makeServer, replay, installStores };
if (require.main === module)
	run().catch((error) => {
		console.error(error.stack || error);
		process.exitCode = 1;
	});
