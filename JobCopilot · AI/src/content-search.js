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
      return (text === '下一页' || text === '下页' || text === '>') && el.offsetParent !== null && !el.disabled;
    }) || null;
  }

  async function loadMoreJobs() {
    const before = cardSignature();
    const containers = getScrollContainers();
    if (containers.length) {
      // 虚拟列表必须分段滚动；直接跳到底会漏掉中间批次。
      for (const el of containers) {
        const step = Math.max(500, Math.floor(el.clientHeight * 0.8));
        el.scrollTop = Math.min(el.scrollTop + step, el.scrollHeight);
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
      }
    } else {
      window.scrollBy(0, Math.max(600, Math.floor(window.innerHeight * 0.8)));
      window.dispatchEvent(new Event('scroll'));
    }
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

  async function scrape(count, minSalary) {
    const seen = {};
    const jobs = [];
    let stall = 0;
    let pages = 1;
    // 分段遍历虚拟列表；到底后继续翻页，直到达到目标或网站确实没有更多结果。
    for (let loop = 0; loop < 500 && jobs.length < count; loop++) {
      const cards = getCards();
      let added = 0;
      for (const c of cards) {
        const j = parseCard(c);
        const floor = salaryFloorK(j.salary);
        const salaryOk = !minSalary || floor === null || floor >= minSalary;
        if (j.id && salaryOk && !seen[j.id]) {
          seen[j.id] = 1;
          jobs.push(j); added++;
          if (jobs.length >= count) break;
        }
      }
      if (added > 0) chrome.runtime.sendMessage({ type: 'PROGRESS', cur: jobs.length, total: count, label: '收集' }).catch(() => {});
      if (jobs.length >= count) break;
      const loaded = await loadMoreJobs();
      if (added > 0 || loaded) { stall = 0; continue; }
      stall++;
      if (stall < 4) { await sleep(600); continue; }
      if (pages >= 50 || !await goNextPage()) break;
      pages++;
      stall = 0;
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

  async function openDirect(job) {
    const btn = await waitFor(SELECTORS.jobs.immediateChatBtn, 8000);
    const det = document.querySelector('.job-detail-box, [class*="job-detail"], .detail-content, .job-detail');
    const jd = det ? (det.innerText || '').trim().slice(0, 3000) : '';
    if (!btn) return { success: false, error: '详情页未找到立即沟通按钮', jd: jd };
    btn.click();
    await sleep(1500);
    const go = await waitForText(['继续沟通'], 5000);
    if (go) go.click();
    return { success: true, jd: jd, navigated: !!go };
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
    if (msg.type === 'OPEN_DIRECT') {
      openDirect(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
    if (msg.type === 'GO_CHAT' || msg.type === 'INITIATE' || msg.type === 'CREATE_CONV') {
      goChat(msg.job).then(r => sendResponse(r)).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }
  });
})();
