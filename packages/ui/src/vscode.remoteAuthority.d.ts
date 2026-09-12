/**
 * Augment vscode.env with remoteAuthority from the resolvers proposed API.
 * Available at runtime in Remote SSH / Codespaces; typed here so we can
 * compile without enabling the full proposed API surface.
 */
import 'vscode';

declare module 'vscode' {
	export namespace env {
		/**
		 * The authority part of the current opened `vscode-remote://` URI.
		 * e.g. `ssh-remote+myserver`. Undefined when not connected to a remote.
		 */
		export const remoteAuthority: string | undefined;
	}
}
