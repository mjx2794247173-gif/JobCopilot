// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

  // 详情页可能由后台直接打开，manifest 尚未完成 selectors.js 注入。
  // 使用脚本内兜底，避免因注入时序出现 SELECTORS is not defined。
  const SELECTORS = globalThis.SELECTORS || {
    jobs: {
      jobCard: 'li.job-card-box',
      jobName: '.job-name',
      jobSalary: '.job-salary',
      tagList: '.tag-list li',
      immediateChatBtn: 'a.op-btn-chat'
    }
  };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  function getCards() { return Array.from(document.querySelectorAll(SELECTORS.jobs.jobCard)); }

  function getScrollContainers() {
    const selectors = [
      '.job-list-container', '.job-list-box', '.job-list',
      '.search-job-list', '[class*="job-list"]', '[class*="job-scroll"]'
    ];
    const found = [];
    for (const selector of selectors) {
      for (const el of document.querySelectorAll(selector)) {
        if (el.scrollHeight > el.clientHeight + 20 && !found.includes(el)) found.push(el);
      }
    }
    return found;
  }

  function cardSignature() {
    return getCards().map(card => parseCard(card).id).filter(Boolean).join('|');
  }

  function findNextPageButton() {
    const selectors = [
      '.options-pages a:last-child', '.page a.next', '.pagination .next',
      '[class*="pagination"] [class*="next"]', '[class*="page"] [class*="next"]'
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.offsetParent !== null && !/disabled|disable/.test(el.className || '')) return el;
    }
    return Array.from(document.querySelectorAll('a, button')).find(el => {
      const text = (el.textContent || '').trim();
      const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '')).toLowerCase();
      return (text === '下一页' || text === '下页' || text === '>' || /next|下一页/.test(label))
        && el.offsetParent !== null && !el.disabled && !/disabled|disable/.test(el.className || '');
    }) || null;
  }

  async function loadMoreJobs() {
    const before = cardSignature();
    const cards = getCards();
    const lastCard = cards[cards.length - 1];
    if (lastCard) lastCard.scrollIntoView({ block: 'end', behavior: 'auto' });
    const containers = getScrollContainers();
    if (containers.length) {
      // 虚拟列表必须分段滚动；直接跳到底会漏掉中间批次。
      for (const el of containers) {
        const step = Math.max(500, Math.floor(el.clientHeight * 0.8));
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    }
    // BOSS 不同版本可能监听内部列表或页面滚动；两者都触发以兼容。
    window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.8)));
    window.dispatchEvent(new Event('scroll', { bubbles: true }));
    await sleep(1200);
    return cardSignature() !== before;
  }

  async function goNextPage() {
    const next = findNextPageButton();
    if (!next) return false;
    const before = cardSignature();
    next.click();
    await sleep(2200);
    window.scrollTo(0, 0);
    for (const el of getScrollContainers()) el.scrollTop = 0;
    await sleep(800);
    return cardSignature() !== before;
  }

  function parseCard(card, baseUrl) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    // BOSS 虚拟列表偶尔会先创建空的 .job-salary 再填内容；优先取带薪资文本的节点。
    const salaryNodes = Array.from(card.querySelectorAll('.job-salary, [class*="salary"], [class*="pay"]'));
    const salEl = salaryNodes.find(el => /(?:\d+(?:\.\d+)?\s*(?:k|K|万)|面议|面谈)/.test(el.textContent || ''))
      || card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const rawLink = linkEl ? (linkEl.getAttribute('href') || linkEl.href || '') : '';
    let link = '';
    try { link = rawLink ? new URL(rawLink, baseUrl || location.origin).href : ''; } catch (e) { link = rawLink; }
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const companyEl = card.querySelector('.company-name a, .company-name, [class*="company-name"], .boss-info .company-name, .company-info a, [class*="company"] a');
    const companyText = companyEl ? companyEl.textContent.trim() : '';
    const id = (m && m[1]) || link || (
      (nameEl ? nameEl.textContent.trim() : '') + '|' + companyText + '|' + (salEl ? salEl.textContent.trim() : '')
    );
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    let company = '';
    if (companyEl) company = companyText;
    return {
      id: id,
      name: nameEl ? nameEl.textContent.trim() : '未知岗位',
      salary: salEl ? salEl.textContent.trim() : '',
      tags: tags,
      company: company,
      link: link
    };
  }

  function salaryFloorK(text) {
    const s = (text || '').replace(/,/g, '').toLowerCase();
    if (!s || /面议|面谈|不限/.test(s)) return null;
    const nums = s.match(/\d+(?:\.\d+)?/g);
    if (!nums || !nums.length) return null;
    const value = Number(nums[0]);
    if (!Number.isFinite(value)) return null;
    return /万/.test(s) ? value * 10 : value;
  }

  async function captureJD(card) {
    card.scrollIntoView({ block: 'center' });
    card.click();
    await sleep(900);
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    let jd = det ? (det.innerText || '').trim() : '';
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => (s.innerText || '').trim()).filter(Boolean).join('\n');
    }
    return jd.slice(0, 3000);
  }

  function addCards(cards, baseUrl, minSalary, seen, jobs, count) {
    let added = 0;
    for (const card of cards) {
      const job = parseCard(card, baseUrl);
      const floor = salaryFloorK(job.salary);
      const salaryOk = !minSalary || floor === null || floor >= minSalary;
      if (job.id && salaryOk && !seen[job.id]) {
        seen[job.id] = true;
        jobs.push(job);
        added++;
        if (jobs.length >= count) break;
      }
    }
    return added;
  }

  async function fetchSearchPage(page) {
    const url = new URL(location.href);
    url.pathname = '/web/geek/jobs';
    url.searchParams.set('page', String(page));
    const response = await fetch(url.href, {
      method: 'GET',
      credentials: 'include',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!response.ok) throw new Error('搜索请求失败 ' + response.status);
    const html = await response.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { cards: Array.from(doc.querySelectorAll(SELECTORS.jobs.jobCard)), url: url.href };
  }

  async function scrape(count, minSalary) {
    const seen = {};
    const jobs = [];
    addCards(getCards(), location.href, minSalary, seen, jobs, count);
    chrome.runtime.sendMessage({ type: 'PROGRESS', cur: jobs.length, total: count, label: '收集' }).catch(() => {});

    // 不操作当前页面，静默请求后续搜索结果并合并；用户界面不会逐页跳转。
    let emptyPages = 0;
    const maxPages = Math.min(50, Math.max(2, Math.ceil(count / 10) + 5));
    for (let page = 2; page <= maxPages && jobs.length < count; page++) {
      try {
        const result = await fetchSearchPage(page);
        const added = addCards(result.cards, result.url, minSalary, seen, jobs, count);
        chrome.runtime.sendMessage({ type: 'PROGRESS', cur: jobs.length, total: count, label: '收集' }).catch(() => {});
        emptyPages = added ? 0 : emptyPages + 1;
        if (emptyPages >= 3) break;
      } catch (e) {
        emptyPages++;
        if (emptyPages >= 3) throw e;
      }
      await sleep(350 + Math.random() * 350);
    }
    return jobs.slice(0, count);
  }

  // 单页快照由后台逐页调用。不要在这个消息处理期间点击分页，
  // 否则页面导航会销毁 content script，导致消息通道提前关闭。
  function scrapePage(minSalary) {
    const jobs = [];
    const seen = {};
    for (const card of getCards()) {
      const job = parseCard(card);
      const floor = salaryFloorK(job.salary);
      const salaryOk = !minSalary || floor === null || floor >= minSalary;
      if (job.id && salaryOk && !seen[job.id]) {
        seen[job.id] = true;
        jobs.push(job);
      }
    }
    return jobs;
  }

  function findCardByJob(job) {
    const cards = getCards();
    for (const c of cards) { const j = parseCard(c); if (job.id && j.id === job.id) return c; }
    for (const c of cards) { const j = parseCard(c); if (j.name === job.name && (!job.company || j.company === job.company)) return c; }
    return null;
  }

  function waitFor(sel, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) { clearInterval(iv); resolve(el); }
        else if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  // 等待出现文字完全匹配的可见元素（用于弹窗"继续沟通"按钮）
  function waitForText(texts, timeout) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        const els = document.querySelectorAll('a, button, span, div');
        for (const el of els) {
          const tx = (el.textContent || '').trim();
          if (texts.indexOf(tx) >= 0 && el.offsetParent !== null) { clearInterval(iv); resolve(el); return; }
        }
        if (Date.now() - t0 > timeout) { clearInterval(iv); resolve(null); }
      }, 200);
    });
  }

  function findChatButton() {
    const elements = document.querySelectorAll('a, button, [role="button"], div, span');
    for (const el of elements) {
      const text = (el.textContent || '').replace(/\s+/g, '').trim();
      if (text !== '立即沟通' && text !== '继续沟通' && text !== '打招呼') continue;
      const clickable = el.closest('a, button, [role="button"], [class*="btn"]') || el;
      if (clickable.offsetParent !== null) return clickable;
    }
    const candidates = document.querySelectorAll([
      SELECTORS.jobs.immediateChatBtn,
      'a[class*="chat"]', 'button[class*="chat"]', '[class*="op-btn"]',
      '[ka*="chat"]', '[data-ka*="chat"]'
    ].join(','));
    for (const direct of candidates) {
      const text = (direct.textContent || '').replace(/\s+/g, '').trim();
      if (direct.offsetParent !== null && /沟通|招呼/.test(text)) return direct;
    }
    return null;
  }

  async function waitForChatButton(timeout) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      const button = findChatButton();
      if (button) return button;
      await sleep(250);
    }
    return null;
  }

  // 点开卡片 → 抓取右侧详情面板的完整JD
  async function openJD(job) {
    const card = findCardByJob(job);
    if (!card) return { success: false, error: '未找到岗位卡片' };
    card.scrollIntoView({ block: 'center' });
    await sleep(400);
    card.click();
    await sleep(1600);
    let jd = '';
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    if (det) jd = (det.innerText || '').trim();
    if (!jd) {
      const secs = document.querySelectorAll('.job-sec-text, [class*="job-sec"], [class*="job-desc"]');
      jd = Array.from(secs).map(s => (s.innerText || '').trim()).filter(Boolean).join('\n');
    }
    return { success: true, jd: jd.slice(0, 1800) };
  }

  // 卡片已打开 → 点立即沟通 → 弹窗点"继续沟通"（跳转聊天页）
  async function goChat(job) {
    let btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 5000);
    if (!btn) {
      const all = document.querySelectorAll('a, button, span');
      for (const el of all) { const tx = (el.textContent || '').trim(); if (tx === '立即沟通' || tx === '继续沟通') { btn = el; break; } }
    }
    if (!btn) { // 面板可能关了，重新点卡片
      const card = findCardByJob(job);
      if (card) { card.click(); await sleep(1200); btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 4000); }
    }
    if (!btn) return { success: false, error: '未找到立即沟通按钮' };
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 4000);
    if (go) { go.click(); return { success: true, navigated: true }; }
    return { success: true, navigated: false };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SCRAPE_PAGE') {
      sendResponse({ success: true, jobs: scrapePage(Number(msg.minSalary) || 0) });
      return;
    }
    if (msg.type === 'SCROLL_BATCH') {
      loadMoreJobs()
        .then(advanced => sendResponse({ success: true, advanced: advanced, jobs: scrapePage(Number(msg.minSalary) || 0) }))
        .catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'NEXT_PAGE') {
      const next = findNextPageButton();
      if (!next) { sendResponse({ success: false, error: '没有下一页' }); return; }
      setTimeout(() => next.click(), 50);
      sendResponse({ success: true });
      return;
    }
    if (msg.type === 'SCRAPE') {
      scrape(msg.count || 20, Number(msg.minSalary) || 0).then(jobs => sendResponse({ success: true, jobs: jobs })).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'OPEN_JD') {
      openJD(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
