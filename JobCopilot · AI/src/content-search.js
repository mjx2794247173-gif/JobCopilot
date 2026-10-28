// ===== 搜索页 content script：收集岗位 + 建立联系（立即沟通→继续沟通跳聊天页）=====
(function () {
  if (window.__bossToudiSearch) return;
  window.__bossToudiSearch = true;

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

  async function loadMoreJobs() {
    const before = getCards().length;
    const containers = getScrollContainers();
    if (containers.length) {
      for (const el of containers) el.scrollTop = el.scrollHeight;
      containers[0].dispatchEvent(new Event('scroll', { bubbles: true }));
    } else {
      window.scrollTo(0, document.body.scrollHeight);
      window.dispatchEvent(new Event('scroll'));
    }
    await sleep(1500);
    return getCards().length > before;
  }

  function parseCard(card) {
    const nameEl = card.querySelector(SELECTORS.jobs.jobName);
    const salEl = card.querySelector(SELECTORS.jobs.jobSalary);
    const linkEl = card.querySelector('a[href*="/job_detail/"]') || card.querySelector('a[ka][href]') || card.querySelector('a');
    const link = linkEl ? linkEl.href : '';
    const m = link.match(/job_detail\/([^.?]+)\.html/);
    const id = (m && m[1]) || ((nameEl ? nameEl.textContent.trim() : '') + '|' + (salEl ? salEl.textContent.trim() : ''));
    const tags = Array.from(card.querySelectorAll(SELECTORS.jobs.tagList)).map(t => t.textContent.trim()).filter(Boolean);
    let company = '';
    const compEl = card.querySelector('.company-name a, .company-name, [class*="company-name"], .boss-info .company-name, .company-info a, [class*="company"] a');
    if (compEl) company = compEl.textContent.trim();
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

  async function scrape(count, minSalary) {
    const seen = {};
    const jobs = [];
    let stall = 0;
    let lastSignature = '';
    // BOSS uses virtualized/infinite lists. Keep trying while the DOM is unchanged,
    // but allow enough time for lazy loading and pagination to complete.
    for (let loop = 0; loop < 80 && jobs.length < count && stall < 10; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        const j = parseCard(c);
        const floor = salaryFloorK(j.salary);
        const salaryOk = !minSalary || floor === null || floor >= minSalary;
        if (j.id && salaryOk && !seen[j.id]) { seen[j.id] = 1; jobs.push(j); added++; if (jobs.length >= count) break; }
      }
      const signature = cards.map(c => {
        const n = c.querySelector(SELECTORS.jobs.jobName);
        return n ? n.textContent.trim() : '';
      }).join('|');
      if (added === 0 && signature === lastSignature) stall++; else stall = 0;
      lastSignature = signature;
      if (jobs.length >= count) break;
      const loaded = await loadMoreJobs();
      if (!loaded && added === 0) await sleep(1000);
    }
    return jobs.slice(0, count);
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
