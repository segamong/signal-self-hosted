"use strict";

(() => {
  const API = "/manage/api";
  const state = { username: "", csrf: "", profiles: [], pools: [], status: null, selected: null, selectedPool: null, poolAction: null, revoking: null, busy: false, refreshQueued: false, filter: "", authenticated: false };
  const app = document.getElementById("app");
  const $ = (selector, scope = document) => scope.querySelector(selector);
  const icons = {
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M12 2.5 4 6v5.5c0 5 8 10 8 10s8-5 8-10V6l-8-3.5Z"/><path d="m8.5 12 2.5 2.5 4.5-5"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M5 12h14m-5-5 5 5-5 5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M10 5h4M11 18.5h2"/></svg>',
    windows: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21h8M12 16v5"/></svg>',
    other: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    profiles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="13" height="10" rx="2"/><path d="M7 18h4M9 14v4"/><rect x="16" y="10" width="5" height="11" rx="1.5"/></svg>',
    help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.7 9a2.4 2.4 0 0 1 4.6 1c0 1.8-2.3 1.8-2.3 3.8M12 17v.1"/></svg>',
    logout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4m6-13 5 5-5 5m-7-5h12"/></svg>',
    globe: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a17 17 0 0 1 0 18 17 17 0 0 1 0-18Z"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m5 12 4.5 4.5L19 7"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6 7a7 7 0 0 1 12-1l2 3M4 15l2 3a7 7 0 0 0 12-1"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>'
  };
  const brand = '<span class="brand-mark" aria-hidden="true">ϟ</span><span class="brand-word">signal<span>.</span></span>';

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  async function api(path, options = {}) {
    const headers = { Accept: "application/json", ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers };
    if (options.method && options.method !== "GET" && path !== "/login" && state.csrf) headers["X-CSRF-Token"] = state.csrf;
    let response;
    try { response = await fetch(API + path, { credentials: "same-origin", cache: "no-store", ...options, headers }); }
    catch { throw new ApiError("Нет связи с сервером. Проверьте подключение и попробуйте снова.", 0); }
    let data;
    try { data = await response.json(); }
    catch { throw new ApiError("Сервер вернул неожиданный ответ. Попробуйте снова.", response.status); }
    if (!response.ok) {
      if (response.status === 401 && path !== "/login") {
        state.authenticated = false;
        state.csrf = "";
        document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
        renderLogin("Сессия завершилась. Войдите ещё раз.");
      }
      const message = typeof data.error === "string" ? data.error : typeof data.message === "string" ? data.message : response.status === 401 ? "Неверное имя пользователя или пароль." : response.status === 429 ? "Слишком много попыток. Подождите немного и попробуйте снова." : "Не удалось выполнить действие. Попробуйте снова.";
      throw new ApiError(message, response.status);
    }
    return data;
  }

  function setError(element, message) {
    element.textContent = message || "";
    element.hidden = !message;
  }

  let toastTimer;
  function toast(message, error = false) {
    clearTimeout(toastTimer);
    const region = $("#toast-region");
    region.replaceChildren();
    const node = document.createElement("div");
    node.className = "toast" + (error ? " error" : "");
    if (!error) node.innerHTML = icons.check;
    const text = document.createElement("span");
    text.textContent = message;
    node.append(text);
    region.append(node);
    toastTimer = setTimeout(() => region.replaceChildren(), error ? 6500 : 3400);
  }

  function showDialog(id) {
    const dialog = document.getElementById(id);
    if (!dialog.open) dialog.showModal();
  }

  function buttonBusy(button, busy, label) {
    button.disabled = busy;
    button.replaceChildren();
    if (busy) {
      const spinner = document.createElement("span");
      spinner.className = "spinner";
      spinner.setAttribute("aria-hidden", "true");
      button.append(spinner);
    }
    button.append(document.createTextNode(label));
  }

  function renderLogin(message = "") {
    app.innerHTML = `<main class="login-shell"><section class="login-story"><a href="/manage/" class="brand" aria-label="Signal">${brand}</a><div class="login-story-main"><span class="eyebrow"><i class="tiny-dot"></i>ВАША ЛИЧНАЯ СЕТЬ</span><h1>Личный VPN.<br><span>Под вашим<br>контролем.</span></h1><p>Защищённые подключения для ваших устройств. Один сервер. Только ваш доступ.</p><div class="signal-visual" aria-hidden="true"><span class="signal-orbit"></span><span class="signal-core">${icons.shield}</span><i class="visual-node"></i><i class="visual-node two"></i></div></div><div class="login-story-footer"><span>${icons.lock}Шифрование TLS 1.3</span><span>${icons.globe}Ваш собственный сервер</span></div></section><section class="login-form-side"><form id="login-form" class="login-card"><span class="eyebrow">SIGNAL CONSOLE</span><h2>С возвращением</h2><p class="muted">Войдите, чтобы управлять подключениями<br>и добавлять новые устройства.</p><p id="login-error" class="form-error" role="alert" hidden></p><label for="username" class="field-label">Имя пользователя</label><input id="username" name="username" type="text" value="admin" required maxlength="100" autocomplete="username" autocapitalize="none" spellcheck="false"><label for="password" class="field-label">Пароль</label><div class="password-wrapper"><input id="password" name="password" type="password" required autocomplete="current-password"><button type="button" id="toggle-password" class="icon-button" aria-label="Показать пароль" aria-pressed="false">${icons.eye}</button></div><button id="login-submit" class="button button-primary button-full login-submit" type="submit">Войти в кабинет ${icons.arrow}</button><div class="login-footnote">${icons.shield}<span>Закрытый кабинет администратора.<br>Управление подключениями после входа.</span></div></form></section></main>`;
    setError($("#login-error"), message);
    $("#toggle-password").addEventListener("click", event => {
      const input = $("#password");
      const reveal = input.type === "password";
      input.type = reveal ? "text" : "password";
      event.currentTarget.setAttribute("aria-pressed", String(reveal));
      event.currentTarget.setAttribute("aria-label", reveal ? "Скрыть пароль" : "Показать пароль");
    });
    $("#login-form").addEventListener("submit", async event => {
      event.preventDefault();
      const button = $("#login-submit");
      buttonBusy(button, true, "Входим…");
      setError($("#login-error"), "");
      try {
        const session = await api("/login", { method: "POST", body: JSON.stringify({ username: $("#username").value.trim(), password: $("#password").value }) });
        $("#password").value = "";
        await enterDashboard(session);
      } catch (error) {
        if (!$("#login-error")) return;
        setError($("#login-error"), error.message);
        buttonBusy(button, false, "Войти в кабинет");
      }
    });
  }

  async function enterDashboard(session) {
    state.authenticated = true;
    state.csrf = session.csrf || "";
    state.username = session.username || "admin";
    state.filter = "";
    state.profiles = [];
    state.pools = [];
    state.status = null;
    renderDashboard();
    await refreshDashboard();
  }

  function renderDashboard() {
    app.innerHTML = `<div class="app-shell"><aside class="sidebar" aria-label="Навигация"><a class="brand" href="/manage/" aria-label="Signal">${brand}</a><div class="workspace-label">${icons.shield}<span>Личное пространство</span></div><span class="sidebar-label">УПРАВЛЕНИЕ</span><nav class="sidebar-nav"><a class="nav-item active" href="#connections" aria-current="page" title="Подключения">${icons.profiles}<span>Подключения</span></a><button class="nav-item help-button" type="button" title="Как подключиться">${icons.help}<span>Как подключиться</span></button></nav><div class="sidebar-bottom"><div class="privacy-card"><div class="privacy-icon">${icons.shield}</div><h3>Защита в каждом соединении</h3><p>Данные между устройством и сервером шифруются.<br>Сам IP виден провайдеру.</p></div><div class="account"><span class="avatar" id="account-avatar">A</span><span class="account-info"><span class="account-name" id="account-name"></span><span class="account-role">Администратор</span></span><button class="icon-button logout-button" type="button" title="Выйти" aria-label="Выйти из кабинета">${icons.logout}</button></div></div></aside><main class="main-area"><header class="topbar"><div class="breadcrumbs"><span>Личное пространство</span>${icons.chevron}<strong>Подключения</strong></div><a class="brand mobile-brand" href="/manage/" aria-label="Signal">${brand}</a><div class="topbar-right"><span class="topbar-badge checking" id="server-badge"><i class="tiny-dot"></i><span>Проверяем сервер</span></span><span class="topbar-divider"></span><button class="help-icon help-button" type="button" aria-label="Как подключиться">?</button><button class="icon-button logout-button mobile-logout" type="button" aria-label="Выйти из кабинета">${icons.logout}</button></div></header><div class="dashboard"><div class="page-heading"><div><span class="eyebrow">SIGNAL CONSOLE</span><h1>Всё начинается с подключения</h1><p>Ваш VPN и устройства — в одном пространстве.</p></div><button class="button button-primary open-create" type="button"><span class="plus" aria-hidden="true">+</span>Новое подключение</button></div><section class="hero" aria-labelledby="hero-title"><div class="hero-copy"><span class="hero-tag">${icons.shield}ЗАЩИЩЁННЫЙ ТРАФИК</span><h2 id="hero-title">Ваша сеть.<br>Ваши правила.</h2><p>Создавайте отдельный доступ для каждого устройства.<br>Шифрование работает при каждом подключении.</p><div class="hero-tech"><span>TLS 1.3</span><span>HTTPS</span><span>Личный сервер</span></div></div><div class="hero-illustration" aria-hidden="true"><div class="shield-visual"><svg viewBox="0 0 100 113" fill="none"><defs><linearGradient id="shield-grad" x1="15" y1="0" x2="89" y2="112" gradientUnits="userSpaceOnUse"><stop stop-color="#a98be6"/><stop offset="1" stop-color="#4a396d"/></linearGradient><linearGradient id="shield-inner" x1="20" y1="0" x2="88" y2="110" gradientUnits="userSpaceOnUse"><stop stop-color="#62477c"/><stop offset="1" stop-color="#332544"/></linearGradient></defs><path d="m50 3 43 18v32c0 30-43 56-43 56S7 83 7 53V21L50 3Z" fill="url(#shield-grad)"/><path d="m50 10 36 15v28c0 24-36 48-36 48S14 77 14 53V25l36-15Z" fill="url(#shield-inner)" stroke="#c9a8ff" stroke-opacity=".25"/><path d="M50 12v86" stroke="#c9a8ff" stroke-opacity=".12"/></svg><span class="shield-check">${icons.check}</span></div><i class="hero-spark"></i><i class="hero-spark two"></i></div></section><p id="dashboard-error" class="form-error page-error" role="alert" hidden></p><section class="metrics" aria-label="Состояние VPN"><article class="metric"><div class="metric-heading"><span>Основной IP сервера</span>${icons.globe}</div><div class="metric-value ip" id="entry-ip">—</div><p class="metric-caption" id="entry-host">Загружаем сведения</p></article><article class="metric"><div class="metric-heading"><span>Подключения</span>${icons.profiles}</div><div class="metric-value"><span id="active-count">—</span><span class="unit">активных</span></div><p class="metric-caption">Отдельный доступ для каждого устройства</p></article><article class="metric"><div class="metric-heading"><span>Шифрование трафика</span>${icons.lock}</div><div class="metric-value">Включено</div><p class="metric-caption positive">${icons.check}Включено в каждом профиле</p></article></section><section id="connections" aria-labelledby="connections-title"><div class="section-heading"><div class="section-heading-main"><h2 id="connections-title">Мои подключения</h2><span class="count-badge" id="profile-count">—</span></div><div class="section-tools"><label class="search-box">${icons.search}<input id="profile-search" type="text" aria-label="Поиск подключений" placeholder="Найти устройство" autocomplete="off"></label><button id="refresh-profiles" class="icon-button refresh-button" type="button" aria-label="Обновить подключения" title="Обновить">${icons.refresh}</button></div></div><div class="profiles-panel"><div id="profiles-content"><div class="data-loading"><span class="spinner" aria-hidden="true"></span>Загружаем подключения…</div></div><div class="panel-footer">${icons.lock}<span>Управляйте профилями после входа. Делитесь доступом по ссылкам подключения или подписки.</span></div></div></section><footer class="dashboard-footer"><span class="footer-protocol">${icons.shield}VLESS · XHTTP · TLS 1.3</span><span>Signal · Личная сеть</span></footer></div></main></div>`;
    $("#account-name").textContent = state.username;
    $("#account-avatar").textContent = state.username.slice(0, 1).toUpperCase();
    document.querySelectorAll(".open-create").forEach(button => button.addEventListener("click", openCreate));
    document.querySelectorAll(".help-button").forEach(button => button.addEventListener("click", () => showDialog("help-dialog")));
    document.querySelectorAll(".logout-button").forEach(button => button.addEventListener("click", logout));
    $("#refresh-profiles").addEventListener("click", refreshDashboard);
    $("#profile-search").addEventListener("input", event => { state.filter = event.target.value; renderProfiles(); });
    const poolNav = document.createElement("a");
    poolNav.className = "nav-item";
    poolNav.href = "#pools";
    poolNav.title = "Пулы профилей";
    poolNav.innerHTML = icons.other + "<span>Пулы профилей</span>";
    $(".sidebar-nav").insertBefore(poolNav, $(".sidebar-nav .help-button"));
    const poolSection = document.createElement("section");
    poolSection.id = "pools";
    poolSection.className = "pools-section";
    poolSection.setAttribute("aria-labelledby", "pools-title");
    poolSection.innerHTML = `<div class="section-heading"><div class="section-heading-main"><h2 id="pools-title">Пулы профилей</h2><span class="count-badge" id="pool-count">—</span></div><button id="open-pool-create" class="button button-secondary" type="button"><span class="plus" aria-hidden="true">+</span>Создать пул</button></div><p class="section-description">Соберите несколько профилей в одну подписку. Добавляйте её в VPN-клиент по одному QR-коду или ссылке.</p><div class="profiles-panel"><div id="pools-content"><div class="data-loading"><span class="spinner" aria-hidden="true"></span>Загружаем пулы…</div></div><div class="panel-footer">${icons.lock}<span>Каждая ссылка подписки даёт доступ к выбранным профилям.</span></div></div>`;
    $(".dashboard").insertBefore(poolSection, $(".dashboard-footer"));
    $("#open-pool-create").addEventListener("click", openPoolCreate);
  }

  async function refreshDashboard() {
    if (!state.authenticated) return;
    if (state.busy) { state.refreshQueued = true; return; }
    state.busy = true;
    const refresh = $("#refresh-profiles");
    if (refresh) { refresh.classList.add("loading"); refresh.disabled = true; }
    const results = await Promise.allSettled([api("/status"), api("/profiles"), api("/pools")]);
    state.busy = false;
    if (!state.authenticated || !$("#profiles-content")) return;
    if (refresh) { refresh.classList.remove("loading"); refresh.disabled = false; }
    const errors = [];
    if (results[0].status === "fulfilled") { state.status = results[0].value; renderStatus(); }
    else { errors.push(results[0].reason.message); renderServerUnknown(); }
    if (results[1].status === "fulfilled") {
      state.profiles = Array.isArray(results[1].value.profiles) ? results[1].value.profiles : [];
      renderProfiles();
    } else {
      errors.push(results[1].reason.message);
      if (!state.profiles.length) {
        $("#profiles-content").innerHTML = '<div class="load-error"><h3>Не удалось загрузить подключения</h3><p></p><button type="button" class="button button-secondary">Попробовать снова</button></div>';
        $("#profiles-content .load-error p").textContent = results[1].reason.message;
        $("#profiles-content .load-error button").addEventListener("click", refreshDashboard);
      }
    }
    if (results[2].status === "fulfilled") {
      state.pools = Array.isArray(results[2].value.pools) ? results[2].value.pools : [];
      renderPools();
    } else {
      errors.push(results[2].reason.message);
      if (!state.pools.length) $("#pools-content").innerHTML = '<div class="no-results">Не удалось загрузить пулы. Попробуйте обновить подключения.</div>';
    }
    setError($("#dashboard-error"), errors.length ? [...new Set(errors)].join(" ") : "");
    if (state.refreshQueued) { state.refreshQueued = false; await refreshDashboard(); }
  }

  function renderServerUnknown() {
    const badge = $("#server-badge");
    if (!badge) return;
    badge.className = "topbar-badge checking";
    badge.querySelector("span").textContent = "Связь не проверена";
  }

  function renderStatus() {
    const status = state.status;
    const badge = $("#server-badge");
    const online = status.online === true;
    badge.className = "topbar-badge" + (online ? "" : " offline");
    badge.querySelector("span").textContent = online ? "Сервер работает" : "Сервер недоступен";
    $("#entry-ip").textContent = status.entryIp || "—";
    $("#entry-host").textContent = status.entryHost || "Основной адрес подключения";
    const protocols = Array.isArray(status.protocols) ? status.protocols.filter(protocol => ["vless", "trojan", "vmess","vless-reality","amneziawg"].includes(protocol)) : ["vless"];
    const footer = $(".footer-protocol");
    if (footer) {
      footer.innerHTML = icons.shield;
      footer.append(document.createTextNode((protocols.length ? protocols : ["vless"]).map(protocolLabel).join(" / ")));
    }
  }

  const deviceLabel = device => ({ windows: "Windows", android: "Android", other: "Другое устройство" }[device] || "Устройство");
  const deviceIcon = device => device === "windows" ? icons.windows : device === "android" ? icons.phone : icons.other;
  const configurationLabel = configuration => ({ auto: "Автовыбор", "packet-up": "Пакетная отправка", "stream-up": "Потоковая отправка",tcp:"TCP 443",udp:"UDP 443 · MTU 1280" }[configuration] || "Пакетная отправка");
  const fingerprintLabel = fingerprint => fingerprint === 'none' ? '' : fingerprint === "firefox" ? "Firefox" : "Chrome";
  const protocolLabel = protocol => ({ vless: "VLESS", trojan: "Trojan", vmess: "VMess AEAD",'vless-reality':'VLESS + REALITY',amneziawg:'AmneziaWG 3.1' }[protocol] || "VLESS");
  const protocolHelp = protocol => ({
    vless: "Основной вариант для актуальных клиентов с поддержкой XHTTP.",
    trojan: "Альтернативный протокол для совместимых клиентов. Как и VLESS, использует XHTTP и HTTPS с TLS 1.3.",
    vmess: "Вариант для клиентов с поддержкой VMess AEAD и XHTTP. Включите на устройстве автоматическую синхронизацию времени.",
    'vless-reality':"Для V2RayTun: TCP 443, REALITY и XTLS Vision. Отдельный вариант для проверки мобильной сети T2; устойчивость нужно подтвердить на телефоне.",
    amneziawg:"Для клиента AmneziaWG с поддержкой 3.1: UDP 443, MTU 1280 и keepalive 25. Поддержка этого .conf в V2RayTun зависит от версии."
  }[protocol] || "Основной вариант для актуальных клиентов с поддержкой XHTTP.");

  function updateCreateProtocol() {
    const protocol = $("#profile-protocol").value;
    $("#profile-protocol-help").textContent = protocolHelp(protocol);
    const advanced = ['vless-reality','amneziawg'].includes(protocol);
    $("#profile-configuration").disabled = advanced;
    $("#profile-configuration").hidden = advanced;
    $('label[for="profile-configuration"]').hidden=advanced;
    $("#xhttp-help").hidden=advanced;
    $("#profile-fingerprint").disabled = protocol==='amneziawg';
    $(".advanced-settings").hidden=protocol==='amneziawg';
    $("#create-protocol-caption").textContent = protocol==='amneziawg' ? 'AmneziaWG 3.1 · ChaCha20-Poly1305' : protocol==='vless-reality' ? 'REALITY · XTLS Vision · TCP 443' : protocolLabel(protocol) + " · XHTTP · TLS 1.3";
  }

  function renderProfiles() {
    if (!$("#profiles-content")) return;
    const active = state.profiles.filter(profile => profile.active !== false);
    $("#active-count").textContent = String(active.length);
    $("#profile-count").textContent = String(state.profiles.length);
    const content = $("#profiles-content");
    const query = state.filter.trim().toLocaleLowerCase("ru");
    const profiles = state.profiles.filter(profile => (String(profile.name || "") + " " + deviceLabel(profile.device) + " " + protocolLabel(profile.protocol)).toLocaleLowerCase("ru").includes(query));
    if (!state.profiles.length) {
      content.innerHTML = `<div class="empty-state"><div class="empty-icon">${icons.profiles}</div><h3>Ваше первое подключение</h3><p>Добавьте телефон или компьютер. Signal создаст профиль с шифрованием трафика для этого устройства.</p><button class="button button-primary open-create" type="button"><span class="plus" aria-hidden="true">+</span>Добавить устройство</button></div>`;
      $(".open-create", content).addEventListener("click", openCreate);
      return;
    }
    if (!profiles.length) { content.innerHTML = '<div class="no-results">Подключений с таким названием нет.</div>'; return; }
    content.innerHTML = '<table class="profiles-table"><thead><tr><th scope="col">Устройство</th><th scope="col">Статус</th><th scope="col">Создано</th><th scope="col">Управление</th></tr></thead><tbody></tbody></table>';
    const body = $("tbody", content);
    for (const profile of profiles) {
      const row = document.createElement("tr");
      row.innerHTML = `<td><div class="profile-cell"><span class="device-icon">${deviceIcon(profile.device)}</span><div class="profile-title"><strong></strong><small></small></div></div></td><td><span class="status-badge"><i></i><span></span></span></td><td><time class="profile-date"></time></td><td><div class="profile-actions"><button class="button profile-open-button" type="button">Открыть ${icons.arrow}</button><button class="icon-button revoke-button" type="button" title="Отключить подключение" aria-label="Отключить подключение">${icons.trash}</button></div></td>`;
      $(".device-icon", row).classList.add(profile.device === "windows" ? "windows" : profile.device === "android" ? "android" : "other");
      $(".profile-title strong", row).textContent = profile.name || "Без названия";
      $(".profile-title small", row).textContent = deviceLabel(profile.device) + (profile.legacy ? " · Ранее создано" : "");
      const configuration = document.createElement("small");
      configuration.className = "profile-configuration";
      configuration.textContent = protocolLabel(profile.protocol) + " · " + configurationLabel(profile.configuration) + " · " + fingerprintLabel(profile.fingerprint);
      $(".profile-title", row).append(configuration);
      const isActive = profile.active !== false;
      $(".status-badge", row).classList.toggle("inactive", !isActive);
      $(".status-badge span", row).textContent = isActive ? "Активен" : "Отключён";
      const date = new Date(profile.createdAt || NaN);
      const time = $("time", row);
      if (Number.isNaN(date.getTime())) time.textContent = "—";
      else { time.dateTime = date.toISOString(); time.textContent = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", year: "numeric" }).format(date); }
      const open = $(".profile-open-button", row);
      open.disabled = !isActive;
      open.addEventListener("click", () => openProfile(profile.id, open));
      const revoke = $(".revoke-button", row);
      revoke.disabled = !isActive;
      revoke.setAttribute("aria-label", "Отключить " + (profile.name || "подключение"));
      revoke.addEventListener("click", () => openRevoke(profile));
      body.append(row);
    }
  }

  function openCreate() {
    const form = $("#create-form");
    form.reset();
    updateCreateProtocol();
    setError($("#create-error"), "");
    showDialog("create-dialog");
    $("#profile-name").focus();
  }

  async function openProfile(id, button) {
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    try {
      const data = await api("/profiles/" + encodeURIComponent(id));
      showProfile(data.profile || data);
    } catch (error) { if (state.authenticated) toast(error.message, true); }
    finally { if (button) { button.disabled = false; button.removeAttribute("aria-busy"); } }
  }

  function showProfile(profile) {
    const native=profile?.protocol==='amneziawg';
    if (!profile || (native ? typeof profile.configText!=='string' : typeof profile.uri!=="string" || !/^(vless|trojan|vmess):\/\//.test(profile.uri))) { toast("Профиль недоступен.",true);return; }
    state.selected = profile;
    $("#detail-name").textContent = profile.name || "Подключение";
    $("#detail-device").textContent = deviceLabel(profile.device);
    $("#detail-configuration").textContent = [protocolLabel(profile.protocol),configurationLabel(profile.configuration),fingerprintLabel(profile.fingerprint),profile.security || 'TLS1.3'].filter(Boolean).join(' · ');
    $("#detail-client-help").textContent=profile.clientHint || 'Импортируйте ссылку или JSON в клиент с поддержкой XHTTP.';
    $("#profile-dialog .connection-address > span").textContent=native ? 'Конфигурация AmneziaWG' : 'Ссылка подключения';
    $("#copy-inline").setAttribute('aria-label',native ? 'Скопировать конфиг' : 'Скопировать ссылку');
    $("#profile-format-help").textContent=native ? 'Импортируйте .conf в клиент AmneziaWG с поддержкой 3.1. ' : profile.protocol==='vless-reality' ? 'Импортируйте ссылку или QR в V2RayTun с поддержкой REALITY. ' : 'Импортируйте ссылку или файл в клиент с поддержкой XHTTP. ';
    $("#profile-link").textContent = native ? profile.configText : profile.uri;
    $("#profile-link").classList.toggle('native-config',native);
    $("#copy-profile").textContent=native ? 'Скопировать конфиг' : 'Скопировать ссылку';
    $("#download-link").textContent=native ? 'Скачать .conf' : 'Скачать .txt';
    $("#download-json").hidden=native;
    $("#download-json").disabled = !profile.clientConfig;
    renderQr($("#profile-qr"), native ? profile.configText : profile.uri, "QR-код подключения " + (profile.name || "Signal"));
    showDialog("profile-dialog");
  }

  function renderQr(qrContainer, value, label) {
    qrContainer.replaceChildren();
    try {
      if (typeof window.qrcode !== "function") throw new Error("QR library unavailable");
      const qr = window.qrcode(0, "M");
      qr.addData(value);
      qr.make();
      const svg = new DOMParser().parseFromString(qr.createSvgTag({ scalable: true, margin: 2 }), "image/svg+xml").documentElement;
      if (svg.localName !== "svg") throw new Error("Invalid QR image");
      svg.setAttribute("role", "img");
      svg.setAttribute("aria-label", label);
      qrContainer.append(document.importNode(svg, true));
    } catch {
      const fallback = document.createElement("p");
      fallback.className = "qr-error";
      fallback.textContent = "QR-код недоступен. Используйте ссылку подключения ниже.";
      qrContainer.append(fallback);
    }
  }

  function openRevoke(profile) {
    state.revoking = profile;
    $("#revoke-name").textContent = profile.name || "Без названия";
    setError($("#revoke-error"), "");
    buttonBusy($("#revoke-submit"), false, "Отключить");
    showDialog("revoke-dialog");
  }

  async function copyProfile() {
    if (!state.selected) return;
    try {
      await navigator.clipboard.writeText(state.selected.configText || state.selected.uri);
      toast(state.selected.protocol==='amneziawg' ? 'Конфиг скопирован. Импортируйте его в AmneziaWG 3.1.' : 'Ссылка скопирована. Импортируйте её в VPN-клиент.');
    } catch { toast("Не удалось скопировать. Выделите ссылку вручную или скачайте файл.", true); }
  }

  function downloadProfile(asJson) {
    const profile = state.selected;
    if (!profile) return;
    let content;
    if (asJson) {
      if (!profile.clientConfig) { toast("JSON для этого профиля недоступен.", true); return; }
      if (typeof profile.clientConfig === "string") {
        try { content = JSON.stringify(JSON.parse(profile.clientConfig), null, 2); }
        catch { toast("Сервер вернул некорректный JSON-профиль.", true); return; }
      } else content = JSON.stringify(profile.clientConfig, null, 2);
    } else content = profile.configText || profile.uri + "\n";
    const filename = (profile.name || "Signal").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80).replace(/[. ]+$/g, "") || "Signal";
    const blob = new Blob([content], { type: asJson ? "application/json;charset=utf-8" : "text/plain;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = href;
    link.download = filename + (profile.protocol==='amneziawg' ? '.conf' : asJson ? ".json" : ".txt");
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function renderPools() {
    const content = $("#pools-content");
    if (!content) return;
    $("#pool-count").textContent = String(state.pools.filter(pool => pool.active !== false).length);
    if (!state.pools.length) {
      content.innerHTML = `<div class="empty-state pool-empty"><div class="empty-icon">${icons.other}</div><h3>Все нужные профили — в одном QR</h3><p>Выберите активные подключения и создайте общую подписку для своего VPN-клиента.</p><button class="button button-secondary" type="button">Создать первый пул</button></div>`;
      $("button", content).addEventListener("click", openPoolCreate);
      return;
    }
    content.replaceChildren();
    for (const pool of state.pools) {
      const row = document.createElement("article");
      row.className = "pool-row";
      row.innerHTML = `<span class="device-icon other">${icons.other}</span><div class="pool-row-title"><strong></strong><small></small></div><span class="status-badge"><i></i><span></span></span><div class="pool-row-actions"><button class="button profile-open-button" type="button">Открыть ${icons.arrow}</button><button class="icon-button revoke-button" type="button" title="Отозвать ссылку пула">${icons.trash}</button></div>`;
      $("strong", row).textContent = pool.name || "Без названия";
      const count = Number.isInteger(pool.activeProfilesCount) ? pool.activeProfilesCount : (pool.profileIds || []).filter(id => state.profiles.some(profile => profile.id === id && profile.active !== false)).length;
      $("small", row).textContent = count + " активных из " + (pool.profileIds || []).length + " профилей";
      const active = pool.active !== false;
      $(".status-badge", row).classList.toggle("inactive", !active);
      $(".status-badge span", row).textContent = active ? "Ссылка активна" : "Ссылка отозвана";
      $(".profile-open-button", row).addEventListener("click", event => openPool(pool.id, event.currentTarget));
      const revoke = $(".revoke-button", row);
      revoke.disabled = !active;
      revoke.setAttribute("aria-label", "Отозвать ссылку пула " + (pool.name || "Без названия"));
      revoke.addEventListener("click", () => { state.selectedPool = pool; openPoolConfirm("revoke"); });
      content.append(row);
    }
  }

  function openPoolCreate() {
    $("#pool-create-form").reset();
    setError($("#pool-create-error"), "");
    const options = $("#pool-profile-options");
    options.replaceChildren();
    const active = state.profiles.filter(profile => profile.active !== false);
    $("#pool-create-submit").disabled = !active.length;
    if (!active.length) {
      const message = document.createElement("p");
      message.className = "field-help";
      message.textContent = "Сначала создайте хотя бы одно подключение.";
      options.append(message);
    }
    for (const profile of active) {
      const label = document.createElement("label");
      label.className = "pool-profile-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.name = "profileIds";
      checkbox.value = profile.id;
      const description = document.createElement("span");
      const name = document.createElement("strong");
      name.textContent = profile.name || "Без названия";
      const detail = document.createElement("small");
      detail.textContent = deviceLabel(profile.device) + " · " + protocolLabel(profile.protocol) + " · " + configurationLabel(profile.configuration);
      description.append(name, detail);
      label.append(checkbox, description);
      options.append(label);
    }
    showDialog("pool-create-dialog");
    $("#pool-name").focus();
  }

  async function openPool(id, button) {
    if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); }
    try {
      const data = await api("/pools/" + encodeURIComponent(id));
      showPool(data.pool);
    } catch (error) { if (state.authenticated) toast(error.message, true); }
    finally { if (button) { button.disabled = false; button.removeAttribute("aria-busy"); } }
  }

  function showPool(pool) {
    if (!pool || typeof pool.id !== "string") { toast("Не удалось открыть пул профилей.", true); return; }
    state.selectedPool = pool;
    $("#pool-detail-name").textContent = pool.name || "Общая подписка";
    const address=pool.qrUrl || pool.subscriptionUrl || pool.bundleUrl;
    const active = pool.active !== false && typeof address === "string" && /^https?:\/\//.test(address);
    $("#pool-detail-status").classList.toggle("inactive", !active);
    $("#pool-detail-status span").textContent = active ? "Ссылка активна" : "Ссылка отозвана";
    const ids = Array.isArray(pool.profileIds) ? pool.profileIds : [];
    const activeCount = Number.isInteger(pool.activeProfilesCount) ? pool.activeProfilesCount : ids.filter(id => state.profiles.some(profile => profile.id === id && profile.active !== false)).length;
    $("#pool-detail-count").textContent = "Активных профилей: " + activeCount;
    $("#pool-subscription-content").hidden = !active;
    $("#pool-link").textContent = active ? address : "";
    $("#pool-dialog .connection-address > span").textContent=pool.hasNativeProfiles ? 'Ссылка набора' : 'Ссылка подписки';
    $("#copy-pool-inline").setAttribute('aria-label',pool.hasNativeProfiles ? 'Скопировать ссылку набора' : 'Скопировать ссылку подписки');
    $("#pool-qr").replaceChildren();
    if (active) renderQr($("#pool-qr"), address, "QR-код набора " + (pool.name || "Signal"));
    const xrayUrl=pool.hasNativeProfiles && active && typeof pool.subscriptionUrl==='string' && /^https?:\/\//.test(pool.subscriptionUrl) ? pool.subscriptionUrl : null;
    $("#pool-xray-subscription").hidden=!xrayUrl;
    $("#pool-xray-qr").replaceChildren();
    if (xrayUrl) renderQr($("#pool-xray-qr"),xrayUrl,"QR подписки для V2RayTun");
    $("#copy-pool").textContent=pool.hasNativeProfiles ? 'Скопировать ссылку набора' : 'Скопировать ссылку подписки';
    $("#pool-qr-help").textContent=pool.hasNativeProfiles ? 'Откройте камерой телефона страницу набора' : 'Добавьте как подписку в совместимом VPN-клиенте';
    $("#pool-import-help").textContent=pool.hasNativeProfiles ? 'QR открывает набор файлов: REALITY — для V2RayTun, AmneziaWG — для клиента с поддержкой 3.1. На странице также доступен ZIP со всеми конфигами.' : 'Импортируйте ссылку как подписку в VPN-клиенте и обновите её для загрузки профилей.';
    $("#revoke-pool").disabled = !active;
    setError($("#pool-detail-error"), active && !activeCount ? "В пуле не осталось активных профилей. Подписка не вернёт конфиги." : "");
    const members = $("#pool-members");
    members.replaceChildren();
    const caption = document.createElement("h3");
    caption.textContent = "Профили пула";
    members.append(caption);
    for (const id of ids) {
      const profile = state.profiles.find(item => item.id === id);
      const item = document.createElement("p");
      item.textContent = profile ? (profile.name || "Без названия") + " · " + protocolLabel(profile.protocol) + " · " + (profile.active !== false ? configurationLabel(profile.configuration) : "Отключён") : "Отключённый профиль";
      members.append(item);
    }
    showDialog("pool-dialog");
  }

  async function copyPool() {
    const pool = state.selectedPool;
    if (!(pool?.qrUrl || pool?.subscriptionUrl || pool?.bundleUrl) || pool.active === false) return;
    try {
      await navigator.clipboard.writeText(pool.qrUrl || pool.subscriptionUrl || pool.bundleUrl);
      toast(pool.hasNativeProfiles ? 'Ссылка набора скопирована. Откройте её в браузере.' : 'Ссылка подписки скопирована. Добавьте её в VPN-клиент.');
    } catch { toast("Не удалось скопировать. Выделите ссылку вручную или скачайте файл.", true); }
  }

  function openPoolConfirm(action) {
    if (!state.selectedPool || state.selectedPool.active === false) return;
    state.poolAction = action;
    const rotating = action === "rotate";
    $("#pool-confirm-title").textContent = rotating ? "Заменить ссылку пула?" : "Отозвать ссылку пула?";
    $("#pool-confirm-description").textContent = rotating ? "Старая ссылка и QR-код перестанут загружать подписку. Для обновлений добавьте новую ссылку в клиенты. Уже импортированные VPN-профили продолжат работать." : "Ссылка и QR-код перестанут загружать подписку. Уже импортированные конфиги продолжат работать. Для отключения VPN-доступа отзовите сами профили.";
    setError($("#pool-confirm-error"), "");
    buttonBusy($("#pool-confirm-submit"), false, rotating ? "Заменить ссылку" : "Отозвать ссылку");
    showDialog("pool-confirm-dialog");
  }

  async function logout(event) {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await api("/logout", { method: "POST", body: "{}" });
      state.authenticated = false;
      state.csrf = "";
      state.selected = null;
      state.profiles = [];
      state.pools = [];
      state.selectedPool = null;
      document.querySelectorAll("dialog[open]").forEach(dialog => dialog.close());
      renderLogin();
    } catch (error) { button.disabled = false; if (state.authenticated) toast(error.message, true); }
  }

  $("#create-form").addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("#profile-name").value.trim();
    if (!name) { setError($("#create-error"), "Укажите название устройства."); $("#profile-name").focus(); return; }
    const device = $('input[name="device"]:checked', event.currentTarget).value;
    const configuration = $("#profile-configuration").value;
    const fingerprint = $("#profile-fingerprint").value;
    const protocol = $("#profile-protocol").value;
    const button = $("#create-submit");
    buttonBusy(button, true, "Создаём подключение…");
    setError($("#create-error"), "");
    try {
      const data = await api("/profiles", { method: "POST", body: JSON.stringify({ name, device, protocol, configuration, fingerprint }) });
      $("#create-dialog").close();
      const profile = data.profile || data;
      showProfile(profile);
      toast("Подключение создано. Добавьте его в VPN-клиент.");
      await refreshDashboard();
    } catch (error) { if (state.authenticated) setError($("#create-error"), error.message); }
    finally { buttonBusy(button, false, "Создать подключение"); }
  });

  $("#profile-protocol").addEventListener("change", updateCreateProtocol);

  $("#revoke-submit").addEventListener("click", async event => {
    if (!state.revoking) return;
    const button = event.currentTarget;
    const id = state.revoking.id;
    buttonBusy(button, true, "Отключаем…");
    setError($("#revoke-error"), "");
    try {
      await api("/profiles/" + encodeURIComponent(id), { method: "DELETE", body: "{}" });
      $("#revoke-dialog").close();
      if (state.selected?.id === id) { $("#profile-dialog").close(); state.selected = null; }
      state.profiles = state.profiles.filter(profile => profile.id !== id);
      renderProfiles();
      toast("Доступ устройства отключён.");
      state.revoking = null;
      await refreshDashboard();
    } catch (error) { if (state.authenticated) setError($("#revoke-error"), error.message); }
    finally { buttonBusy(button, false, "Отключить"); }
  });

  $("#copy-profile").addEventListener("click", copyProfile);
  $("#pool-create-form").addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("#pool-name").value.trim();
    const profileIds = [...event.currentTarget.querySelectorAll('input[name="profileIds"]:checked')].map(input => input.value);
    if (!name || !profileIds.length) { setError($("#pool-create-error"), !name ? "Укажите название пула." : "Выберите хотя бы один профиль."); return; }
    const button = $("#pool-create-submit");
    buttonBusy(button, true, "Создаём пул…");
    setError($("#pool-create-error"), "");
    try {
      const data = await api("/pools", { method: "POST", body: JSON.stringify({ name, profileIds }) });
      $("#pool-create-dialog").close();
      showPool(data.pool);
      toast("Пул создан. Импортируйте подписку в VPN-клиент.");
      await refreshDashboard();
    } catch (error) { if (state.authenticated) setError($("#pool-create-error"), error.message); }
    finally { buttonBusy(button, false, "Создать пул и QR-код"); }
  });
  $("#copy-pool").addEventListener("click", copyPool);
  $("#copy-pool-inline").addEventListener("click", copyPool);
  $("#download-pool").addEventListener("click", () => {
    const pool = state.selectedPool;
    if (!(pool?.qrUrl || pool?.subscriptionUrl || pool?.bundleUrl) || pool.active === false) return;
    const name = (pool.name || "Signal-pool").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80).replace(/[. ]+$/g, "") || "Signal-pool";
    const href = URL.createObjectURL(new Blob([(pool.qrUrl || pool.subscriptionUrl || pool.bundleUrl) + "\n"], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = href;
    link.download = name + "-subscription.txt";
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  });
  $("#rotate-pool").addEventListener("click", () => openPoolConfirm("rotate"));
  $("#revoke-pool").addEventListener("click", () => openPoolConfirm("revoke"));
  $("#pool-confirm-submit").addEventListener("click", async event => {
    if (!state.selectedPool || !state.poolAction) return;
    const id = state.selectedPool.id;
    const rotating = state.poolAction === "rotate";
    const button = event.currentTarget;
    buttonBusy(button, true, rotating ? "Заменяем…" : "Отзываем…");
    setError($("#pool-confirm-error"), "");
    try {
      const data = await api("/pools/" + encodeURIComponent(id) + (rotating ? "/rotate" : ""), { method: rotating ? "POST" : "DELETE", body: "{}" });
      $("#pool-confirm-dialog").close();
      if (rotating) showPool(data.pool);
      else if ($("#pool-dialog").open) showPool({ ...state.selectedPool, active: false, subscriptionUrl: null });
      state.poolAction = null;
      toast(rotating ? "Ссылка заменена. Добавьте новую подписку в клиенты." : "Ссылка пула отозвана. VPN-профили продолжают работать.");
      await refreshDashboard();
    } catch (error) { if (state.authenticated) setError($("#pool-confirm-error"), error.message); }
    finally { buttonBusy(button, false, rotating ? "Заменить ссылку" : "Отозвать ссылку"); }
  });
  $("#copy-inline").addEventListener("click", copyProfile);
  $("#copy-pool-xray").addEventListener("click", async () => {
    const url=state.selectedPool?.subscriptionUrl;
    if (!url || state.selectedPool.active===false) return;
    try { await navigator.clipboard.writeText(url); toast('Подписка скопирована. Добавьте её в V2RayTun.'); }
    catch { toast('Не удалось скопировать подписку.',true); }
  });
  $("#download-link").addEventListener("click", () => downloadProfile(false));
  $("#download-json").addEventListener("click", () => downloadProfile(true));
  $("#detail-help-button").addEventListener("click", () => showDialog("help-dialog"));
  document.querySelectorAll(".close-dialog").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  document.querySelectorAll("dialog").forEach(dialog => {
    dialog.addEventListener("click", event => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  });
  $("#profile-dialog").addEventListener("close", () => { state.selected = null; $("#profile-link").textContent = ""; $("#profile-qr").replaceChildren(); });
  $("#pool-dialog").addEventListener("close", () => { state.selectedPool = null; $("#pool-link").textContent = ""; $("#pool-qr").replaceChildren(); $("#pool-xray-qr").replaceChildren(); });

  async function boot() {
    try {
      const session = await api("/session");
      if (session.authenticated) await enterDashboard(session);
      else renderLogin();
    } catch (error) { renderLogin(error.message); }
  }

  boot();
})();
