// Light/dark theme. The page follows the system setting until the user
// clicks the header toggle; that choice is saved and wins from then on.
// Loaded in <head> so the saved theme applies before the first paint.

const THEME_STORAGE_KEY = 'srt_theme';
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

function savedTheme() {
    try {
        const theme = localStorage.getItem(THEME_STORAGE_KEY);
        return theme === 'light' || theme === 'dark' ? theme : null;
    } catch (e) {
        // Storage can be blocked (e.g. some privacy modes); fall back to the system theme.
        return null;
    }
}

// The user's saved choice, or null to follow the system.
let chosenTheme = savedTheme();

// data-theme is always set, so the stylesheet needs only one dark block and no
// prefers-color-scheme duplicate.
function applyTheme() {
    document.documentElement.dataset.theme = chosenTheme || (systemDark.matches ? 'dark' : 'light');
}

function currentTheme() {
    return document.documentElement.dataset.theme;
}

applyTheme();

document.addEventListener('DOMContentLoaded', () => {
    const button = document.getElementById('themeToggle');
    if (!button) return;

    function updateButton() {
        const next = currentTheme() === 'dark' ? 'light' : 'dark';
        button.dataset.next = next;
        button.setAttribute('aria-label', `Switch to ${next} theme`);
        button.title = `Switch to ${next} theme`;
    }

    button.addEventListener('click', () => {
        chosenTheme = currentTheme() === 'dark' ? 'light' : 'dark';
        applyTheme();
        try {
            localStorage.setItem(THEME_STORAGE_KEY, chosenTheme);
        } catch (e) {
            // Not saved; the switch still applies to this page.
        }
        updateButton();
    });
    systemDark.addEventListener('change', () => {
        if (chosenTheme) return;
        applyTheme();
        updateButton();
    });
    updateButton();
});
