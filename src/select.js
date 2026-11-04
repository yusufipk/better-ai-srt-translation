// Custom dropdown that replaces the browser's native <select> popup.
// The native <select> stays in the DOM as the source of truth: app.js keeps
// reading its .value and listening for its "change" event, and this widget
// only mirrors it. Follows the WAI-ARIA select-only combobox pattern.

let dropdownCount = 0;

function enhanceSelect(select) {
    const id = `dd${++dropdownCount}`;
    const labelEl = select.closest('.field')?.querySelector('.field-label');
    if (labelEl && !labelEl.id) labelEl.id = `${id}-label`;

    const root = document.createElement('div');
    root.className = 'dropdown';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'control dropdown-button';
    button.setAttribute('role', 'combobox');
    button.setAttribute('aria-haspopup', 'listbox');
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', `${id}-list`);
    if (labelEl) button.setAttribute('aria-labelledby', labelEl.id);

    const list = document.createElement('ul');
    list.className = 'dropdown-list';
    list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    if (labelEl) list.setAttribute('aria-labelledby', labelEl.id);

    let options = [];
    let activeIndex = -1;
    let typed = '';
    let typedTimer = null;

    function buildOptions() {
        list.replaceChildren();
        options = Array.from(select.options).map((opt, i) => {
            const li = document.createElement('li');
            li.id = `${id}-opt${i}`;
            li.className = 'dropdown-option';
            li.setAttribute('role', 'option');
            li.textContent = opt.textContent;
            li.dataset.value = opt.value;
            li.addEventListener('click', () => choose(i));
            li.addEventListener('mousemove', () => setActive(i, false));
            list.appendChild(li);
            return li;
        });
    }

    function sync() {
        const opt = select.options[select.selectedIndex];
        button.textContent = opt ? opt.textContent : '';
        options.forEach((li, i) => li.setAttribute('aria-selected', String(i === select.selectedIndex)));
    }

    function setActive(i, scroll = true) {
        if (!options.length) return;
        i = Math.max(0, Math.min(options.length - 1, i));
        if (i === activeIndex && !scroll) return;
        activeIndex = i;
        options.forEach((li, j) => li.classList.toggle('active', j === activeIndex));
        button.setAttribute('aria-activedescendant', options[activeIndex].id);
        if (scroll) options[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function open() {
        if (!list.hidden) return;
        list.hidden = false;
        root.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
        // Open upwards when the list does not fit below but does fit above.
        root.classList.remove('drop-up');
        const rect = button.getBoundingClientRect();
        const needed = list.offsetHeight + 8;
        root.classList.toggle('drop-up', window.innerHeight - rect.bottom < needed && rect.top >= needed);
        setActive(select.selectedIndex);
    }

    function close() {
        if (list.hidden) return;
        list.hidden = true;
        root.classList.remove('open');
        button.setAttribute('aria-expanded', 'false');
        button.removeAttribute('aria-activedescendant');
    }

    function choose(i) {
        close();
        button.focus();
        if (i === select.selectedIndex) return;
        select.selectedIndex = i;
        sync();
        select.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function typeAhead(char) {
        clearTimeout(typedTimer);
        typed += char.toLowerCase();
        typedTimer = setTimeout(() => { typed = ''; }, 600);
        const start = list.hidden ? select.selectedIndex : activeIndex;
        const order = options.map((_, k) => (start + 1 + k) % options.length);
        // A repeated single letter cycles through matches; longer input matches a prefix.
        const needle = typed.split('').every(c => c === typed[0]) ? typed[0] : typed;
        const match = order.find(k => options[k].textContent.toLowerCase().startsWith(needle));
        if (match === undefined) return;
        if (list.hidden) choose(match);
        else setActive(match);
    }

    // Some browsers (Safari, Firefox on macOS) do not focus a clicked button,
    // so focus it explicitly and close on any pointer press outside the widget.
    button.addEventListener('click', () => {
        button.focus();
        if (list.hidden) open();
        else close();
    });
    button.addEventListener('blur', close);
    // Pressing inside the list (options, padding, scrollbar) must not move
    // focus off the button, or blur would close the list mid-scroll.
    list.addEventListener('mousedown', (e) => e.preventDefault());
    document.addEventListener('pointerdown', (e) => {
        if (!root.contains(e.target)) close();
    });
    if (labelEl) {
        labelEl.addEventListener('click', () => button.focus());
    }
    button.addEventListener('keydown', (e) => {
        const isOpen = !list.hidden;
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                if (!isOpen) open();
                else setActive(activeIndex + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (!isOpen) open();
                else setActive(activeIndex - 1);
                break;
            case 'Home':
                if (isOpen) { e.preventDefault(); setActive(0); }
                break;
            case 'End':
                if (isOpen) { e.preventDefault(); setActive(options.length - 1); }
                break;
            case 'PageDown':
                if (isOpen) { e.preventDefault(); setActive(activeIndex + 8); }
                break;
            case 'PageUp':
                if (isOpen) { e.preventDefault(); setActive(activeIndex - 8); }
                break;
            case ' ':
                // While a type-ahead search is running, space is part of it.
                if (typed) {
                    e.preventDefault();
                    typeAhead(' ');
                    break;
                }
            // falls through
            case 'Enter':
                e.preventDefault();
                if (isOpen) choose(activeIndex);
                else open();
                break;
            case 'Escape':
                if (isOpen) { e.preventDefault(); close(); }
                break;
            case 'Tab':
                if (isOpen) choose(activeIndex);
                break;
            default:
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
                    e.preventDefault();
                    typeAhead(e.key);
                }
        }
    });

    // Keep the widget in step when app code changes the select.
    select.addEventListener('change', sync);

    select.classList.add('native-select');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    select.after(root);
    root.append(button, list);

    // An unknown saved value leaves nothing selected; fall back to the first option.
    if (select.selectedIndex === -1 && select.options.length) select.selectedIndex = 0;

    buildOptions();
    sync();

    return { sync, rebuild: () => { buildOptions(); sync(); } };
}
