/**
 * Platform-to-asset mapping for llama.cpp GitHub Releases.
 * Pure mapping from process.platform + process.arch to release asset name components.
 */

export interface PlatformAsset {
	/** Suffix in the asset filename (e.g. 'macos-arm64', 'win-vulkan-x64') */
	suffix: string;
	/** Archive file extension (e.g. '.tar.gz', '.zip') */
	ext: string;
}

const PLATFORM_MAP: Record<string, Record<string, PlatformAsset>> = {
	darwin: {
		arm64: { suffix: 'macos-arm64', ext: '.tar.gz' },
	},
	win32: {
		x64: { suffix: 'win-vulkan-x64', ext: '.zip' },
	},
	linux: {
		x64: { suffix: 'ubuntu-vulkan-x64', ext: '.tar.gz' },
		arm64: { suffix: 'ubuntu-vulkan-arm64', ext: '.tar.gz' },
	},
};

/**
 * Get platform asset info for the current OS/arch.
 * Throws with a user-friendly message on unsupported platforms.
 */
export function getPlatformAsset(): PlatformAsset {
	const platformEntries = PLATFORM_MAP[process.platform];
	if (platformEntries) {
		const asset = platformEntries[process.arch];
		if (asset) {
			return asset;
		}
	}
	throw new Error(
		`Managed llama-server is not available for your platform (${process.platform}/${process.arch}). ` +
		`You can still use the extension by running llama-server yourself and configuring an endpoint in Settings → Llama Copilot → Endpoints.`
	);
}

/**
 * Build the full asset filename for a given build number.
 * Example: getAssetFilename('5000') => 'llama-b5000-bin-ubuntu-vulkan-x64.tar.gz'
 */
export function getAssetFilename(buildNumber: string): string {
	const { suffix, ext } = getPlatformAsset();
	return `llama-b${buildNumber}-bin-${suffix}${ext}`;
}

/**
 * Check if the current platform is supported for managed mode.
 */
export function isSupportedPlatform(): boolean {
	const platformEntries = PLATFORM_MAP[process.platform];
	if (!platformEntries) return false;
	return process.arch in platformEntries;
}

/**
 * Get the llama-server binary name for the current platform.
 */
export function getServerBinaryName(): string {
	return process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
}

/**
 * Get the llama-cli binary name for the current platform.
 */
export function getCliBinaryName(): string {
	return process.platform === 'win32' ? 'llama-cli.exe' : 'llama-cli';
}
