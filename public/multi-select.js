// ---------------------------------------------------------------------------
// Filtros con selección múltiple: convierte un <select data-multi> en un botón
// que abre una lista con casillas. Se pueden marcar varias opciones a la vez;
// sin ninguna marcada equivale a "Todas" (la opción vacía del <select>).
// El <select> original sigue existiendo (oculto, multiple) y guarda lo marcado:
// la suite lo lee con msVals() y escucha su "change" como siempre.
// Funciona con listas que se crean o se llenan después (se vigilan).
// ---------------------------------------------------------------------------
(function () {
  'use strict';
  var SIZE_RE = /^(?:sm:|md:|lg:)?(?:w-|min-w-|max-w-|flex-|grow|shrink|basis-)/;
  var isBlank = function (o) { return o.value === '' || o.value === '_ALL_'; };
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function enhance(sel) {
    if (sel.__ms) return;
    sel.__ms = true;
    sel.multiple = true;
    var classes = (sel.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    var wrap = document.createElement('div');
    wrap.className = 'relative ' + (classes.some(function (c) { return /^(?:sm:|md:|lg:)?w-full$/.test(c); }) ? 'block ' : 'inline-block align-middle ') + classes.filter(function (c) { return SIZE_RE.test(c); }).join(' ');
    sel.parentNode.insertBefore(wrap, sel);
    wrap.appendChild(sel);
    sel.style.display = 'none';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.className = classes.filter(function (c) { return !SIZE_RE.test(c) && c !== 'hidden'; }).join(' ') + ' w-full pr-7 text-left truncate';
    if (sel.title) btn.title = sel.title;
    var caret = document.createElement('span');
    caret.className = 'pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 text-[10px]';
    caret.innerHTML = '&#9662;';
    var panel = document.createElement('div');
    panel.className = 'hidden absolute left-0 z-[80] mt-1 min-w-full w-max max-w-[18rem] max-h-72 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg p-1 text-sm text-slate-800';
    panel.setAttribute('role', 'listbox');
    panel.setAttribute('aria-multiselectable', 'true');
    wrap.appendChild(btn); wrap.appendChild(caret); wrap.appendChild(panel);

    function blank() { for (var i = 0; i < sel.options.length; i++) if (isBlank(sel.options[i])) return sel.options[i]; return null; }
    function picked() { return [].filter.call(sel.options, function (o) { return o.selected && !isBlank(o); }); }
    function sync() {
      var b = blank(); if (b) b.selected = false;
      var p = picked();
      var all = b ? b.textContent.trim() : 'Todas';
      var txt = !p.length ? all : p.length === 1 ? p[0].textContent.trim() : p.map(function (o) { return o.textContent.trim(); }).join(', ');
      if (p.length > 1 && txt.length > 28) txt = p.length + ' ' + (sel.getAttribute('data-multi-unit') || 'seleccionadas');
      btn.textContent = txt;
      btn.title = (sel.title ? sel.title + ': ' : '') + (p.length ? p.map(function (o) { return o.textContent.trim(); }).join(', ') : all);
      btn.classList.toggle('font-semibold', p.length > 0);
      btn.disabled = sel.disabled;
      if (open) render();
    }
    function render() {
      var b = blank(), p = picked(), html = [];
      html.push('<label class="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-sky-50 font-semibold border-b border-slate-100 mb-1"><input type="checkbox" data-i="-1" class="w-4 h-4 accent-sky-600"' + (p.length ? '' : ' checked') + '> ' + esc(b ? b.textContent.trim() : 'Todas') + '</label>');
      for (var i = 0; i < sel.options.length; i++) {
        var o = sel.options[i];
        if (isBlank(o)) continue;
        html.push('<label class="flex items-center gap-2 px-2 py-1.5 rounded cursor-pointer hover:bg-sky-50 whitespace-nowrap"><input type="checkbox" data-i="' + i + '" class="w-4 h-4 accent-sky-600"' + (o.selected ? ' checked' : '') + (o.disabled ? ' disabled' : '') + '> ' + esc(o.textContent.trim() || '—') + '</label>');
      }
      if (html.length === 1) html.push('<div class="px-2 py-1.5 text-slate-400">Sin opciones</div>');
      panel.innerHTML = html.join('');
    }
    var open = false;
    function show() { if (sel.disabled) return; open = true; render(); panel.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }
    function hide() { open = false; panel.classList.add('hidden'); btn.setAttribute('aria-expanded', 'false'); }
    btn.addEventListener('click', function () { if (open) hide(); else show(); });
    panel.addEventListener('change', function (e) {
      var i = Number(e.target.getAttribute('data-i'));
      if (i === -1) { [].forEach.call(sel.options, function (o) { o.selected = false; }); }
      else if (sel.options[i]) sel.options[i].selected = e.target.checked;
      sync();
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    document.addEventListener('mousedown', function (e) { if (open && !wrap.contains(e.target)) hide(); });
    document.addEventListener('keydown', function (e) { if (open && e.key === 'Escape') { hide(); btn.focus(); } });

    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['disabled'] });
    sel.addEventListener('ms:sync', sync);
    sync();
  }

  function scan(root) { (root.querySelectorAll ? root.querySelectorAll('select[data-multi]') : []).forEach(enhance); if (root.matches && root.matches('select[data-multi]')) enhance(root); }
  function start() {
    scan(document);
    new MutationObserver(function (muts) { muts.forEach(function (m) { m.addedNodes.forEach(function (n) { if (n.nodeType === 1) scan(n); }); }); })
      .observe(document.body, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  // Lo marcado (sin la opción "Todas"). Vacío = todas.
  window.msVals = function (s) {
    s = typeof s === 'string' ? document.getElementById(s) : s;
    if (!s) return [];
    return [].filter.call(s.options, function (o) { return o.selected && !isBlank(o); }).map(function (o) { return o.value; });
  };
  // ¿El valor pasa el filtro? (sin nada marcado pasa todo)
  window.msHas = function (s, v) { var a = window.msVals(s); return !a.length || a.indexOf(String(v)) !== -1; };
  // Marca exactamente esos valores (los que ya no existan se ignoran).
  window.msSet = function (s, vals) {
    s = typeof s === 'string' ? document.getElementById(s) : s;
    if (!s) return [];
    var want = (vals || []).map(String);
    [].forEach.call(s.options, function (o) { o.selected = !isBlank(o) && want.indexOf(o.value) !== -1; });
    s.dispatchEvent(new Event('ms:sync'));
    return window.msVals(s);
  };
  // Vuelve a llenar las opciones conservando lo que estaba marcado.
  window.msFill = function (s, html) {
    s = typeof s === 'string' ? document.getElementById(s) : s;
    if (!s) return [];
    var prev = window.msVals(s);
    s.innerHTML = html;
    return window.msSet(s, prev);
  };
  window.enhanceMultiSelect = enhance;
})();
