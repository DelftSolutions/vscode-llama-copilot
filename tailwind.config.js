/** @type {import('tailwindcss').Config} */
module.exports = {
    // VS Code adds the `vscode-dark` class to <body> when the editor is in a
    // dark theme — use it instead of `prefers-color-scheme` (which follows the
    // OS, not the editor, and breaks when the two disagree).
    darkMode: ['class', '[class~="vscode-dark"]'],
    content: [
        'media/onboarding/index.html',
        'media/onboarding/wizard-controller.js',
        'media/models-manager/index.html',
        'media/models-manager/models-manager-controller.js',
    ],
    theme: {
        /**
         * The webview <style> blocks (media/onboarding/index.html etc.) do the
         * heavy lifting — most elements are styled with raw --vscode-* variables
         * and brand colors, not Tailwind utilities. The tokens below are the
         * only theme colors the generated CSS actually emits (bg-background on
         * the onboarding sidebar). Keep additions minimal: a token only earns
         * its place once a webview class uses it.
         */
        extend: {
            colors: {
                background: 'var(--vscode-editor-background, #1e1e1e)',
            },
        },
    },
    corePlugins: {
        // VS Code webviews supply their own base styles (body font, colors, etc.)
        // via inline CSS. Disabling preflight avoids Tailwind's CSS reset from
        // overriding VS Code's built-in styles.
        preflight: false,
    },
    plugins: [],
};
