import { formatLink } from './message-plain-text';

const SLACK_MRKDWN_LINK_REGEX = /<(https?:\/\/[^|<>]+)(?:\|([^<>]*))?>/g;

/** For raw Slack mrkdwn (e.g. `conversations.replies` text) that never went through the adapter. */
export function expandSlackMrkdwnLinks(mrkdwn: string): string {
	return mrkdwn.replace(SLACK_MRKDWN_LINK_REGEX, (_match, url: string, label: string | undefined) =>
		formatLink(decodeSlackEntities(url), decodeSlackEntities(label ?? '')),
	);
}

function decodeSlackEntities(value: string): string {
	return value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
