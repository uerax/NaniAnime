import './style.css';

const API_SUBJECTS_URL = '/api/bangumi/subjects';
const FALLBACK_COVER_URL = 'https://bgm.tv/img/bangumi/404.png';
const SUBJECT_PAGE_LIMIT = 20;
const QUEUE_REFILL_THRESHOLD = 3;
const MAX_RANDOM_ATTEMPTS = 5;
const TOTAL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const QUEUE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SUBJECT_TYPES = {
  anime: {
    type: 2,
    label: '动漫',
    requireCover: true,
    initialLimit: 1,
  },
  book: {
    type: 1,
    label: '漫画小说',
    requireCover: true,
    initialLimit: 1,
  },
  drama: {
    type: 6,
    label: '三次元',
    requireCover: false,
    initialLimit: 1,
  },
};

const stateEl = document.querySelector('#state');
const animeEl = document.querySelector('#anime');
const coverEl = document.querySelector('#cover');
const subjectLinkEl = document.querySelector('#subject-link');
const subjectIdEl = document.querySelector('#subject-id');
const scoreEl = document.querySelector('#score');
const titleEl = document.querySelector('#title');
const originalTitleEl = document.querySelector('#original-title');
const refreshButton = document.querySelector('#refresh');
const subjectTypeInputs = document.querySelectorAll('input[name="subject-type"]');

let selectedSubjectKey = document.querySelector('input[name="subject-type"]:checked').value;
let isLoading = false;
const subjectQueues = new Map();
const subjectTotals = new Map();
const lastSubjectIds = new Map();
const refillingSubjectKeys = new Set();

function currentSubjectType() {
  return SUBJECT_TYPES[selectedSubjectKey];
}

function queueCacheKey(subjectKey) {
  return `random-anime-daily:${subjectKey}:queue:v1`;
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

function getCoverUrl(subject) {
  return subject.images?.large || subject.images?.common || subject.images?.medium || FALLBACK_COVER_URL;
}

function preloadCovers(subjects) {
  subjects.slice(0, QUEUE_REFILL_THRESHOLD).forEach((subject) => {
    const coverUrl = getCoverUrl(subject);

    if (coverUrl) {
      new Image().src = coverUrl;
    }
  });
}

function getCachedSubjectQueue(subjectKey) {
  try {
    const cache = JSON.parse(localStorage.getItem(queueCacheKey(subjectKey)));

    if (!cache || Date.now() - cache.savedAt > QUEUE_CACHE_TTL_MS || !Array.isArray(cache.queue)) {
      return [];
    }

    return cache.queue.filter((subject) => {
      return subject?.id && (!SUBJECT_TYPES[subjectKey].requireCover || subject.images);
    });
  } catch (_error) {
    return [];
  }
}

function getSubjectQueue(subjectKey) {
  if (!subjectQueues.has(subjectKey)) {
    const cachedQueue = getCachedSubjectQueue(subjectKey);
    subjectQueues.set(subjectKey, cachedQueue);
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
        queue: getSubjectQueue(subjectKey).slice(0, SUBJECT_PAGE_LIMIT),
      }),
    );
  } catch (_error) {}
}

function appendSubjectQueue(subjectKey, subjects) {
  const queue = getSubjectQueue(subjectKey);
  const existingIds = new Set(queue.map((subject) => subject.id));
  const lastSubjectId = lastSubjectIds.get(subjectKey);
  const nextSubjects = shuffle(subjects).filter((subject) => {
    return subject.id !== lastSubjectId && !existingIds.has(subject.id);
  });

  queue.push(...nextSubjects);

  if (queue.length > 1 && queue[0].id === lastSubjectId) {
    [queue[0], queue[1]] = [queue[1], queue[0]];
  }

  saveSubjectQueue(subjectKey);
  preloadCovers(queue);
}

function getNextSubject(subjectKey) {
  const queue = getSubjectQueue(subjectKey);
  const subject = queue.shift();
  lastSubjectIds.set(subjectKey, subject.id);
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

function buildSubjectsUrl(subjectKey, limit, offset) {
  const params = new URLSearchParams({
    type: String(SUBJECT_TYPES[subjectKey].type),
    sort: 'date',
    limit: String(limit),
    offset: String(offset),
  });

  return `${API_SUBJECTS_URL}?${params}`;
}

async function fetchSubjectsPage(subjectKey, limit, offset) {
  const response = await fetch(buildSubjectsUrl(subjectKey, limit, offset));

  if (!response.ok) {
    throw new Error(`Bangumi API 返回 ${response.status}`);
  }

  return response.json();
}

async function getSubjectTotal(subjectKey) {
  if (subjectTotals.has(subjectKey)) {
    return subjectTotals.get(subjectKey);
  }

  const cachedTotal = getCachedSubjectTotal(subjectKey);

  if (cachedTotal) {
    subjectTotals.set(subjectKey, cachedTotal);
    return cachedTotal;
  }

  const firstPage = await fetchSubjectsPage(subjectKey, 1, 0);
  const total = Number(firstPage.total);

  if (!Number.isInteger(total) || total <= 0) {
    throw new Error('invalid total');
  }

  subjectTotals.set(subjectKey, total);
  saveSubjectTotal(subjectKey, total);

  return total;
}

function randomOffset(total, limit) {
  return Math.floor(Math.random() * Math.max(total - limit + 1, 1));
}

function normalizeSubject(subject) {
  return {
    id: subject.id,
    type: subject.type,
    name: subject.name,
    name_cn: subject.name_cn,
    platform: subject.platform,
    images: subject.images,
    rating: subject.rating,
  };
}

function filterValidSubjects(page, subjectKey) {
  const subjectType = SUBJECT_TYPES[subjectKey];

  return (page.data || [])
    .filter((subject) => {
      return subject.type === subjectType.type && (!subjectType.requireCover || subject.images);
    })
    .map(normalizeSubject);
}

function uniqueSubjects(subjects, subjectKey) {
  const subjectsById = new Map();
  const lastSubjectId = lastSubjectIds.get(subjectKey);

  subjects.forEach((subject) => {
    if (subject.id !== lastSubjectId) {
      subjectsById.set(subject.id, subject);
    }
  });

  return [...subjectsById.values()];
}

async function fetchRandomSubjectsPage(subjectKey, limit = SUBJECT_PAGE_LIMIT, maxAttempts = MAX_RANDOM_ATTEMPTS) {
  const total = await getSubjectTotal(subjectKey);

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const page = await fetchSubjectsPage(subjectKey, limit, randomOffset(total, limit));
    const candidates = uniqueSubjects(filterValidSubjects(page, subjectKey), subjectKey);

    if (candidates.length > 0) {
      return candidates;
    }
  }

  return [];
}

async function fetchInitialSubjects(subjectKey) {
  const subjectType = SUBJECT_TYPES[subjectKey];
  const total = await getSubjectTotal(subjectKey);
  const page = await fetchSubjectsPage(subjectKey, subjectType.initialLimit, randomOffset(total, subjectType.initialLimit));

  return uniqueSubjects(
    (page.data || [])
      .filter((subject) => subject.type === subjectType.type)
      .map(normalizeSubject),
    subjectKey,
  );
}

async function refillQueue(subjectKey) {
  const queue = getSubjectQueue(subjectKey);

  if (refillingSubjectKeys.has(subjectKey) || queue.length > QUEUE_REFILL_THRESHOLD) {
    return;
  }

  refillingSubjectKeys.add(subjectKey);

  try {
    appendSubjectQueue(subjectKey, await fetchRandomSubjectsPage(subjectKey));
  } catch (_error) {
  } finally {
    refillingSubjectKeys.delete(subjectKey);
  }
}

function setLoading(message = `正在随机抽取${currentSubjectType().label}...`) {
  refreshButton.disabled = true;
  refreshButton.textContent = '加载中...';
  stateEl.textContent = message;
  stateEl.classList.remove('hidden', 'error');
  animeEl.classList.add('hidden');
}

function setError(message) {
  refreshButton.disabled = false;
  refreshButton.textContent = '再试一次';
  stateEl.textContent = message;
  stateEl.classList.remove('hidden');
  stateEl.classList.add('error');
  animeEl.classList.add('hidden');
}

function renderSubject(subject, subjectKey) {
  const subjectType = SUBJECT_TYPES[subjectKey];
  const title = subject.name_cn || subject.name || '未命名条目';
  const coverUrl = getCoverUrl(subject);
  const originalTitle = subject.name && subject.name_cn && subject.name !== subject.name_cn ? subject.name : '';
  const score = typeof subject.rating?.score === 'number' && subject.rating.score > 0 ? subject.rating.score.toFixed(1) : '暂无评分';
  const category = subject.platform || subjectType.label;

  coverEl.src = coverUrl;
  coverEl.alt = title;
  subjectLinkEl.href = `https://bgm.tv/subject/${subject.id}`;
  subjectIdEl.textContent = `ID: ${subject.id} / ${category}`;
  scoreEl.textContent = `★ ${score}`;
  titleEl.textContent = title;
  originalTitleEl.textContent = originalTitle;
  originalTitleEl.classList.toggle('hidden', !originalTitle);

  refreshButton.disabled = false;
  refreshButton.textContent = '换一个';
  stateEl.classList.add('hidden');
  animeEl.classList.remove('hidden');
}

async function loadRandomSubject() {
  if (isLoading) {
    return;
  }

  const subjectKey = selectedSubjectKey;
  const queue = getSubjectQueue(subjectKey);

  if (queue.length > 0) {
    renderSubject(getNextSubject(subjectKey), subjectKey);
    refillQueue(subjectKey);
    return;
  }

  isLoading = true;
  setLoading(`正在随机抽取${SUBJECT_TYPES[subjectKey].label}...`);

  try {
    appendSubjectQueue(subjectKey, await fetchInitialSubjects(subjectKey));

    if (getSubjectQueue(subjectKey).length === 0) {
      throw new Error('empty random page');
    }

    renderSubject(getNextSubject(subjectKey), subjectKey);
    refillQueue(subjectKey);
  } catch (_error) {
    setError(`暂时没能抽到${SUBJECT_TYPES[subjectKey].label}，请再试一次。`);
  } finally {
    isLoading = false;
  }
}

subjectTypeInputs.forEach((input) => {
  input.addEventListener('change', () => {
    selectedSubjectKey = input.value;
    getSubjectQueue(selectedSubjectKey);
  });
});
refreshButton.addEventListener('click', loadRandomSubject);
loadRandomSubject();
