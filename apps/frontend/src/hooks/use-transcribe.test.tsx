// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MAX_RECORDING_SECONDS, useTranscribe } from './use-transcribe';

const transcribeMutate = vi.fn();

vi.mock('@/main', () => ({
	trpcClient: { transcribe: { transcribe: { mutate: (input: unknown) => transcribeMutate(input) } } },
}));

class FakeMediaRecorder {
	static instances: FakeMediaRecorder[] = [];
	static isTypeSupported = () => true;
	state: 'inactive' | 'recording' = 'inactive';
	mimeType = 'audio/webm';
	ondataavailable: ((e: { data: Blob }) => void) | null = null;
	onstop: (() => Promise<void> | void) | null = null;

	constructor() {
		FakeMediaRecorder.instances.push(this);
	}

	start() {
		this.state = 'recording';
	}

	stop() {
		this.state = 'inactive';
		this.ondataavailable?.({ data: new Blob(['audio-bytes']) });
		void this.onstop?.();
	}
}

class FakeAudioContext {
	createMediaStreamSource() {
		return { connect: () => {} };
	}
	createAnalyser() {
		return { fftSize: 0, smoothingTimeConstant: 0 };
	}
	close = vi.fn();
}

const trackStop = vi.fn();
const getUserMedia = vi.fn();

function pressKey(key: string) {
	const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
	act(() => {
		window.dispatchEvent(event);
	});
	return event;
}

async function startRecording(onTranscribed = vi.fn()) {
	const hook = renderHook(() => useTranscribe({ onTranscribed }));
	await act(async () => {
		hook.result.current.toggle();
	});
	await waitFor(() => expect(hook.result.current.state).toBe('recording'));
	return { ...hook, onTranscribed };
}

describe('useTranscribe', () => {
	beforeEach(() => {
		FakeMediaRecorder.instances = [];
		transcribeMutate.mockReset();
		trackStop.mockReset();
		getUserMedia.mockReset();
		getUserMedia.mockResolvedValue({ getTracks: () => [{ stop: trackStop }] });
		vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
		vi.stubGlobal('AudioContext', FakeAudioContext);
		Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('Esc cancels the recording without calling the API', async () => {
		const { result, onTranscribed } = await startRecording();

		const event = pressKey('Escape');

		await waitFor(() => expect(result.current.state).toBe('idle'));
		expect(event.defaultPrevented).toBe(true);
		expect(transcribeMutate).not.toHaveBeenCalled();
		expect(onTranscribed).not.toHaveBeenCalled();
		expect(trackStop).toHaveBeenCalled();
	});

	it('Enter finishes the recording and hands the transcript over', async () => {
		transcribeMutate.mockResolvedValue({ text: '  hello world ' });
		const { result, onTranscribed } = await startRecording();

		const event = pressKey('Enter');

		await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith('hello world'));
		expect(event.defaultPrevented).toBe(true);
		expect(transcribeMutate).toHaveBeenCalledTimes(1);
		expect(result.current.error).toBeNull();
	});

	it('reports an empty transcript as nothing-recognized', async () => {
		transcribeMutate.mockResolvedValue({ text: '   ' });
		const { result, onTranscribed } = await startRecording();

		act(() => result.current.finish());

		await waitFor(() => expect(result.current.error).toBe('nothing-recognized'));
		expect(onTranscribed).not.toHaveBeenCalled();
	});

	it('keeps the audio after a failed transcription and retries it', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		transcribeMutate.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ text: 'second try' });
		const { result, onTranscribed } = await startRecording();

		act(() => result.current.finish());
		await waitFor(() => expect(result.current.error).toBe('transcription-failed'));
		const firstAudio = transcribeMutate.mock.calls[0][0];

		await act(async () => {
			result.current.retry();
		});

		await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith('second try'));
		expect(transcribeMutate).toHaveBeenCalledTimes(2);
		expect(transcribeMutate.mock.calls[1][0]).toEqual(firstAudio);
		expect(result.current.error).toBeNull();
	});

	it('discards the kept audio when the error is dismissed', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		transcribeMutate.mockRejectedValue(new Error('boom'));
		const { result } = await startRecording();

		act(() => result.current.finish());
		await waitFor(() => expect(result.current.error).toBe('transcription-failed'));
		act(() => result.current.dismissError());
		act(() => result.current.retry());

		expect(result.current.error).toBeNull();
		expect(transcribeMutate).toHaveBeenCalledTimes(1);
	});

	it.each([
		['NotAllowedError', 'permission-denied'],
		['SecurityError', 'permission-denied'],
		['NotFoundError', 'no-microphone'],
		['NotReadableError', 'microphone-unavailable'],
	])('maps a %s from getUserMedia to %s', async (name, expected) => {
		getUserMedia.mockRejectedValue(new DOMException('nope', name));
		const { result } = renderHook(() => useTranscribe({ onTranscribed: vi.fn() }));

		await act(async () => {
			result.current.toggle();
		});

		expect(result.current.error).toBe(expected);
		expect(result.current.state).toBe('idle');
	});

	it('reports unsupported when the page has no media devices', async () => {
		Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
		const { result } = renderHook(() => useTranscribe({ onTranscribed: vi.fn() }));

		await act(async () => {
			result.current.toggle();
		});

		expect(result.current.error).toBe('unsupported');
		expect(getUserMedia).not.toHaveBeenCalled();
	});

	it('finishes automatically at the recording cap', async () => {
		const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
		transcribeMutate.mockResolvedValue({ text: 'long one' });
		const { result, onTranscribed } = await startRecording();

		const capCall = setTimeoutSpy.mock.calls.find(([, delay]) => delay === MAX_RECORDING_SECONDS * 1000);
		expect(capCall).toBeDefined();
		act(() => (capCall![0] as () => void)());

		await waitFor(() => expect(onTranscribed).toHaveBeenCalledWith('long one'));
		expect(result.current.state).toBe('idle');
	});

	it('releases the media stream on unmount without transcribing', async () => {
		const { unmount } = await startRecording();

		unmount();

		expect(trackStop).toHaveBeenCalled();
		expect(transcribeMutate).not.toHaveBeenCalled();
	});
});
