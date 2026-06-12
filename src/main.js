const API_SUBJECTS_URL = '/api/bangumi/subjects';
const API_SUBJECT_DETAIL_URL = '/api/bangumi/subjects';
const FALLBACK_COVER_URL = 'https://bgm.tv/img/bangumi/404.png';
const INITIAL_CANDIDATE_LIMIT = 3;
const REFILL_CANDIDATE_LIMIT = 50;
const BATCH_PICK_LIMIT = 4;
const DETAIL_FETCH_PARALLEL_REQUESTS = 6;
const DETAIL_FETCH_EXTRA_REQUESTS = 4;
const QUEUE_TARGET_SIZE = 20;
const QUEUE_CACHE_LIMIT = 20;
const QUEUE_REFILL_THRESHOLD = 8;
const QUEUE_REFILL_PARALLEL_REQUESTS = 4;
const MAX_RANDOM_ATTEMPTS = 5;
const MAX_FETCH_FAILURES = 2;
const FETCH_TIMEOUT_MS = 4000;
const COVER_LOAD_TIMEOUT_MS = 5000;
const QUEUE_FILL_FAILURE_LIMIT = 2;
const RECENT_SUBJECT_LIMIT = 80;
const TOTAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const QUEUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUBJECT_TYPES = {
  anime: {
    type: 2,
    label: '动漫',
    fallbackTotal: 28378,
    idPoolUrl: 'https://raw.githubusercontent.com/uerax/NaniAnime/refs/heads/master/public/data/subject-ids/anime.json',
  },
  book: {
    type: 1,
    label: '漫画小说',
    fallbackTotal: 382262,
    idPoolUrl: 'https://raw.githubusercontent.com/uerax/NaniAnime/refs/heads/master/public/data/subject-ids/book.json',
  },
  drama: {
    type: 6,
    label: '三次元',
    fallbackTotal: 26155,
    idPoolUrl: 'https://raw.githubusercontent.com/uerax/NaniAnime/refs/heads/master/public/data/subject-ids/drama.json',
  },
};
const DEBUG_LOGS = false;

const stateEl = document.querySelector('#state');
const animeEl = document.querySelector('#anime');
const coverEl = document.querySelector('#cover');
const subjectLinkEl = document.querySelector('#subject-link');
const subjectIdEl = document.querySelector('#subject-id');
const scoreEl = document.querySelector('#score');
const airDateEl = document.createElement('span');
const titleEl = document.querySelector('#title');
const originalTitleEl = document.querySelector('#original-title');
const refreshButton = document.querySelector('#refresh');
const subjectTypeInputs = document.querySelectorAll('input[name="subject-type"]');

airDateEl.className = 'air-date';
subjectIdEl.parentElement.insertBefore(scoreEl, subjectIdEl);
subjectIdEl.after(airDateEl);

let selectedSubjectKey = document.querySelector('input[name="subject-type"]:checked').value;
let isLoading = false;
let coverRequestId = 0;
const subjectQueues = new Map();
const subjectTotals = new Map();
const subjectIdPools = new Map();
const subjectIdPoolPromises = new Map();
const lastSubjectIds = new Map();
const recentSubjectIds = new Map();
const refillingSubjectKeys = new Set();

function debugLog(event, detail = {}) {
  if (!DEBUG_LOGS) {
    return;
  }

  console.debug(`[NaniAnime] ${event}`, detail);
}

function debugWarn(event, detail = {}) {
  if (!DEBUG_LOGS) {
    return;
  }

  console.warn(`[NaniAnime] ${event}`, detail);
}

function formatError(error) {
  return {
    name: error?.name,
    message: error?.message,
  };
}

function currentSubjectType() {
  return SUBJECT_TYPES[selectedSubjectKey];
}

function queueCacheKey(subjectKey) {
  return `random-anime-daily:${subjectKey}:queue:v6`;
}

function totalCacheKey(subjectKey) {
  return `random-anime-daily:${subjectKey}:total:v1`;
}

function shuffle(items) {
  const result = [...items];

  for (let index = result.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1));
    [result[index], result[randomIndex]] = [result[randomIndex], result[index]];
  }

  return result;
}

function pickRandomSubjects(items, limit) {
  return shuffle(items).slice(0, limit);
}

function getCoverUrl(subject) {
  return subject.images?.large || subject.images?.common || subject.images?.medium || FALLBACK_COVER_URL;
}

function formatYearMonth(date) {
  const match = String(date || '').match(/^(\d{4})(?:-(\d{2}))?/);

  if (!match || match[1] === '0000') {
    return '';
  }

  if (!match[2] || match[2] === '00') {
    return match[1];
  }

  return `${match[1]}年${match[2]}月`;
}

function preloadCovers(subjects) {
  subjects.slice(0, QUEUE_REFILL_THRESHOLD).forEach((subject) => {
    const coverUrl = getCoverUrl(subject);

    if (coverUrl) {
      new Image().src = coverUrl;
    }
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error('cover image load timeout'));
    }, COVER_LOAD_TIMEOUT_MS);

    function cleanup() {
      clearTimeout(timeoutId);
      image.onload = null;
      image.onerror = null;
    }

    image.onload = () => {
      cleanup();
      resolve(url);
    };
    image.onerror = () => {
      cleanup();
      reject(new Error('cover image load failed'));
    };
    image.src = url;
  });
}

async function resolveCoverUrl(subject, subjectKey, coverUrl) {
  try {
    return await loadImage(coverUrl);
  } catch (error) {
    debugWarn('cover preload failed, fallback applied', { subjectKey, id: subject.id, coverUrl, error: formatError(error) });
  }

  if (coverUrl === FALLBACK_COVER_URL) {
    return FALLBACK_COVER_URL;
  }

  try {
    return await loadImage(FALLBACK_COVER_URL);
  } catch (error) {
    debugWarn('fallback cover preload failed', { subjectKey, id: subject.id, error: formatError(error) });
    return FALLBACK_COVER_URL;
  }
}

function isSubjectShapeValid(subject, subjectKey) {
  return subject?.id && subject.type === SUBJECT_TYPES[subjectKey].type;
}

function getCachedSubjectQueue(subjectKey) {
  try {
    const cache = JSON.parse(localStorage.getItem(queueCacheKey(subjectKey)));

    if (!cache || Date.now() - cache.savedAt > QUEUE_CACHE_TTL_MS || !Array.isArray(cache.queue)) {
      debugLog('queue cache miss', { subjectKey });
      return [];
    }

    const queue = cache.queue.filter((subject) => isSubjectShapeValid(subject, subjectKey));
    debugLog('queue cache hit', { subjectKey, cachedCount: cache.queue.length, validCount: queue.length });

    return queue;
  } catch (error) {
    debugWarn('queue cache read failed', { subjectKey, error: formatError(error) });
    return [];
  }
}

function getSubjectQueue(subjectKey) {
  if (!subjectQueues.has(subjectKey)) {
    const cachedQueue = getCachedSubjectQueue(subjectKey);
    subjectQueues.set(subjectKey, cachedQueue.slice(0, QUEUE_CACHE_LIMIT));
    preloadCovers(cachedQueue);
  }

  return subjectQueues.get(subjectKey);
}

function saveSubjectQueue(subjectKey) {
  try {
    localStorage.setItem(
      queueCacheKey(subjectKey),
      JSON.stringify({
        savedAt: Date.now(),
        queue: getSubjectQueue(subjectKey).slice(0, QUEUE_CACHE_LIMIT),
      }),
    );
  } catch (_error) {}
}

function getRecentSubjectIds(subjectKey) {
  if (!recentSubjectIds.has(subjectKey)) {
    recentSubjectIds.set(subjectKey, []);
  }

  return recentSubjectIds.get(subjectKey);
}

function rememberSubject(subjectKey, subject) {
  if (!subject?.id) {
    return;
  }

  lastSubjectIds.set(subjectKey, subject.id);

  const recentIds = getRecentSubjectIds(subjectKey);
  const existingIndex = recentIds.indexOf(subject.id);

  if (existingIndex >= 0) {
    recentIds.splice(existingIndex, 1);
  }

  recentIds.unshift(subject.id);

  if (recentIds.length > RECENT_SUBJECT_LIMIT) {
    recentIds.length = RECENT_SUBJECT_LIMIT;
  }
}

function queuedSubjectIds(subjectKey) {
  return new Set(getSubjectQueue(subjectKey).map((subject) => subject.id));
}

function filterFreshSubjects(subjects, subjectKey) {
  const subjectsById = new Map();
  const queuedIds = queuedSubjectIds(subjectKey);
  const recentIds = new Set(getRecentSubjectIds(subjectKey));
  const lastSubjectId = lastSubjectIds.get(subjectKey);

  subjects.forEach((subject) => {
    if (!queuedIds.has(subject.id) && !recentIds.has(subject.id) && subject.id !== lastSubjectId) {
      subjectsById.set(subject.id, subject);
    }
  });

  return [...subjectsById.values()];
}

function appendSubjectQueueBatch(subjectKey, subjects) {
  const queue = getSubjectQueue(subjectKey);
  const queuedIds = new Set(queue.map((subject) => subject.id));
  let appendedCount = 0;

  subjects.forEach((subject) => {
    if (queue.length >= QUEUE_CACHE_LIMIT || !isSubjectShapeValid(subject, subjectKey) || queuedIds.has(subject.id)) {
      return;
    }

    queue.push(subject);
    queuedIds.add(subject.id);
    appendedCount += 1;
  });

  if (appendedCount > 0) {
    saveSubjectQueue(subjectKey);
    preloadCovers(queue);
  }

  debugLog('queue append batch', {
    subjectKey,
    inputCount: subjects.length,
    appendedCount,
    queueLength: queue.length,
    inputIds: subjects.map((subject) => subject?.id),
  });

  return appendedCount;
}

function getNextSubject(subjectKey) {
  const queue = getSubjectQueue(subjectKey);
  const subject = queue.shift();
  saveSubjectQueue(subjectKey);

  return subject;
}

function getCachedSubjectTotal(subjectKey) {
  try {
    const cache = JSON.parse(localStorage.getItem(totalCacheKey(subjectKey)));

    if (!cache || Date.now() - cache.savedAt > TOTAL_CACHE_TTL_MS || !Number.isInteger(cache.total)) {
      return null;
    }

    return cache.total;
  } catch (_error) {
    return null;
  }
}

function saveSubjectTotal(subjectKey, total) {
  try {
    localStorage.setItem(
      totalCacheKey(subjectKey),
      JSON.stringify({
        savedAt: Date.now(),
        total,
      }),
    );
  } catch (_error) {}
}

function rememberSubjectTotal(subjectKey, total) {
  if (!Number.isInteger(total) || total <= 0) {
    return;
  }

  subjectTotals.set(subjectKey, total);
  saveSubjectTotal(subjectKey, total);
}

function rememberSubjectTotalFromPage(subjectKey, page) {
  rememberSubjectTotal(subjectKey, Number(page.total));
}

function getSubjectTotalSnapshot(subjectKey) {
  if (subjectTotals.has(subjectKey)) {
    const total = subjectTotals.get(subjectKey);
    debugLog('total snapshot memory', { subjectKey, total });
    return total;
  }

  const cachedTotal = getCachedSubjectTotal(subjectKey);

  if (cachedTotal !== null) {
    subjectTotals.set(subjectKey, cachedTotal);
    debugLog('total snapshot cache', { subjectKey, total: cachedTotal });
    return cachedTotal;
  }

  const fallbackTotal = SUBJECT_TYPES[subjectKey].fallbackTotal;
  debugLog('total snapshot fallback', { subjectKey, total: fallbackTotal });

  return fallbackTotal;
}

function buildSubjectsUrl(subjectKey, limit, offset) {
  const params = new URLSearchParams({
    type: String(SUBJECT_TYPES[subjectKey].type),
    sort: 'date',
    limit: String(limit),
    offset: String(offset),
  });

  return `${API_SUBJECTS_URL}?${params}`;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSubjectDetailUrl(id) {
  return `${API_SUBJECT_DETAIL_URL}/${id}`;
}

async function getSubjectIdPool(subjectKey) {
  if (subjectIdPools.has(subjectKey)) {
    return subjectIdPools.get(subjectKey);
  }

  if (subjectIdPoolPromises.has(subjectKey)) {
    return subjectIdPoolPromises.get(subjectKey);
  }

  const subjectType = SUBJECT_TYPES[subjectKey];
  const promise = fetchWithTimeout(subjectType.idPoolUrl)
    .then((response) => {
      if (!response.ok) {
        throw new Error(`ID 文件返回 ${response.status}`);
      }

      return response.json();
    })
    .then((ids) => {
      if (!Array.isArray(ids)) {
        throw new Error('ID 文件格式不是数组');
      }

      const validIds = ids.filter((id) => Number.isInteger(id) && id > 0);

      if (validIds.length === 0) {
        throw new Error('ID 文件为空');
      }

      subjectIdPools.set(subjectKey, validIds);
      debugLog('id pool loaded', { subjectKey, count: validIds.length });

      return validIds;
    })
    .finally(() => {
      subjectIdPoolPromises.delete(subjectKey);
    });

  subjectIdPoolPromises.set(subjectKey, promise);

  return promise;
}

function pickRandomSubjectIds(subjectKey, ids, limit) {
  const pickedIds = [];
  const pickedIdSet = new Set();
  const blockedIds = new Set([
    ...queuedSubjectIds(subjectKey),
    ...getRecentSubjectIds(subjectKey),
  ]);
  const lastSubjectId = lastSubjectIds.get(subjectKey);

  if (lastSubjectId) {
    blockedIds.add(lastSubjectId);
  }

  const maxAttempts = Math.min(ids.length, Math.max(limit * 24, 120));

  for (let attempt = 0; attempt < maxAttempts && pickedIds.length < limit; attempt += 1) {
    const id = ids[Math.floor(Math.random() * ids.length)];

    if (!blockedIds.has(id) && !pickedIdSet.has(id)) {
      pickedIds.push(id);
      pickedIdSet.add(id);
    }
  }

  if (pickedIds.length < limit) {
    for (const id of ids) {
      if (!blockedIds.has(id) && !pickedIdSet.has(id)) {
        pickedIds.push(id);
        pickedIdSet.add(id);
      }

      if (pickedIds.length >= limit) {
        break;
      }
    }
  }

  return pickedIds;
}

async function fetchSubjectDetail(subjectKey, id) {
  const url = buildSubjectDetailUrl(id);
  const startedAt = performance.now();

  try {
    const response = await fetchWithTimeout(url);

    if (!response.ok) {
      throw new Error(`Bangumi API 返回 ${response.status}`);
    }

    const subject = normalizeSubject(await response.json());

    if (!isSubjectShapeValid(subject, subjectKey)) {
      throw new Error('条目类型不匹配');
    }

    debugLog('detail request parsed', {
      subjectKey,
      id,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return subject;
  } catch (error) {
    debugWarn('detail request failed', {
      subjectKey,
      id,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: formatError(error),
    });
    throw error;
  }
}

function pushUniqueSubject(targetSubjects, subject, seenIds) {
  if (!subject?.id || seenIds.has(subject.id)) {
    return;
  }

  targetSubjects.push(subject);
  seenIds.add(subject.id);
}

async function fetchSubjectDetailsByIds(subjectKey, ids, limit) {
  const subjects = [];
  const seenIds = new Set();

  for (let index = 0; index < ids.length && subjects.length < limit; index += DETAIL_FETCH_PARALLEL_REQUESTS) {
    const chunk = ids.slice(index, index + DETAIL_FETCH_PARALLEL_REQUESTS);
    const results = await Promise.allSettled(chunk.map((id) => fetchSubjectDetail(subjectKey, id)));

    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        pushUniqueSubject(subjects, result.value, seenIds);
      }
    });
  }

  return subjects.slice(0, limit);
}

async function fetchRandomSubjectDetails(subjectKey, pickLimit) {
  try {
    const ids = await getSubjectIdPool(subjectKey);
    const requestLimit = Math.min(ids.length, pickLimit + DETAIL_FETCH_EXTRA_REQUESTS + DETAIL_FETCH_PARALLEL_REQUESTS);
    const pickedIds = pickRandomSubjectIds(subjectKey, ids, requestLimit);

    if (pickedIds.length === 0) {
      return [];
    }

    const subjects = await fetchSubjectDetailsByIds(subjectKey, pickedIds, pickLimit);
    const candidates = filterFreshSubjects(subjects, subjectKey).slice(0, pickLimit);

    debugLog('id batch picked', {
      subjectKey,
      pickLimit,
      requestLimit,
      pickedIdCount: pickedIds.length,
      subjectCount: subjects.length,
      freshCount: candidates.length,
    });

    return candidates;
  } catch (error) {
    debugWarn('id batch failed', { subjectKey, pickLimit, error: formatError(error) });
    return [];
  }
}

async function fetchRandomSubjects(subjectKey, pickLimit, fallbackCandidateLimit) {
  const subjects = await fetchRandomSubjectDetails(subjectKey, pickLimit);

  if (subjects.length > 0) {
    return subjects;
  }

  return fetchRandomSubjectBatch(subjectKey, fallbackCandidateLimit, pickLimit);
}

async function fetchSubjectsPage(subjectKey, limit, offset) {
  const url = buildSubjectsUrl(subjectKey, limit, offset);
  const startedAt = performance.now();

  debugLog('request start', { subjectKey, limit, offset, url });

  try {
    const response = await fetchWithTimeout(url);
    const elapsedMs = Math.round(performance.now() - startedAt);

    debugLog('request response', { subjectKey, limit, offset, status: response.status, elapsedMs });

    if (!response.ok) {
      throw new Error(`Bangumi API 返回 ${response.status}`);
    }

    const page = await response.json();
    rememberSubjectTotalFromPage(subjectKey, page);
    debugLog('request parsed', {
      subjectKey,
      limit,
      offset,
      total: page.total,
      dataCount: Array.isArray(page.data) ? page.data.length : null,
      elapsedMs: Math.round(performance.now() - startedAt),
    });

    return page;
  } catch (error) {
    debugWarn('request failed', {
      subjectKey,
      limit,
      offset,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: formatError(error),
    });
    throw error;
  }
}

function randomPageOffset(total, limit) {
  const safeTotal = Math.max(Number(total) || 0, limit);
  const pageCount = Math.max(Math.ceil(safeTotal / limit), 1);
  const pageIndex = Math.floor(Math.random() * pageCount);

  return pageIndex * limit;
}

function normalizeSubject(subject) {
  return {
    id: subject.id,
    type: subject.type,
    name: subject.name,
    name_cn: subject.name_cn,
    platform: subject.platform,
    date: subject.date,
    images: subject.images,
    rating: subject.rating,
  };
}

function filterValidSubjects(page, subjectKey) {
  const subjectType = SUBJECT_TYPES[subjectKey];

  return (page.data || [])
    .filter((subject) => subject?.id && subject.type === subjectType.type)
    .map(normalizeSubject);
}

async function fetchRandomSubjectBatch(subjectKey, candidateLimit, pickLimit = BATCH_PICK_LIMIT) {
  let fetchFailures = 0;

  debugLog('batch start', { subjectKey, candidateLimit, pickLimit, queueLength: getSubjectQueue(subjectKey).length });

  for (let attempt = 0; attempt < MAX_RANDOM_ATTEMPTS; attempt += 1) {
    try {
      const total = getSubjectTotalSnapshot(subjectKey);
      const offset = randomPageOffset(total, candidateLimit);
      const page = await fetchSubjectsPage(subjectKey, candidateLimit, offset);
      const validSubjects = filterValidSubjects(page, subjectKey);
      const candidates = filterFreshSubjects(validSubjects, subjectKey);

      debugLog('batch candidates', {
        subjectKey,
        attempt: attempt + 1,
        candidateLimit,
        pickLimit,
        offset,
        total,
        rawCount: Array.isArray(page.data) ? page.data.length : null,
        validCount: validSubjects.length,
        freshCount: candidates.length,
        queueLength: getSubjectQueue(subjectKey).length,
        recentCount: getRecentSubjectIds(subjectKey).length,
      });

      if (candidates.length > 0) {
        const pickedSubjects = pickRandomSubjects(candidates, pickLimit);
        debugLog('batch picked', {
          subjectKey,
          pickedCount: pickedSubjects.length,
          pickedIds: pickedSubjects.map((subject) => subject.id),
        });

        return pickedSubjects;
      }
    } catch (error) {
      fetchFailures += 1;
      debugWarn('batch attempt failed', {
        subjectKey,
        attempt: attempt + 1,
        candidateLimit,
        fetchFailures,
        error: formatError(error),
      });

      if (fetchFailures >= MAX_FETCH_FAILURES) {
        debugWarn('batch stopped by fetch failure limit', { subjectKey, candidateLimit, fetchFailures });
        return [];
      }
    }
  }

  debugWarn('batch exhausted attempts', { subjectKey, candidateLimit, maxAttempts: MAX_RANDOM_ATTEMPTS });
  return [];
}

async function fillSubjectQueue(subjectKey, targetSize = QUEUE_TARGET_SIZE) {
  const queueLength = getSubjectQueue(subjectKey).length;

  if (refillingSubjectKeys.has(subjectKey) || queueLength >= targetSize) {
    debugLog('queue fill skipped', {
      subjectKey,
      queueLength,
      targetSize,
      isRefilling: refillingSubjectKeys.has(subjectKey),
    });
    return;
  }

  refillingSubjectKeys.add(subjectKey);
  debugLog('queue fill start', { subjectKey, queueLength, targetSize });

  let failures = 0;

  try {
    while (getSubjectQueue(subjectKey).length < targetSize && failures < QUEUE_FILL_FAILURE_LIMIT) {
      const queueLengthBeforeBatch = getSubjectQueue(subjectKey).length;
      const neededCount = targetSize - queueLengthBeforeBatch;
      const requestCount = Math.min(QUEUE_REFILL_PARALLEL_REQUESTS, Math.ceil(neededCount / BATCH_PICK_LIMIT));

      debugLog('queue fill batch start', {
        subjectKey,
        neededCount,
        requestCount,
        queueLength: queueLengthBeforeBatch,
        targetSize,
      });

      const results = await Promise.all(
        Array.from({ length: requestCount }, () =>
          fetchRandomSubjects(subjectKey, BATCH_PICK_LIMIT, REFILL_CANDIDATE_LIMIT)
            .then((subjects) => {
              const remainingCount = targetSize - getSubjectQueue(subjectKey).length;

              if (remainingCount <= 0) {
                return { status: 'fulfilled', appendedCount: 0 };
              }

              return {
                status: 'fulfilled',
                appendedCount: appendSubjectQueueBatch(subjectKey, subjects.slice(0, remainingCount)),
              };
            })
            .catch((error) => {
              debugWarn('queue fill request rejected', { subjectKey, error: formatError(error) });
              return { status: 'rejected', appendedCount: 0 };
            }),
        ),
      );
      const fulfilledCount = results.filter((result) => result.status === 'fulfilled').length;
      const rejectedCount = results.length - fulfilledCount;
      const appendedCount = results.reduce((total, result) => total + result.appendedCount, 0);

      debugLog('queue fill batch settled', {
        subjectKey,
        neededCount,
        requestCount,
        fulfilledCount,
        rejectedCount,
        appendedCount,
        queueLength: getSubjectQueue(subjectKey).length,
        targetSize,
      });

      if (appendedCount === 0) {
        failures += 1;
        debugWarn('queue fill batch empty', {
          subjectKey,
          failures,
          requestCount,
          queueLength: getSubjectQueue(subjectKey).length,
        });
        continue;
      }

      failures = 0;
    }
  } catch (error) {
    debugWarn('queue fill failed', { subjectKey, error: formatError(error) });
  } finally {
    debugLog('queue fill end', { subjectKey, queueLength: getSubjectQueue(subjectKey).length, targetSize, failures });
    refillingSubjectKeys.delete(subjectKey);
  }
}

function refillQueue(subjectKey) {
  if (getSubjectQueue(subjectKey).length > QUEUE_REFILL_THRESHOLD) {
    return;
  }

  fillSubjectQueue(subjectKey);
}

function showClickNotice(message) {
  stateEl.textContent = message;
  stateEl.classList.remove('hidden', 'error');
  stateEl.classList.add('notice');
}

function setLoading(message = `正在随机抽取${currentSubjectType().label}...`) {
  coverRequestId += 1;
  refreshButton.disabled = false;
  refreshButton.textContent = '换一个';
  showClickNotice(message);
  animeEl.classList.remove('hidden');
  animeEl.classList.add('is-loading');
  coverEl.onerror = null;
  coverEl.removeAttribute('src');
  coverEl.alt = '加载中';

  originalTitleEl.textContent = '';
  originalTitleEl.classList.add('hidden');

  airDateEl.textContent = '';
  airDateEl.classList.add('hidden');

  if (!subjectIdEl.textContent.startsWith('ID:')) {
    scoreEl.textContent = '★ ...';
    subjectIdEl.textContent = '正在抽取中';
    titleEl.textContent = '正在加载...';
  }
}

function setError(message) {
  coverRequestId += 1;
  refreshButton.disabled = false;
  refreshButton.textContent = '再试一次';
  stateEl.textContent = message;
  stateEl.classList.remove('hidden', 'notice');
  stateEl.classList.add('error');
  coverEl.onerror = null;
  coverEl.removeAttribute('src');
  animeEl.classList.remove('is-loading');
  animeEl.classList.add('hidden');
}

function renderSubject(subject, subjectKey) {
  const subjectType = SUBJECT_TYPES[subjectKey];
  const title = subject.name_cn || subject.name || '未命名条目';
  const coverUrl = getCoverUrl(subject);
  const originalTitle = subject.name && subject.name_cn && subject.name !== subject.name_cn ? subject.name : '';
  const score = typeof subject.rating?.score === 'number' && subject.rating.score > 0 ? subject.rating.score.toFixed(1) : '暂无评分';
  const category = subject.platform || subjectType.label;
  const yearMonth = formatYearMonth(subject.date);
  const currentCoverRequestId = (coverRequestId += 1);

  animeEl.classList.remove('hidden');
  animeEl.classList.add('is-loading');
  coverEl.onerror = null;
  coverEl.removeAttribute('src');
  coverEl.alt = title;
  subjectLinkEl.href = `https://bgm.tv/subject/${subject.id}`;
  scoreEl.textContent = `★ ${score}`;
  subjectIdEl.textContent = category;
  airDateEl.textContent = yearMonth ? `${yearMonth}` : '';
  airDateEl.classList.toggle('hidden', !yearMonth);
  titleEl.textContent = title;
  originalTitleEl.textContent = originalTitle;
  originalTitleEl.classList.toggle('hidden', !originalTitle);

  refreshButton.disabled = false;
  refreshButton.textContent = '换一个';
  stateEl.classList.remove('notice', 'error');
  stateEl.classList.add('hidden');

  resolveCoverUrl(subject, subjectKey, coverUrl).then((resolvedCoverUrl) => {
    if (currentCoverRequestId !== coverRequestId) {
      return;
    }

    coverEl.onerror = () => {
      debugWarn('cover failed after preload, fallback applied', { subjectKey, id: subject.id, coverUrl: resolvedCoverUrl });
      coverEl.onerror = null;
      coverEl.src = FALLBACK_COVER_URL;
    };
    coverEl.src = resolvedCoverUrl;
    animeEl.classList.remove('is-loading');
  });
}

function showSubject(subject, subjectKey) {
  debugLog('show subject', { subjectKey, id: subject?.id, title: subject?.name_cn || subject?.name });
  rememberSubject(subjectKey, subject);
  renderSubject(subject, subjectKey);
}

async function loadRandomSubject() {
  if (isLoading) {
    debugLog('load ignored while loading', { selectedSubjectKey });
    showClickNotice(`正在随机抽取${SUBJECT_TYPES[selectedSubjectKey].label}，请稍候...`);
    return;
  }

  const subjectKey = selectedSubjectKey;
  const queue = getSubjectQueue(subjectKey);

  debugLog('load start', { subjectKey, queueLength: queue.length });

  if (queue.length > 0) {
    const subject = getNextSubject(subjectKey);
    debugLog('load from queue', { subjectKey, id: subject?.id, queueLengthAfterShift: getSubjectQueue(subjectKey).length });
    showSubject(subject, subjectKey);
    refillQueue(subjectKey);
    return;
  }

  isLoading = true;
  setLoading(`正在随机抽取${SUBJECT_TYPES[subjectKey].label}...`);

  try {
    const subjects = await fetchRandomSubjects(subjectKey, INITIAL_CANDIDATE_LIMIT, INITIAL_CANDIDATE_LIMIT);
    const [subject, ...queuedSubjects] = subjects;

    debugLog('load initial batch result', {
      subjectKey,
      count: subjects.length,
      subjectId: subject?.id,
      queuedIds: queuedSubjects.map((queuedSubject) => queuedSubject.id),
    });

    if (!subject) {
      throw new Error('empty random subject');
    }

    showSubject(subject, subjectKey);
    appendSubjectQueueBatch(subjectKey, queuedSubjects);
    fillSubjectQueue(subjectKey);
  } catch (error) {
    debugWarn('load failed', { subjectKey, error: formatError(error) });
    setError(`暂时没能获取到${SUBJECT_TYPES[subjectKey].label}，请再试一次。`);
  } finally {
    isLoading = false;
    debugLog('load end', { subjectKey, queueLength: getSubjectQueue(subjectKey).length });
  }
}

subjectTypeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    selectedSubjectKey = input.value;
    debugLog('subject type changed', { selectedSubjectKey, queueLength: getSubjectQueue(selectedSubjectKey).length });
    getSubjectQueue(selectedSubjectKey);
    refillQueue(selectedSubjectKey);
  });
});
refreshButton.addEventListener('click', loadRandomSubject);
loadRandomSubject();
