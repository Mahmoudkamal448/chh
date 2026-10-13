(function () {
  "use strict";

  var STORAGE_KEY = "ufq-lang";
  var dict = window.UFQ_I18N || {};
  var nodes = document.querySelectorAll("[data-i18n]");

  // Arabic text is the HTML default: remember it so we can switch back.
  dict.ar = {};
  nodes.forEach(function (el) {
    dict.ar[el.getAttribute("data-i18n")] = el.textContent.trim();
  });

  var titles = {
    ar: "UFQ – United For Quality | الجودة وسلامة الغذاء",
    en: "UFQ – United For Quality | Quality & Food Safety"
  };

  function setLang(lang) {
    if (!dict[lang]) lang = "ar";
    var t = dict[lang];
    nodes.forEach(function (el) {
      var key = el.getAttribute("data-i18n");
      if (t[key] !== undefined) el.textContent = t[key];
    });
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";
    document.title = titles[lang];
    toggle.textContent = lang === "ar" ? "EN" : "عربي";
    try { localStorage.setItem(STORAGE_KEY, lang); } catch (e) { /* storage blocked */ }
  }

  var toggle = document.getElementById("lang-toggle");
  toggle.addEventListener("click", function () {
    setLang(document.documentElement.lang === "ar" ? "en" : "ar");
  });

  // Initial language: ?lang=en|ar  >  saved choice  >  Arabic
  var initial = new URLSearchParams(location.search).get("lang");
  if (!initial) {
    try { initial = localStorage.getItem(STORAGE_KEY); } catch (e) { initial = null; }
  }
  setLang(initial || "ar");

  // Mobile menu
  var menuBtn = document.getElementById("menu-toggle");
  var nav = document.getElementById("main-nav");
  menuBtn.addEventListener("click", function () {
    var open = nav.classList.toggle("open");
    menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  nav.addEventListener("click", function (e) {
    if (e.target.tagName === "A") {
      nav.classList.remove("open");
      menuBtn.setAttribute("aria-expanded", "false");
    }
  });

  // Highlight the nav link of the section on screen
  var links = nav.querySelectorAll("a");
  if ("IntersectionObserver" in window) {
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) {
          a.classList.toggle("active", a.getAttribute("href") === "#" + entry.target.id);
        });
      });
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("main section[id]").forEach(function (s) { observer.observe(s); });
  }

  document.getElementById("year").textContent = new Date().getFullYear();
})();
