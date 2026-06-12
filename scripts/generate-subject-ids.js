import { mkdir, writeFile, readFile } from 'node:fs/promises';

const BANGUMI_SUBJECTS_URL = 'https://api.bgm.tv/v0/subjects';
const BANGUMI_USER_AGENT = 'uerax/NaniAnime';
const PAGE_LIMIT = Number(process.env.PAGE_LIMIT || 50);
const PAGE_CONCURRENCY = Number(process.env.PAGE_CONCURRENCY || 3);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || 10000);
const MAX_RETRIES = Number(process.env.MAX_RETRIES || 3);
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 800);
const OUTPUT_DIR = new URL('../public/data/subject-ids/', import.meta.url);
const SUBJECT_TYPES = {
  anime: {
    type: 2,
    label: '动漫',
    output: new URL('anime.json', OUTPUT_DIR),
  },
  book: {
    type: 1,
    label: '漫画小说',
    output: new URL('book.json', OUTPUT_DIR),
  },
  drama: {
    type: 6,
    label: '三次元',
    output: new URL('drama.json', OUTPUT_DIR),
  },
};

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'user-agent': BANGUMI_USER_AGENT,
      },
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

function buildSubjectsUrl(subjectType, offset) {
  const params = new URLSearchParams({
    type: String(subjectType.type),
    sort: 'date',
    limit: String(PAGE_LIMIT),
    offset: String(offset),
  });

  return `${BANGUMI_SUBJECTS_URL}?${params}`;
}

async function fetchSubjectsPage(subjectKey, subjectType, offset) {
  const url = buildSubjectsUrl(subjectType, offset);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        throw new Error(`Bangumi API 返回 ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`${subjectKey} offset=${offset} 获取失败：${error.message}`);
      }
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw new Error(`${subjectKey} offset=${offset} 获取失败`);
}

function extractSubjectIds(page, subjectType) {
  if (!Array.isArray(page.data)) {
    return [];
  }

  return page.data
    .filter((subject) => Number.isInteger(subject?.id) && subject.type === subjectType.type)
    .map((subject) => subject.id);
}

// 新增：读取本地已存在的 ID 数据
async function loadExistingSubjectIds(outputPath) {
  try {
    const content = await readFile(outputPath, 'utf8');
    const ids = JSON.parse(content);
    if (Array.isArray(ids)) {
      return new Set(ids);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`⚠️ 读取本地文件失败 (${outputPath})，将重新全量拉取。原因: ${error.message}`);
    }
  }
  return new Set();
}

async function collectSubjectIds(subjectKey, subjectType) {
  console.log(`\n--- 开始处理 ${subjectType.label} (type=${subjectType.type}) ---`);

  // 1. 读取本地历史数据
  const existingIds = await loadExistingSubjectIds(subjectType.output);
  const subjectIds = new Set(existingIds);
  
  // 找出本地最大的 ID 作为安全锚点
  let maxLocalId = 0;
  for (const id of existingIds) {
    if (id > maxLocalId) {
      maxLocalId = id;
    }
  }
  
  if (existingIds.size > 0) {
    console.log(`📂 检测到本地已存在 ${existingIds.size} 个 ID，当前本地最大 ID = ${maxLocalId}`);
  }

  // 2. 拉取首页获取总数
  const firstPage = await fetchSubjectsPage(subjectKey, subjectType, 0);
  const total = Number(firstPage.total);

  if (!Number.isInteger(total) || total <= 0) {
    throw new Error(`${subjectKey} total 无效：${firstPage.total}`);
  }

  console.log(`📡 API 返回最新总数 Total = ${total} (可能包含已隐藏/删除的失效条目)`);

  const firstPageIds = extractSubjectIds(firstPage, subjectType);
  firstPageIds.forEach((id) => subjectIds.add(id));

  const hasNewIdInFirstPage = firstPageIds.some(id => id > maxLocalId);
  const missingCount = total - existingIds.size;

  // 3. 智能计算需要增量拉取的 offset 范围
  const offsets = [];
  let startOffset = PAGE_LIMIT;
  let endOffset = total;

  if (existingIds.size > 0) {
    if (missingCount <= 0 && !hasNewIdInFirstPage) {
      console.log(`✅ 本地数据已是最新 (与 API Total 数量对齐)，无需增量更新。`);
      return; 
    }

    console.log(`🔍 发现数据偏差或潜在增量 (差值: ${missingCount})，正在探测增量方向...`);

    let knownCount = 0;
    firstPageIds.forEach((id) => { if (existingIds.has(id)) knownCount++; });

    const buffer = PAGE_LIMIT * 4;

    if (knownCount > PAGE_LIMIT / 2) {
      // ===== 【核心优化：尾部幽灵数据探底】 =====
      console.log(`   -> 探测到增量可能在尾部，正在进行末尾页“幽灵数据”排查...`);
      // 计算最后一页的游标位置
      const lastPageOffset = Math.max(0, total - PAGE_LIMIT);
      try {
        const lastPage = await fetchSubjectsPage(subjectKey, subjectType, lastPageOffset);
        const lastPageIds = extractSubjectIds(lastPage, subjectType);
        const hasNewIdInLastPage = lastPageIds.some(id => id > maxLocalId);

        if (!hasNewIdInLastPage) {
          console.log(`🛡️ [拦截成功] 最后一页 (offset=${lastPageOffset}) 的数据全低于本地最大 ID。`);
          console.log(`🎉 ${subjectType.label} 完成：差值为隐藏/失效条目，无真实新增，已提前终止。`);
          return; // 直接拦截，拒绝后续多余请求
        }
      } catch (error) {
        console.warn(`   ⚠️ 尾部探底失败 (${error.message})，将降级执行常规拉取策略。`);
      }

      startOffset = Math.max(PAGE_LIMIT, total - Math.max(0, missingCount) - buffer);
      console.log(`   -> 探底确认有真实新增！计算出的起始位置 offset = ${startOffset}`);
    } else {
      // ===== 【头部幽灵数据排查】 =====
      if (!hasNewIdInFirstPage) {
        console.log(`🛡️ [拦截成功] 头部首页未出现新 ID。`);
        console.log(`🎉 ${subjectType.label} 完成：差值为隐藏/失效条目，无真实新增，已提前终止。`);
        return; 
      }
      
      endOffset = Math.min(total, Math.max(0, missingCount) + buffer);
      console.log(`   -> 探底确认有真实新增！增量分布在头部。限制最大拉取游标 offset = ${endOffset}`);
    }
  } else {
    console.log(`🚀 未检测到本地数据，将执行全量拉取 (Total: ${total})...`);
  }

  // 组装任务队列
  for (let offset = startOffset; offset < endOffset; offset += PAGE_LIMIT) {
    offsets.push(offset);
  }

  // 4. 并发抓取
  let nextIndex = 0;
  let actualFinishedTasks = 0;
  let shouldStopEarly = false;
  const failures = [];

  if (offsets.length > 0) {
    console.log(`⚙️  构建了 ${offsets.length} 个请求任务位置，并发数=${PAGE_CONCURRENCY}。开始批量抓取...`);

    async function worker() {
      while (nextIndex < offsets.length) {
        if (shouldStopEarly) break;

        const offset = offsets[nextIndex];
        nextIndex += 1;

        try {
          const page = await fetchSubjectsPage(subjectKey, subjectType, offset);
          const pageIds = extractSubjectIds(page, subjectType);
          
          if (pageIds.length > 0) {
            pageIds.forEach((id) => subjectIds.add(id));
            
            // 兜底熔断，防止探测成功但中间仍有断层
            const hasAnyNewId = pageIds.some(id => id > maxLocalId);
            if (!hasAnyNewId && maxLocalId > 0) {
              console.log(`🛑 [兜底熔断] offset=${offset} 数据已全低于本地最大 ID，触发提前终止。`);
              shouldStopEarly = true;
              break;
            }
          }
        } catch (error) {
          failures.push({ offset, message: error.message });
        }

        actualFinishedTasks += 1;
        if (actualFinishedTasks % 5 === 0 || actualFinishedTasks === offsets.length) {
          console.log(`   [进度] 已处理位置: ${actualFinishedTasks}/${offsets.length} | 当前收集池: ${subjectIds.size}`);
        }
      }
    }

    const workerCount = Math.min(PAGE_CONCURRENCY, offsets.length);
    await Promise.all(Array.from({ length: workerCount }, worker));
  }

  if (failures.length > 0) {
    console.error(`\n⚠️  警告: 有 ${failures.length} 个位置抓取失败，已被跳过。`);
  }

  // 6. 排序并写入文件
  const addedCount = subjectIds.size - existingIds.size;
  
  if (addedCount > 0 || missingCount < 0) {
    const sortedIds = [...subjectIds].sort((left, right) => left - right);
    await mkdir(OUTPUT_DIR, { recursive: true });
    await writeFile(subjectType.output, `${JSON.stringify(sortedIds)}\n`, 'utf8');
    console.log(`🎉 ${subjectType.label} 完成：实际新增了 ${Math.max(0, addedCount)} 个真实有效 ID，文件总计包含 ${sortedIds.length} 个 ID。`);
  } else {
    console.log(`🎉 ${subjectType.label} 完成：经过排查，没有新增有效 ID，无需写入文件。`);
  }
}

async function main() {
  const requestedKeys = process.argv.slice(2);
  const subjectKeys = requestedKeys.length > 0 ? requestedKeys : Object.keys(SUBJECT_TYPES);

  for (const subjectKey of subjectKeys) {
    const subjectType = SUBJECT_TYPES[subjectKey];

    if (!subjectType) {
      throw new Error(`未知类型：${subjectKey}，可选：${Object.keys(SUBJECT_TYPES).join(', ')}`);
    }

    await collectSubjectIds(subjectKey, subjectType);
  }
}

main().catch((error) => {
  console.error('❌ 脚本执行遭遇致命错误:', error);
  process.exitCode = 1;
});