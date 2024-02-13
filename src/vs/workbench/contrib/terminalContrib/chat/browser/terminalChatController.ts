/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from 'vs/base/common/lifecycle';
import { TerminalChatWidget } from 'vs/workbench/contrib/terminalContrib/chat/browser/terminalChatWidget';
import { ITerminalContribution, ITerminalInstance, ITerminalService, IXtermTerminal, isDetachedTerminalInstance } from 'vs/workbench/contrib/terminal/browser/terminal';
import { IDimension } from 'vs/base/browser/dom';
import { Lazy } from 'vs/base/common/lazy';
import { IConfigurationService } from 'vs/platform/configuration/common/configuration';
import { TerminalSettingId } from 'vs/platform/terminal/common/terminal';
import { TerminalWidgetManager } from 'vs/workbench/contrib/terminal/browser/widgets/widgetManager';
import { ITerminalProcessManager } from 'vs/workbench/contrib/terminal/common/terminal';
import type { Terminal as RawXtermTerminal } from '@xterm/xterm';
import { IInstantiationService } from 'vs/platform/instantiation/common/instantiation';
import { IChatAgentRequest, IChatAgentService } from 'vs/workbench/contrib/chat/common/chatAgents';
import { IChatProgress } from 'vs/workbench/contrib/chat/common/chatService';
import { generateUuid } from 'vs/base/common/uuid';
import { CancellationTokenSource } from 'vs/base/common/cancellation';
import { IChatRequestVariableValue } from 'vs/workbench/contrib/chat/common/chatVariables';
import { marked } from 'vs/base/common/marked/marked';
import { TerminalContextKeys } from 'vs/workbench/contrib/terminal/common/terminalContextKey';
import { IContextKey, IContextKeyService } from 'vs/platform/contextkey/common/contextkey';
import { IChatAccessibilityService } from 'vs/workbench/contrib/chat/browser/chat';
import { CTX_INLINE_CHAT_RESPONSE_TYPES, InlineChatResponseTypes } from 'vs/workbench/contrib/inlineChat/common/inlineChat';

export class TerminalChatController extends Disposable implements ITerminalContribution {
	static readonly ID = 'terminal.Chat';

	static get(instance: ITerminalInstance): TerminalChatController | null {
		return instance.getContribution<TerminalChatController>(TerminalChatController.ID);
	}
	/**
	 * Currently focused chat widget. This is used to track action context since
	 * 'active terminals' are only tracked for non-detached terminal instanecs.
	 */
	static activeChatWidget?: TerminalChatController;
	private _chatWidget: Lazy<TerminalChatWidget> | undefined;
	private _lastLayoutDimensions: IDimension | undefined;
	private _accessibilityRequestId: number = 0;
	get chatWidget(): TerminalChatWidget | undefined { return this._chatWidget?.value; }

	private readonly _ctxHasActiveRequest!: IContextKey<boolean>;
	private readonly _ctxHasTerminalAgent!: IContextKey<boolean>;
	private readonly _ctxLastResponseType!: IContextKey<undefined | InlineChatResponseTypes>;

	private _cancellationTokenSource!: CancellationTokenSource;

	constructor(
		private readonly _instance: ITerminalInstance,
		processManager: ITerminalProcessManager,
		widgetManager: TerminalWidgetManager,
		@IConfigurationService private _configurationService: IConfigurationService,
		@ITerminalService private readonly _terminalService: ITerminalService,
		@IInstantiationService private readonly _instantiationService: IInstantiationService,
		@IChatAgentService private readonly _chatAgentService: IChatAgentService,
		@IContextKeyService private readonly _contextKeyService: IContextKeyService,
		@IChatAccessibilityService private readonly _chatAccessibilityService: IChatAccessibilityService,
	) {
		super();
		if (!this._configurationService.getValue(TerminalSettingId.ExperimentalInlineChat)) {
			return;
		}
		this._ctxHasActiveRequest = TerminalContextKeys.chatRequestActive.bindTo(this._contextKeyService);
		this._ctxHasTerminalAgent = TerminalContextKeys.chatAgentRegistered.bindTo(this._contextKeyService);
		this._ctxLastResponseType = CTX_INLINE_CHAT_RESPONSE_TYPES.bindTo(this._contextKeyService);

		if (!this._chatAgentService.hasAgent('terminal')) {
			this._register(this._chatAgentService.onDidChangeAgents(() => {
				if (this._chatAgentService.getAgent('terminal')) {
					this._ctxHasTerminalAgent.set(true);
				}
			}));
		} else {
			this._ctxHasTerminalAgent.set(true);
		}
		this._cancellationTokenSource = new CancellationTokenSource();
	}

	layout(_xterm: IXtermTerminal & { raw: RawXtermTerminal }, dimension: IDimension): void {
		if (!this._configurationService.getValue(TerminalSettingId.ExperimentalInlineChat)) {
			return;
		}
		this._lastLayoutDimensions = dimension;
		this._chatWidget?.rawValue?.layout(dimension.width);
	}

	xtermReady(xterm: IXtermTerminal & { raw: RawXtermTerminal }): void {
		if (!this._configurationService.getValue(TerminalSettingId.ExperimentalInlineChat)) {
			return;
		}
		this._chatWidget = new Lazy(() => {
			const chatWidget = this._instantiationService.createInstance(TerminalChatWidget, this._instance.domElement!, this._instance);
			chatWidget.focusTracker.onDidFocus(() => {
				TerminalChatController.activeChatWidget = this;
				if (!isDetachedTerminalInstance(this._instance)) {
					this._terminalService.setActiveInstance(this._instance);
				}
			});
			chatWidget.focusTracker.onDidBlur(() => {
				TerminalChatController.activeChatWidget = undefined;
				this._instance.resetScrollbarVisibility();
			});
			if (!this._instance.domElement) {
				throw new Error('FindWidget expected terminal DOM to be initialized');
			}

			if (this._lastLayoutDimensions) {
				chatWidget.layout(this._lastLayoutDimensions.width);
			}

			return chatWidget;
		});
	}

	cancel(): void {
		this._cancellationTokenSource.cancel();
	}

	async acceptInput(): Promise<void> {
		let message = '';
		this._chatAccessibilityService.acceptRequest();
		this._ctxHasActiveRequest.set(true);
		const cancellationToken = this._cancellationTokenSource.token;
		const agentId = 'terminal';
		const progressCallback = (progress: IChatProgress) => {
			if (cancellationToken.isCancellationRequested) {
				return;
			}

			if (progress.kind === 'content' || progress.kind === 'markdownContent') {
				message += progress.content;
			}
			this._chatWidget?.rawValue?.updateProgress(progress);
		};
		const resolvedVariables: Record<string, IChatRequestVariableValue[]> = {};
		const requestId = generateUuid();
		const requestProps: IChatAgentRequest = {
			sessionId: generateUuid(),
			requestId,
			agentId,
			message: this._chatWidget?.rawValue?.input() || '',
			variables: resolvedVariables,
			variables2: { message: this._chatWidget?.rawValue?.input() || '', variables: [] }
		};
		this._chatWidget?.rawValue?.setValue();

		try {
			await this._chatAgentService.invokeAgent(agentId, requestProps, progressCallback, [], cancellationToken);
		} catch (e) {
			// Provider is not ready
			this._ctxHasActiveRequest.set(false);
			this._chatWidget?.rawValue?.updateProgress();
			return;
		}
		const codeBlock = marked.lexer(message).filter(token => token.type === 'code')?.[0]?.raw.replaceAll('```', '');
		this._accessibilityRequestId++;
		if (cancellationToken.isCancellationRequested) {
			return;
		}
		if (codeBlock) {
			// TODO: check the SR experience
			this._chatWidget?.rawValue?.renderTerminalCommand(codeBlock, this._accessibilityRequestId);
		} else {
			this._chatWidget?.rawValue?.renderMessage(message, this._accessibilityRequestId, requestId);
			this._ctxLastResponseType.set(InlineChatResponseTypes.OnlyMessages);
		}
		this._ctxHasActiveRequest.set(false);
		this._chatWidget?.rawValue?.updateProgress();
	}

	acceptCommand(): void {
		this._chatWidget?.rawValue?.acceptCommand();
	}

	reveal(): void {
		this._chatWidget?.rawValue?.reveal();
	}

	override dispose() {
		super.dispose();
		this._chatWidget?.rawValue?.dispose();
	}
}
