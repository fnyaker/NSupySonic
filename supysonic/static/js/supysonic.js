/*
 * This file is part of Supysonic.
 * Supysonic is a Python implementation of the Subsonic server API.
 *
 * Copyright (C) 2017-2024 Óscar García Amor
 *               2017-2024 Alban 'spl0k' Féron
 *
 * Distributed under terms of the GNU AGPLv3 license.
 */

const tooltipTriggerList = document.querySelectorAll('[data-bs-toggle="tooltip"]')
const tooltipList = [...tooltipTriggerList].map(tooltipTriggerEl => new bootstrap.Tooltip(tooltipTriggerEl))

/* Every state-changing endpoint is POST-only and CSRF-protected: submit a
 * throwaway form carrying the session token instead of navigating to a link.
 * (A plain <a href="/user/del/…"> was fireable from any page the admin
 * happened to visit.) Read-only links, such as the playlist export, keep
 * navigating normally. */
function csrfPost(url) {
  var meta = document.querySelector('meta[name="csrf-token"]');
  var form = document.createElement('form');
  form.method = 'post';
  form.action = url;
  var field = document.createElement('input');
  field.type = 'hidden';
  field.name = '_csrf';
  field.value = meta ? meta.getAttribute('content') : '';
  form.appendChild(field);
  document.body.appendChild(form);
  form.submit();
}

document.querySelectorAll('.modal').forEach(function (modal) {
  modal.addEventListener('show.bs.modal', function (e) {
    var href = e.relatedTarget.getAttribute('data-href');
    var post = e.relatedTarget.getAttribute('data-method') === 'post';
    var btnOk = modal.querySelector('.btn-ok');
    if (post) {
      btnOk.removeAttribute('href');
    } else {
      btnOk.setAttribute('href', href);
    }
    btnOk.addEventListener('click', function () {
      var modalInstance = bootstrap.Modal.getInstance(modal);
      modalInstance.hide();
      if (post) {
        csrfPost(href);
      }
    }, { once: true });
  });
});

document.querySelectorAll('a[data-method="post"]').forEach(function (link) {
  link.addEventListener('click', function (e) {
    e.preventDefault();
    csrfPost(link.getAttribute('href'));
  });
});

function setTheme(theme) {
  if (theme === 'auto') {
    const systemTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.body.setAttribute('data-bs-theme', systemTheme);
  } else {
    document.body.setAttribute('data-bs-theme', theme);
  }
}

const savedTheme = localStorage.getItem('theme') || 'light';
document.querySelector(`input[value="${savedTheme}"]`).checked = true;
setTheme(savedTheme);

document.querySelectorAll('input[name="theme"]').forEach(function (radio) {
  radio.addEventListener('change', function () {
    const selectedTheme = this.value;
    localStorage.setItem('theme', selectedTheme);
    setTheme(selectedTheme);
  });
});

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
  if (localStorage.getItem('theme') === 'auto') {
    setTheme('auto');
  }
});
