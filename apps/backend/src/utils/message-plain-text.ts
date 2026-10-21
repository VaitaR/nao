import { type Root, toPlainText, walkAst } from 'chat';

const HTTP_URL_REGEX = /^https?:\/\//i;

/**
 * Plain text of a parsed chat message with link targets kept. Adapters that build
 * `Message.text` with `toPlainText` (Slack `<url|label>`, Teams `<a href>`) keep only the
 * link label, so the agent would never see the URL. Reads the adapter's AST rather than
 * the raw event so inline user mentions keep their resolved display names.
 */
export function plainTextWithLinks(formatted: Root): string {
	const withLinkTargets = walkAst(structuredClone(formatted), (node) =>
		node.type === 'link'
			? { type: 'text', value: formatLink(node.url, toPlainText({ type: 'root', children: node.children })) }
			: node,
	);
	return toPlainText(withLinkTargets);
}

/** The URL alone when the label is (a truncated prefix of) it, else `label (url)`. */
export function formatLink(url: string, label: string): string {
	if (!HTTP_URL_REGEX.test(url)) {
		return label;
	}
	const shownLabel = label.trim();
	const labelPrefix = stripScheme(shownLabel).replace(/(?:…|\.\.\.)$/, '');
	if (!labelPrefix || stripScheme(url).toLowerCase().startsWith(labelPrefix.toLowerCase())) {
		return url;
	}
	return `${shownLabel} (${url})`;
}

function stripScheme(value: string): string {
	return value.replace(HTTP_URL_REGEX, '');
}
