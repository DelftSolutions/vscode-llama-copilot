/**
 * Persistent status bar item that surfaces onboarding/setup progress.
 * Visible only during downloading/starting/loading/error phases, then hidden —
 * so the state is always visible without cluttering the status bar afterwards.
 * Clicking the item reopens the setup wizard (llamaCopilot.onboarding).
 */

import * as vscode from 'vscode';

export class OnboardingStatusBar {
	private item: vscode.StatusBarItem | undefined;

	private ensure(): vscode.StatusBarItem {
		if (!this.item) {
			this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
			this.item.command = 'llamaCopilot.onboarding';
			this.item.tooltip = 'Llama Copilot setup — click to open the setup panel';
		}
		return this.item;
	}

	setDownloading(percent?: number): void {
		const item = this.ensure();
		item.text = `$(sync~spin) Downloading llama-server${percent !== undefined ? ` ${percent}%` : ''}`;
		item.show();
	}

	setStarting(): void {
		const item = this.ensure();
		item.text = '$(sync~spin) Starting your model';
		item.show();
	}

	setLoading(modelName: string): void {
		const item = this.ensure();
		item.text = `$(sync~spin) Loading ${modelName}`;
		item.show();
	}

	setError(): void {
		const item = this.ensure();
		item.text = '$(warning) Llama Copilot setup failed';
		item.show();
	}

	hide(): void {
		this.item?.hide();
	}

	dispose(): void {
		this.item?.dispose();
		this.item = undefined;
	}
}
