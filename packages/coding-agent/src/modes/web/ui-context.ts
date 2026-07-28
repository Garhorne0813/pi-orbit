import * as crypto from "node:crypto";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import type { WsExtensionUIRequest, WsExtensionUIResponse } from "./types.ts";
import type { ConnectionManager } from "./ws/connection-manager.ts";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "type" | "id"> : never;
type ExtensionUIRequestPayload = WithoutEnvelope<WsExtensionUIRequest>;

export function createWebExtensionUIContext(
	sessionId: string,
	connectionManager: ConnectionManager,
): ExtensionUIContext {
	function send(request: WsExtensionUIRequest): boolean {
		return connectionManager.sendToSession(sessionId, request);
	}

	function createDialogPromise<T>(
		opts: ExtensionUIDialogOptions | undefined,
		defaultValue: T,
		request: ExtensionUIRequestPayload,
		acceptResponse: (response: WsExtensionUIResponse) => boolean,
		parseResponse: (response: WsExtensionUIResponse) => T,
	): Promise<T> {
		if (opts?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = crypto.randomUUID();
		return new Promise((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				opts?.signal?.removeEventListener("abort", onAbort);
				connectionManager.cancelUIRequest(sessionId, id);
			};
			const finish = (value: T) => {
				cleanup();
				resolve(value);
			};
			const onAbort = () => finish(defaultValue);
			opts?.signal?.addEventListener("abort", onAbort, { once: true });
			if (opts?.timeout) timeoutId = setTimeout(() => finish(defaultValue), opts.timeout);
			if (
				!connectionManager.registerUIRequest(sessionId, id, (response) => {
					if (!("cancelled" in response) && !acceptResponse(response)) return false;
					finish(parseResponse(response));
					return true;
				})
			) {
				finish(defaultValue);
				return;
			}
			if (!send({ type: "extension_ui_request", id, ...request } as WsExtensionUIRequest)) {
				finish(defaultValue);
			}
		});
	}

	return {
		select: (title, options, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "select", title, options, timeout: opts?.timeout },
				(response) => "value" in response,
				(response) => ("value" in response ? response.value : undefined),
			),
		confirm: (title, message, opts) =>
			createDialogPromise(
				opts,
				false,
				{ method: "confirm", title, message, timeout: opts?.timeout },
				(response) => "confirmed" in response,
				(response) => ("confirmed" in response ? response.confirmed : false),
			),
		input: (title, placeholder, opts) =>
			createDialogPromise(
				opts,
				undefined,
				{ method: "input", title, placeholder, timeout: opts?.timeout },
				(response) => "value" in response,
				(response) => ("value" in response ? response.value : undefined),
			),
		notify(message, type): void {
			send({ type: "extension_ui_request", id: crypto.randomUUID(), method: "notify", message, notifyType: type });
		},
		onTerminalInput(): () => void {
			return () => {};
		},
		setStatus(key, text): void {
			send({
				type: "extension_ui_request",
				id: crypto.randomUUID(),
				method: "setStatus",
				statusKey: key,
				statusText: text,
			});
		},
		setWorkingMessage(_message?: string): void {},
		setWorkingVisible(_visible: boolean): void {},
		setWorkingIndicator(_options?: WorkingIndicatorOptions): void {},
		setHiddenThinkingLabel(_label?: string): void {},
		setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
			if (content === undefined || (Array.isArray(content) && content.every((line) => typeof line === "string"))) {
				send({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setWidget",
					widgetKey: key,
					widgetLines: content as string[] | undefined,
					widgetPlacement: options?.placement,
				});
			}
		},
		setFooter(): void {},
		setHeader(): void {},
		setTitle(title): void {
			send({ type: "extension_ui_request", id: crypto.randomUUID(), method: "setTitle", title });
		},
		async custom<T>(): Promise<T> {
			return undefined as T;
		},
		pasteToEditor(text): void {
			this.setEditorText(text);
		},
		setEditorText(text): void {
			send({ type: "extension_ui_request", id: crypto.randomUUID(), method: "set_editor_text", text });
		},
		getEditorText(): string {
			return "";
		},
		editor: (title, prefill) =>
			createDialogPromise(
				undefined,
				undefined,
				{ method: "editor", title, prefill },
				(response) => "value" in response,
				(response) => ("value" in response ? response.value : undefined),
			),
		addAutocompleteProvider(): void {},
		setEditorComponent(): void {},
		getEditorComponent() {
			return undefined;
		},
		get theme() {
			return theme;
		},
		getAllThemes() {
			return [];
		},
		getTheme(_name: string) {
			return undefined;
		},
		setTheme(_theme: string | Theme) {
			return { success: false, error: "Theme switching not supported in web mode" };
		},
		getToolsExpanded() {
			return false;
		},
		setToolsExpanded(_expanded: boolean): void {},
	};
}
