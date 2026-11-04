// Editable combobox: a text input that keeps free typing and adds a
// filterable suggestion list under it, styled like the dropdown in select.js.
// The input stays the source of truth; picking a suggestion writes its text
// into the input and fires a normal "input" event. Follows the WAI-ARIA
// editable combobox with list autocomplete pattern.

let comboboxCount = 0;
// Rendering thousands of rows would make typing lag; the filter narrows it.
const COMBOBOX_MAX_ROWS = 300;

function enhanceCombobox(input, { onOpen } = {}) {
    const id = `cb${++comboboxCount}`;

    const root = document.createElement('div');
    root.className = 'dropdown combobox';

    const list = document.createElement('ul');
    list.className = 'dropdown-list';
    list.id = `${id}-list`;
    list.setAttribute('role', 'listbox');
    list.hidden = true;
    const labelEl = input.closest('.field')?.querySelector('.field-label');
    if (labelEl) {
        if (!labelEl.id) labelEl.id = `${id}-label`;
        list.setAttribute('aria-labelledby', labelEl.id);
    }

    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', list.id);
    input.autocomplete = 'off';

    let items = [];
    let status = '';
    let rows = [];
    let activeIndex = -1;
    // Until the user types, an open list shows every item, not just the
    // ones matching the value already in the field.
    let filtering = false;

    function render() {
        list.replaceChildren();
        const needle = filtering ? input.value.trim().toLowerCase() : '';
        const matches = needle ? items.filter(item => item.toLowerCase().includes(needle)) : items;
        rows = matches.slice(0, COMBOBOX_MAX_ROWS).map((item, i) => {
            const li = document.createElement('li');
            li.id = `${id}-opt${i}`;
            li.className = 'dropdown-option';
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', String(item === input.value.trim()));
            li.textContent = item;
            li.addEventListener('click', () => choose(item));
            li.addEventListener('mousemove', () => setActive(i, false));
            list.appendChild(li);
            return li;
        });
        let note = status;
        if (!note && items.length && !matches.length) note = 'No matching model. The typed name is used as is.';
        if (!note && matches.length > rows.length) note = `${matches.length - rows.length} more, type to narrow down`;
        if (note) {
            const li = document.createElement('li');
            li.className = 'dropdown-status';
            li.setAttribute('role', 'presentation');
            li.textContent = note;
            list.appendChild(li);
        }
        activeIndex = -1;
        input.removeAttribute('aria-activedescendant');
        // Nothing to show: keep the list closed instead of an empty box.
        if (!rows.length && !note) close();
    }

    function setActive(i, scroll = true) {
        if (!rows.length) return;
        i = Math.max(0, Math.min(rows.length - 1, i));
        activeIndex = i;
        rows.forEach((li, j) => li.classList.toggle('active', j === activeIndex));
        input.setAttribute('aria-activedescendant', rows[activeIndex].id);
        if (scroll) rows[activeIndex].scrollIntoView({ block: 'nearest' });
    }

    function open() {
        if (!list.hidden) return;
        filtering = false;
        if (onOpen) onOpen();
        render();
        if (!rows.length && !list.querySelector('.dropdown-status')) return;
        list.hidden = false;
        root.classList.add('open');
        input.setAttribute('aria-expanded', 'true');
        place();
        highlightCurrent();
    }

    // Open upwards when the list does not fit below but does fit above.
    function place() {
        root.classList.remove('drop-up');
        const rect = input.getBoundingClientRect();
        const needed = list.offsetHeight + 8;
        root.classList.toggle('drop-up', window.innerHeight - rect.bottom < needed && rect.top >= needed);
    }

    function highlightCurrent() {
        const current = rows.findIndex(li => li.textContent === input.value.trim());
        if (current >= 0) setActive(current);
    }

    function close() {
        if (list.hidden) return;
        list.hidden = true;
        root.classList.remove('open');
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    }

    function choose(item) {
        close();
        input.focus();
        if (input.value === item) return;
        input.value = item;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    }

    input.addEventListener('click', () => {
        if (list.hidden) open();
        else close();
    });
    input.addEventListener('input', (e) => {
        // choose() fires an input event too; that one must not reopen the list.
        if (!e.isTrusted) return;
        if (list.hidden) open();
        filtering = true;
        render();
    });
    input.addEventListener('blur', close);
    list.addEventListener('mousedown', (e) => e.preventDefault());
    input.addEventListener('keydown', (e) => {
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
            case 'Enter':
                if (isOpen && activeIndex >= 0) {
                    e.preventDefault();
                    choose(rows[activeIndex].textContent);
                }
                break;
            case 'Escape':
                if (isOpen) { e.preventDefault(); close(); }
                break;
        }
    });

    input.after(root);
    root.append(input, list);

    // Items often arrive after the list opened on "Loading models...", so
    // size, direction and the highlighted row are worked out again.
    function refresh() {
        if (list.hidden) return;
        render();
        if (list.hidden) return;
        place();
        if (!filtering) highlightCurrent();
    }

    return {
        setItems(next) { items = next; status = ''; refresh(); },
        setStatus(text) { items = []; status = text; refresh(); },
        close
    };
}
