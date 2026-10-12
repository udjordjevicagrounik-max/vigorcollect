/* global window, document, URLSearchParams */
// Wireframe helpers (vanilla, no build): empty-state variant, today's date, wizard steps.
(function () {
  var params = new URLSearchParams(window.location.search);
  var empty = params.get('empty') === '1';
  if (empty) document.body.classList.add('is-empty');

  // Toggle link between the data and the empty-state variant.
  var toggle = document.getElementById('wf-toggle');
  if (toggle) {
    toggle.href = window.location.pathname + (empty ? '' : '?empty=1');
    toggle.textContent = empty ? 'Prikaži sa podacima' : 'Prikaži prazno stanje (?empty=1)';
  }

  // Today in sr-Latn (Intl, rule 25) — demo dates are relative to today, like the seed.
  document.querySelectorAll('[data-today]').forEach(function (el) {
    el.textContent = new Intl.DateTimeFormat('sr-Latn', { dateStyle: 'full' }).format(new Date());
  });
  document.querySelectorAll('[data-days]').forEach(function (el) {
    var d = new Date();
    d.setDate(d.getDate() + Number(el.getAttribute('data-days')));
    el.textContent = new Intl.DateTimeFormat('sr-Latn', { dateStyle: 'medium' }).format(d);
  });

  // Wizard: show the step named in the hash (#korak-1 … #korak-4).
  var steps = document.querySelectorAll('.step');
  if (steps.length) {
    var show = function () {
      var id = window.location.hash.replace('#', '') || steps[0].id;
      var index = 0;
      steps.forEach(function (s, i) {
        s.classList.toggle('active', s.id === id);
        if (s.id === id) index = i;
      });
      document.querySelectorAll('.steps li').forEach(function (li, i) {
        li.classList.toggle('done', i < index);
        if (i === index) li.setAttribute('aria-current', 'step');
        else li.removeAttribute('aria-current');
      });
    };
    window.addEventListener('hashchange', show);
    show();
  }
})();
