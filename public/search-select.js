// ---------------------------------------------------------------------------
// Listas con buscador: convierte un <select data-search> en un cuadro de texto
// donde se escribe para filtrar (sin importar tildes ni mayúsculas) y se borra
// con la "x". El <select> original sigue existiendo (oculto) y es el que guarda
// el valor: el resto de la suite lo lee y escucha su "change" como siempre.
// Funciona también con listas que se crean o se llenan después (se vigilan).
// ---------------------------------------------------------------------------
(function () {
  'use strict';
  var norm = function (t) { return String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); };
  var VALUE = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var INDEX = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
  var SIZE_RE = /^(?:sm:|md:|lg:)?(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-)/;

  function enhance(sel) {
    if (sel.__ss || sel.multiple) return;
    sel.__ss = true;
    var classes = (sel.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    var wrap = document.createElement('div');
    wrap.className = 'relative ' + (classes.some(function (c) { return /^(?:sm:|md:|lg:)?w-full$/.test(c); }) ? 'block ' : 'inline-block align-middle ') + classes.filter(function (c) { return SIZE_RE.test(c); }).join(' ');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.style.display = 'none';

    var inp = document.createElement('input');
    inp.type = 'text';
    inp.autocomplete = 'off';
    inp.spellcheck = false;
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.className = classes.filter(function (c) { return !SIZE_RE.test(c) && c !== 'hidden'; }).join(' ') + ' w-full pr-7';
    if (sel.title) inp.title = sel.title;
    var clear = document.createElement('button');
    clear.type = 'button';
    clear.tabIndex = -1;
    clear.setAttribute('aria-label', 'Borrar');
    clear.className = 'absolute right-1.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100 text-xs leading-none hidden';
    clear.textContent = '✕';
    var list = document.createElement('div');
    list.className = 'hidden absolute left-0 right-0 z-[80] mt-1 max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg text-sm text-slate-800';
    list.setAttribute('role', 'listbox');
    wrap.appendChild(inp); wrap.appendChild(clear); wrap.appendChild(list);

    var items = [], active = -1, open = false;
    function blankOption() { for (var i = 0; i < sel.options.length; i++) if (sel.options[i].value === '') return sel.options[i]; return null; }
    function sync() {
      var o = sel.options[INDEX.get.call(sel)];
      var blank = blankOption();
      inp.placeholder = (blank ? blank.textContent.trim() : '') || 'Escribe para buscar…';
      if (!open) inp.value = o && o.value !== '' ? o.textContent.trim() : '';
      clear.classList.toggle('hidden', !(o && o.value !== '') || sel.disabled);
      inp.disabled = sel.disabled;
    }
    function render(q) {
      var nq = norm(q).trim();
      var html = [], idx = 0;
      items = [];
      var lastGroup = null;
      for (var i = 0; i < sel.options.length; i++) {
        var o = sel.options[i];
        if (o.disabled && o.value === '') continue;
        if (nq && o.value === '') continue; // "Todos…" solo aparece con el cuadro vacío
        var txt = o.textContent.trim();
        if (nq && norm(txt).indexOf(nq) === -1) continue;
        var g = o.parentNode && o.parentNode.tagName === 'OPTGROUP' ? o.parentNode.label : null;
        if (g && g !== lastGroup) html.push('<div class="px-3 pt-2 pb-1 text-[11px] font-bold uppercase text-slate-400">' + esc(g) + '</div>');
        lastGroup = g;
        items.push(o);
        html.push('<div role="option" data-i="' + idx + '" class="px-3 py-1.5 cursor-pointer ' + (o.selected && o.value !== '' ? 'font-semibold text-sky-700 ' : '') + (o.disabled ? 'text-slate-300 cursor-not-allowed' : 'hover:bg-sky-50') + '">' + esc(txt || '—') + '</div>');
        idx++;
      }
      list.innerHTML = html.join('') || '<div class="px-3 py-2 text-slate-400">Sin resultados</div>';
      active = -1;
    }
    function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function show() { if (sel.disabled) return; open = true; render(inp.value === currentText() ? '' : inp.value); list.classList.remove('hidden'); }
    function hide() { open = false; list.classList.add('hidden'); sync(); }
    function currentText() { var o = sel.options[INDEX.get.call(sel)]; return o && o.value !== '' ? o.textContent.trim() : ''; }
    function choose(o) {
      if (!o || o.disabled) return;
      var changed = VALUE.get.call(sel) !== o.value;
      VALUE.set.call(sel, o.value);
      open = false; list.classList.add('hidden'); sync();
      if (changed) sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    function mark(i) {
      var nodes = list.querySelectorAll('[role="option"]');
      if (!nodes.length) return;
      active = Math.max(0, Math.min(nodes.length - 1, i));
      nodes.forEach(function (n, k) { n.classList.toggle('bg-sky-100', k === active); });
      nodes[active].scrollIntoView({ block: 'nearest' });
    }

    inp.addEventListener('focus', function () { inp.select(); show(); });
    inp.addEventListener('click', function () { if (!open) show(); });
    inp.addEventListener('input', function () { open = true; render(inp.value); list.classList.remove('hidden'); clear.classList.toggle('hidden', !inp.value); });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) show(); mark(active + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); mark(active - 1); }
      else if (e.key === 'Enter') { if (open) { e.preventDefault(); choose(items[active >= 0 ? active : 0]); } }
      else if (e.key === 'Escape') { hide(); inp.blur(); }
    });
    inp.addEventListener('blur', function () { setTimeout(function () { if (document.activeElement !== inp) hide(); }, 150); });
    list.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var n = e.target.closest('[role="option"]');
      if (n) choose(items[Number(n.dataset.i)]);
    });
    clear.addEventListener('mousedown', function (e) {
      e.preventDefault();
      var blank = blankOption();
      if (blank) choose(blank);
      else { inp.value = ''; inp.focus(); show(); }
    });

    // El resto de la suite cambia el valor o vuelve a llenar la lista: se refleja en el cuadro.
    Object.defineProperty(sel, 'value', { configurable: true, get: function () { return VALUE.get.call(this); }, set: function (v) { VALUE.set.call(this, v); sync(); } });
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get: function () { return INDEX.get.call(this); }, set: function (v) { INDEX.set.call(this, v); sync(); } });
    new MutationObserver(function () { sync(); if (open) render(inp.value); }).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    sel.addEventListener('change', sync);
    sync();
  }

  function scan(root) { (root.querySelectorAll ? root.querySelectorAll('select[data-search]') : []).forEach(enhance); if (root.matches && root.matches('select[data-search]')) enhance(root); }
  function start() {
    scan(document);
    new MutationObserver(function (muts) { muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); }); }); })
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.enhanceSearchSelect = enhance;
})();
